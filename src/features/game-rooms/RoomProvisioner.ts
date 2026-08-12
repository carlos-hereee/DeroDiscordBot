import { ChannelType, DiscordAPIError, type CategoryChannel, type Guild, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { gameRoomCreatedEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildRoomChannelName, resolveRoomChannelName } from "./roomNaming.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { roomOpenerEmbed } from "./gameRoomsEmbeds.js";
import { roomMoveRow } from "./roomGames.js";
import { hangmanRow } from "./roomHangman.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { GameSlug, RoomVisibility } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── RoomProvisioner ──────────────────────────────────────────────────
// What:  turns an agreed match into a live Discord channel plus the GameRoom row that
//        outlives it.
// Who:   the challenge board (Phase 4) and the owner-only debug command (Phase 3).
// When:  once per room, on the host pressing Start.
// Where: the ONLY place a room channel is created. Everything downstream (the trail,
//        the lifecycle, the sweep) assumes a room's channel and row were born together
//        in this function, which is what lets the recovery sweeps treat "row without a
//        channel" as an unambiguous abandonment rather than a race.
// How:   ① claim the host's in-flight slot, ② check the guild cap, ③ create the
//        channel, ④ create the row, ⑤ post and pin the opener, ⑥ log. Every failure
//        path releases the slot in a finally.

// ── the in-flight map ─────────────────────────────────────────────────
// What:  the one piece of state this feature keeps in memory, and it keeps only this.
// Why:   a host who double-clicks Start fires two interactions milliseconds apart, far
//        inside the round trip of the cap check plus the channel create, so both would
//        pass their checks and build two channels. The partial unique index on
//        (guildId, hostId) catches the second ROW, but only after its CHANNEL exists,
//        which would leave an orphan channel with no row and nothing to sweep it.
// When:  held for the duration of one open() call and released in a finally, always.
// Where: losing this map on a Railway deploy costs nothing, because the index is the
//        real guarantee and this is only the thing that keeps the failure cheap.
const inflightOpens = new Map<string, Promise<RoomOpenResult>>();

// Test seam, and the reason this is not just a module-local: a leaked entry would make
// every later open by that host return the previous result forever.
export const _clearInflightOpens = (): void => inflightOpens.clear();

export type RoomOpenResult =
	| { ok: true; room: IGameRoom; channel: TextChannel }
	// Every failure names itself, so the caller renders one reply per reason rather
	// than a single "could not open a room" that tells the member nothing about
	// whether waiting, upgrading or asking an admin is the fix.
	| { ok: false; reason: "alreadyHosting"; existingChannelId: string | null }
	| { ok: false; reason: "guildFull" }
	| { ok: false; reason: "missingPermissions" }
	| { ok: false; reason: "createFailed" };

export interface RoomOpenInput {
	guild: Guild;
	category: CategoryChannel;
	game: GameSlug;
	hostId: string;
	hostDisplayName: string;
	playerIds: string[];
	spectatorIds?: string[];
	visibility: RoomVisibility;
	adminRoleId?: string | null;
	// Set when a DRAFT row already exists, which is the challenge board's path: the
	// row was created the moment the host pressed Start a challenge, and this call is
	// promoting it rather than opening from nothing. Without this the insert below
	// would collide with the partial unique index against the host's own draft, and
	// the honest-looking result would be "you already have a room open" pointing at
	// the very draft the member is trying to start.
	existingRoomId?: string;
}

export const RoomProvisioner = {
	// Open a room, or explain why not. Never throws for an expected condition; a caller
	// only has to handle the discriminated union.
	async open(input: RoomOpenInput): Promise<RoomOpenResult> {
		const key = `${input.guild.id}:${input.hostId}`;

		// A second click while the first is still running gets the FIRST call's result
		// rather than a second room. Returning the same promise (rather than a "busy"
		// error) means a double click reads to the member as one slightly slow click,
		// which is what it was.
		const inflight = inflightOpens.get(key);
		if (inflight) return inflight;

		const work = RoomProvisioner.openUnguarded(input).finally(() => {
			// ALWAYS, including on a throw. A leaked entry would pin this host's next
			// open forever, and the symptom (one member permanently unable to start a
			// game, everyone else fine) is close to undiagnosable from a log.
			inflightOpens.delete(key);
		});
		inflightOpens.set(key, work);
		return work;
	},

	async openUnguarded(input: RoomOpenInput): Promise<RoomOpenResult> {
		const { guild, category, game, hostId, visibility } = input;

		// ① F11, the friendly half. The partial unique index is the real enforcement and
		// would throw a duplicate key on create; checking first is what turns that into a
		// jump link to the room the host already has.
		//
		// Skipped entirely when adopting a draft: the host's one open room IS the draft
		// being promoted, so this check would refuse the very thing it is protecting.
		if (!input.existingRoomId) {
			const existing = await gameRoomStore.findOpenByHost(guild.id, hostId);
			if (existing) {
				return { ok: false, reason: "alreadyHosting", existingChannelId: existing.channelId };
			}
		}

		// ② The guild cap. Counting ROWS rather than the category's children stays correct
		// when an admin deletes a room channel by hand, which counting channels would not.
		const openCount = await gameRoomStore.countOpenInGuild(guild.id);
		if (openCount >= BOT_CONSTANTS.GAME_ROOM_MAX_PER_GUILD) {
			return { ok: false, reason: "guildFull" };
		}

		const playerIds = Array.from(new Set([hostId, ...input.playerIds]));
		const spectatorIds = input.spectatorIds ?? [];

		// ③ The name. Collisions are ordinary rather than exceptional: a finished room
		// keeps its channel for the whole archive window, so a host playing twice in an
		// evening lands on their own previous channel name.
		const takenNames = new Set(category.children.cache.map((child) => child.name));
		const baseName = buildRoomChannelName(game, input.hostDisplayName, hostId);
		const channelName = resolveRoomChannelName(baseName, (candidate) => takenNames.has(candidate));

		let channel: TextChannel;
		try {
			channel = (await guild.channels.create({
				name: channelName,
				type: ChannelType.GuildText,
				parent: category.id,
				permissionOverwrites: buildRoomOverwrites({
					everyoneRoleId: guild.roles.everyone.id,
					botId: guild.client.user!.id,
					hostId,
					playerIds,
					spectatorIds,
					visibility,
					phase: "playing",
					adminRoleId: input.adminRoleId ?? null,
				}),
			})) as TextChannel;
		} catch (error) {
			// 50013 is the one failure with a specific, actionable cause: the bot cannot
			// build in the arcade category. Reply honestly and NEVER retry. A retry loop
			// against a permission the bot does not have is an infinite loop with a rate
			// limit at the end of it.
			if (error instanceof DiscordAPIError && error.code === 50013) {
				return { ok: false, reason: "missingPermissions" };
			}
			console.error("[game-rooms] room channel create failed", { guildId: guild.id, hostId, error });
			return { ok: false, reason: "createFailed" };
		}

		// ④ The row. Created AFTER the channel so a row can never point at a channel that
		// was never built; the opposite order would leave a phantom room in every list.
		//
		// Adopting a draft skips the insert: the board created that row when the host
		// pressed Start a challenge, and it already carries the boardMessageId this
		// channel's card is anchored to.
		let room: IGameRoom;
		try {
			if (input.existingRoomId) {
				const adopted = await gameRoomStore.findByRoomId(guild.id, input.existingRoomId);
				if (!adopted) throw new Error(`draft ${input.existingRoomId} vanished before provisioning`);
				room = adopted;
			} else {
				room = await gameRoomStore.create({
					guildId: guild.id,
					game,
					hostId,
					visibility,
					playerIds,
					spectatorIds,
				});
			}
		} catch (error) {
			// Almost certainly the partial unique index catching a race the in-flight map
			// could not (two processes, or a click that straddled a deploy). The channel
			// exists and now has no row, so delete it rather than leave an orphan the
			// sweep will never see: the sweep only ever looks at ROWS.
			await channel.delete("game room row create failed").catch(() => undefined);
			console.error("[game-rooms] room row create failed, channel rolled back", { guildId: guild.id, hostId, error });
			return { ok: false, reason: "createFailed" };
		}

		// ⑤ Move to "playing" and record the ids that only exist now. Two writes rather
		// than one because create() owns the shape of a new row and this owns the
		// transition; folding them would put lifecycle logic into the store.
		// The opener carries the game's own controls, so a player never has to find a
		// command to take their turn. Pinned below, which is what keeps it reachable
		// once the trail has scrolled past it.
		const opener = await channel
			.send({
				embeds: [roomOpenerEmbed(game, hostId, playerIds, visibility === "public")],
				// Hangman opens with the AUTHORING control, not a guess control: there
				// is no word yet, and offering "guess a letter" before one exists would
				// be a button whose only possible answer is "not yet".
				components: [game === "hangman" ? hangmanRow({ roomId: room.roomId }, false) : roomMoveRow({ roomId: room.roomId, game })],
			})
			.catch(() => null);
		await opener?.pin().catch(() => undefined);

		const started = await gameRoomStore.setStatus(guild.id, room.roomId, "playing", {
			channelId: channel.id,
			openerMessageId: opener?.id ?? null,
			startedAt: new Date(),
		});

		// ⑥ Fire and forget, per house rule 7: an audit write that failed must never take
		// down a room the members can already see and play in.
		botLogStore
			.log(guild.id, gameRoomCreatedEvent(room.roomId), {
				game,
				hostId,
				visibility,
				channelId: channel.id,
				playerCount: playerIds.length,
			})
			.catch((error) => console.error("[game-rooms] botLog for room create failed", error));

		return { ok: true, room: started ?? room, channel };
	},
};

// Render a failure into the one sentence the member should read. Kept beside the
// provisioner so a new reason cannot be added without a string to go with it.
export function describeRoomOpenFailure(result: Exclude<RoomOpenResult, { ok: true }>): string {
	switch (result.reason) {
		case "alreadyHosting":
			return gameRoomsCopy.errors.alreadyHosting(result.existingChannelId);
		case "guildFull":
			return gameRoomsCopy.errors.guildFull();
		case "missingPermissions":
			return gameRoomsCopy.errors.missingPermissions;
		case "createFailed":
			return gameRoomsCopy.errors.createFailed;
	}
}
