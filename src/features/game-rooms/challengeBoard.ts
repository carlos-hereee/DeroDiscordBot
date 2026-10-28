import {
	ActionRowBuilder,
	ChannelType,
	MessageFlags,
	StringSelectMenuBuilder,
	TextChannel,
	type ButtonInteraction,
	type CategoryChannel,
	type EmbedBuilder,
	type Client,
	type Guild,
	type Message,
	type RepliableInteraction,
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
	type SoloOpenResult,
	startBlackjackRoomBoard,
	startSoloBlackjackBoard,
} from "./soloRooms.js";
import { resolveRoomChannel } from "./roomTrail.js";
import { roomLifecycle } from "./roomLifecycle.js";
import { rematchedResultEmbed, roomOpenerLogo, roomResultEmbed } from "./gameRoomsEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { GAME_ROOM_SELECT_PREFIX, confirmCustomId } from "./gameRoomActions.js";
import { isPickerPrefix, pickedValues, showPicker } from "./pickerModal.js";
import { buildInviteOptions, refilterInvitees } from "./invitePicker.js";
import {
	openerCardEmbed,
	openerCardRows,
	isCooperativeGame,
	isDeroPlayable,
	type DraftSettingAction,
} from "./challengeBoardEmbeds.js";
import { isSoloRematchGame, offersReferee, refereeOn, type GameSlug, type RoomVisibility } from "./roomTypes.js";
import { effectiveSpectatorMode } from "./roomPermissions.js";
import { cardStateFor, challengeCardLink, editOpenerCard, readChallengeChannelIds, refreshCard, resolveChallengesChannel, type ChallengeChannelIds } from "./challengeCard.js";
import { asChallengeReach, isWithinReach, readChallengeReach } from "./challengeReach.js";
import { isKicked, judgeJoin } from "./joinGate.js";
import { buyInModal, chargeJoiner, draftBuyInOf, isChipDraft, isValidDraftBuyIn, refundAllJoiners, refundJoiners, refundOpenedSeats, settleDraftBuyIns, submittedBuyIn } from "./holdemDraftBuyIn.js";
import {
	bandOfMatch,
	buildSettingsModal,
	defaultSettings,
	isSettingsGame,
	joinOfRoom,
	matchOfRoom,
	readSettingsAnswers,
	settingFieldsFor,
	settingsModalFields,
	settingsOfRoom,
	type ChallengeSettings,
	type JoinChoice,
	type SettingField,
	type SettingsContext,
	type SettingsGame,
	type SettingsMode,
} from "./challengeSettings.js";
import { applyApproval, applyRatingBand, applySpectatorMode } from "./hostControls.js";
import { parseChipAmount } from "@features/economy/chipWallet.js";
import { isRatedGame } from "@features/ratings/ratingEngine.js";
import type { SoloLuckGame } from "@features/games/soloLuck.js";
import { consentPrompt, isGuildBanned, isUserBanned, readNetworkGuild } from "./networkRules.js";
import { hasNetworkConsent } from "./networkConsent.js";
import { scheduleNetworkBoardRefresh } from "./networkBoard.js";
import { networkBanStore } from "@db/stores/networkBanStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { botSeatIdsFor, botsAllowedIn, casualBotSeats, maxBotSeats, takesBots } from "./botSeat.js";
import { adminLog } from "@features/setup/adminLog.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { answerInChannel, beginChannelAnswer, type PendingChannelAnswer } from "@utils/answerInChannel.js";
import {
	acknowledgeConfirm,
	acknowledgeTextModal,
	confirmFallback,
	showConfirm,
	showEmbedNotice,
	showModalOrReply,
	showNotice,
	type ConfirmInteraction,
	type ModalOpeningInteraction,
} from "@utils/textModal.js";

// The host controls' words are shared by every pack (2026-10 item 244 Phase 4), so
// the default pack is the right one for every guild.
const hostWords = rokCommanderCopy.arcadeHostControls;
// The network words (2026-10 item 244 Phase 5b), shared by every pack for the same reason.
const networkWords = rokCommanderCopy.arcadeNetwork;

// ── challengeBoard ───────────────────────────────────────────────────
// What:  the challenge flow: start a challenge from its creation modal, whose choices land
//        on the draft through the card's own choice functions (2026-10 item 263 Phase 2a),
//        post its card already configured (in ⚔️challenges, or in 🏆rated-challenges for a
//        rated game's rated match), gather the people who want in, then hand the result to
//        RoomProvisioner. Nothing is played on a card: every match, a round against Dero
//        included, plays in a room (Arcade 1).
// Who:   the board's own buttons, the 🎉party-games and 🕹️games table starts, and the
//        /mini-game subcommands that post a card, which route here rather than keeping a
//        second way to start a match.
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

// ── a card choice, applied ────────────────────────────────────────────
/**
 * What one of the card's choice functions did to a draft: the row it wrote, or why it
 * refused (the caller says it: a notice for a press, a note on the card for the creation
 * modal). `needsConsent` marks the network refusal that the network notice answers.
 */
export type DraftChoice = { ok: true; room: IGameRoom } | { ok: false; refusal: string; needsConsent?: boolean };

/** Who makes a draft choice: a card's button, or the creation modal's or Edit settings' Submit (or its fallback button). */
type HostPress = ButtonInteraction | ModalSubmitInteraction;

// ── start a challenge (2026-10 item 263 Phase 2a, R3-13) ──────────────
// Every start (the board's per game buttons, the 🎉party-games Host table buttons, the
// 🕹️games Blackjack table, and the slash commands that post a card) opens ONE creation
// modal with that game's settings (challengeSettings.ts) as its first answer, and the card
// posts on its Submit already configured, at its gather step. The modal replaced the start
// confirm of 2026-10 item 257 and the card's own first step.

// The press's context from the one GuildConfig read it makes: the reach and the bot switch
// decide the modal's options, and whether 🏆rated-challenges exists decides its title.
function settingsContextOf(game: SettingsGame, config: unknown): SettingsContext {
	const stored = (config ?? {}) as { challengeReach?: unknown; botOpponentsEnabled?: boolean | null; arcadeRatedChallengesChannelId?: string | null };
	return {
		game,
		reach: asChallengeReach(stored.challengeReach),
		botsAllowed: botsAllowedIn(stored),
		hasRatedChannel: Boolean(stored.arcadeRatedChallengesChannelId),
	};
}

/**
 * A per game start: the creation modal, posted nowhere until its Submit (confirmChallengeDraft).
 * A host whose slot holds a draft gets the same modal with a line saying Submit closes that
 * draft first, its card linked (R3-9: one Submit frees the slot and posts the new card); a host
 * whose match is in play is told where it is, and nothing opens. Writes nothing.
 *
 * ⚠️ THE THREE SECOND WINDOW (risk R4). A modal must be the first answer inside Discord's three
 * seconds, so the press makes only the two reads the modal needs, IN PARALLEL: the host's open
 * room and the GuildConfig row, which answers the reach, the bot switch and the rated channel at
 * once. Nothing renders and nothing else is fetched before showModal.
 */
export async function offerChallengeDraft(interaction: ModalOpeningInteraction, game: GameSlug): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.outsideGuild] });
		return;
	}
	if (!isSettingsGame(game)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const [existing, config] = await Promise.all([gameRoomStore.findOpenByHost(guildId, interaction.user.id), guildConfigStore.findByGuildId(guildId)]);
	if (existing && existing.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.confirms.matchInPlay(existing.channelId ?? null)] });
		return;
	}
	const context = settingsContextOf(game, config);
	const notice = existing ? gameRoomsCopy.confirms.replaceDraft(challengeCardLink(channelIdsOf(config), existing)) : null;
	// The Submit carries the held draft's roomId, so it closes that draft and no other.
	const confirmId = confirmCustomId("newok", game, existing?.roomId);
	const { modal } = buildSettingsModal(context, { customId: confirmId, mode: { kind: "create" }, values: defaultSettings(context), notice });
	// When Discord refuses the modal, the start falls back to the confirm button it always had,
	// which posts the card at the default settings for Edit settings to change.
	await showModalOrReply(interaction, modal, () =>
		confirmFallback({ title: gameRoomsCopy.notices.challenge, sections: [notice ?? gameRoomsCopy.confirms.newChallenge(game)], confirmId })
	);
}

const channelIdsOf = (config: unknown): ChallengeChannelIds => (config ?? {}) as ChallengeChannelIds;

/**
 * The one room per host refusal with its fix, for a start that opens a room rather than a card
 * (arcadeHost's solo starts, 2026-10 item 263 R3-9): at the press, a held draft is offered to
 * close through a confirm whose Submit (`confirmId`) closes it and then opens the room, and a
 * held running room is never touched: the notice names it, linked, to finish or archive there.
 * Answers true when the slot was held (the press is answered), false when it is free. Makes the
 * same two parallel reads as a challenge start, inside Discord's three seconds.
 */
export async function offerToFreeSlot(interaction: ModalOpeningInteraction, confirmIdFor: (roomId: string) => string): Promise<boolean> {
	const guildId = interaction.guildId;
	if (!guildId) return false;
	const [existing, config] = await Promise.all([gameRoomStore.findOpenByHost(guildId, interaction.user.id), guildConfigStore.findByGuildId(guildId)]);
	if (!existing) return false;
	if (existing.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.confirms.matchInPlay(existing.channelId ?? null)] });
		return true;
	}
	await showConfirm(interaction, {
		title: gameRoomsCopy.notices.challenge,
		sections: [gameRoomsCopy.confirms.replaceDraft(challengeCardLink(channelIdsOf(config), existing))],
		confirmId: confirmIdFor(existing.roomId),
	});
	return true;
}

/**
 * Close the draft a replace confirm named, while it is still a draft of this host's, so a
 * confirm left open while that draft started never touches the live match. The same close
 * Call it off makes (closeDraft). Answers whether it closed.
 */
export async function closeHeldDraft(guild: Guild, roomId: string, hostId: string): Promise<boolean> {
	const open = await gameRoomStore.findByRoomId(guild.id, roomId);
	if (!open || open.status !== "draft" || open.hostId !== hostId) return false;
	await closeDraft(guild, open);
	return true;
}

/**
 * The creation modal's Submit (or the fallback's confirm button, which carries no fields and
 * so posts the defaults): close the held draft it named, then either play Dero (a luck game's
 * Who you play: Dero, through the card's own Play Dero path, posting no card) or post the card
 * with every choice applied. Acknowledged quietly before the slow work and followed by no
 * private line (R3-6): the card in its channel is the answer.
 */
export async function confirmChallengeDraft(interaction: ConfirmInteraction, game: GameSlug, replaceRoomId: string | null): Promise<void> {
	const guild = interaction.guild;
	if (!guild) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.outsideGuild] });
		return;
	}
	if (!isSettingsGame(game)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const context = settingsContextOf(game, await guildConfigStore.findByGuildId(guild.id));
	// The fields the press showed: the held draft's line took a slot when there was one.
	const fields = settingsModalFields(game, CREATE_MODE, replaceRoomId !== null);
	const wanted = interaction.isModalSubmit() ? readSettingsAnswers(interaction, context, fields, defaultSettings(context)) : defaultSettings(context);

	if (replaceRoomId) await closeHeldDraft(guild, replaceRoomId, interaction.user.id);

	if (wanted.opponent === "dero" && isDeroPlayable(game)) {
		await playDeroRound(interaction, guild, game);
		return;
	}

	await acknowledgeConfirm(interaction);
	const opened = await openChallengeDraft(guild, interaction.user.id, game, {
		wantsCasual: wanted.match === "casual" || wanted.match === "casual-bots",
		configure: (room) => applySettings(interaction, room, wanted, fields, CREATE_MODE),
	});
	// Every refusal here is a race: the press already found the slot free and the game valid,
	// so what is left (a slot taken since, a missing arcade, the paid plan, a failed post) is
	// read only now, after the acknowledgement, and answers privately.
	if (!opened.ok) await showRefusalNotice(interaction, draftRefusalReply(opened));
}

const CREATE_MODE: SettingsMode = { kind: "create" };

/** Why a challenge card could not be posted, for the press or the scheduled open to explain. */
export type DraftOpenFailure =
	| { ok: false; reason: "noAccess"; upgradeUrl?: string }
	| { ok: false; reason: "alreadyHosting"; channelId: string | null }
	| { ok: false; reason: "noChannel" }
	| { ok: false; reason: "failed" };

export type DraftOpenResult = { ok: true; room: IGameRoom; channel: TextChannel; card: Message } | DraftOpenFailure;

// A refusal is a line of text or one text only embed, and either answers as a notice;
// showEmbedNotice keeps the upgrade embed a private reply should it ever carry fields.
async function showRefusalNotice(interaction: RepliableInteraction, refusal: { content: string } | { embeds: EmbedBuilder[] }): Promise<void> {
	if ("content" in refusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal.content] });
		return;
	}
	const [embed] = refusal.embeds;
	if (embed) await showEmbedNotice(interaction, embed);
}

// The private answer to a press the opener refused, the same words the press always had.
function draftRefusalReply(failure: DraftOpenFailure): { content: string } | { embeds: EmbedBuilder[] } {
	if (failure.reason === "noAccess") return { embeds: [gameRoomUpgradeEmbed(failure.upgradeUrl)] };
	if (failure.reason === "alreadyHosting") return { content: gameRoomsCopy.errors.alreadyHosting(failure.channelId) };
	// A missing arcade category is a state an admin can fix, not a failure, so it opens under
	// the challenge title rather than the error embed's (2026-10 item 263 R3-12).
	if (failure.reason === "noChannel") return { content: gameRoomsCopy.errors.noArcadeCategory };
	return { embeds: [errorEmbed(gameRoomsCopy.errors.createFailed)] };
}

/** How a new draft is set up before its card posts: the creation modal's choices, or Open to all for a scheduled party game. */
export interface DraftOpenOptions {
	// Starts the card Open to all where the server's reach allows it (a scheduled party game,
	// whose host may not be at the keyboard when its time comes), Invite only where it does not.
	openToAll?: boolean;
	// Whether the host asked for a casual match, which decides the channel checked before the
	// row exists; the channel the card posts in follows what the match became.
	wantsCasual?: boolean;
	// Applies the creation modal's choices to the new row before its card exists, answering the
	// row the card is drawn from (applySettings).
	configure?: (room: IGameRoom) => Promise<IGameRoom>;
}

/**
 * Post one challenge card for `hostId` and create its draft row: the one opener behind a
 * member's creation modal (confirmChallengeDraft) and a scheduled party game Dero opens by
 * itself at its time (partyGamesOpen, 2026-10 item 254, Arcade 4), so the two cannot drift into
 * different rules about who may host what. It answers nobody; the caller says why.
 *
 * The card posts at its gather step, already configured (2026-10 item 263 Phase 2a): the
 * creation modal's choices land on the row first, through the card's own choice functions, and
 * the channel follows the game and the match the row ends up with (owner decision 8).
 */
export async function openChallengeDraft(guild: Guild, hostId: string, game: GameSlug, options: DraftOpenOptions = {}): Promise<DraftOpenResult> {
	const guildId = guild.id;
	// The paid-tier seam. Fails OPEN by design (see gameRoomAccess), and costs nothing
	// at all while ENFORCE_GAME_ROOM_TIER is unset, which is production today.
	const access = await checkGameRoomAccess(guildId, hostId);
	if (!access.allowed) return { ok: false, reason: "noAccess", upgradeUrl: access.upgradeUrl };

	// F11's friendly half, checked before anything is posted publicly. The partial
	// unique index would throw on the insert below; this turns that into a jump link.
	const existing = await gameRoomStore.findOpenByHost(guildId, hostId);
	if (existing) return { ok: false, reason: "alreadyHosting", channelId: existing.channelId ?? null };

	// Checked before the row exists, for the match the host asked for, so a server with no
	// challenge channel never gets a draft (or a bot.slot line) for a card that cannot post.
	const wantsCasual = options.wantsCasual ?? false;
	const askedChannel = await resolveChallengesChannel(guild, game, wantsCasual);
	if (!askedChannel) return { ok: false, reason: "noChannel" };

	// One read answers whether this draft takes Dero bots (2026-10 item 250 Phase 5: a game a bot
	// can play, in a server that lets hosts add bots) and how far its challenge may reach.
	const config = await guildConfigStore.findByGuildId(guildId);
	const botsOffered = takesBots(game) && botsAllowedIn(config);
	const reach = asChallengeReach((config as { challengeReach?: unknown } | null)?.challengeReach);
	const startsOpen = Boolean(options.openToAll) && isWithinReach(reach, "public");

	let created: IGameRoom;
	try {
		created = await gameRoomStore.create({
			guildId,
			game,
			hostId,
			visibility: startsOpen ? "public" : "invite",
			botsOffered,
		});
	} catch (error) {
		// Almost certainly the unique index catching a double click that outran the
		// findOpenByHost above. The honest answer is the same as the friendly one.
		console.error("[game-rooms] draft create failed", { guildId, error });
		return { ok: false, reason: "alreadyHosting", channelId: null };
	}

	const room = options.configure ? await options.configure(created) : created;
	// A casual choice the card's rules refused leaves a rated match, which posts where rated
	// matches do; the match is fixed from here, so the card never moves.
	const channel = (room.casual ?? false) === wantsCasual ? askedChannel : await resolveChallengesChannel(guild, game, room.casual ?? false);
	if (!channel) {
		await gameRoomStore.markArchived(guildId, room.roomId);
		return { ok: false, reason: "noChannel" };
	}

	const state = cardStateFor(room, { visibility: room.visibility, pool: room.spectatorIds ?? [] });
	const logo = roomOpenerLogo(game);
	const card = await channel
		.send({
			embeds: [openerCardEmbed(state, undefined, logo?.ref)],
			components: openerCardRows(room.roomId, state),
			files: logo ? [logo.attachment] : [],
			// A scheduled card names its host, and a card must never ping them.
			allowedMentions: { parse: [] },
		})
		.catch(() => null);

	if (!card) {
		// The row exists and its card does not, so the host would hold a room slot they
		// can never see or cancel. Roll the draft back rather than stranding them.
		await gameRoomStore.markArchived(guildId, room.roomId);
		return { ok: false, reason: "failed" };
	}

	await gameRoomStore.update(guildId, room.roomId, { boardMessageId: card.id });
	// The card went up as text so a press is answered inside Discord's three second
	// window; its picture follows in a second edit once it has drawn.
	void editOpenerCard(guild, room.roomId, card, state);
	return { ok: true, room, channel, card };
}

// ── the settings, applied (owner decision 3: fold, never fork) ────────
// What:  a creation or Edit settings Submit's choices, written onto the draft by calling the
//        SAME function each card control calls, in the order a host pressing them would: who
//        can join (the visibility or the network, then approval), the match (Rated or Casual,
//        its Dero bots through Play vs bots' one write, then the band), Hold'em's buy in, the
//        referee and the auctions, and who may watch last, since a network table refuses it.
// Why:   one path onto the row per setting. A second writer here would be a second set of
//        rules about the reach, the network, consent, bots and the chip ledger to keep in step.
// How:   a choice that equals the row is skipped, so an edit writes only what changed. A choice
//        the card's own rules refuse is not applied; its refusal becomes a note on the card under
//        the settings line (settingsNotes), with the one fallback the card itself implies: a
//        refused network table opens to all, the nearest choice within the reach.
async function applySettings(interaction: HostPress, room: IGameRoom, wanted: ChallengeSettings, fields: readonly SettingField[], mode: SettingsMode): Promise<IGameRoom> {
	const words = gameRoomsCopy.creation;
	const names = words.settingNames;
	const notes: string[] = [];
	let current = room;
	const take = (choice: DraftChoice, setting: string): void => {
		if (choice.ok) current = choice.room;
		else notes.push(words.notApplied(setting, choice.refusal));
	};

	// ① Who can join: the visibility the old first step chose, then the approval toggle.
	if (fields.includes("join") && joinOfRoom(current) !== wanted.join) {
		const visibility = VISIBILITY_OF_JOIN[wanted.join];
		if (visibilityChoiceOf(current) !== visibility) {
			const chosen = await applyVisibilityChoice(interaction, current, visibility);
			if (!chosen.ok && visibility === "network") {
				notes.push(words.notApplied(names.network, chosen.refusal));
				// The network notice is the card's own answer to a host who never accepted it.
				if (chosen.needsConsent) await answerInChannel(interaction, "member", consentPrompt({ kind: "again" }));
				if (current.visibility !== "public") take(await applyVisibilityChoice(interaction, current, "public"), names.join);
			} else take(chosen, names.join);
		}
		const approve = wanted.join === "approve";
		if (current.visibility === "public" && (current.requireApproval ?? false) !== approve) take(await applyApproval(current, approve ? "on" : "off"), names.join);
	}

	// ② The match, fixed at creation: Rated or Casual, then the band of a rated match.
	if (fields.includes("match") && matchOfRoom(current) !== wanted.match) {
		if (wanted.match === "casual-bots") take(await applyCasualChoice(interaction, current, "on"), names.casualBots);
		else if (wanted.match === "casual") take(await applyCasualChoice(interaction, current, CASUAL_WITHOUT_BOTS), names.match);
		else {
			if (current.casual) take(await applyCasualChoice(interaction, current, "off"), names.match);
			const band = bandOfMatch(wanted.match);
			if (band && (current.ratingBand ?? "any") !== band) take(await applyRatingBand(current, band), names.band);
		}
	}

	// ③ Hold'em's buy in: an amount the buy in validation refuses leaves the one in force, and
	// the note says which (Edit settings can fix it before anybody joins).
	if (fields.includes("buyIn")) {
		const amount = wantedBuyIn(wanted.buyIn, current.holdemBuyIn ?? null);
		if (amount !== undefined) {
			const chosen = await applyDraftBuyIn(current, amount);
			if (chosen.ok) current = chosen.room;
			else notes.push(words.notApplied(names.buyIn, `${chosen.refusal} ${words.buyInKept(draftBuyInOf(current))}`));
		}
	}

	// ④ The referee and Monopoly's auctions. Hold'em's referee is applied even when the held
	// draft's line took its field, since its default is on (owner decision 5) and a new row's is off.
	if (offersReferee(current.game) && refereeOn(current) !== wanted.referee && (mode.kind === "create" || fields.includes("referee") || fields.includes("table"))) {
		take(await applyDraftSetting(current, "referee", wanted.referee ? "on" : "off"), names.referee);
	}
	if (fields.includes("table") && (current.monopolyAuctions ?? false) !== wanted.auctions) take(await applyDraftSetting(current, "auctions", wanted.auctions ? "on" : "off"), names.auctions);

	// ⑤ Who may watch, last: a network table keeps its own spectators, so only a choice other
	// than the default it opens with is worth a note there.
	if (fields.includes("watch") && current.spectatorMode !== wanted.watch && !(current.network && wanted.watch === effectiveSpectatorMode("public", null))) {
		take(await applySpectatorMode(current, wanted.watch), names.watch);
	}

	// The notes replace the last Submit's, so a fixed choice stops being reported.
	if (notes.length > 0 || (current.settingsNotes ?? []).length > 0) {
		current = (await gameRoomStore.update(current.guildId, current.roomId, { settingsNotes: notes })) ?? current;
	}
	return current;
}

// Which of the card's old first step choices a row holds: the network, Open to all or Invite only.
type VisibilityChoice = "network" | "public" | "invite";
function visibilityChoiceOf(room: IGameRoom): VisibilityChoice {
	if (room.network) return "network";
	return room.visibility === "public" ? "public" : "invite";
}

// Who can join, as the old first step's choice it makes: approving is Open to all plus the toggle.
const VISIBILITY_OF_JOIN: Record<JoinChoice, VisibilityChoice> = { invite: "invite", public: "public", approve: "public", network: "network" };

/**
 * The buy in a Submit asks to set, or undefined for none: blank keeps the standard stack (and
 * takes a custom amount back to it on Edit settings), anything typed is read as chips, and null
 * stands for typed text that is no amount, which the buy in's own validation refuses with its
 * range. An amount already in force is no change.
 */
function wantedBuyIn(typed: string, current: number | null): number | null | undefined {
	const text = typed.trim();
	if (text === "") return current === null ? undefined : BOT_CONSTANTS.HOLDEM_STARTING_STACK;
	const amount = parseChipAmount(text);
	return amount !== null && amount === current ? undefined : amount;
}

// ── Edit settings (owner decision 7) ──────────────────────────────────
// The host reopens the creation modal prefilled with the draft's values. The match is fixed
// at creation and never offered; until the first joiner (nobody in the pool but the host and
// no buy in paid) every other field can change, after it only Who may watch, Referee and
// Table options. Host only, with no admin override (HOST_STRICT_ACTIONS).

/** Whether anybody joined the draft: someone in the pool, or a buy in paid on the card. */
const hasJoiner = (room: IGameRoom): boolean => (room.spectatorIds ?? []).length > 0 || (room.buyInPaidBy ?? []).length > 0;

/**
 * The card's Edit settings press: the settings modal prefilled with the draft's values. One
 * read before it opens (risk R4), the GuildConfig row its options depend on.
 */
export async function openSettingsEditor(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if (!isSettingsGame(room.game)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const context = settingsContextOf(room.game, await guildConfigStore.findByGuildId(room.guildId));
	const { modal } = buildSettingsModal(context, { customId: confirmCustomId("editok", room.roomId), mode: { kind: "edit", hasJoiner: hasJoiner(room) }, values: settingsOfRoom(room) });
	await showModalOrReply(interaction, modal, () => ({ content: gameRoomsCopy.creation.editUnavailable, flags: MessageFlags.Ephemeral }));
}

/**
 * Edit settings' Submit, on the row gatePress read again (a draft started or closed since is
 * refused there as a race, and plays nothing). The fields are worked out again from that row,
 * so a joiner who arrived while the modal stood open locks what a joiner locks. Who you play:
 * Dero plays the card's own Play Dero; anything else is applied as the creation modal's is.
 */
export async function confirmSettingsEdit(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	const guild = interaction.guild;
	// Edit settings has no fallback button, so only a forged id arrives as a press: it acts on nothing.
	if (!guild || !interaction.isModalSubmit() || !isSettingsGame(room.game)) {
		await acknowledgeConfirm(interaction);
		return;
	}
	const context = settingsContextOf(room.game, await guildConfigStore.findByGuildId(room.guildId));
	const mode: SettingsMode = { kind: "edit", hasJoiner: hasJoiner(room) };
	const fields = settingFieldsFor(room.game, mode);
	const wanted = readSettingsAnswers(interaction, context, fields, settingsOfRoom(room));
	if (fields.includes("opponent") && wanted.opponent === "dero") {
		await playDero(interaction, room);
		return;
	}
	await acknowledgeConfirm(interaction);
	const updated = await applySettings(interaction, room, wanted, fields, mode);
	await refreshDraftCard(guild, updated);
}

// ── the draft's on or off settings ────────────────────────────────────
// The host decides at open whether a Monopoly lot a player passes on goes to auction
// (master plan Section 1) and whether Dero referees the match out loud (Session 5c,
// Monopoly and Hold'em since 2026-10 item 257 Phase 4b). Both live on the draft row,
// which the provisioner adopts, so each reaches the match without a second copy anywhere.
// One handler for both, keyed by the card action that carries it, so the toggles cannot
// drift into different rules.
const DRAFT_SETTINGS = {
	auctions: { field: "monopolyAuctions", offeredFor: (game: GameSlug) => game === "monopoly" },
	referee: { field: "referee", offeredFor: offersReferee },
} as const satisfies Record<DraftSettingAction, { field: keyof IGameRoom; offeredFor: (game: GameSlug) => boolean }>;

/**
 * Switch one on or off draft setting: the one write behind a card's auctions or referee toggle
 * and the creation modal's Referee and Table options (2026-10 item 263 Phase 2a).
 */
export async function applyDraftSetting(room: IGameRoom, action: DraftSettingAction, choice: string): Promise<DraftChoice> {
	const setting = DRAFT_SETTINGS[action];
	// The arg is user input like the rest of a customId: anything but the two values a card
	// renders, or a setting this game's card never offers, is a retired or forged control.
	if (!setting.offeredFor(room.game) || (choice !== "on" && choice !== "off")) return { ok: false, refusal: gameRoomsCopy.errors.controlRetired };
	const patch: Partial<IGameRoom> = {};
	patch[setting.field] = choice === "on";
	return { ok: true, room: (await gameRoomStore.update(room.guildId, room.roomId, patch)) ?? room };
}

export async function chooseDraftSetting(interaction: ButtonInteraction, room: IGameRoom, action: DraftSettingAction, choice: string): Promise<void> {
	const applied = await applyDraftSetting(room, action, choice);
	if (!applied.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [applied.refusal] });
		return;
	}
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, applied.room, cardStateFor(applied.room, { visibility: applied.room.visibility, pool: applied.room.spectatorIds ?? [] }));
}

// ── the visibility chooser ────────────────────────────────────────────
/**
 * Make a draft Invite only, Open to all, or open to the network: the one write behind the old
 * card's first step and the creation modal's Who can join (2026-10 item 263 Phase 2a).
 *
 * ⚠️ THE REACH CEILING, REFUSED AT THE CHOICE (2026-10 item 244 Phase 4). The modal leaves Open
 * to all out when the server is invite only, but a modal or card opened before the admin
 * changed the setting still offers it, and a hidden choice is a suggestion, not a gate.
 * checkRoomAdmission refuses the open again, for every other way in.
 */
export async function applyVisibilityChoice(interaction: HostPress, room: IGameRoom, choice: string): Promise<DraftChoice> {
	if (choice === "network") return applyNetworkChoice(interaction, room);
	const visibility: RoomVisibility = choice === "public" ? "public" : "invite";
	if (!isWithinReach(await readChallengeReach(room.guildId), visibility)) return { ok: false, refusal: hostWords.reach.publicRefused };
	// Leaving the network is new with Edit settings: the old card had no way back from it.
	const patch: Partial<IGameRoom> = room.network ? { visibility, network: false } : { visibility };
	return { ok: true, room: (await gameRoomStore.update(room.guildId, room.roomId, patch)) ?? room };
}

export async function chooseVisibility(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	const chosen = await applyVisibilityChoice(interaction, room, choice);
	if (!chosen.ok) {
		// A host who never accepted the network notice is shown it, then presses the choice again.
		if (chosen.needsConsent) await answerInChannel(interaction, "member", consentPrompt({ kind: "again" }));
		else await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [chosen.refusal] });
		return;
	}
	const updated = chosen.room;
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, updated, cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] }));

	// A host choosing the PRIVATE form sees the ceiling before the refusal ever
	// could: "Your server has 6/10 private rooms open on the Starter plan." Null
	// (and therefore silent) while the tier surface is not enforcing, which is
	// production today. Fire and forget after the card edit; a failed post must
	// not undo a visibility choice that already landed. It posts in 💬dero-commands
	// (2026-10 item 257 Phase 5), the card's own update having acknowledged the press.
	if (updated.visibility === "invite") {
		readPrivateQuotaStatus(room.guildId, interaction.user.id)
			.then((status) =>
				status ? answerInChannel(interaction, "member", { content: `Invite only. ${status}` }) : undefined
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
// not accepted the network notice is refused with needsConsent, which the caller answers
// with the notice.
async function applyNetworkChoice(interaction: HostPress, room: IGameRoom): Promise<DraftChoice> {
	const refusal = interaction.user.id === room.hostId ? await networkChoiceRefusal(interaction.client, room) : networkWords.hostRefusals.notHost;
	if (refusal) return { ok: false, refusal };
	if (!(await hasNetworkConsent(room.hostId))) return { ok: false, refusal: gameRoomsCopy.creation.networkConsent, needsConsent: true };

	// A spectator choice is dropped: a network table offers no spectator choice (its watchers in
	// other servers are its satellites' business), so it keeps the default a network table has
	// always opened with.
	return { ok: true, room: (await gameRoomStore.update(room.guildId, room.roomId, { visibility: "public", network: true, spectatorMode: null })) ?? room };
}

// Why this table cannot be opened to the network, or null: a game no satellite mirrors, a
// server that is not on the network, or a host or server the owner banned from it.
async function networkChoiceRefusal(client: Client, room: IGameRoom): Promise<string | null> {
	if (!isNetworkGame(room.game)) return networkWords.hostRefusals.notNetworkGame(gameRoomsCopy.gameLabel(room.game));
	if (!(await readNetworkGuild(client, room.guildId)).onNetwork) return networkWords.hostRefusals.notOnNetwork;
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
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.pickerEmpty] });
		return;
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(`${GAME_ROOM_SELECT_PREFIX}:invite:${room.roomId}`)
		.setPlaceholder(gameRoomsCopy.board.pickerPlaceholder)
		.setMinValues(1)
		.setMaxValues(options.length)
		.addOptions(options);

	// A pick of several members is no single choice a modal holds, so it posts in
	// 💬dero-commands (2026-10 item 257 Phase 5); handleInviteSelect refuses anyone but the host.
	await answerInChannel(interaction, "member", {
		content: gameRoomsCopy.board.pickerPrompt,
		components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
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
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.notYourChallenge] });
		return;
	}

	// ⚠️ RE-FILTER SERVER SIDE. The values arrive from the client, and a customId plus
	// its payload are user input however the menu was built, so the structural
	// guarantee above holds even against a hand-crafted interaction. Members the host
	// removed are filtered out here too, from the row read just above, so a picker
	// opened before a removal cannot invite them back.
	const picked = await refilterInvitees(interaction.guild, interaction.values, room.hostId, room.kickedIds ?? []);

	const saved = (await gameRoomStore.update(guildId, roomId, { spectatorIds: picked })) ?? room;
	// Each person the host invites onto a Casual draft takes a Dero bot's seat (Arcade 6).
	const updated = await yieldBotSeatsTo(interaction.client, room, saved);
	// Who was invited is an answer, not a state (owner rule 1, 2026-10 item 263 R3-11), and it
	// belongs to the picker the host pressed in 💬dero-commands, so the picker becomes it and
	// loses its select. No ping: the host is answering their own prompt where they pressed it.
	await interaction.update({ content: gameRoomsCopy.board.pickerSaved(picked.length), components: [], allowedMentions: { parse: [] } });
	await refreshCard(interaction.guild, updated, cardStateFor(updated, { visibility: "invite", pool: picked }));
}

// ── open to all: the Join button ──────────────────────────────────────
// ⚠️ BOT FREE BY CONSTRUCTION. Bots cannot click buttons, so this path cannot admit
// one; there is nothing to filter. That is the other half of F9, and it is why the
// two visibilities need no shared "is this a bot" check.
export async function joinChallenge(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const actorId = interaction.user.id;

	if (actorId === room.hostId) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.hostCannotJoin] });
		return;
	}
	if ((room.spectatorIds ?? []).includes(actorId)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.alreadyJoined] });
		return;
	}
	if ((room.pendingJoinIds ?? []).includes(actorId)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [hostWords.approval.alreadyAsked] });
		return;
	}
	if ((room.spectatorIds ?? []).length >= BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.poolFull(BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)] });
		return;
	}

	// The host's say (2026-10 item 244 Phase 4): a removed member is refused, a rating
	// outside the band is refused, and a host who approves each joiner gets a request.
	const verdict = await judgeJoin(room, actorId, { alreadyApproved: false });
	if (verdict.kind === "refuse") {
		// A network table needs the network notice first (2026-10 item 244 Phase 5b); the
		// member presses Join again once they accept it.
		if (verdict.reason === "noConsent") {
			await answerInChannel(interaction, "member", consentPrompt({ kind: "again" }));
			return;
		}
		const refusal = verdict.reason === "kicked" ? hostWords.kick.refusedRejoin : hostWords.band.refused(gameRoomsCopy.gameLabel(room.game));
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
		return;
	}
	// A Hold'em chip table is paid for on the card (2026-10 item 257 Phase 4a): the buy in leaves the
	// wallet now, whether the joiner goes straight in or waits for the host, and goes back if they
	// are declined, removed, or the challenge is cancelled.
	if (room.game === "holdem") {
		const unpaid = await chargeJoiner(room, actorId);
		if (unpaid) {
			await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [unpaid] });
			return;
		}
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
		await refundJoiners(room, [actorId]);
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [hostWords.kick.refusedRejoin] });
		return;
	}
	// On a Casual draft the joiner takes a Dero bot's seat (2026-10 item 254, Arcade 6).
	const updated = added ? await yieldBotSeatsTo(interaction.client, room, added) : room;

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
		await refundJoiners(room, [interaction.user.id]);
		const fresh = (await gameRoomStore.findByRoomId(room.guildId, room.roomId)) ?? room;
		const refusal = isKicked(fresh, interaction.user.id) ? hostWords.kick.refusedRejoin : gameRoomsCopy.board.draftGone;
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
		return;
	}
	// A request filed is work done, so it is an answer (owner rule 1, R3-11): it posts in
	// 💬dero-commands and pings the member who asked.
	await answerInChannel(interaction, "member", { content: hostWords.approval.asked });
	await refreshDraftCard(interaction.guild!, updated);
}

// ── start the match ───────────────────────────────────────────────────
// Start match asks first (2026-10 item 257, owner item 12): the room channel is made only
// on the confirm's Submit (confirmStartMatch), or on the opponent picker's Submit when the
// host has a choice to make, since choosing who plays is itself the yes.
export async function startMatch(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const refusal = startRefusal(room);
	if (refusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
		return;
	}
	if (needsOpponentPick(room)) {
		await openOpponentPicker(interaction, room);
		return;
	}
	await showConfirm(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.confirms.start], confirmId: confirmCustomId("startok", room.roomId) });
}

/**
 * Start match's confirm: every refusal checked again on the row gatePress read again,
 * since the pool may have moved while the confirm stood open, then the room is provisioned.
 */
export async function confirmStartMatch(interaction: ConfirmInteraction, room: IGameRoom): Promise<void> {
	const refusal = startRefusal(room);
	if (refusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
		return;
	}
	// A picker cannot open from a modal Submit, so a pool that grew past one sends the host
	// back to the button, which opens it.
	if (needsOpponentPick(room)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.confirms.startPickNeeded] });
		return;
	}
	const answer = await beginChannelAnswer(interaction, "member");
	// A battleship match against a Dero bot and a cooperative game single nobody out; a
	// head to head start with one candidate seats that one (none for a bots or network start).
	const singlesOut = !isCooperativeGame(room.game) && !(room.game === "battleship" && (room.botSeats ?? 0) > 0);
	await provisionFromDraft(interaction, answer, room, singlesOut ? ((room.spectatorIds ?? [])[0] ?? null) : null);
}

// Every reason Start match is refused before any channel exists, the same on the press and
// on its confirm. Null when the match may start.
function startRefusal(room: IGameRoom): string | null {
	const pool = room.spectatorIds ?? [];
	// A network table may open with nobody else in the pool (2026-10 item 244 Phase 5b):
	// its players come from the network board and the room's own Buy in once it opens,
	// and a Hold'em table is built to open with no seat taken.
	// Dero bots fill seats too (2026-10 item 250 Phase 5), so a host may start against
	// bots alone.
	const bots = room.botSeats ?? 0;
	if (pool.length === 0 && !room.network && bots === 0) return gameRoomsCopy.board.poolEmpty;

	// Monopoly seats the host plus the whole pool, and its board has six seats while
	// the pool can grow to GAME_ROOM_MAX_SPECTATORS. Refused HERE, before any channel
	// exists, because the engine throws on a seventh seat and the provisioner only
	// builds the match after the channel is already up, which would strand a room
	// with no board in it.
	if (room.game === "monopoly" && pool.length + 1 + bots > MONOPOLY_MAX_SEATS) {
		return bots > 0
			? gameRoomsCopy.monopoly.tooManyWithBots(MONOPOLY_MAX_SEATS, pool.length, bots)
			: gameRoomsCopy.monopoly.tooManyPlayers(MONOPOLY_MAX_SEATS, pool.length);
	}

	// A Blackjack table has five seats (2026-10 item 254, Arcade 1), the host's among them,
	// refused here for the same reason as Monopoly's six: before any channel exists.
	if (room.game === "blackjack" && pool.length + 1 > BLACKJACK_MAX_SEATS) {
		return gameRoomsCopy.board.blackjackTooManyPlayers(BLACKJACK_MAX_SEATS, pool.length);
	}
	return null;
}

// Whether the host must choose who plays: more than one candidate in a head to head game.
// A battleship challenge with a Dero bot plays the bot, nobody in the pool singled out
// (2026-10 item 250 Phase 5), and ⚠️ A COOPERATIVE GAME NEVER ASKS WHO PLAYS: in hangman
// the whole pool guesses together against the host's word, so picking one of them would
// turn a party game into a duel. Everyone else stays in spectatorIds, already in the
// right field.
function needsOpponentPick(room: IGameRoom): boolean {
	if (room.game === "battleship" && (room.botSeats ?? 0) > 0) return false;
	if (isCooperativeGame(room.game)) return false;
	return (room.spectatorIds ?? []).length > 1;
}

// The host chooses who plays from the pool: a modal whose Submit (handleOpponentSelect)
// starts the match, or the select message Discord falls back to.
async function openOpponentPicker(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	const pool = room.spectatorIds ?? [];
	const options = [];
	for (const id of pool.slice(0, BOT_CONSTANTS.GAME_ROOM_MAX_SPECTATORS)) {
		const member = interaction.guild!.members.cache.get(id) ?? (await interaction.guild!.members.fetch(id).catch(() => null));
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

	await showPicker(interaction, {
		action: "opponent",
		roomId: room.roomId,
		title: gameRoomsCopy.notices.challenge,
		prompt: gameRoomsCopy.board.chooseOpponentPrompt,
		label: gameRoomsCopy.board.chooseOpponentPlaceholder,
		select,
	});
}

// The opponent picker's submission, for the multi-joiner case: from its modal, or from
// the select message Discord falls back to when it refuses the modal.
export async function handleOpponentSelect(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (!isPickerPrefix(prefix) || action !== "opponent" || !roomId) return;

	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.notYourChallenge] });
		return;
	}

	// A member the host removed after this picker opened is out of the pool by now, so
	// the pool check refuses them; isKicked says so outright rather than leaning on it.
	const chosen = pickedValues(interaction)[0];
	if (!chosen || !(room.spectatorIds ?? []).includes(chosen) || isKicked(room, chosen)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.poolEmpty] });
		return;
	}

	const answer = await beginChannelAnswer(interaction, "member");
	await provisionFromDraft(interaction, answer, room, chosen);
}

// Shared tail of both start paths: promote the chosen member, provision, and close
// out the card. One function so the two entry points cannot diverge about who ends up
// a player and who ends up a spectator.
async function provisionFromDraft(
	interaction: ConfirmInteraction | StringSelectMenuInteraction,
	// The start's slow answer, already acknowledged: it posts in 💬dero-commands (2026-10
	// item 257 Phase 5), or privately where that channel does not exist.
	answer: PendingChannelAnswer,
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
		await answer.send({ embeds: [errorEmbed(gameRoomsCopy.errors.noArcadeCategory)] });
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

	// A Hold'em chip table seats everyone who paid on the card, and charges the host their own
	// seat here (item 257 Phase 4a); a short wallet stops the start before any channel exists.
	const settled = await settleDraftBuyIns(room, pool);
	if (!settled.ok) {
		await answer.send({ embeds: [errorEmbed(settled.reason)] });
		return;
	}
	const paidSeats = settled.seats;

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
		holdemSeats: paidSeats ?? undefined,
	});

	if (!result.ok) {
		if (paidSeats) await refundOpenedSeats(room, paidSeats);
		await answer.send({ embeds: [errorEmbed(describeRoomOpenFailure(result))] });
		return;
	}
	// The ledger is settled: those buy ins are stacks at the table now, paid back by the table.
	if (paidSeats) await gameRoomStore.update(room.guildId, room.roomId, { buyInPaidBy: [] });

	// A Blackjack table is dealt once its room is up (2026-10 item 254, Arcade 1), every
	// gathered player seated; a table that cannot start has already closed its room.
	if (room.game === "blackjack" && !(await startBlackjackRoomBoard(guild, result.room, result.channel))) {
		await answer.send({ embeds: [errorEmbed(gameRoomsCopy.errors.createFailed)] });
		return;
	}

	// Nothing posts in 💬dero-commands once the room is open (2026-10 item 263 R3-24): the room's
	// opener pings its players there. Only the no channel fallback still has a private defer
	// waiting, so only it names the room.
	if (answer.channelId === null) await answer.send({ content: gameRoomsCopy.board.cardStarted(result.channel.id) });
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
		await showRefusalNotice(interaction, check.reply);
		return;
	}

	// Everything below writes rows and talks to Discord several times over, which can
	// run past the three second interaction window. Deferring the UPDATE (rather than a
	// reply) is what lets ③ edit the result card the button lives on.
	await interaction.deferUpdate();
	try {
		const failure = await playRematchInPlace(interaction, room, check.channel);
		if (failure) await answerInChannel(interaction, "member", { content: failure });
	} catch (error) {
		// A Mongo or Discord failure mid way. Whatever was written is safe to leave (see
		// Where above): a new row that never reached "playing" is a draft the idle sweep
		// closes, and its channel is archived through it.
		console.error("[game-rooms] rematch failed", { guildId: room.guildId, roomId: room.roomId, error });
		await answerInChannel(interaction, "member", { content: gameRoomsCopy.errors.createFailed });
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

	// Solo visibility rematches only for the solo games whose result card offers it
	// (roomTypes.SOLO_REMATCH_GAMES). A coin flip or dice round against Dero is a single
	// press from the card instead, and solo-rps asks its throw in the room, so its rematch is
	// one more prompt (2026-10 item 257 Phase 4b); any other game with solo visibility is a
	// row no current path writes, and seeding it would open the wrong thing.
	if (room.visibility === "solo" && !isSoloRematchGame(room.game)) {
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
	// Every admission refusal (one room per host, a full server, the private ceiling, the
	// reach) is a state, so it opens as a titled notice rather than an error embed (R3-12).
	if (admission) return { ok: false, reply: { content: describeRoomOpenFailure(admission) } };

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
			referee: refereeOn(finished),
			// And the host controls (2026-10 item 244 Phase 4), above all who was removed:
			// the rematch plays in the SAME channel, so a member removed from it stays
			// removed, and a public Hold'em rematch's Buy in refuses them like the first.
			ratingBand: finished.ratingBand ?? "any",
			requireApproval: finished.requireApproval ?? false,
			kickedIds: finished.kickedIds ?? [],
			// The same Dero bots sit down again (2026-10 item 250 Phase 5), and a Casual match's
			// rematch stays unrated like it (2026-10 item 254, Arcade 6).
			botSeats: finished.botSeats ?? 0,
			casual: finished.casual ?? false,
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
//        is played in ⚔️challenges.
// Who:   a card's `dero` button (strict host only: HOST_STRICT_ACTIONS), Edit settings'
//        Who you play: Dero, and, with no draft to close, the creation modal's Who you play:
//        Dero (playDeroRound, 2026-10 item 263 Phase 2a), which posts no card.
// Where: soloLuck is the ONE solo round, shared with /mini-game against Dero and the
//        🕹️games row, so the odds and the pay cannot drift between the three doors. An rps
//        round asks for its throw IN its room, through the turn prompt (soloLuckRoom,
//        2026-10 item 257 Phase 4b), so the press asks nothing here and a rematch can ask
//        again in the same channel.
// How:   ① refuse anything but a luck draft; ② archive the draft, which frees the
//        host's one room slot exactly like Call it off, so the solo room may take it (the
//        slot a Play Dero press could find held is this very draft, which is why it needs no
//        offer to close one); ③ open the solo room, which plays the coin or the dice at once
//        and prompts the rps throw; ④ close the card with the line that points at the room.
export async function playDero(interaction: HostPress, room: IGameRoom): Promise<void> {
	if (!isDeroPlayable(room.game)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}
	const guild = interaction.guild;
	if (!guild) return;
	// Acknowledged quietly first: opening a room is a channel create plus its opener, which
	// can run past Discord's three second window.
	const answer = await beginChannelAnswer(interaction, "member");
	await gameRoomStore.markArchived(room.guildId, room.roomId);

	const channel = await openDeroRoom(interaction, guild, room.game, answer);
	const resultLine = channel ? gameRoomsCopy.board.cardPlayedDero(room.hostId, channel.id) : gameRoomsCopy.board.cardDeroUnavailable(room.hostId);
	await refreshCard(guild, room, cardStateFor(room, { visibility: room.visibility, resultLine }));
}

// The creation modal's Who you play: Dero: the same round with no draft to close and no card.
async function playDeroRound(interaction: ConfirmInteraction, guild: Guild, game: SoloLuckGame): Promise<void> {
	const answer = await beginChannelAnswer(interaction, "member");
	await openDeroRoom(interaction, guild, game, answer);
}

// ③ The solo room itself, the one tail of every Play Dero door. The room's opener pings the
// member there, so nothing posts in 💬dero-commands (2026-10 item 263 R3-24); only the no
// channel fallback's private defer still waits for a word. Null when the room did not open.
async function openDeroRoom(interaction: HostPress, guild: Guild, game: SoloLuckGame, answer: PendingChannelAnswer): Promise<TextChannel | null> {
	const member = guild.members.cache.get(interaction.user.id);
	const opened = await openSoloRoom(guild, soloLuckSlugFor(game), {
		userId: interaction.user.id,
		displayName: member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
		user: interaction.user,
	});
	if (!opened.ok) {
		await answerSoloRefusal(interaction, answer, opened);
		return null;
	}
	if (answer.channelId === null) await answer.send({ content: gameRoomsCopy.board.cardStarted(opened.channel.id) });
	return opened.channel;
}

/**
 * A solo room that would not open, answered after its press was acknowledged. A held slot is
 * only a race by now, since every solo start refuses it at the press (2026-10 item 263 R3-9),
 * so it is a notice linking the card or the room that holds it, never an error embed pinging in
 * 💬dero-commands; every other refusal keeps the answer it always had. Shared with arcadeHost.
 */
export async function answerSoloRefusal(interaction: RepliableInteraction, answer: PendingChannelAnswer, failure: Exclude<SoloOpenResult, { ok: true }>): Promise<void> {
	if (failure.reason !== "alreadyHosting") {
		await answer.send({ embeds: [errorEmbed(describeSoloOpenFailure(failure))] });
		return;
	}
	const line = await heldSlotLine(interaction.guildId ?? "", interaction.user.id);
	// With no channel the private defer still waits, so the line is its answer; in a channel
	// the quiet acknowledgement left nothing waiting, so the line is a private notice.
	if (answer.channelId === null) await answer.send({ content: line });
	else await showNotice(interaction, { title: gameRoomsCopy.notices.room, sections: [line] });
}

// Where the host's one slot is held: the card of a draft, linked, or the channel of a match.
async function heldSlotLine(guildId: string, hostId: string): Promise<string> {
	const [existing, ids] = await Promise.all([gameRoomStore.findOpenByHost(guildId, hostId), readChallengeChannelIds(guildId)]);
	if (existing?.status === "draft") return gameRoomsCopy.errors.alreadyHostingCard(challengeCardLink(ids, existing));
	return gameRoomsCopy.errors.alreadyHosting(existing?.channelId ?? null);
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
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
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
	await showPicker(interaction, {
		action: BOT_COUNT_FIELD,
		roomId: room.roomId,
		title: gameRoomsCopy.notices.challenge,
		prompt: gameRoomsCopy.board.botPickerPrompt,
		label: gameRoomsCopy.board.botPickerPlaceholder,
		select,
	});
}

/** The bot count picker's submission, from its modal or its select message: the host's, on a draft, a count the game takes. */
export async function handleBotSelect(interaction: StringSelectMenuInteraction | ModalSubmitInteraction): Promise<void> {
	const [prefix, action, roomId] = interaction.customId.split(":");
	if (!isPickerPrefix(prefix) || action !== BOT_COUNT_FIELD || !roomId) return;
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) return;

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.status !== "draft") {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.draftGone] });
		return;
	}
	if (room.hostId !== interaction.user.id) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.board.onlyHostStarts] });
		return;
	}
	const refusal = await botRefusal(room);
	if (refusal) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [refusal] });
		return;
	}
	// The value is user input whoever built the menu, so it is checked against the counts.
	const count = Number.parseInt(pickedValues(interaction)[0] ?? "", 10);
	if (!Number.isInteger(count) || count < 0 || count > maxBotSeats(room.game)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.errors.controlRetired] });
		return;
	}

	const updated = await saveBotSeats(interaction, room, { botSeats: count }, gameRoomsCopy.board.botOptionCount(count));
	// The count saved is an answer that belongs to the card, whose bots line the refresh
	// below redraws (owner rule 1, R3-11). The modal's Submit closes through
	// acknowledgeTextModal (R3-6); the select message Discord falls back to becomes the answer.
	if (interaction.isModalSubmit()) await acknowledgeTextModal(interaction);
	else await interaction.update({ content: gameRoomsCopy.board.botsSaved(count), components: [], allowedMentions: { parse: [] } });
	await refreshCard(interaction.guild, updated, cardStateFor(updated, { visibility: updated.visibility, pool: updated.spectatorIds ?? [] }));
}

// ⚠️ THE ONE WRITE BEHIND THE BOT DOOR. Play vs bots and the Casual choice both set a
// draft's bot count here, so a bot sits down only through a host's own press and every
// change of the count is one bot.slot line in 🗒️admin-log, whichever button made it.
async function saveBotSeats(
	interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
	room: IGameRoom,
	patch: { botSeats: number; casual?: boolean },
	detail: string
): Promise<IGameRoom> {
	const updated = (await gameRoomStore.update(room.guildId, room.roomId, patch)) ?? room;
	if ((room.botSeats ?? 0) !== patch.botSeats) {
		adminLog.emitFor(interaction, room.guildId, "bot.slot", {
			subject: gameRoomsCopy.gameLabel(room.game),
			detail,
			game: room.game,
			matchId: room.roomId,
			botCount: patch.botSeats,
			actor: interaction.user.id,
		});
	}
	return updated;
}

// ── Rated or Casual (2026-10 item 254, Arcade 6) ──────────────────────
// What:  the host's choice on a Hold'em, Monopoly or Battleship draft. "on", the card's
//        Casual, fills the empty seats with Dero bots up to BOT_CONSTANTS.CASUAL_TABLE_SEATS;
//        CASUAL_WITHOUT_BOTS (2026-10 item 263 R3-5) is casual with no bot, so a server with
//        bots off can still play an unrated match; "off", Rated, the default, takes every bot
//        away, since a rated match cannot hold one.
// Who:   a card's `casual` toggle (from before the creation modal), the host's alone
//        (HOST_STRICT_ACTIONS), and the creation modal's The match (applySettings).
// Where: the fill goes through saveBotSeats, the write Play vs bots makes, so Casual is
//        not a second bot door: it is the host choosing a number of bots by another
//        button. The badge reads the flag through challengeBadge, and recordMatchRatings
//        refuses to rate a casual row even once people took every bot's seat.

/** The casual choice's value for a casual match with no Dero bot. */
export const CASUAL_WITHOUT_BOTS = "plain";

/**
 * Set a rated game's draft Rated or Casual, its Dero bots with it. Refused only where bots are
 * asked for ("on") and cannot sit (botRefusal): Rated and a casual match without bots seat none.
 */
export async function applyCasualChoice(interaction: HostPress, room: IGameRoom, choice: string): Promise<DraftChoice> {
	// The arg is user input like the rest of a customId: anything but the values a card or
	// the creation modal sends is a retired or forged control.
	if (choice !== "on" && choice !== "off" && choice !== CASUAL_WITHOUT_BOTS) return { ok: false, refusal: gameRoomsCopy.errors.controlRetired };
	const wantsBots = choice === "on";
	if (wantsBots) {
		const refusal = await botRefusal(room);
		if (refusal) return { ok: false, refusal };
	}
	// Only a rated game has a match to make casual; botRefusal already said so for "on".
	if (!isRatedGame(room.game)) return { ok: false, refusal: gameRoomsCopy.errors.controlRetired };
	const words = gameRoomsCopy.board.casual;
	const casual = choice !== "off";
	const bots = wantsBots ? casualBotSeats(room.game, (room.spectatorIds ?? []).length) : 0;
	const detail = casual ? words.logFilled(bots) : words.logCleared;
	return { ok: true, room: await saveBotSeats(interaction, room, { casual, botSeats: bots }, detail) };
}

export async function chooseCasual(interaction: ButtonInteraction, room: IGameRoom, choice: string): Promise<void> {
	const chosen = await applyCasualChoice(interaction, room, choice);
	if (!chosen.ok) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [chosen.refusal] });
		return;
	}
	// The card is the answer: its badge and its settings line change.
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, chosen.room, cardStateFor(chosen.room, { visibility: chosen.room.visibility, pool: chosen.room.spectatorIds ?? [] }));
}

/**
 * A person came into a Casual draft's pool (Join, the invite picker, or the host
 * accepting a request): each one takes one Dero bot's seat, never more, and a seat never
 * swaps once the match has started (the store's draft filter). `before` is the row as the
 * press read it and `after` the row the pool write returned, so the bots lost are the
 * people gained between the two; a double click gains nobody and costs no bot. Answers
 * the row to draw the card from, with one bot.slot line when a bot left. Dero is the
 * actor, since the joiner pressed Join, not a bot control.
 */
export async function yieldBotSeatsTo(client: Client, before: IGameRoom, after: IGameRoom): Promise<IGameRoom> {
	if (!after.casual || after.status !== "draft" || (after.botSeats ?? 0) === 0) return after;
	const gained = (after.spectatorIds ?? []).length - (before.spectatorIds ?? []).length;
	if (gained <= 0) return after;
	const lowered = await gameRoomStore.lowerBotSeats(after.guildId, after.roomId, (before.botSeats ?? 0) - gained);
	if (!lowered) return after;
	adminLog.emit({
		guild: { id: after.guildId, client },
		kind: "bot.slot",
		actor: { source: "dero" },
		payload: {
			subject: gameRoomsCopy.gameLabel(after.game),
			detail: gameRoomsCopy.board.casual.logSwapped(lowered.botSeats ?? 0),
			game: after.game,
			matchId: after.roomId,
			botCount: lowered.botSeats ?? 0,
		},
	});
	return lowered;
}

// ── the Hold'em buy in on the card (2026-10 item 257 Phase 4a) ────────
// The host's Set the buy in: a modal from the card's button, applied on its Submit. Refused
// honestly on a server with chips off and once anybody has paid, since a payment is for the
// amount it was charged.
export async function openBuyIn(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	if (!(await isChipDraft(room))) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.holdem.buyInFreeTable] });
		return;
	}
	if ((room.buyInPaidBy ?? []).length > 0) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [gameRoomsCopy.holdem.buyInLocked] });
		return;
	}
	await interaction.showModal(buyInModal(room.roomId, draftBuyInOf(room)));
}

/** The buy in modal's Submit: re-gated and re-read, because a modal is reachable without the button. */
export async function handleBuyInModal(interaction: ModalSubmitInteraction): Promise<void> {
	const [, , roomId] = interaction.customId.split(":");
	const guildId = interaction.guildId;
	if (!guildId || !roomId || !interaction.guild) return;
	const notice = (text: string) => showNotice(interaction, { title: gameRoomsCopy.notices.challenge, sections: [text] });

	const room = await gameRoomStore.findByRoomId(guildId, roomId);
	if (!room || room.game !== "holdem" || room.status !== "draft") return notice(gameRoomsCopy.board.draftGone);
	if (room.hostId !== interaction.user.id) return notice(gameRoomsCopy.board.onlyHostStarts);

	const chosen = await applyDraftBuyIn(room, submittedBuyIn(interaction));
	if (!chosen.ok) return notice(chosen.refusal);
	await interaction.deferUpdate();
	await refreshDraftCard(interaction.guild, chosen.room);
}

/**
 * Set a Hold'em draft's buy in: the one write behind the old card's Set the buy in modal and
 * the creation modal's Buy in (2026-10 item 263 Phase 2a). Refused on a table that plays free
 * (chips off, a network table, a Dero bot seat), for an amount outside the table's bounds or
 * none at all, and once anybody has paid, since a payment is for the amount it was charged.
 */
export async function applyDraftBuyIn(room: IGameRoom, amount: number | null): Promise<DraftChoice> {
	if (!(await isChipDraft(room))) return { ok: false, refusal: gameRoomsCopy.holdem.buyInFreeTable };
	const economy = BOT_CONSTANTS.ECONOMY;
	if (amount === null || !isValidDraftBuyIn(amount)) return { ok: false, refusal: gameRoomsCopy.holdem.buyInInvalid(economy.HOLDEM_MIN_BUY_IN, economy.HOLDEM_MAX_BUY_IN) };
	const updated = await gameRoomStore.setHoldemBuyIn(room.guildId, room.roomId, amount);
	return updated ? { ok: true, room: updated } : { ok: false, refusal: gameRoomsCopy.holdem.buyInLocked };
}

// ── cancel ────────────────────────────────────────────────────────────
export async function cancelDraft(interaction: ButtonInteraction, room: IGameRoom): Promise<void> {
	// "archived" rather than a delete: the row is the audit trail, and the partial
	// unique index only counts non-terminal statuses, so archiving is what actually
	// frees the host's slot.
	await gameRoomStore.markArchived(room.guildId, room.roomId);
	// Everyone who paid the buy in gets it back (item 257 Phase 4a), after the draft is closed.
	await refundAllJoiners(room);
	await interaction.deferUpdate();
	await refreshCard(interaction.guild!, room, cancelledCardState(room));
}

// Cancel's close, for the one room per host confirm (item 15): the same archive that frees
// the slot, with the card redrawn as cancelled in the background, since the confirm still
// has to post the new card inside Discord's three second window.
async function closeDraft(guild: Guild, room: IGameRoom): Promise<void> {
	await gameRoomStore.markArchived(room.guildId, room.roomId);
	await refundAllJoiners(room);
	void refreshCard(guild, room, cancelledCardState(room)).catch((error: unknown) =>
		console.error("[game-rooms] the replaced draft's card did not redraw", { guildId: room.guildId, roomId: room.roomId, error })
	);
}

const cancelledCardState = (room: IGameRoom) => cardStateFor(room, { visibility: room.visibility, cancelled: true });

export const challengeBoard = {
	offerChallengeDraft,
	confirmChallengeDraft,
	openSettingsEditor,
	confirmSettingsEdit,
	confirmStartMatch,
	chooseVisibility,
	openInvitePicker,
	handleInviteSelect,
	joinChallenge,
	startMatch,
	handleOpponentSelect,
	cancelDraft,
	rematchFromRoom,
	chooseDraftSetting,
	playDero,
	openBotPicker,
	handleBotSelect,
	chooseCasual,
	openBuyIn,
	handleBuyInModal,
};
