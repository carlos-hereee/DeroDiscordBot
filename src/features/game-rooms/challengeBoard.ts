import {
	ActionRowBuilder,
	ChannelType,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextChannel,
	type ButtonInteraction,
	type CategoryChannel,
	type EmbedBuilder,
	type Guild,
	type ModalSubmitInteraction,
	type StringSelectMenuInteraction,
} from "discord.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { MAX_SEATS as MONOPOLY_MAX_SEATS } from "@features/games/monopolyBoard.js";
import { MAX_SEATS as BLACKJACK_MAX_SEATS } from "@features/games/blackjackHandler.js";
import { checkGameRoomAccess, gameRoomUpgradeEmbed } from "@features/entitlements/gameRoomAccess.js";
import {
	RoomProvisioner,
	checkRoomAdmission,
	describeRoomOpenFailure,
	resolveRoomSeats,
	seedRoom,
} from "./RoomProvisioner.js";
import {
	describeSoloOpenFailure,
	openSoloRoom,
	readPrivateQuotaStatus,
	soloLuckSlugFor,
	startBlackjackRoomBoard,
	startSoloBlackjackBoard,
} from "./soloRooms.js";
import { resolveRoomChannel } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { rematchedResultEmbed, roomOpenerLogo, roomResultEmbed } from "./gameRoomsEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";
import { buildInviteOptions, refilterInvitees } from "./invitePicker.js";
import {
	openerCardEmbed,
	openerCardRows,
	isCooperativeGame,
	isDeroPlayable,
	type MonopolyDraftSettingAction,
} from "./challengeBoardEmbeds.js";
import type { GameSlug, RoomVisibility } from "./roomTypes.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";
import { cardStateFor, editOpenerCard, refreshCard, resolveChallengesChannel } from "./challengeCard.js";
import { isWithinReach, readChallengeReach } from "./challengeReach.js";
import { isKicked, judgeJoin } from "./joinGate.js";
import { consentPrompt, isGuildBanned, isUserBanned, readNetworkGuild } from "./networkRules.js";
import { hasNetworkConsent } from "./networkConsent.js";
import { scheduleNetworkBoardRefresh } from "./networkBoard.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { SoloLuckPlay } from "@features/games/soloLuck.js";
import { botSeatIdsFor, botsAllowedIn, maxBotSeats, takesBots } from "./botSeat.js";
import { adminLog } from "@features/setup/adminLog.js";
import { RPS_CHOICES, type RpsChoice } from "@features/games/rpsWinner.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// The host controls' words are shared by every pack (2026-10 item 244 Phase 4), so
// the default pack is the right one for every guild.
const hostWords = rokCommanderCopy.arcadeHostControls;
// The network words (2026-10 item 244 Phase 5b), shared by every pack for the same reason.
const networkWords = rokCommanderCopy.arcadeNetwork;

// ── challengeBoard ───────────────────────────────────────────────────
// What:  the challenge flow: start a challenge (its card in ⚔️challenges, or in
//        🏆rated-challenges for a rated game, 2026-10 item 254, Arcade 5), choose who can
//        see it and who may watch, gather the people who want in, then hand the result to
//        RoomProvisioner. Nothing is played on a card: every match, a round against Dero
//        included, plays in a room (Arcade 1).
// Who:   the board's own buttons, and the /mini-game two-player subcommands, which
//        route here rather than keeping a second way to start a match.
// When:  from the first press to the moment the room's channel exists.
// Where: the draft GameRoom row IS the state. Nothing about a challenge lives in
//        memory, which is what makes a challenge survive the Railway deploy that
//        would have killed the old in-memory challengeFlow mid-handshake. The Rematch
//        button lives here too, but never touches the board: a rematch plays on in the
//        finished room's own channel (see its section at the end).
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

/**
 * Re-render a draft's card from its row, for the host controls (hostControls.ts) that
 * change a draft without going through this file's own handlers. Only ever called
 * after the visibility step, which is the only step that offers those controls.
 */
export async function refreshDraftCard(guild: Guild, room: IGameRoom): Promise<void> {
	await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, pool: room.spectatorIds ?? [] }));
}

// ── start a challenge ─────────────────────────────────────────────────
// Reached from the board's per-game buttons AND from /mini-game, so the two cannot
// drift into different rules about who may start what. Returns the draft row when one
// was created, or null when the press was refused (the refusal has already replied).
export async function startChallengeDraft(
	interaction: ButtonInteraction | { guild: Guild | null; guildId: string | null; user: { id: string }; reply: ButtonInteraction["reply"] },
	game: GameSlug
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

	// The game decides the channel, once, here: a rated game's card goes to
	// 🏆rated-challenges and stays there whatever its badge later says.
	const channel = await resolveChallengesChannel(guild, game);
	if (!channel) {
		await interaction.reply({ embeds: [errorEmbed(gameRoomsCopy.errors.noArcadeCategory)], flags: MessageFlags.Ephemeral });
		return null;
	}

	// Whether this card offers Play vs bots (2026-10 item 250 Phase 5): a game a bot can
	// play, in a server that lets hosts add bots. Decided once, here, so the card never
	// offers a door it would refuse; the press reads the switch again.
	const botsOffered = takesBots(game) && botsAllowedIn(await guildConfigStore.findByGuildId(guildId));

	let room: IGameRoom;
	try {
		room = await gameRoomStore.create({
			guildId,
			game,
			hostId: interaction.user.id,
			visibility: "invite",
			botsOffered,
		});
	} catch (error) {
		// Almost certainly the unique index catching a double click that outran the
		// findOpenByHost above. The honest answer is the same as the friendly one.
		console.error("[game-rooms] draft create failed", { guildId, error });
		await interaction.reply({ content: gameRoomsCopy.errors.alreadyHosting(null), flags: MessageFlags.Ephemeral });
		return null;
	}

	// The server's challenge reach decides whether Open to all is offered at all; the
	// choice is still refused server side (chooseVisibility, checkRoomAdmission), since a
	// card posted before an admin narrowed the reach still carries the button.
	const reach = await readChallengeReach(guildId);
	const allowPublic = isWithinReach(reach, "public");
	// The network choice (2026-10 item 244 Phase 5b) is offered only where it could work:
	// a server whose reach is network, for a game a satellite can mirror. chooseVisibility
	// refuses it again on the press, for the same stale card reason as Open to all.
	const allowNetwork = reach === "network" && isNetworkGame(game);
	const state = cardStateFor(room, { visibility: null, pool: room.spectatorIds ?? [], allowPublic, allowNetwork });
	const logo = roomOpenerLogo(game);
	const card = await channel
		.send({
			embeds: [openerCardEmbed(state, undefined, logo?.ref)],
			components: openerCardRows(room.roomId, state),
			files: logo ? [logo.attachment] : [],
		})
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
		content: gameRoomsCopy.board.cardStarted(channel.id).replace("The match is under way in", "Your challenge card is in"),
		flags: MessageFlags.Ephemeral,
	});
	// The card went up as text so the press was answered inside Discord's three
	// second window; its picture follows in a second edit once it has drawn.
	void editOpenerCard(guild, room.roomId, card, state);
	return room;
}

// ── Monopoly's draft settings ─────────────────────────────────────────
// The host decides at open whether a lot a player passes on goes to auction (master
// plan Section 1) and whether Dero referees the match out loud (Session 5c). Both
// live on the draft row, which the provisioner adopts, so each reaches the match
// without a second copy anywhere. One handler for both, keyed by the card action
// that carries it, so the two toggles cannot drift into different rules.
const MONOPOLY_DRAFT_SETTINGS = {
	auctions: "monopolyAuctions",
	referee: "monopolyReferee",
} as const satisfies Record<MonopolyDraftSettingAction, keyof IGameRoom>;

export async function chooseMonopolyDraftSetting(
	interaction: ButtonInteraction,
	room: IGameRoom,
	action: MonopolyDraftSettingAction,
	choice: string
): Promise<void> {
	// The arg is user input like the rest of a customId: anything but the two values
	// a card renders is a retired or forged control.
	if (room.game !== "monopoly" || (choice !== "on" && choice !== "off")) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}
	const patch: Partial<IGameRoom> = {};
	patch[MONOPOLY_DRAFT_SETTINGS[action]] = choice === "on";
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, patch)) ?? room;

	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, updated, cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] }));
}

// ── the visibility chooser ────────────────────────────────────────────
export async function chooseVisibility(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	if (choice === "network") {
		await chooseNetworkTable(interaction, room);
		return;
	}
	const visibility: RoomVisibility = choice === "public" ? "public" : "invite";

	// ⚠️ THE REACH CEILING, REFUSED AT THE CHOICE (2026-10 item 244 Phase 4). The card
	// leaves Open to all off when the server is invite only, but a card posted before the
	// admin changed the setting still has the button, and a hidden button is a suggestion,
	// not a gate. checkRoomAdmission refuses the open again, for every other way in.
	if (!isWithinReach(await readChallengeReach(room.guildId), visibility)) {
		await interaction.reply({ content: hostWords.reach.publicRefused, flags: MessageFlags.Ephemeral });
		return;
	}

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

const isNetworkGame = (game: GameSlug): boolean => (BOT_CONSTANTS.NETWORK_GAMES as readonly string[]).includes(game);

// ── the network choice (2026-10 item 244 Phase 5b) ────────────────────
// Open to all, plus players from other network servers once the table opens: the row
// becomes a public room with network set, which the provisioner adopts like any draft,
// and the network board lists the table once it is playing and taking players.
//
// ⚠️ THE HOST THEMSELVES, AND ONLY WITH THEIR CONSENT. The board names the host in other
// servers, and consent is personal, so the router's admin override (an admin pressing a
// host's button) cannot open somebody else's table to the network; and a host who has
// not accepted the network notice is shown it, then presses the choice again.
async function chooseNetworkTable(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const refusal = interaction.user.id === room.hostId ? await networkChoiceRefusal(interaction, room) : networkWords.hostRefusals.notHost;
	if (refusal) {
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}
	if (!(await hasNetworkConsent(room.hostId))) {
		await interaction.reply(consentPrompt({ kind: "again" }));
		return;
	}

	const updated = (await gameRoomStore.update(room.guildId, room.roomId, { visibility: "public", network: true })) ?? room;
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, updated, cardStateFor(updated, { visibility: "public", pool: updated.spectatorIds ?? [] }));
}

// Why this table cannot be opened to the network, or null: a game no satellite mirrors, a
// server that is not on the network, or a host or server the owner banned from it.
async function networkChoiceRefusal(interaction: ButtonInteraction, room: IGameRoom): Promise<string | null> {
	if (!isNetworkGame(room.game)) return networkWords.hostRefusals.notNetworkGame(gameRoomsCopy.gameLabel(room.game));
	if (!(await readNetworkGuild(interaction.client, room.guildId)).onNetwork) return networkWords.hostRefusals.notOnNetwork;
	const bans = await networkBanStore.findAgainst({ userIds: [room.hostId], guildIds: [room.guildId] });
	if (isUserBanned(bans, room.hostId)) return networkWords.hostRefusals.banned;
	if (isGuildBanned(bans, room.guildId)) return networkWords.hostRefusals.serverBanned;
	return null;
}

// ── the invite picker (F9's structural half) ──────────────────────────
// ⚠️ A StringSelect THE BOT POPULATES, so a bot cannot appear no matter what the
// client sends back; the option list and the server side re-filter both live in
// invitePicker.ts, shared with Dero's hold em rules card.
export async function openInvitePicker(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const guild = interaction.guild!;
	// A member the host removed is never offered again (2026-10 item 244 Phase 4).
	const options = await buildInviteOptions(guild, room.hostId, room.kickedIds ?? []);

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
	// its payload are user input however the menu was built, so the structural
	// guarantee above holds even against a hand-crafted interaction. Members the host
	// removed are filtered out here too, from the row read just above, so a picker
	// opened before a removal cannot invite them back.
	const picked = await refilterInvitees(interaction.guild, interaction.values, room.hostId, room.kickedIds ?? []);

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
	if ((room.pendingJoinIds ?? []).includes(actorId)) {
		await interaction.reply({ content: hostWords.approval.alreadyAsked, flags: MessageFlags.Ephemeral });
		return;
	}
	if ((room.spectatorIds ?? []).length >= BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS) {
		await interaction.reply({
			content: gameRoomsCopy.board.poolFull(BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS),
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// The host's say (2026-10 item 244 Phase 4): a removed member is refused, a rating
	// outside the band is refused, and a host who approves each joiner gets a request.
	const verdict = await judgeJoin(room, actorId, { alreadyApproved: false });
	if (verdict.kind === "refuse") {
		// A network table needs the network notice first (2026-10 item 244 Phase 5b); the
		// member presses Join again once they accept it.
		if (verdict.reason === "noConsent") {
			await interaction.reply(consentPrompt({ kind: "again" }));
			return;
		}
		const refusal = verdict.reason === "kicked" ? hostWords.kick.refusedRejoin : hostWords.band.refused(gameRoomsCopy.gameLabel(room.game));
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}
	if (verdict.kind === "ask") {
		await askHostToJoin(interaction, room);
		return;
	}

	// $addToSet, so two members clicking in the same tick both land and a double click
	// is a no-op rather than a duplicate entry. Null means the host removed this member
	// in the moment since the read above (the store's kickedIds filter).
	const added = await gameRoomStore.addPoolMember(room.guildId, room.roomId, actorId);
	if (!added && isKicked((await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room, actorId)) {
		await interaction.reply({ content: hostWords.kick.refusedRejoin, flags: MessageFlags.Ephemeral });
		return;
	}
	const updated = added ?? room;

	await interaction.deferUpdate();
	await refreshCard(
		interaction.guild!,
		updated,
		cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] })
	);
}

// The host approves each joiner (2026-10 item 244 Phase 4): the member goes on the
// waiting list instead of the pool, answered from the host's Requests panel, and the
// card's waiting count moves. A null from the store means the write did not apply:
// the host removed this member, or the draft ended, a moment after the read.
async function askHostToJoin(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const updated = await gameRoomStore.addPendingJoin(room.guildId, room.roomId, interaction.user.id);
	if (!updated) {
		const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
		const refusal = isKicked(fresh, interaction.user.id) ? hostWords.kick.refusedRejoin : gameRoomsCopy.board.draftGone;
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}
	await interaction.reply({ content: hostWords.approval.asked, flags: MessageFlags.Ephemeral });
	await refreshDraftCard(interaction.guild!, updated);
}

// ── start the match ───────────────────────────────────────────────────
export async function startMatch(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const pool = room.spectatorIds ?? [];
	// A network table may open with nobody else in the pool (2026-10 item 244 Phase 5b):
	// its players come from the network board and the room's own Buy in once it opens,
	// and a Hold'em table is built to open with no seat taken.
	// Dero bots fill seats too (2026-10 item 250 Phase 5), so a host may start against
	// bots alone.
	const bots = room.botSeats ?? 0;
	if (pool.length === 0 && !room.network && bots === 0) {
		await interaction.reply({ content: gameRoomsCopy.board.poolEmpty, flags: MessageFlags.Ephemeral });
		return;
	}

	// Monopoly seats the host plus the whole pool, and its board has six seats while
	// the pool can grow to GAME_ROOM_MAX_SPECTATORS. Refused HERE, before any channel
	// exists, because the engine throws on a seventh seat and the provisioner only
	// builds the match after the channel is already up, which would strand a room
	// with no board in it.
	if (room.game === "monopoly" && pool.length + 1 + bots > MONOPOLY_MAX_SEATS) {
		const refusal =
			bots > 0
				? gameRoomsCopy.monopoly.tooManyWithBots(MONOPOLY_MAX_SEATS, pool.length, bots)
				: gameRoomsCopy.monopoly.tooManyPlayers(MONOPOLY_MAX_SEATS, pool.length);
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}

	// A Blackjack table has five seats (2026-10 item 254, Arcade 1), the host's among them,
	// refused here for the same reason as Monopoly's six: before any channel exists.
	if (room.game === "blackjack" && pool.length + 1 > BLACKJACK_MAX_SEATS) {
		await interaction.reply({ content: gameRoomsCopy.board.blackjackTooManyPlayers(BLACKJACK_MAX_SEATS, pool.length), flags: MessageFlags.Ephemeral });
		return;
	}

	// A battleship challenge with a Dero bot plays the bot: nobody in the pool is singled
	// out, and the pool watches (2026-10 item 250 Phase 5).
	if (room.game === "battleship" && bots > 0) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		await provisionFromDraft(interaction, room, null);
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

	// A member the host removed after this picker opened is out of the pool by now, so
	// the pool check refuses them; isKicked says so outright rather than leaning on it.
	const chosen = interaction.values[0];
	if (!chosen || !(room.spectatorIds ?? []).includes(chosen) || isKicked(room, chosen)) {
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

	// Head to head: the chosen opponent plays and everyone else in the pool is left over.
	// Cooperative: the WHOLE pool plays and nobody is left over.
	//
	// The leftovers watch only under the host's Invite only spectator setting (2026-10
	// item 254, Arcade 11), written as explicit spectators. Open to spectators drops them,
	// because the single @everyone entry already covers watching and per-member entries
	// would reintroduce the O(members) cost it exists to avoid; No spectators drops them
	// because nobody but the players sees the room.
	const pool = room.spectatorIds ?? [];
	const cooperative = isCooperativeGame(room.game);
	// A head to head match against a Dero bot (battleship) seats the host alone; the bot is
	// the opponent, in the match's own state, never in playerIds (botSeat.ts).
	const humanOpponents = opponentId ? [opponentId] : [];
	const playerIds = cooperative ? [room.hostId, ...pool] : [room.hostId, ...humanOpponents];
	const others = cooperative ? [] : pool.filter((id) => id !== opponentId);
	const spectatorIds = effectiveSpectatorMode(room.visibility, room.spectatorMode) === "invite" ? others : [];
	const botIds = botSeatIdsFor(room.game, playerIds.length, room.botSeats ?? 0);

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
		spectatorMode: room.spectatorMode ?? null,
		adminRoleId: config?.adminRoleId ?? null,
		// The draft row already exists, so the provisioner must adopt it rather than
		// insert a second one and collide with the unique index.
		existingRoomId: room.roomId,
		monopolyAuctions: room.monopolyAuctions ?? false,
		botIds,
	});

	if (!result.ok) {
		await interaction.editReply({ embeds: [errorEmbed(describeRoomOpenFailure(result))] });
		return;
	}

	// A Blackjack table is dealt once its room is up (2026-10 item 254, Arcade 1), every
	// gathered player seated; a table that cannot start has already closed its room.
	if (room.game === "blackjack" && !(await startBlackjackRoomBoard(guild, result.room, result.channel))) {
		await interaction.editReply({ embeds: [errorEmbed(gameRoomsCopy.errors.createFailed)] });
		return;
	}

	await interaction.editReply({ content: gameRoomsCopy.board.cardStarted(result.channel.id) });
	// A network table is now playing and taking players, which is what the board lists.
	if (room.network) scheduleNetworkBoardRefresh();
	await refreshCard(
		guild,
		result.room,
		cardStateFor(result.room, { visibility: room.visibility, pool: [], startedChannelId: result.channel.id })
	);
}

// ── rematch: the next match in the same channel ──────────────────────
// What:  pressed on a FINISHED room's result card, it starts the next match of the same
//        game IN THE SAME CHANNEL. A new GameRoom row takes the channel over; the
//        finished row keeps its transcript and lets the channel go.
// Who:   any player of the finished room (GAME_ROOM_ACTIONS.rematch is playersOnly). The
//        presser hosts the rematch, and every player of the finished match is seated
//        again with the same visibility and spectators. Solo rooms included.
// When:  at most once per finished room. findByRematchedFrom answers a scrolled back
//        press; the release in takeOverChannel is the atomic claim when two players
//        press in the same moment.
// Where: ⚠️ THE ORDER OF THE TWO ROW WRITES IS THE SAFETY PROPERTY. The new row is
//        created ALREADY POINTING AT THE CHANNEL, and only then does the finished row let
//        it go. A crash between the two leaves two rows on one channel, which the
//        finished row's archive clock and the idle sweep both clean up. The reverse order
//        would leave a moment where NO row points at the channel, and a crash there
//        strands a locked channel nothing will ever delete.
// How:   ① refuse, writing nothing, on status, an earlier rematch, a vanished channel or
//        the presser's admission (their one room, the guild cap, the private ceiling);
//        ② take the channel over; ③ say on the result card who started it; ④ unlock the
//        channel for the new players; ⑤ seed the match through the provisioner's own
//        seeding, exactly as a first match is seeded.
export async function rematchFromRoom(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const check = await checkRematch(interaction, room);
	if (!check.ok) {
		await interaction.reply({ ...check.reply, flags: MessageFlags.Ephemeral });
		return;
	}

	// Everything below writes rows and talks to Discord several times over, which can
	// run past the three second interaction window. Deferring the UPDATE (rather than a
	// reply) is what lets ③ edit the result card the button lives on.
	await interaction.deferUpdate();
	try {
		const failure = await playRematchInPlace(interaction, room, check.channel);
		if (failure) await interaction.followUp({ content: failure, flags: MessageFlags.Ephemeral });
	} catch (error) {
		// A Mongo or Discord failure mid way. Whatever was written is safe to leave (see
		// Where above): a new row that never reached "playing" is a draft the idle sweep
		// closes, and its channel is archived through it.
		console.error("[game-rooms] rematch failed", { guildId: room.guildId, roomId: room.roomId, error });
		await interaction.followUp({ content: gameRoomsCopy.errors.createFailed, flags: MessageFlags.Ephemeral }).catch(() => undefined);
	}
}

type RematchCheck =
	| { ok: true; channel: TextChannel }
	| { ok: false; reply: { content: string } | { embeds: EmbedBuilder[] } };

// ① Every reason to refuse a rematch, checked before anything is written. On success it
// hands back the channel the rematch will play in.
async function checkRematch(interaction: ButtonInteraction, room: IGameRoom): Promise<RematchCheck> {
	// The result card only exists on a finished room, but its buttons live as long as
	// the message: refuse by STATUS, exactly like the board controls.
	if (room.status !== "finished") return { ok: false, reply: { content: gameRoomsCopy.errors.notFound } };

	// Solo visibility rematches for the two solo games only. A solo luck round against Dero
	// (2026-10 item 254, Arcade 1) has no rematch, its result card offers none, since its
	// round is played as its room opens; any other game with solo visibility is a row no
	// current path writes, and seeding it would open the wrong thing.
	if (room.visibility === "solo" && room.game !== "solo-hangman" && room.game !== "solo-blackjack") {
		return { ok: false, reply: { content: gameRoomsCopy.errors.notFound } };
	}

	// ⚠️ NO REMATCH AT A TABLE THAT SEATED OTHER SERVERS (2026-10 item 244 Phase 5a). A
	// rematch plays on in the host's channel, which those players cannot see, and taking
	// the channel over clears this row's archive clock, so its satellites in other servers
	// would never be swept. Refused before anything is written; they archive with this room.
	if ((room.satellites ?? []).length > 0) {
		return { ok: false, reply: { content: rokCommanderCopy.arcadeSatellites.rematchRefused } };
	}

	if (await gameRoomStore.findByRematchedFrom(room.guildId, room.roomId)) {
		return { ok: false, reply: { content: gameRoomsCopy.errors.rematchAlreadyOffered } };
	}

	// The channel is what a rematch plays in, so a room whose channel is gone (archived,
	// or deleted by an admin a moment ago) has nothing to rematch in.
	const channel = await resolveRoomChannel(interaction.client, room.channelId);
	if (!channel) return { ok: false, reply: { content: gameRoomsCopy.errors.notFound } };

	const admission = await checkRoomAdmission({ guild: interaction.guild!, hostId: interaction.user.id, visibility: room.visibility });
	if (admission) return { ok: false, reply: { embeds: [errorEmbed(describeRoomOpenFailure(admission))] } };

	return { ok: true, channel };
}

// ② to ⑤. Returns the sentence to tell the presser when the rematch could not start,
// or null once the new match is playable.
async function playRematchInPlace(interaction: ButtonInteraction, finished: IGameRoom, channel: TextChannel): Promise<string | null> {
	const guild = interaction.guild!;
	const hostId = interaction.user.id;

	const takeover = await takeOverChannel(finished, hostId, channel.id);
	if (!takeover.ok) {
		return takeover.reason === "alreadyHosting" ? gameRoomsCopy.errors.alreadyHosting(null) : gameRoomsCopy.errors.rematchAlreadyOffered;
	}
	const next = takeover.room;

	// ③ The finished room's result card now says who started the rematch, in place of
	// the archive notice that is no longer true, and drops its buttons: the finished
	// row owns no channel to archive and has spent its one rematch. Cosmetic, so a
	// failed edit is logged and the rematch carries on.
	await interaction
		.editReply({ embeds: [rematchedResultEmbed(interaction.message.embeds[0] ?? roomResultEmbed(finished.winnerId), hostId)], components: [] })
		.catch((error) => console.warn("[game-rooms] failed to mark the result card rematched", { roomId: finished.roomId, error }));

	// ④ The finished room left an @everyone SendMessages deny behind; the new match gets
	// the playing matrix for its own players. The finished opener is unpinned so the
	// pinned card in the channel is always the live match's.
	await roomLifecycle.applyRoomPhase(interaction.client, channel, next, "playing");
	if (finished.openerMessageId) await channel.messages.unpin(finished.openerMessageId).catch(() => undefined);

	// ⑤ Seeded exactly as RoomProvisioner seeds a first match of this game. A rematch
	// opens a standard hold em table, the same as a board challenge does: a table's
	// custom terms come only from Dero's rules card.
	const started = await seedRoom({
		guild,
		channel,
		room: next,
		game: next.game,
		hostId,
		playerIds: next.playerIds,
		visibility: next.visibility,
		spectatorMode: next.spectatorMode ?? null,
		monopolyAuctions: next.monopolyAuctions,
		botIds: botSeatIdsFor(next.game, next.playerIds.length, next.botSeats ?? 0),
	});

	if (next.game === "solo-blackjack") {
		const member = guild.members.cache.get(hostId);
		const displayName = member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
		if (!(await startSoloBlackjackBoard(guild, started, channel, { userId: hostId, displayName }))) {
			return gameRoomsCopy.errors.createFailed;
		}
	}
	// A multi seat table deals its rematch the way its first match was dealt.
	if (next.game === "blackjack" && !(await startBlackjackRoomBoard(guild, started, channel))) {
		return gameRoomsCopy.errors.createFailed;
	}
	return null;
}

type ChannelTakeover = { ok: true; room: IGameRoom } | { ok: false; reason: "alreadyHosting" | "rematchTaken" };

// ② The two row writes, in the order the header above explains: the new row is born on
// the channel, then the finished row releases it. The new row is a "draft" until
// seedRoom moves it to "playing", like every room before its match is seeded.
async function takeOverChannel(finished: IGameRoom, hostId: string, channelId: string): Promise<ChannelTakeover> {
	const { playerIds, spectatorIds } = resolveRoomSeats(finished.visibility, hostId, finished.playerIds, finished.spectatorIds);

	let next: IGameRoom;
	try {
		next = await gameRoomStore.create({
			guildId: finished.guildId,
			game: finished.game,
			hostId,
			visibility: finished.visibility,
			playerIds,
			spectatorIds,
			channelId,
			rematchedFromRoomId: finished.roomId,
			// The same match settings as the game it rematches. Nothing else carries
			// them: Monopoly's referee in particular is read off the ROW on every move.
			monopolyAuctions: finished.monopolyAuctions ?? false,
			monopolyReferee: finished.monopolyReferee ?? false,
			// And the host controls (2026-10 item 244 Phase 4), above all who was removed:
			// the rematch plays in the SAME channel, so a member removed from it stays
			// removed, and a public Hold'em rematch's Buy in refuses them like the first.
			ratingBand: finished.ratingBand ?? "any",
			requireApproval: finished.requireApproval ?? false,
			kickedIds: finished.kickedIds ?? [],
			// The same Dero bots sit down again (2026-10 item 250 Phase 5).
			botSeats: finished.botSeats ?? 0,
			// And the same people watch (2026-10 item 254, Arcade 11): the rematch's unlock
			// and its invite follow the setting the host chose for the first match.
			spectatorMode: finished.spectatorMode ?? null,
		});
	} catch (error) {
		// Almost certainly the partial unique index catching a room the presser opened
		// after findRematchRefusal looked. Nothing was written, so nothing to undo.
		console.error("[game-rooms] rematch row create failed", { guildId: finished.guildId, hostId, error });
		return { ok: false, reason: "alreadyHosting" };
	}

	if (!(await roomLifecycle.releaseChannel(finished))) {
		// The claim was lost: another player's rematch took the channel first, or the
		// sweep archived the room a moment ago. This row must not stay on the channel, so
		// it is archived, which frees the presser's host slot and clears its channelId.
		await gameRoomStore.markArchived(next.guildId, next.roomId);
		return { ok: false, reason: "rematchTaken" };
	}
	return { ok: true, room: next };
}

// ── Play Dero instead (post-launch plan item 13) ──────────────────────
// What:  the host of a coin flip, dice roll or rps challenge plays one round against
//        Dero instead of waiting on a member. The draft closes and the round plays in a
//        solo room of the host's own (soloRooms, 2026-10 item 254, Arcade 1), so nothing
//        is played in ⚔️challenges; the host is told privately where it is.
// Who:   the card's `dero` button (strict host only: HOST_STRICT_ACTIONS), and for rps
//        the throw modal it opens, whose submit re-checks the host and the draft
//        because a modal is reachable without the button.
// Where: soloLuck is the ONE solo round, shared with /mini-game against Dero and the
//        🕹️games row, so the odds and the pay cannot drift between the three doors.
// How:   ① refuse anything but a luck draft; ② archive the draft, which frees the
//        host's one room slot exactly like Call it off, so the solo room may take it;
//        ③ open the solo room, which plays the round; ④ close the card with the line that
//        points at the room.
const DERO_THROW_FIELD = "throw";

export async function playDero(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if (!isDeroPlayable(room.game)) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}
	// rps needs the host's throw first: a modal with the three throws, so the press
	// answers with the question rather than a message to dismiss.
	if (room.game === "rps") {
		await interaction.showModal(deroThrowModal(room.roomId));
		return;
	}
	await playDeroRound(interaction, room, { game: room.game === "coinflip" ? "coinflip" : "diceroll" });
}

function deroThrowModal(roomId: string): ModalBuilder {
	const words = gameRoomsCopy;
	return new ModalBuilder()
		.setCustomId(`${GAME_ROOM_MODAL_PREFIX}:dero:${roomId}`)
		.setTitle(words.board.deroThrowModalTitle)
		.addLabelComponents(
			new LabelBuilder().setLabel(words.board.deroThrowLabel).setStringSelectMenuComponent(
				new StringSelectMenuBuilder()
					.setCustomId(DERO_THROW_FIELD)
					.setMinValues(1)
					.setMaxValues(1)
					.addOptions(RPS_CHOICES.map((choice) => ({ label: words.games.rpsLabel(choice), value: choice })))
			)
		);
}

/** The rps throw modal's submit: the same gates as the button, then the round. */
export async function handleDeroThrowModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, , roomId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "draft" || room.game !== "rps") {
		await interaction.reply({ content: gameRoomsCopy.board.draftGone, flags: MessageFlags.Ephemeral });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.board.onlyHostStarts, flags: MessageFlags.Ephemeral });
		return;
	}
	// The value is user input whoever built the menu, so it is checked against the throws.
	const memberThrow = interaction.fields.getStringSelectValues(DERO_THROW_FIELD)[0] as RpsChoice | undefined;
	if (!memberThrow || !RPS_CHOICES.includes(memberThrow)) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}
	await playDeroRound(interaction, room, { game: "rps", memberThrow });
}

async function playDeroRound(interaction: ButtonInteraction | ModalSubmitInteraction, room: IGameRoom, play: SoloLuckPlay): Promise<void> {
	const guild = interaction.guild;
	if (!guild) return;
	// Deferred first: opening a room is a channel create plus its opener, which can run
	// past Discord's three second window.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	await gameRoomStore.markArchived(room.guildId, room.roomId);

	const member = guild.members.cache.get(interaction.user.id);
	const opened = await openSoloRoom(
		guild,
		soloLuckSlugFor(play),
		{ userId: interaction.user.id, displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username, user: interaction.user },
		{ luckPlay: play }
	);
	if (!opened.ok) {
		await interaction.editReply({ embeds: [errorEmbed(describeSoloOpenFailure(opened))] });
		await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, resultLine: gameRoomsCopy.board.cardDeroUnavailable(room.hostId) }));
		return;
	}
	await interaction.editReply({ content: gameRoomsCopy.board.cardStarted(opened.channel.id) });
	await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, resultLine: gameRoomsCopy.board.cardPlayedDero(room.hostId, opened.channel.id) }));
}

// ── Play vs bots (2026-10 item 250 Phase 5) ───────────────────────────
// What:  the host chooses how many Dero bots sit down when the match starts: a private
//        select of 0 to the game's most (botSeat.maxBotSeats), answered on the draft row.
// Who:   the host alone (HOST_STRICT_ACTIONS), on the button and again on the select,
//        since a select's customId is reachable without the button.
// Where: ⚠️ THE ONLY DOOR A BOT COMES THROUGH. The invite picker and the Join button stay
//        closed to bots, structurally, so a bot never sits down unless a member chose it.
//        Every change is one bot.slot line in 🗒️admin-log.
const BOT_COUNT_FIELD = "bots";

// Why bots cannot join this draft, or null when they can: a game no bot plays, a network
// table, or a server whose admin switched bots off since the card opened.
async function botRefusal(room: IGameRoom): Promise<string | null> {
	if (!takesBots(room.game) || room.network) return gameRoomsCopy.board.botsNotHere;
	const config = await guildConfigStore.findByGuildId(room.guildId);
	return botsAllowedIn(config) ? null : gameRoomsCopy.board.botsOff;
}

export async function openBotPicker(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const refusal = await botRefusal(room);
	if (refusal) {
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}
	const current = room.botSeats ?? 0;
	const counts = Array.from({ length: maxBotSeats(room.game) + 1 }, (_, count) => count);
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:${BOT_COUNT_FIELD}:${room.roomId}`)
		.setPlaceholder(gameRoomsCopy.board.botPickerPlaceholder)
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(
			counts.map((count) => ({
				label: count === 0 ? gameRoomsCopy.board.botOptionNone : gameRoomsCopy.board.botOptionCount(count),
				value: String(count),
				default: count === current,
			}))
		);
	await interaction.reply({
		content: gameRoomsCopy.board.botPickerPrompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
		flags: MessageFlags.Ephemeral,
	});
}

/** The bot count select's submission: the host's, on a draft, a count the game takes. */
export async function handleBotSelect(interaction: StringSelectMenuInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (prefix !== GAME_ROOM_SELECT_PREFIX || action !== BOT_COUNT_FIELD || !roomId) return;
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "draft") {
		await interaction.reply({ content: gameRoomsCopy.board.draftGone, flags: MessageFlags.Ephemeral });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await interaction.reply({ content: gameRoomsCopy.board.onlyHostStarts, flags: MessageFlags.Ephemeral });
		return;
	}
	const refusal = await botRefusal(room);
	if (refusal) {
		await interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
		return;
	}
	// The value is user input whoever built the menu, so it is checked against the counts.
	const count = Number.parseInt(interaction.values[0] ?? "", 10);
	if (!Number.isInteger(count) || count < 0 || count > maxBotSeats(room.game)) {
		await interaction.reply({ content: gameRoomsCopy.errors.controlRetired, flags: MessageFlags.Ephemeral });
		return;
	}

	const updated = (await gameRoomStore.update(guildId, roomId, { botSeats: count })) ?? room;
	await interaction.reply({ content: gameRoomsCopy.board.botsSaved(count), flags: MessageFlags.Ephemeral });
	if ((room.botSeats ?? 0) !== count) {
		adminLog.emitFor(interaction, guildId, "bot.slot", {
			subject: gameRoomsCopy.gameLabel(room.game),
			detail: gameRoomsCopy.board.botOptionCount(count),
			game: room.game,
			matchId: room.roomId,
			botCount: count,
			actor: interaction.user.id,
		});
	}
	await refreshCard(interaction.guild, updated, cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] }));
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
	chooseMonopolyDraftSetting,
	playDero,
	handleDeroThrowModal,
	openBotPicker,
	handleBotSelect,
};
