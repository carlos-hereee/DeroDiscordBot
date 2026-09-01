import {
	ActionRowBuilder,
	ChannelType,
	MessageFlags,
	StringSelectMenuBuilder,
	TextChannel,
	type ButtonInteraction,
	type CategoryChannel,
	type Guild,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { checkGameRoomAccess, gameRoomUpgradeEmbed } from "@features/entitlements/gameRoomAccess.js";
import { RoomProvisioner, describeRoomOpenFailure } from "./RoomProvisioner.js";
import { openSoloRoom, describeSoloOpenFailure, readPrivateQuotaStatus } from "./soloRooms.js";
import { roomTrail } from "./roomTrail.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { openerCardEmbed, openerCardRows, isCooperativeGame, type OpenerCardState } from "./challengeBoardEmbeds.js";
import type { GameSlug, RoomVisibility } from "./roomTypes.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── challengeBoard ───────────────────────────────────────────────────
// What:  the ⚔️challenges flow: start a challenge, choose who can see it, gather
//        the people who want in, then hand the result to RoomProvisioner.
// Who:   the board's own buttons, and the /mini-game two-player subcommands, which
//        route here rather than keeping a second way to start a match.
// When:  from the first press to the moment the room's channel exists.
// Where: the draft GameRoom row IS the state. Nothing about a challenge lives in
//        memory, which is what makes a challenge survive the Railway deploy that
//        would have killed the old in-memory challengeFlow mid-handshake.
// How:   ONE card, edited in place at every step, and ONE pool mechanism for both
//        visibilities. See the pool note below; it is the decision that keeps this
//        file from being two parallel flows.

// ── the pool, and why one mechanism serves both visibilities ──
// A draft's `spectatorIds` holds everyone who is in, whichever way they got there:
// the members an invite-only host picked, or the members who pressed Join on an
// open-to-all card. At start the host promotes exactly ONE of them into `playerIds`
// and every other stays put, already in the right field.
//
// The alternative (a separate "invited" array, or an "accepted" array) would mean two
// code paths, two truncation rules and two ways to be wrong about who can see the
// room. This way the permission matrix receives the same two arrays no matter how the
// challenge was assembled.

async function resolveChallengesChannel(guild: Guild): Promise<TextChannel | null> {
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const channelId = (stored as unknown as { arcadeChallengesChannelId?: string | null } | null)?.arcadeChallengesChannelId;
	if (!channelId) return null;
	const channel = await guild.channels.fetch(channelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

function cardStateFor(room: IGameRoom, overrides: Partial<OpenerCardState> = {}): OpenerCardState {
	return {
		game: room.game,
		hostId: room.hostId,
		// A draft row carries the schema default "invite" before the host has chosen,
		// so the CARD's notion of "not chosen yet" cannot read the row's visibility
		// field. `status === "draft"` plus a null boardMessageId is not enough either.
		// The honest signal is startedAt: null and an explicit override from the
		// caller that knows whether the chooser has been answered.
		visibility: overrides.visibility ?? null,
		pool: room.spectatorIds ?? [],
		...overrides,
	};
}

// Re-render the opener card for a room's current state. Cosmetic, so a failure is
// logged and swallowed: the draft row is the truth and the next edit will catch up.
async function refreshCard(guild: Guild, room: IGameRoom, state: OpenerCardState): Promise<void> {
	if (!room.boardMessageId) return;
	const channel = await resolveChallengesChannel(guild);
	if (!channel) return;
	const message = await channel.messages.fetch(room.boardMessageId).catch(() => null);
	if (!message) return;
	await message
		.edit({ embeds: [openerCardEmbed(state)], components: openerCardRows(room.roomId, state) })
		.catch((error) => console.warn("[game-rooms] failed to refresh the opener card", error));
}

// A rematch's head start: the finished room's other players pre-fill the pool, and
// the finished room's id rides the row as the one-rematch-per-room idempotency key.
export interface ChallengeDraftSeed {
	spectatorIds: string[];
	rematchedFromRoomId: string;
}

// ── start a challenge ─────────────────────────────────────────────────
// Reached from the board's per-game buttons AND from /mini-game, so the two cannot
// drift into different rules about who may start what. Returns the draft row when one
// was created, or null when the press was refused (the refusal has already replied).
export async function startChallengeDraft(
	interaction: ButtonInteraction | { guild: Guild | null; guildId: string | null; user: { id: string }; reply: ButtonInteraction["reply"] },
	game: GameSlug,
	seed?: ChallengeDraftSeed
): Promise<IGameRoom | null> {
	const guild = interaction.guild;
	const guildId = interaction.guildId;
	if (!guild || !guildId) {
		await interaction.reply({ embeds: [errorEmbed("This only works inside a server.")], flags: MessageFlags.Ephemeral });
		return null;
	}

	// The paid-tier seam. Fails OPEN by design (see gameRoomAccess), and costs nothing
	// at all while ENFORCE_GAME_ROOM_TIER is unset, which is production today.
	const access = await checkGameRoomAccess(guildId, interaction.user.id);
	if (!access.allowed) {
		await interaction.reply({ embeds: [gameRoomUpgradeEmbed(access.upgradeUrl)], flags: MessageFlags.Ephemeral });
		return null;
	}

	// F11's friendly half, checked before anything is posted publicly. The partial
	// unique index would throw on the insert below; this turns that into a jump link.
	const existing = await gameRoomStore.findOpenByHost(guildId, interaction.user.id);
	if (existing) {
		await interaction.reply({
			content: gameRoomsCopy.errors.alreadyHosting(existing.channelId),
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	const channel = await resolveChallengesChannel(guild);
	if (!channel) {
		await interaction.reply({ embeds: [errorEmbed(gameRoomsCopy.errors.noArcadeCategory)], flags: MessageFlags.Ephemeral });
		return null;
	}

	let room: IGameRoom;
	try {
		room = await gameRoomStore.create({
			guildId,
			game,
			hostId: interaction.user.id,
			visibility: "invite",
			// A rematch arrives with the finished table already in the pool, so the
			// host only re-confirms who plays rather than re-gathering everyone.
			spectatorIds: seed?.spectatorIds,
			rematchedFromRoomId: seed?.rematchedFromRoomId ?? null,
		});
	} catch (error) {
		// Almost certainly the unique index catching a double click that outran the
		// findOpenByHost above. The honest answer is the same as the friendly one.
		console.error("[game-rooms] draft create failed", { guildId, error });
		await interaction.reply({ content: gameRoomsCopy.errors.alreadyHosting(null), flags: MessageFlags.Ephemeral });
		return null;
	}

	const state = cardStateFor(room, { visibility: null, pool: room.spectatorIds ?? [] });
	const card = await channel
		.send({ embeds: [openerCardEmbed(state)], components: openerCardRows(room.roomId, state) })
		.catch(() => null);

	if (!card) {
		// The row exists and its card does not, so the host would hold a room slot they
		// can never see or cancel. Roll the draft back rather than stranding them.
		await gameRoomStore.markArchived(guildId, room.roomId);
		await interaction.reply({ embeds: [errorEmbed(gameRoomsCopy.errors.createFailed)], flags: MessageFlags.Ephemeral });
		return null;
	}

	await gameRoomStore.update(guildId, room.roomId, { boardMessageId: card.id });
	await interaction.reply({
		content: seed
			? gameRoomsCopy.board.rematchOffered(channel.id)
			: gameRoomsCopy.board.cardStarted(channel.id).replace("The match is under way in", "Your challenge card is in"),
		flags: MessageFlags.Ephemeral,
	});
	return room;
}

// ── the visibility chooser ────────────────────────────────────────────
export async function chooseVisibility(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	const visibility: RoomVisibility = choice === "public" ? "public" : "invite";
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { visibility })) ?? room;

	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, updated, cardStateFor(updated, { visibility, pool: updated.spectatorIds ?? [] }));

	// A host choosing the PRIVATE form sees the ceiling before the refusal ever
	// could: "Your server has 6/10 private rooms open on the Starter plan." Null
	// (and therefore silent) while the tier surface is not enforcing, which is
	// production today. Fire and forget after the card edit; a failed followUp must
	// not undo a visibility choice that already landed.
	if (visibility === "invite") {
		readPrivateQuotaStatus(room.guildId, interaction.user.id)
			.then((status) =>
				status ? interaction.followUp({ content: `Invite only. ${status}`, flags: MessageFlags.Ephemeral }) : undefined
			)
			.catch((error) => console.warn("[game-rooms] private quota status failed", error));
	}
}

// ── the invite picker (F9's structural half) ──────────────────────────
// ⚠️ A StringSelect THE BOT POPULATES, and that is the whole point. A UserSelect is
// filled in by Discord from the guild's member list and will happily return a bot,
// which would put "Dero" back on the opponent list through a component rather than
// through a copy string. Here the bot builds every option itself and filters
// `member.user.bot`, so a bot cannot appear no matter what the client sends back.
// The handler re-checks anyway, because a customId and its values are user input.
export async function openInvitePicker(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const guild = interaction.guild!;

	// Cache first, then one fetch. A cold cache after a restart would otherwise show
	// an almost empty picker in a busy guild.
	let members = guild.members.cache;
	if (members.size <= 1) members = await guild.members.fetch().catch(() => members);

	const options = members
		.filter((member) => !member.user.bot && member.id !== room.hostId)
		.map((member) => ({
			label: (member.displayName || member.user.username).slice(0, 100),
			value: member.id,
			description: `@${member.user.username}`.slice(0, 100),
		}))
		// Discord caps a select at 25 options, which is also GAME_ROOM_MAX_SPECTATORS.
		// The two agreeing is deliberate rather than lucky: the picker cannot offer
		// more members than a room could carry overwrites for.
		.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS);

	if (options.length === 0) {
		await interaction.reply({ content: gameRoomsCopy.board.pickerEmpty, flags: MessageFlags.Ephemeral });
		return;
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:invite:${room.roomId}`)
		.setPlaceholder(gameRoomsCopy.board.pickerPlaceholder)
		.setMinValues(1)
		.setMaxValues(options.length)
		.addOptions(options);

	await interaction.reply({
		content: gameRoomsCopy.board.pickerPrompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
		flags: MessageFlags.Ephemeral,
	});
}

// The picker's submission. Registered separately because the registry keys select
// menus in their own map.
export async function handleInviteSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_SELECT_PREFIX || action !== "invite" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room) {
		await interaction.reply({ content: gameRoomsCopy.board.draftGone, flags: MessageFlags.Ephemeral });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.board.notYourChallenge, flags: MessageFlags.Ephemeral });
		return;
	}

	// ⚠️ RE-FILTER SERVER SIDE. The values arrive from the client, and a customId plus
	// its payload are user input however the menu was built. Re-resolving each id
	// against the guild and dropping bots means the structural guarantee above holds
	// even against a hand-crafted interaction.
	const picked: string[] = [];
	for (const id of interaction.values.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)) {
		if (id === room.hostId) continue;
		const member = interaction.guild.members.cache.get(id) ?? (await interaction.guild.members.fetch(id).catch(() => null));
		if (member && !member.user.bot) picked.push(id);
	}

	const updated = (await gameRoomStore.update(guildId, roomId, { spectatorIds: picked })) ?? room;
	await interaction.reply({ content: gameRoomsCopy.board.pickerSaved(picked.length), flags: MessageFlags.Ephemeral });
	await refreshCard(interaction.guild, updated, cardStateFor(updated, { visibility: "invite", pool: picked }));
}

// ── open to all: the Join button ──────────────────────────────────────
// ⚠️ BOT FREE BY CONSTRUCTION. Bots cannot click buttons, so this path cannot admit
// one; there is nothing to filter. That is the other half of F9, and it is why the
// two visibilities need no shared "is this a bot" check.
export async function joinChallenge(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const actorId = interaction.user.id;

	if (actorId === room.hostId) {
		await interaction.reply({ content: gameRoomsCopy.board.hostCannotJoin, flags: MessageFlags.Ephemeral });
		return;
	}
	if ((room.spectatorIds ?? []).includes(actorId)) {
		await interaction.reply({ content: gameRoomsCopy.board.alreadyJoined, flags: MessageFlags.Ephemeral });
		return;
	}
	if ((room.spectatorIds ?? []).length >= BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS) {
		await interaction.reply({
			content: gameRoomsCopy.board.poolFull(BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// $addToSet, so two members clicking in the same tick both land and a double click
	// is a no-op rather than a duplicate entry.
	const updated = (await gameRoomStore.addPoolMember(room.guildId, room.roomId, actorId)) ?? room;

	await interaction.deferUpdate();
	await refreshCard(
		interaction.guild!,
		updated,
		cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] })
	);
}

// ── start the match ───────────────────────────────────────────────────
export async function startMatch(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const pool = room.spectatorIds ?? [];
	if (pool.length === 0) {
		await interaction.reply({ content: gameRoomsCopy.board.poolEmpty, flags: MessageFlags.Ephemeral });
		return;
	}

	// ⚠️ A COOPERATIVE GAME NEVER ASKS WHO PLAYS. In hangman the whole pool guesses
	// together against the host's word, so picking one of them would turn a party
	// game into a duel and leave the rest as spectators of a game they joined to
	// play. provisionFromDraft handles the promotion; this just skips the question.
	if (isCooperativeGame(room.game)) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		await provisionFromDraft(interaction, room, null);
		return;
	}

	// More than one candidate: the host chooses who plays, and everyone else stays in
	// spectatorIds, already in the right field. One candidate needs no question.
	if (pool.length > 1) {
		const options = [];
		for (const id of pool.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)) {
			const member =
				interaction.guild!.members.cache.get(id) ?? (await interaction.guild!.members.fetch(id).catch(() => null));
			options.push({
				label: (member?.displayName || member?.user.username || id).slice(0, 100),
				value: id,
			});
		}
		const select = new StringSelectMenuBuilder()
			.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:opponent:${room.roomId}`)
			.setPlaceholder(gameRoomsCopy.board.chooseOpponentPlaceholder)
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions(options);

		await interaction.reply({
			content: gameRoomsCopy.board.chooseOpponentPrompt,
			components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	await provisionFromDraft(interaction, room, pool[0]);
}

// The opponent picker's submission, for the multi-joiner case.
export async function handleOpponentSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_SELECT_PREFIX || action !== "opponent" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room) {
		await interaction.reply({ content: gameRoomsCopy.board.draftGone, flags: MessageFlags.Ephemeral });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.board.notYourChallenge, flags: MessageFlags.Ephemeral });
		return;
	}

	const chosen = interaction.values[0];
	if (!chosen || !(room.spectatorIds ?? []).includes(chosen)) {
		await interaction.reply({ content: gameRoomsCopy.board.poolEmpty, flags: MessageFlags.Ephemeral });
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	await provisionFromDraft(interaction, room, chosen);
}

// Shared tail of both start paths: promote the chosen member, provision, and close
// out the card. One function so the two entry points cannot diverge about who ends up
// a player and who ends up a spectator.
async function provisionFromDraft(
	interaction: ButtonInteraction | StringSelectMenuInteraction,
	room: IGameRoom,
	// Null for a cooperative game, where the whole pool plays and there is nobody to
	// single out.
	opponentId: string | null
): Promise<void> {
	const guild = interaction.guild!;
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const config = stored as unknown as { gamesCategoryId?: string | null; adminRoleId?: string | null } | null;

	const categoryId = config?.gamesCategoryId;
	const category = categoryId ? await guild.channels.fetch(categoryId).catch(() => null) : null;
	if (!category || category.type !== ChannelType.GuildCategory) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.errors.noArcadeCategory)] });
		return;
	}

	// Head to head: the chosen opponent plays and everyone else in the pool becomes an
	// explicit spectator. Cooperative: the WHOLE pool plays and nobody is left over.
	//
	// Either way, in a PUBLIC room the leftovers are dropped rather than written as
	// overwrites, because the single @everyone entry already covers watching and
	// per-member entries would reintroduce the O(members) cost the public case exists
	// to avoid.
	const pool = room.spectatorIds ?? [];
	const cooperative = isCooperativeGame(room.game);
	const playerIds = cooperative ? [room.hostId, ...pool] : [room.hostId, opponentId as string];
	const others = cooperative ? [] : pool.filter((id) => id !== opponentId);
	const spectatorIds = room.visibility === "public" ? [] : others;

	await gameRoomStore.update(room.guildId, room.roomId, { playerIds, spectatorIds });

	const host = guild.members.cache.get(room.hostId) ?? (await guild.members.fetch(room.hostId).catch(() => null));
	const result = await RoomProvisioner.open({
		guild,
		category: category as CategoryChannel,
		game: room.game,
		hostId: room.hostId,
		hostDisplayName: host?.displayName ?? host?.user.username ?? "player",
		playerIds,
		spectatorIds,
		visibility: room.visibility,
		adminRoleId: config?.adminRoleId ?? null,
		// The draft row already exists, so the provisioner must adopt it rather than
		// insert a second one and collide with the unique index.
		existingRoomId: room.roomId,
	});

	if (!result.ok) {
		await interaction.editReply({ embeds: [errorEmbed(describeRoomOpenFailure(result))] });
		return;
	}

	await interaction.editReply({ content: gameRoomsCopy.board.cardStarted(result.channel.id) });
	await refreshCard(
		guild,
		result.room,
		cardStateFor(result.room, { visibility: room.visibility, pool: [], startedChannelId: result.channel.id })
	);
}

// ── rematch ───────────────────────────────────────────────────────────
// Pressed on a FINISHED room's result card. The board path opens a fresh challenge
// card (visibility resets, the host chooses again) with the finished table already in
// the pool; the solo path skips the board and provisions a new solo room directly.
// One rematch per finished room, ever: the card stays clickable for the whole archive
// window, and rematchedFromRoomId is what stops a press per scroll-back.
export async function rematchFromRoom(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	// The result card only exists on a finished room, but its buttons live as long as
	// the message: refuse by STATUS, exactly like the board controls.
	if (room.status !== "finished") {
		await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
		return;
	}

	const already = await gameRoomStore.findByRematchedFrom(room.guildId, room.roomId);
	if (already) {
		await interaction.reply({ content: gameRoomsCopy.errors.rematchAlreadyOffered, flags: MessageFlags.Ephemeral });
		return;
	}

	// ── solo: no challenge board, straight to a new room ──
	// The gate on this path is the private tier quota inside the provisioner; running
	// out of private slots on a solo rematch is an honest refusal, not a silent one.
	if (room.visibility === "solo") {
		if (room.game !== "solo-hangman" && room.game !== "solo-blackjack") {
			await interaction.reply({ content: gameRoomsCopy.errors.notFound, flags: MessageFlags.Ephemeral });
			return;
		}
		const guild = interaction.guild!;
		const member = guild.members.cache.get(interaction.user.id);
		const result = await openSoloRoom(
			guild,
			room.game,
			{
				userId: interaction.user.id,
				displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
			},
			room.roomId
		);
		if (!result.ok) {
			await interaction.reply({ embeds: [errorEmbed(describeSoloOpenFailure(result))], flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.reply({ content: gameRoomsCopy.board.cardStarted(result.channel.id), flags: MessageFlags.Ephemeral });
		// The connecting line in the finished room's transcript (announcement 4e).
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "system",
			text: gameRoomsCopy.trail.rematchOpened(result.channel.id),
		});
		return;
	}

	// ── board games: a fresh challenge card, presser as host ──
	// The OTHER players from the finished room pre-fill the pool, so the invite list
	// already has them; nobody is auto promoted, the host still presses Start.
	const others = room.playerIds.filter((id) => id !== interaction.user.id);
	const draft = await startChallengeDraft(interaction, room.game, {
		spectatorIds: others,
		rematchedFromRoomId: room.roomId,
	});
	if (!draft) return;

	// The connecting line in the finished room's transcript (announcement 4e), posted
	// after the card exists so the link never points at a rematch that failed to open.
	const channel = await resolveChallengesChannel(interaction.guild!);
	if (channel) {
		await roomTrail.postMove(interaction.client, room, {
			actorId: interaction.user.id,
			kind: "system",
			text: gameRoomsCopy.trail.rematchOpened(channel.id),
		});
	}
}

// ── cancel ────────────────────────────────────────────────────────────
export async function cancelDraft(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	// "archived" rather than a delete: the row is the audit trail, and the partial
	// unique index only counts non-terminal statuses, so archiving is what actually
	// frees the host's slot.
	await gameRoomStore.markArchived(room.guildId, room.roomId);
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, room, cardStateFor(room, { visibility: room.visibility, cancelled: true }));
}

export const challengeBoard = {
	startChallengeDraft,
	chooseVisibility,
	openInvitePicker,
	handleInviteSelect,
	joinChallenge,
	startMatch,
	handleOpponentSelect,
	cancelDraft,
	rematchFromRoom,
};
