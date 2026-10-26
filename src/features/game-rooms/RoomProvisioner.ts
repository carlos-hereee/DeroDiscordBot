import { ChannelType, DiscordAPIError, type CategoryChannel, type Guild, type TextChannel } from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { gameRoomCreatedEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { buildRoomChannelName, resolveRoomChannelName } from "./roomNaming.js";
import { buildRoomOverwrites } from "./roomPermissions.js";
import { roomHostRow, roomOpenerEmbed, roomOpenerLogo } from "./gameRoomsEmbeds.js";
import { roomMoveRow } from "./roomGames.js";
import { hangmanRow, hangmanCategoryRow, startSoloHangmanRound } from "./roomHangman.js";
import {
	startMatch as startBattleshipMatch,
	deserializeMatch,
	battleshipBoardMessage,
} from "./roomBattleship.js";
import { createTable as createHoldemTable, joinTable as joinHoldemTable, type HoldemTable, type HoldemTerms } from "@features/games/holdemTable.js";
import type { HangmanCategory } from "@features/games/hangmanWords.js";
import { tableEmbed as holdemTableEmbed, joiningRows as holdemJoiningRows } from "./roomHoldem.js";
import { createInitialState as createMonopolyState } from "@features/games/monopolyState.js";
import { chipTableFor } from "./holdemChips.js";
import { botSeatName, labelBotMentions } from "./botSeat.js";
import { monopolyBoardEmbed, monopolyControlsRow } from "./roomMonopoly.js";
import { checkGameRoomAccess } from "@features/entitlements/gameRoomAccess.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { isWithinReach, readChallengeReach } from "./challengeReach.js";
import { mintRoomInvite } from "./roomInvite.js";
import type { GameSlug, RoomVisibility, SpectatorMode } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── RoomProvisioner ──────────────────────────────────────────────────
// What:  turns an agreed match into a live Discord channel plus the GameRoom row that
//        outlives it.
// Who:   the challenge board (Phase 4) and the owner-only debug command (Phase 3).
//        Its admission check and its seeding are exported for the one room that does
//        NOT get a new channel: a rematch, which plays on in the finished room's.
// When:  once per room, on the host pressing Start.
// Where: the ONLY place a room channel is created. Everything downstream (the trail,
//        the lifecycle, the sweep) assumes a room's channel and row were born together
//        in this function, which is what lets the recovery sweeps treat "row without a
//        channel" as an unambiguous abandonment rather than a race.
// How:   ① claim the host's in-flight slot, ② check the guild cap, ③ create the
//        channel, ④ create the row, ⑤ post and pin the opener, ⑥ log. Every failure
//        path releases the slot in a finally.

// ── rate limit and cap arithmetic at the Pro ceiling (25 private rooms) ──
// Checked 2026-09-01 against Discord's public limits (docs.discord.com Channels
// resource, docs.discord.food rate-limit topic); the one live measurement still owed
// is flagged below.
//
//   Channels per category: 50, hard. The arcade category holds ~5 fixed channels
//   (rules, challenges, leaderboard and kin) plus rooms, so 25 private rooms lands at
//   30/50. A guild running public rooms alongside a full private ceiling has
//   50 - 5 - 25 = 20 public slots before Discord refuses the create; not a documented
//   risk, but the arithmetic the next tier bump has to redo.
//   Channels per guild: 500, hard. Not a constraint at any tier.
//   Channel creation: ~50 creates per 10 min per guild is the widely observed soft
//   bucket (not officially documented). 25 concurrent private rooms is at most 25
//   creates in a burst, well under it; if POST /guilds/{id}/channels ever answers
//   429, the fix is a per-guild queue around guild.channels.create, NOT a lower tier
//   cap. No queue is built yet, deliberately.
//   Message send: 5 per 5s PER CHANNEL. Every room is its own channel, so 25 rooms
//   firing turns concurrently is 25 independent buckets, never one shared one.
//   Invite creation (⑤ᵃ below): at most one createInvite per room open (only a room
//   everyone may watch takes one, roomInvite), far under any plausible bucket. ⚠️ NOT yet measured live: read the X-RateLimit-* headers off
//   one createInvite against a test guild before raising any tier past 50.
//   Mongo writes: ~3 to 5 per turn per room (row update, move append, opener edit,
//   audit log). 25 rooms at a turn per 10s is ~12 writes/s worst case. Not a concern.
//   Bot memory: rooms are Mongo backed; the only per-open memory here is the small
//   inflightOpens Map below. Not a concern.

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

// Games whose controls ride their OWN board message, the one that gets edited every
// turn. Their pinned opener carries none of the game's controls, only the host's
// Remove a player for the games that allow one in play (openerComponents).
//
// ⚠️ A GAME MISSING FROM THIS LIST GETS A DEAD BUTTON, which is what hold em shipped
// with: it was neither "battleship" nor "hangman", so the opener fell through to
// roomMoveRow and pinned a "Make your pick" button (the rps fallback label, ✊ and
// all) above a real poker table. Pressing it routed to runRoomMove, matched no branch
// there, and answered "This game has no room controls yet." on a game that shipped
// the same day. Naming the set instead of testing one slug is what stops the next
// game repeating it.
// solo-blackjack is here because a blackjack table has ALWAYS ridden its own edited
// board message (posted by startBlackjackTable after the room opens), so its opener
// stays a plain card exactly like battleship's and hold em's. solo-hangman is NOT
// here: it rides the trail plus the pinned guess control, like room hangman.
// monopoly rides its own board message too, edited after every move, and so does a
// multi seat blackjack table (2026-10 item 254, Arcade 1), dealt like the solo one. The
// three solo luck rounds have no controls at all: the round is played the moment the room
// opens and its result is the room's one message, so their opener stays a plain card.
const SELF_BOARDED_GAMES: readonly GameSlug[] = [
	"battleship",
	"holdem",
	"monopoly",
	"blackjack",
	"solo-blackjack",
	"solo-coinflip",
	"solo-diceroll",
	"solo-rps",
];

// The controls a room's pinned opener carries, for every game that is not self boarded.
// Hangman opens on the AUTHORING control plus the category select: there is no word
// yet, and offering "guess a letter" before one exists would be a button whose only
// answer is "not yet". The solo form is the opposite: its word is seeded from the bank
// right after, so it opens straight on the GUESS control and never shows authoring.
function openerControls(game: GameSlug, roomId: string) {
	if (game === "hangman") return [hangmanRow({ roomId }, false), hangmanCategoryRow({ roomId })];
	if (game === "solo-hangman") return [hangmanRow({ roomId }, true)];
	return [roomMoveRow({ roomId, game })];
}

// The pinned opener's components. A self boarded game keeps its controls on its own
// board, so its opener carries only the host's Remove a player row (2026-10 item 244
// Phase 4) when the game allows a removal in play, and nothing otherwise. The opener
// is pinned, which is why the host's control lives there: it stays one click away
// however far the trail has scrolled, and it is the same place in every game.
function openerComponents(game: GameSlug, roomId: string) {
	if (!SELF_BOARDED_GAMES.includes(game)) return { components: openerControls(game, roomId) };
	const hostRow = roomHostRow(game, roomId);
	return hostRow ? { components: [hostRow] } : {};
}

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
	// The tier-gated PRIVATE ceiling (invite + solo). Carries the numbers so the copy
	// can say which limit on which plan, not just "no".
	| { ok: false; reason: "privateQuotaHit"; quota: number; tier: string }
	// A public room in a server whose challenge reach is invite only (2026-10 item 244
	// Phase 4). Every door into a room ends here, so this is the refusal that counts.
	| { ok: false; reason: "outsideReach" }
	| { ok: false; reason: "missingPermissions" }
	| { ok: false; reason: "createFailed" };

export type RoomOpenFailure = Exclude<RoomOpenResult, { ok: true }>;

export interface RoomOpenInput {
	guild: Guild;
	category: CategoryChannel;
	game: GameSlug;
	hostId: string;
	hostDisplayName: string;
	playerIds: string[];
	spectatorIds?: string[];
	visibility: RoomVisibility;
	// The host's spectator setting (2026-10 item 254, Arcade 11), off the draft row. Absent
	// or null reads as the visibility's default (roomPermissions.effectiveSpectatorMode).
	spectatorMode?: SpectatorMode | null;
	adminRoleId?: string | null;
	// Set when a DRAFT row already exists, which is the challenge board's path: the
	// row was created the moment the host pressed Start a challenge, and this call is
	// promoting it rather than opening from nothing. Without this the insert below
	// would collide with the partial unique index against the host's own draft, and
	// the honest-looking result would be "you already have a room open" pointing at
	// the very draft the member is trying to start.
	existingRoomId?: string;
	// The rules a hold em table opens with, set only by Dero's rules card (the host
	// asked for a table and confirmed its terms). Absent everywhere else, which
	// opens the standard table exactly as before. Ignored for every other game.
	holdemTerms?: HoldemTerms;
	// Whether a Monopoly match opens with auctions on: the host's choice on the
	// challenge card, carried from the draft row. Absent means off. Ignored for every
	// other game.
	monopolyAuctions?: boolean;
	// The shelf a SOLO hangman word is drawn from, set only by the 🕹️games category
	// start. Absent draws from the whole bank. Ignored for every other game.
	hangmanCategory?: HangmanCategory;
	// The Dero bot seats the host chose on the challenge card (2026-10 item 250 Phase 5),
	// from botSeat.botSeatIdsFor. They sit in the game's own state and NEVER in playerIds,
	// which carry channel permissions. Absent or empty seats no bot.
	botIds?: string[];
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

		// ① ② The host's one room, the guild cap and the private ceiling, in that order.
		const refusal = await checkRoomAdmission({ guild, hostId, visibility, existingRoomId: input.existingRoomId });
		if (refusal) return refusal;

		const { playerIds, spectatorIds } = resolveRoomSeats(visibility, hostId, input.playerIds, input.spectatorIds);

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
					spectatorMode: input.spectatorMode ?? null,
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
					spectatorMode: input.spectatorMode ?? null,
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

		// ⑤ ⑥ Make the room playable: invite, opener, the move to "playing", the game's
		// own state, and the audit line.
		const started = await seedRoom({
			guild,
			channel,
			room,
			game,
			hostId,
			playerIds,
			visibility,
			spectatorMode: input.spectatorMode ?? null,
			holdemTerms: input.holdemTerms,
			monopolyAuctions: input.monopolyAuctions,
			hangmanCategory: input.hangmanCategory,
			botIds: input.botIds,
		});

		return { ok: true, room: started, channel };
	},
};

export interface RoomAdmissionInput {
	guild: Guild;
	hostId: string;
	visibility: RoomVisibility;
	// Set when promoting an existing draft; see RoomOpenInput.existingRoomId.
	existingRoomId?: string;
}

/**
 * Whether a new live room may open for this host, or the reason it may not. Returns
 * null when the room may open. Writes nothing, so a refusal leaves no trace.
 *
 * Shared by the provisioner and a rematch in the same channel, because a rematch is a
 * new live room too: it holds a host slot, counts against the guild cap and counts
 * against the private tier ceiling exactly like a room that brings its own channel.
 */
export async function checkRoomAdmission(input: RoomAdmissionInput): Promise<RoomOpenFailure | null> {
	const { guild, hostId, visibility } = input;

	// ⓪ The server's challenge reach (2026-10 item 244 Phase 4): an invite only server
	// opens no public room, by the board, a rematch or Dero's rules card alike. First,
	// because it is the one refusal no amount of waiting fixes. Read only for a public
	// room, so an invite or solo open costs no extra read.
	if (visibility === "public" && !isWithinReach(await readChallengeReach(guild.id), visibility)) {
		return { ok: false, reason: "outsideReach" };
	}

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

	// ②ᵇ The tier-gated PRIVATE ceiling: "invite" and "solo" rooms count, "public"
	// never does. The decision is the same cached, fail-open answer the challenge
	// board reads; while ENFORCE_GAME_ROOM_TIER is unset (production today) the
	// quota is Infinity and this whole block costs zero I/O beyond the flag read.
	if (visibility !== "public") {
		const decision = await checkGameRoomAccess(guild.id, hostId);
		if (Number.isFinite(decision.privateQuota)) {
			const privateOpen = await gameRoomStore.countOpenInGuildByVisibility(guild.id, ["invite", "solo"]);
			// An adopted draft already sits in that count with this very visibility
			// (chooseVisibility wrote it), so promoting it must not read as opening a
			// room BEYOND the one it already is. Fresh opens have no row yet.
			const alreadyCounted = input.existingRoomId ? 1 : 0;
			if (privateOpen - alreadyCounted >= decision.privateQuota) {
				return {
					ok: false,
					reason: "privateQuotaHit",
					quota: decision.privateQuota,
					tier: decision.tierKey ?? "unsubscribed",
				};
			}
		}
	}

	return null;
}

/**
 * Who plays and who watches in a room of this visibility. The host is always a player.
 *
 * A solo room seats the host and NOBODY else, structurally: extra players and
 * spectators are dropped here the way a public room's spectators are dropped in
 * provisionFromDraft, so a caller cannot smuggle a second seat or a watcher into a
 * one-player room.
 */
export function resolveRoomSeats(
	visibility: RoomVisibility,
	hostId: string,
	playerIds: string[],
	spectatorIds: string[] = []
): { playerIds: string[]; spectatorIds: string[] } {
	if (visibility === "solo") return { playerIds: [hostId], spectatorIds: [] };
	return { playerIds: Array.from(new Set([hostId, ...playerIds])), spectatorIds };
}

export interface RoomSeedInput {
	guild: Guild;
	// The room's channel, already carrying the "playing" overwrites.
	channel: TextChannel;
	// The room's row, which must not be "playing" yet: this moves it there.
	room: IGameRoom;
	game: GameSlug;
	hostId: string;
	playerIds: string[];
	visibility: RoomVisibility;
	// Decides whether the room gets an invite link (roomInvite) and what the opener says
	// about who can watch. Absent or null reads as the visibility's default.
	spectatorMode?: SpectatorMode | null;
	holdemTerms?: HoldemTerms;
	monopolyAuctions?: boolean;
	hangmanCategory?: HangmanCategory;
	// The Dero bot seats the host chose on the challenge card (2026-10 item 250 Phase 5),
	// from botSeat.botSeatIdsFor. They sit in the game's own state and NEVER in playerIds,
	// which carry channel permissions. Absent or empty seats no bot.
	botIds?: string[];
}

// ── seeding: from a channel and a row to a playable match ─────────────
// What:  everything a room needs between "its channel and row exist" and "the players
//        can play": the invite link, the pinned opener with the game's controls, the
//        move to "playing", and the game's own starting state.
// Who:   RoomProvisioner.openUnguarded for a first match in a new channel, and
//        challengeBoard.rematchFromRoom for a rematch in the channel the finished room
//        handed over. ONE function, so a rematch can never open a game differently
//        from how a first match opens it.
// When:  once per room, right after its row exists and its channel is writable.
// How:   ⑤ᵃ invite, ⑤ opener and status, then the per game state, then ⑥ the audit
//        line. A blackjack table is NOT here, solo or multi seat: soloRooms deals it
//        (startSoloBlackjackBoard, startBlackjackRoomBoard), because a table that fails
//        to start closes the room, and that is the caller's decision rather than the
//        provisioner's. Nor is a solo luck round, which soloRooms plays once the room is up.
export async function seedRoom(input: RoomSeedInput): Promise<IGameRoom> {
	const { guild, channel, room, game, hostId, playerIds, visibility } = input;
	const botIds = input.botIds ?? [];

	// ⑤ᵃ Mint the room's invite link before the opener composes so the URL can ride the
	// opener's LAST line. Only a public room everyone may watch gets one, and finish
	// deletes it the moment the match ends (roomInvite, 2026-10 item 254, Arcade 10); a
	// rematch passes through here too, so it follows the same rule as a first open.
	// Best effort: a failed mint is a room without a link, never a failed open.
	const inviteCode = await mintRoomInvite(channel, room, visibility, input.spectatorMode);

	// ⑤ Move to "playing" and record the ids that only exist now. Two writes rather
	// than one because create() owns the shape of a new row and this owns the
	// transition; folding them would put lifecycle logic into the store.
	// The opener carries the game's own controls, so a player never has to find a
	// command to take their turn. Pinned below, which is what keeps it reachable
	// once the trail has scrolled past it.
	const logo = roomOpenerLogo(game);
	const opener = await channel
		.send({
			embeds: [roomOpenerEmbed(game, hostId, [...playerIds, ...botIds], visibility, input.spectatorMode ?? null, inviteCode, logo?.ref)],
			...(logo ? { files: [logo.attachment] } : {}),
			...openerComponents(game, room.roomId),
		})
		.catch(() => null);
	await opener?.pin().catch(() => undefined);

	const started = await gameRoomStore.setStatus(guild.id, room.roomId, "playing", {
		channelId: channel.id,
		openerMessageId: opener?.id ?? null,
		inviteCode,
		startedAt: new Date(),
	});

	// Battleship needs a MATCH, not just a room: two fleets laid out and a board
	// message to edit every turn. Done here rather than lazily on the first click
	// so both players see the grid the moment the channel appears, and so the
	// fleets exist before anyone can press Fire.
	// Hold em opens as a JOINING table rather than a dealt hand: the room's
	// players are whoever buys in, which is not known until they do.
	if (game === "holdem") {
		const table = createHoldemTable(Date.now(), input.holdemTerms);
		// Whether the table plays for the members' wallet chips (2026-10 item 250 Phase 5),
		// decided once, here, so a table never changes what it plays for mid way. A table
		// with a bot seat plays free, so a bot never pays a member chips it never had.
		const chips = await chipTableFor(room, botIds.length > 0);
		if (chips) table.chips = chips;
		// The host's Dero bots take their seats before anybody buys in.
		for (const botId of botIds) joinHoldemTable(table, botId, botSeatName(botId));
		const boardMessage = await channel
			.send({ embeds: [firstTableEmbed(table)], components: holdemJoiningRows(room.roomId, table.seats.length, table) })
			.catch(() => null);
		await gameRoomStore.update(guild.id, room.roomId, {
			secret: { ...table, boardMessageId: boardMessage?.id ?? null } as never,
		});
	}

	// Monopoly opens straight on the first seat's roll: every player is already
	// known (the whole pool, which challengeBoard.startMatch capped at six), so
	// unlike hold em there is no joining phase. The board is posted before the
	// state is persisted so the stored state can carry the message id it edits.
	// Auctions follow the host's choice on the challenge card; with them on, a pass
	// opens a sealed bid round that roomMonopolyAuction runs and closes.
	if (game === "monopoly") {
		// The bots sit after the members, each on the token its name says (botSeat).
		const state = createMonopolyState([...playerIds, ...botIds], { auctionsEnabled: input.monopolyAuctions ?? false });
		// The board picture, when its art is on disk, rides the same message as the
		// embed whose image points at it; with no art it is the text map alone.
		const { embed, attachment } = await monopolyBoardEmbed(state);
		const boardMessage = await channel
			.send({
				embeds: [embed],
				components: monopolyControlsRow(state, state.seats[0].userId, room.roomId),
				files: attachment ? [attachment] : [],
			})
			.catch(() => null);
		await gameRoomStore.update(guild.id, room.roomId, {
			// `secret` is a Mongoose Mixed field and IGameRoom types it as hangman's
			// RoomSecret, so another game's state needs the cast to be stored there.
			secret: { ...state, boardMessageId: boardMessage?.id ?? null } as never,
		});
	}

	// Solo hangman is seeded HERE rather than authored: the host is the guesser, so
	// the word and its hint come from the bundled bank with no author. authoredBy
	// null is what lets the host past roomHangman's host-cannot-guess gate, which
	// keys on the AUTHOR, not the host. Seeded after the opener so a click racing
	// the seed reads as "waiting for the word" for a moment rather than erroring.
	// It starts through the same path a hosted round does, which also posts the
	// first gallows card.
	if (game === "solo-hangman") {
		await startSoloHangmanRound(
			guild.client,
			{
				guildId: guild.id,
				roomId: room.roomId,
				channelId: channel.id,
				openerMessageId: opener?.id ?? null,
				hostId,
			},
			input.hangmanCategory
		);
	}

	if (game === "battleship") {
		const usernames = Object.fromEntries(
			playerIds.map((id) => [id, guild.members.cache.get(id)?.displayName ?? id])
		);
		// Against a Dero bot (2026-10 item 250 Phase 5) the bot is the second captain; the
		// row's playerIds stay the host alone, so the match names its two players itself.
		const botCaptain = botIds[0];
		if (botCaptain) usernames[botCaptain] = botSeatName(botCaptain);
		const captains = botCaptain ? { ...(started ?? room), playerIds: [hostId, botCaptain] } : (started ?? room);
		const match = startBattleshipMatch(captains as IGameRoom, usernames);
		const boardMessage = await channel
			.send(await battleshipBoardMessage(deserializeMatch(match), room.roomId))
			.catch(() => null);
		// No separate reroll message any more: the match opens in setup, and the board's
		// own setup row carries Randomize and Ready (post-launch plan item 17).
		await gameRoomStore.update(guild.id, room.roomId, {
			secret: { ...match, boardMessageId: boardMessage?.id ?? null } as never,
		});
	}

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

	return started ?? room;
}

// The first table embed, with any Dero bot seats named rather than mentioned (2026-10
// item 250 Phase 5); every later redraw names them through labelEmbedForRoom.
function firstTableEmbed(table: HoldemTable) {
	const embed = holdemTableEmbed(table, 0);
	return embed.setDescription(labelBotMentions(embed.data.description ?? ""));
}

// Render a failure into the one sentence the member should read. Kept beside the
// provisioner so a new reason cannot be added without a string to go with it.
export function describeRoomOpenFailure(result: RoomOpenFailure): string {
	switch (result.reason) {
		case "alreadyHosting":
			return gameRoomsCopy.errors.alreadyHosting(result.existingChannelId);
		case "guildFull":
			return gameRoomsCopy.errors.guildFull();
		case "privateQuotaHit":
			return gameRoomsCopy.errors.privateQuotaHit(result.quota, gameRoomsCopy.tierName(result.tier));
		case "outsideReach":
			// Both packs share the host control words, so the default pack is right here.
			return rokCommanderCopy.arcadeHostControls.reach.publicRefused;
		case "missingPermissions":
			return gameRoomsCopy.errors.missingPermissions;
		case "createFailed":
			return gameRoomsCopy.errors.createFailed;
	}
}
