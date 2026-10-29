import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ── the notice inventory (2026-10 item 263, R3-11 and R3-6) ──────────────────
// What:  finds every call of the six notice helpers and of the six files' own notice
//        wrappers in the source, and holds each one to INVENTORY below: the file, the named
//        function it sits in, a piece of its line, and its kind under owner rule 1 of the
//        Round 3 list (a notice states something; an answer is never a notice).
// Why:   an answer hidden behind a notice helper is the bug Round 3 found ("Your challenge
//        card is in ..." as a private line), and a line grep cannot see which helper a line
//        reaches. A new call fails here until it is listed with its kind, a listed call that
//        disappears fails too, and an entry of kind answer always fails, so no answer can
//        come back behind a notice.
// How:   matched by file, enclosing function and a piece of the line, never a line number,
//        which moves with every edit above it. Phase 1b sorted features/game-rooms and
//        features/games and Phase 1c everything else, so no site may be unsorted and only a
//        failure may call showErrorNotice. The verdicts and their reasons are the fourth pass
//        of companyuno-discord/docs/handoffs/dero-private-reply-audit-2026-10-part-2.md.
//
// A second scan (the channel error inventory, below INVENTORY) finds every error embed handed
// to a channel answer, which pings its member where it posts, and allows a failure alone there.
//
// utils/textModal.ts is not scanned: it is where the helpers are written, so its calls are
// the helpers calling each other, not places a member is answered.

const SOURCE_ROOT = join(__dirname, "..");

/** Phase 1c sorted every site, so none may be unsorted again; the audit's own cases below still pass true. */
const UNSORTED_ALLOWED = false;

/** The folders Phase 1b sorted, where an unsorted entry was never allowed even before Phase 1c. */
const SORTED_FOLDERS = ["features/game-rooms/", "features/games/"];

const NOTICE_HELPERS = ["showNotice", "showErrorNotice", "showEmbedNotice", "showCooldownNotice", "showRefusalNotice", "showPendingNotice"] as const;

// Functions that only pass their words on to a notice helper, so a call of one is a notice site
// its own line would not show. Each was read to confirm it does nothing else. `calledFrom` names
// the other files an exported wrapper is called in, which are scanned for it too.
const NOTICE_WRAPPERS: readonly { file: string; name: string; calledFrom?: readonly string[] }[] = [
	{ file: "commands/utility/dero.ts", name: "refuse" },
	{ file: "features/community/communityButtons.ts", name: "replyRefusal" },
	{ file: "features/community/enableCommunity.ts", name: "replyError" },
	{ file: "features/dero-brain/holdemRulesCard.ts", name: "replyPrivately" },
	{ file: "features/setup/rulesEdit.ts", name: "replyPrivately" },
	{ file: "features/community/configureOnboarding.ts", name: "replyOnboardingError", calledFrom: ["features/community/promptEditModal.ts"] },
];

/**
 * A site's kind under owner rule 1. state: a cooldown, a refusal, nothing to do, a closed card
 * or room, a passed turn. failure: something actually failed, so it may keep the error title.
 * answer: a result, a list, a reading or work done, which never stays behind a notice. private:
 * a hand, a fleet, a sealed bid, a secret, kept to the member it belongs to. race: a state only
 * a modal Submit can meet, answered by the private fallback. replaced: a site a later phase
 * removes. unsorted: not yet sorted, which no entry may be since Phase 1c.
 */
type NoticeKind = "state" | "failure" | "answer" | "private" | "race" | "replaced" | "unsorted";

interface NoticeEntry {
	file: string;
	/** The named function the call sits in (`Class.method` inside a class). */
	within: string;
	/** A piece of the call's line that tells it from the function's other sites; absent when the entry covers them all. */
	anchor?: string;
	/** How many sites the entry covers. */
	count?: number;
	kind: NoticeKind;
	/** Why it may stay private: required for private, race and replaced. */
	why?: string;
}

/** One call found in the source. */
interface NoticeSite {
	file: string;
	within: string;
	line: number;
	text: string;
}

const INVENTORY: readonly NoticeEntry[] = [
	// ── game-rooms/challengeBoard.ts ──
	{ file: "features/game-rooms/challengeBoard.ts", within: "offerChallengeDraft", anchor: "gameRoomsCopy.errors.outsideGuild", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "offerChallengeDraft", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "offerChallengeDraft", anchor: "gameRoomsCopy.confirms.matchInPlay(existing.chan", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "offerToFreeSlot", anchor: "gameRoomsCopy.confirms.matchInPlay(existing.chan", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmChallengeDraft", anchor: "gameRoomsCopy.errors.outsideGuild", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmChallengeDraft", anchor: "gameRoomsCopy.errors.controlRetired", kind: "race", why: "the creation modal's Submit for a game with no settings: the router (gatePress) refuses one first, so only a forged Submit meets it" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmChallengeDraft", anchor: "draftRefusalReply(opened", kind: "race", why: "the creation modal's Submit, after its acknowledgement: the press already found the slot free, so a slot taken since, a missing challenge channel, the paid plan and a refused post are read only now (R3-6: a card that posts is followed by no private line)" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openSettingsEditor", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "showRefusalNotice", anchor: "refusal.content", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "showRefusalNotice", anchor: "embed", kind: "failure", why: "the opener's embeds: a create that failed (the error embed) or the paid plan's upgrade embed, titled Game rooms; every state among them is plain text since R3-12" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "chooseDraftSetting", anchor: "applied.refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "chooseVisibility", anchor: "chosen.refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openInvitePicker", anchor: "gameRoomsCopy.board.pickerEmpty", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleInviteSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleInviteSelect", anchor: "gameRoomsCopy.board.notYourChallenge", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "gameRoomsCopy.board.hostCannotJoin", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "gameRoomsCopy.board.alreadyJoined", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "hostWords.approval.alreadyAsked", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "gameRoomsCopy.board.poolFull(BOT_CONSTANTS.GAME_", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "unpaid", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "joinChallenge", anchor: "hostWords.kick.refusedRejoin", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "acceptBuyIn", anchor: "text", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "askHostToJoin", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "startMatch", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmStartMatch", anchor: "refusal", kind: "race", why: "the start confirm's Submit: startMatch refused the same pool first, so a Submit meets it only when the row moved after the press, which passed the same check first" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmStartMatch", anchor: "gameRoomsCopy.confirms.startPickNeeded", kind: "race", why: "the start confirm's Submit: startMatch opens the picker instead when the pool needs one, so only a pool that grew while the confirm stood open meets this" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleOpponentSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "race", why: "the opponent picker's Submit (or its select fallback): the draft ended after the Start press" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleOpponentSelect", anchor: "gameRoomsCopy.board.notYourChallenge", kind: "race", why: "the opponent picker's Submit: the Start press is host strict, so only a forged or replayed Submit is not the host's" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleOpponentSelect", anchor: "gameRoomsCopy.board.poolEmpty", kind: "race", why: "the opponent picker's Submit: the chosen member left or was removed after the picker opened" },
	// The start countdown (2026-10 item 267, decision 13): a second Start while the match counts in.
	{ file: "features/game-rooms/challengeBoard.ts", within: "startMatch", anchor: "gameRoomsCopy.board.countdownRunning", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "confirmStartMatch", anchor: "gameRoomsCopy.board.countdownRunning", kind: "race", why: "the start confirm's Submit: startMatch refuses a Start while the match counts in, so only a confirm opened before another Submit began the count meets this" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleOpponentSelect", anchor: "gameRoomsCopy.board.countdownRunning", kind: "race", why: "the opponent picker's Submit: startMatch refuses a Start while the match counts in, so only a picker opened before the count began meets this" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openAfterCountdown", anchor: "refusal", kind: "race", why: "the end of the start countdown, after the Start's Submit was acknowledged: the pool moved during the ten seconds, so the draft can no longer start as it was" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "rematchFromRoom", anchor: "check.reply", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "playDero", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openBotPicker", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleBotSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "race", why: "the bot count picker's Submit: the draft ended after the Play vs bots press" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleBotSelect", anchor: "gameRoomsCopy.board.onlyHostStarts", kind: "race", why: "the bot count picker's Submit: the press is host strict, so only a forged or replayed Submit is not the host's" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleBotSelect", anchor: "refusal", kind: "race", why: "the bot count picker's Submit: openBotPicker refused bots first, so a Submit meets it only when the row moved after the press, which passed the same check first" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleBotSelect", anchor: "gameRoomsCopy.errors.controlRetired", kind: "race", why: "the bot count picker's Submit with a count no picker offers: only a forged or stale Submit sends one" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "chooseCasual", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "cancelDraft", anchor: "gameRoomsCopy.board.draftGone", kind: "race", why: "Call it off after the router let a draft through: only a start countdown that claimed the draft for play in between meets it (2026-10 item 276, P1-2)" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "answerSoloRefusal", anchor: "sections: [line]", kind: "race", why: "a solo room refused for a held slot after its press was acknowledged: every solo start refuses a held slot at the press (R3-9), so only a slot taken since meets it, and it links the card or room holding it" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "answerOpenRefusal", kind: "race", why: "a room refused after its press was acknowledged: a solo start reads no arcade, a full server and the private ceiling at the press (readSoloRefusalAtPress), so only a change since meets it; a draft start's refusal needs the provisioner's reads" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "provisionFromDraft", anchor: "settled.reason", kind: "race", why: "a host's short wallet for their own seat, read when the start charges it, after its acknowledgement" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openBuyIn", anchor: "gameRoomsCopy.holdem.buyInFreeTable", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "openBuyIn", anchor: "gameRoomsCopy.holdem.buyInLocked", kind: "state" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "handleBuyInModal", anchor: "text", kind: "race", why: "the buy in modal's Submit: openBuyIn refused a free or paid table first; what is left is the row moving after the press, and a typed amount out of range, which only the Submit can read" },

	// ── game-rooms/gameRequestHandlers.ts ──
	{ file: "features/game-rooms/gameRequestHandlers.ts", within: "replyOutsideGuild", anchor: "getPluginCopy(null).gameRequests.outsideGuild", kind: "state" },
	{ file: "features/game-rooms/gameRequestHandlers.ts", within: "removeAsAdmin", anchor: "context.copy.adminOnly", kind: "state" },

	// ── game-rooms/gameRoomHandlers.ts ──
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "gameRoomsCopy.errors.outsideGuild", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "\"This control is no longer available.\"", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "gameRoomsCopy.errors.notFound", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "satelliteWords.hostRoomOnly", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "satelliteWords.notSeatedHere", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "gameRoomsCopy.errors.notYours", count: 2, kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "gatePress", anchor: "gameRoomsCopy.board.onlyHostStarts", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "handleGameRoomButton", anchor: "\"This control is no longer available.\"", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "handleGameRoomButton", anchor: "refusal", count: 3, kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "runConfirmed", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "confirmForfeit", anchor: "refusal", kind: "race", why: "the forfeit confirm's Submit: the Forfeit press runs forfeitRefusal first (R3-6), so a Submit meets it only when the row moved after the press (or a forged id skipped the press), which passed the same check first" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "handleGameRoomConfirm", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/gameRoomHandlers.ts", within: "registerGameRoomHandlers", anchor: "\"This control is no longer available.\"", count: 2, kind: "state" },

	// ── game-rooms/hostControls.ts ──
	{ file: "features/game-rooms/hostControls.ts", within: "loadRoomForHost", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "loadRoomForHost", anchor: "gameRoomsCopy.errors.notFound", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "loadRoomForHost", anchor: "gameRoomsCopy.errors.notYours", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleBandSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleBandSelect", anchor: "choice.refusal", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleSpectatorSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleSpectatorSelect", anchor: "choice.refusal", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "toggleApproval", anchor: "applied.refusal", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "openJoinRequests", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "openJoinRequests", anchor: "words.approval.requestsEmpty", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleJoinRequestSelect", anchor: "gameRoomsCopy.board.draftGone", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleJoinRequestSelect", anchor: "words.approval.requestsEmpty", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "openRemovePicker", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "openRemovePicker", anchor: "words.kick.empty", kind: "state" },
	{ file: "features/game-rooms/hostControls.ts", within: "handleRemoveSelect", anchor: "words.kick.gone", kind: "race", why: "the Remove a player picker's Submit (or its select fallback): the chosen member left or was removed after the picker opened" },

	// ── game-rooms/networkBanSubcommands.ts ──
	{ file: "features/game-rooms/networkBanSubcommands.ts", within: "runNetworkBanSubcommand", anchor: "copy.notOwner", kind: "state" },
	{ file: "features/game-rooms/networkBanSubcommands.ts", within: "runNetworkBanSubcommand", anchor: "copy.unknownSubcommand(`${sub} ${targetKind}`)", kind: "state" },
	{ file: "features/game-rooms/networkBanSubcommands.ts", within: "runNetworkBanSubcommand", anchor: "read.problem", kind: "state" },
	{ file: "features/game-rooms/networkBanSubcommands.ts", within: "runNetworkBanSubcommand", anchor: "embed", kind: "private", why: "the platform owner's cross server ban record, which names a member for the owner's eyes only, like the Verse and render analytics views" },
	{ file: "features/game-rooms/networkBanSubcommands.ts", within: "runNetworkBanSubcommand", anchor: "copy.saveFailed", kind: "failure" },

	// ── game-rooms/networkJoin.ts ──
	{ file: "features/game-rooms/networkJoin.ts", within: "handleNetworkBoardSelect", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/networkJoin.ts", within: "handleNetworkConsentButton", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },

	// ── game-rooms/partyGames.ts ──
	{ file: "features/game-rooms/partyGames.ts", within: "handlePartyGamesButton", anchor: "gameRoomsCopy.partyGames.adminsOnly", kind: "state" },
	{ file: "features/game-rooms/partyGames.ts", within: "handlePartyGamesButton", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/partyGames.ts", within: "hostHangman", anchor: "sections: [pressRefusal]", kind: "state" },
	{ file: "features/game-rooms/partyGames.ts", within: "hostHangman", anchor: "gameRoomsCopy.partyGames.noChannel", kind: "race", why: "the stored 🎉party-games channel is gone, which only the fetch after the acknowledgement can tell" },
	{ file: "features/game-rooms/partyGames.ts", within: "hostHangman", anchor: "gamesCopy.hangman.alreadyRunning", kind: "race", why: "a round started in 🎉party-games since the press checked it" },

	// ── game-rooms/partyGamesSchedule.ts ──
	{ file: "features/game-rooms/partyGamesSchedule.ts", within: "handleRsvpButton", anchor: "[words.gone]", kind: "state" },
	{ file: "features/game-rooms/partyGamesSchedule.ts", within: "handleRsvpButton", anchor: "words.over", kind: "state" },
	{ file: "features/game-rooms/partyGamesSchedule.ts", within: "handleRsvpButton", anchor: "choice === \"yes\" ? words.full : words.gone", kind: "state" },

	// ── game-rooms/roomBattleshipHandlers.ts ──
	{ file: "features/game-rooms/roomBattleshipHandlers.ts", within: "handleViewBoard", anchor: "gameRoomsCopy.battleship.matchOver", kind: "state" },
	{ file: "features/game-rooms/roomBattleshipHandlers.ts", within: "handleRandomize", anchor: "relaid.reason", kind: "state" },
	{ file: "features/game-rooms/roomBattleshipHandlers.ts", within: "handleReady", anchor: "refusal", kind: "state" },

	// ── game-rooms/roomGames.ts ──
	{ file: "features/game-rooms/roomGames.ts", within: "runRoomMove", anchor: "gameRoomsCopy.errors.notFound", kind: "state" },
	{ file: "features/game-rooms/roomGames.ts", within: "runRoomMove", anchor: "\"This game has no room controls yet.\"", kind: "state" },
	{ file: "features/game-rooms/roomGames.ts", within: "promptRpsChoice", anchor: "gameRoomsCopy.games.rpsAlreadyPicked", kind: "state" },
	{ file: "features/game-rooms/roomGames.ts", within: "handleRpsSelect", anchor: "gameRoomsCopy.errors.notFound", kind: "race", why: "the throw picker's Submit (or its select fallback): the match ended after the press" },
	{ file: "features/game-rooms/roomGames.ts", within: "handleRpsSelect", anchor: "gameRoomsCopy.errors.notYours", kind: "race", why: "the throw picker's Submit: the press is players only, so only a forged or replayed Submit is not a player's" },
	{ file: "features/game-rooms/roomGames.ts", within: "handleRpsSelect", anchor: "sections: [refusal]", kind: "race", why: "the throw picker's Submit: promptRpsChoice refused a second pick first, so only a double Submit or a forfeit since the read meets the claim (rpsAlreadyPicked or notFound, 2026-10 item 276)" },
	{ file: "features/game-rooms/roomGames.ts", within: "handleRpsSelect", anchor: "gameRoomsCopy.games.rpsLocked(choice)", kind: "private", why: "names the member's own throw before the reveal; from the picker's Submit it is the private fallback, and the room's public line names nobody's choice" },

	// ── game-rooms/roomHangman.ts ──
	{ file: "features/game-rooms/roomHangman.ts", within: "handleCategorySelect", anchor: "gameRoomsCopy.errors.notFound", count: 2, kind: "state" },
	{ file: "features/game-rooms/roomHangman.ts", within: "handleCategorySelect", anchor: "gameRoomsCopy.errors.notYours", kind: "state" },
	{ file: "features/game-rooms/roomHangman.ts", within: "handleCategorySelect", anchor: "gameRoomsCopy.hangman.wordAlreadySet", kind: "state" },
	{ file: "features/game-rooms/roomHangman.ts", within: "openGuessModal", anchor: "gameRoomsCopy.hangman.waitingForWord(room.hostId", kind: "state" },
	{ file: "features/game-rooms/roomHangman.ts", within: "openGuessModal", anchor: "gameRoomsCopy.hangman.hostCannotGuess", kind: "state" },

	// ── game-rooms/roomHoldemHandlers.ts ──
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleBuyIn", anchor: "joinRefusalText(room, verdict.reason)", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleBuyIn", anchor: "claim.refusal", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "askHostForSeat", anchor: "hostWords.approval.alreadyAsked", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "askHostForSeat", anchor: "hostWords.kick.refusedRejoin", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleDeal", anchor: "gameRoomsCopy.holdem.handInProgress", count: 2, kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleDeal", anchor: "gameRoomsCopy.holdem.needMorePlayers", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleDeal", anchor: "gameRoomsCopy.holdem.tournamentOver", count: 2, kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleMove", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleLeaveTable", anchor: "sections: [refusal]", kind: "race", why: "the Leave confirm's Submit: the Leave press runs leaveRefusal first (R3-6), so a Submit meets it only when the row moved after the press, which passed the same check first" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleLeaveTable", anchor: "gameRoomsCopy.holdem.notSeated", kind: "race", why: "the Leave confirm's Submit: leaveRefusal passed, so the engine refuses only a seat that went out after the press" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleLeaveTable", anchor: "gameRoomsCopy.holdem.tableBusy", kind: "race", why: "the Leave confirm's Submit lost its write to a move that landed first" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleEndTable", anchor: "refusal ?? gameRoomsCopy.holdem.tournamentOver", kind: "race", why: "the End confirm's Submit: the End press runs endRefusal first (R3-6), so a Submit meets it only when the row moved after the press, which passed the same check first" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleEndTable", anchor: "gameRoomsCopy.holdem.tableBusy", kind: "race", why: "the End confirm's Submit lost its claim to a move that landed first" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleImBack", anchor: "gameRoomsCopy.holdem.tournamentOver", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleImBack", anchor: "RETURN_REFUSALS[result.reason]", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleImBack", anchor: "gameRoomsCopy.holdem.tableBusy", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleSeatsToggle", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleSeatsToggle", anchor: "refusal", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleSeatsToggle", anchor: "open ? hostWords.seats.alreadyOpen : hostWords.s", kind: "state" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", within: "handleShowCards", anchor: "gameRoomsCopy.holdem.tournamentOver", kind: "state" },

	// ── game-rooms/roomMonopolyAuction.ts ──
	{ file: "features/game-rooms/roomMonopolyAuction.ts", within: "handleMauction", anchor: "gameRoomsCopy.monopoly.noAuction", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyAuction.ts", within: "handleMauction", anchor: "gameRoomsCopy.monopoly.auctionOver", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyAuction.ts", within: "handleMauction", anchor: "gameRoomsCopy.monopoly.inventoryOut", kind: "state" },

	// ── game-rooms/roomMonopolyBuild.ts ──
	{ file: "features/game-rooms/roomMonopolyBuild.ts", within: "handleMbuild", anchor: "gameRoomsCopy.monopoly.noBoard", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyBuild.ts", within: "handleMbuild", anchor: "gameRoomsCopy.monopoly.nothingToBuild", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyBuild.ts", within: "handleBuildSelect", anchor: "outcome.reason", kind: "state" },

	// ── game-rooms/roomMonopolyHandlers.ts ──
	{ file: "features/game-rooms/roomMonopolyHandlers.ts", within: "loadSeatedRoom", anchor: "gameRoomsCopy.monopoly.matchOver", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyHandlers.ts", within: "loadSeatedRoom", anchor: "gameRoomsCopy.errors.notYours", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyHandlers.ts", within: "handleMjail", anchor: "gameRoomsCopy.errors.controlRetired", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyHandlers.ts", within: "handleMinventory", anchor: "gameRoomsCopy.monopoly.noBoard", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyHandlers.ts", within: "refuse", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyMortgage.ts", within: "runHoldingsSelect", kind: "state" },

	// ── game-rooms/roomMonopolyRefereeNotice.ts ──
	{ file: "features/game-rooms/roomMonopolyRefereeNotice.ts", within: "handleEnableVoice", anchor: "words.enableVoiceAdminOnly", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyRefereeNotice.ts", within: "handleEnableVoice", anchor: "earlyAccessEmbed(access.generalReleaseAt", kind: "state" },
	// ── game-rooms/cardVoice.ts (2026-10 item 267, Queue Dero) ──
	{ file: "features/game-rooms/cardVoice.ts", within: "offerQueue", anchor: "words.alreadyQueued", kind: "state" },
	{ file: "features/game-rooms/cardVoice.ts", within: "offerQueue", anchor: "words.noTarget", kind: "state" },
	{ file: "features/game-rooms/cardVoice.ts", within: "offerQueue", anchor: "words.alreadyThere", kind: "state" },
	{ file: "features/game-rooms/cardVoice.ts", within: "confirmQueue", anchor: "words.noTarget", kind: "race", why: "Queue Dero's Submit: the press answered the same state first, so a Submit meets it only when the host, Dero or the queue moved while the modal stood open (a second Submit meets the place the first took)" },
	{ file: "features/game-rooms/cardVoice.ts", within: "confirmQueue", anchor: "words.alreadyThere", kind: "race", why: "Queue Dero's Submit: the press answered the same state first, so a Submit meets it only when the host, Dero or the queue moved while the modal stood open (a second Submit meets the place the first took)" },
	{ file: "features/game-rooms/cardVoice.ts", within: "confirmQueue", anchor: "words.alreadyQueued", kind: "race", why: "Queue Dero's Submit: the press answered the same state first, so a Submit meets it only when the host, Dero or the queue moved while the modal stood open (a second Submit meets the place the first took)" },

	// ── game-rooms/roomMonopolySurrender.ts ──
	{ file: "features/game-rooms/roomMonopolySurrender.ts", within: "handleMsurrender", anchor: "refusal", kind: "state" },

	// ── game-rooms/roomMonopolyTrade.ts ──
	{ file: "features/game-rooms/roomMonopolyTrade.ts", within: "handleMtrade", anchor: "state ? gameRoomsCopy.monopoly.matchOver : gameR", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", within: "handleMtrade", anchor: "gameRoomsCopy.monopoly.inventoryOut", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", within: "handleMtrade", anchor: "gameRoomsCopy.monopoly.noTradePartners", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", within: "handleTradePartnerSelect", anchor: "gameRoomsCopy.monopoly.matchOver", kind: "state" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", within: "handleTradePartnerSelect", anchor: "gameRoomsCopy.monopoly.noTradePartners", kind: "state" },

	// ── game-rooms/savedMatches.ts ──
	{ file: "features/game-rooms/savedMatches.ts", within: "showMatchHistory", anchor: "copy.outsideGuild", kind: "state" },
	{ file: "features/game-rooms/savedMatches.ts", within: "showMatchHistory", anchor: "copy.botMember", kind: "state" },

	// ── game-rooms/turnPrompt.ts ──
	{ file: "features/game-rooms/turnPrompt.ts", within: "handleTurnPress", anchor: "text", kind: "state" },
	{ file: "features/game-rooms/turnPrompt.ts", within: "handleTurnSubmit", anchor: "text", kind: "race", why: "the turn modal's Submit: handleTurnPress refuses the same turn first, so only a turn that passed while the modal stood open meets it (risk R4)" },
	{ file: "features/game-rooms/turnPrompt.ts", within: "handleTurnMovePress", anchor: "text", kind: "state" },
	{ file: "features/game-rooms/turnPrompt.ts", within: "playTurnMove", anchor: "text", kind: "race", why: "the game refused the move after every check passed: another press or the clock moved the turn between the read and the move's compare and swap" },

	// ── games/arcadeHost.ts ──
	{ file: "features/games/arcadeHost.ts", within: "openSoloRoomForMember", anchor: "describeSoloOpenFailure(refusal)", kind: "state" },
	// A solo Blackjack table's buy in the wallet cannot cover (2026-10 item 267): a state at the press.
	{ file: "features/games/arcadeHost.ts", within: "openSoloRoomForMember", anchor: "blackjackCharge.reason", kind: "state" },

	// ── games/blackjackHandler.ts ──
	{ file: "features/games/blackjackHandler.ts", within: "runBlackjack", anchor: "c.cooldownMessage(Math.ceil(gate.remainingMs / 1", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "runBlackjack", anchor: "sections: [c.outsideGuild]", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "runBlackjack", anchor: "showNotice(interaction, { title: gamesCopy.notices.blackjack, sections: [c.alreadyRunning]", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "runBlackjack", anchor: "showPendingNotice(interaction, answer, { title: gamesCopy.notices.blackjack, sections: [c.alreadyRunning]", kind: "race", why: "a table opened in the channel since the press checked it" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "c.alreadySeated", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "c.tableFull", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "c.notSeated", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "c.hostOnlyDeal", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "seated ? c.notYourTurn : c.notPlaying", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "onClick", anchor: "c.illegalAction", kind: "state" },
	{ file: "features/games/blackjackHandler.ts", within: "leaveDuringHand", anchor: "refusal", kind: "state" },

	// ── games/challengeEntry.ts ──

	// ── games/hangmanHandler.ts ──
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "gamesCopy.hangman.cooldownMessage(Math.ceil(gate", kind: "state" },
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "sections: [gamesCopy.outsideGuild]", kind: "state" },
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "showNotice(interaction, { title: gamesCopy.notices.hangman, sections: [gamesCopy.hangman.alreadyRunning]", kind: "state" },
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "gamesCopy.hangmanInRoom", kind: "state" },
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "showPendingNotice(interaction, answer, { title: gamesCopy.notices.hangman, sections: [gamesCopy.hangman.alreadyRunning]", kind: "race", why: "a round started in the channel since the press checked it" },
	{ file: "features/games/hangmanHandler.ts", within: "onGuessClick", anchor: "(click, { title: gamesCopy.notices.hangman, sections: [gamesCopy.hangman.closed]", kind: "state" },
	{ file: "features/games/hangmanHandler.ts", within: "onGuessClick", anchor: "(submit, { title: gamesCopy.notices.hangman, sections: [gamesCopy.hangman.closed]", kind: "race", why: "the guess modal's Submit: the round ended while the member typed" },
	{ file: "features/games/hangmanHandler.ts", within: "onGuessClick", anchor: "guessRefusal(result)", kind: "race", why: "a letter already tried or a character that is no letter: only the Submit can read what was typed" },

	// ── games/soloLuck.ts ──
	{ file: "features/games/soloLuck.ts", within: "playSoloLuck", anchor: "gamesCopy.outsideGuild", kind: "state" },

	// ── commands/admin/dero-config.ts ──
	{ file: "commands/admin/dero-config.ts", within: "run", anchor: "sections: [c.notInGuild", kind: "state" },
	{ file: "commands/admin/dero-config.ts", within: "run", anchor: "sections: [c.setupRequired", kind: "state" },
	{ file: "commands/admin/dero-config.ts", within: "run", anchor: "c.saveFailed", kind: "failure" },

	// ── commands/admin/leaderboard.ts ──
	{ file: "commands/admin/leaderboard.ts", within: "execute", count: 4, kind: "state" },

	// ── commands/admin/self-destruct.ts ──
	{ file: "commands/admin/self-destruct.ts", within: "execute", kind: "state" },

	// ── commands/admin/setup.ts ──
	{ file: "commands/admin/setup.ts", within: "execute", count: 3, kind: "state" },

	// ── commands/fun/mini-game.ts ──
	{ file: "commands/fun/mini-game.ts", within: "execute", kind: "failure" },

	// ── commands/fun/rating.ts ──
	{ file: "commands/fun/rating.ts", within: "execute", kind: "state" },

	// ── commands/fun/secret-code.ts ──
	{ file: "commands/fun/secret-code.ts", within: "execute", kind: "private", why: "what a secret code did is the member's own secret: posted in a channel it would give the code away to everyone who saw it work" },

	// ── commands/utility/dero.ts ──
	{ file: "commands/utility/dero.ts", within: "refuse", kind: "state" },
	{ file: "commands/utility/dero.ts", within: "tell", count: 8, kind: "state" },
	{ file: "commands/utility/dero.ts", within: "bringDeroIntoCall", count: 4, kind: "state" },
	{ file: "commands/utility/dero.ts", within: "sendDeroAwayFromCall", count: 4, kind: "state" },
	{ file: "commands/utility/dero.ts", within: "sendServerPlanCode", count: 2, kind: "state" },
	{ file: "commands/utility/dero.ts", within: "execute", kind: "failure" },

	// ── command-buttons/adminCommandLauncher.ts ──
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "admitAdmin", count: 2, kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "resolveTarget", kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "runLeaf", kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "showForm", kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "openAdminLaunch", kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "offerSwitchFix", kind: "state" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "handlePanelSubmit", count: 3, kind: "race", why: "the settings panel's Submit for a panel or guild that is gone (the press opened it from a live button, so only a stale or replayed Submit meets it), or a value the panel refuses, which only the Submit can read" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "handleFormSubmit", anchor: "commandButtonsCopy.launcher.staleButton", kind: "race", why: "the command form's Submit whose field mask no longer reads: only a Submit from a form opened before the command changed meets it" },
	{ file: "features/command-buttons/adminCommandLauncher.ts", within: "handleFormSubmit", anchor: "read.problem", kind: "race", why: "the command form's Submit with a value out of range: only the Submit can read it" },

	// ── community/communityButtons.ts ──
	{ file: "features/community/communityButtons.ts", within: "handleCommunityButton", count: 4, kind: "state" },
	{ file: "features/community/communityButtons.ts", within: "replyRefusal", kind: "state" },

	// ── community/configureOnboarding.ts ──
	{ file: "features/community/configureOnboarding.ts", within: "handleConfigureOnboardingButton", count: 2, kind: "state" },
	{ file: "features/community/configureOnboarding.ts", within: "handleConfirmOnboarding", count: 2, kind: "state" },
	// The confirm modal's Submit (2026-10 item 263 R3-20): expired, or a check that changed since Confirm.
	{ file: "features/community/configureOnboarding.ts", within: "handleWriteOnboarding", count: 2, kind: "state" },
	{ file: "features/community/configureOnboarding.ts", within: "replyOnboardingError", kind: "state" },

	// ── community/enableCommunity.ts ──
	{ file: "features/community/enableCommunity.ts", within: "handleEnableClick", count: 2, kind: "state" },
	{ file: "features/community/enableCommunity.ts", within: "handleChannelsPicked", anchor: "communityCopy.errors.expired", kind: "race", why: "the channel picker's Submit after its flow expired or the config went: the press found both" },
	{ file: "features/community/enableCommunity.ts", within: "handleChannelsPicked", anchor: "noWizardPowers", kind: "race", why: "the channel picker's Submit, gated again: an admin role can be taken away while the modal is open" },
	{ file: "features/community/enableCommunity.ts", within: "handleChannelsPicked", anchor: "communityCopy.errors.channelsMissing", kind: "race", why: "the channel picker's Submit with a channel not picked: only the Submit can read it" },
	{ file: "features/community/enableCommunity.ts", within: "handleConfirm", kind: "state" },
	{ file: "features/community/enableCommunity.ts", within: "replyError", kind: "state" },

	// ── community/promptEditModal.ts ──
	{ file: "features/community/promptEditModal.ts", within: "handlePickPrompt", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "handlePickOption", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "handleEditPromptButton", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "openAnswerModal", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "readCurrentDraft", count: 3, kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "applyPressEdit", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "runModalEdit", kind: "state" },
	{ file: "features/community/promptEditModal.ts", within: "handleEditSubmitted", count: 5, kind: "race", why: "an onboarding editor modal's Submit: the press read the same draft and gate first, so only a draft or role that moved while the modal stood open, or a typed edit only the Submit can read, meets it" },

	// ── dero-brain/holdemRulesCard.ts ──
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "replyPrivately", kind: "state" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "passGate", count: 4, kind: "state" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "openTable", kind: "state" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "handleRulesCardButton", kind: "state" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "handleRulesCardSelect", kind: "state" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "handleRulesCardModal", anchor: "cardCopy.expired", kind: "race", why: "the table rules modal's Submit with a customId no card carries: only a stale or forged Submit sends one" },
	{ file: "features/dero-brain/holdemRulesCard.ts", within: "handleRulesCardModal", anchor: "describeTermsRefusal", kind: "race", why: "the table rules modal's Submit with terms out of range: only the Submit can read it" },

	// ── economy/chipClaim.ts ──
	{ file: "features/economy/chipClaim.ts", within: "runChipClaim", anchor: "sections: [copy.notInGuild", kind: "state" },
	{ file: "features/economy/chipClaim.ts", within: "runChipClaim", anchor: "sections: [wait", kind: "state" },
	{ file: "features/economy/chipClaim.ts", within: "runChipClaim", anchor: "copy.failed", kind: "failure" },
	{ file: "features/economy/chipClaim.ts", within: "playClaimRound", anchor: "copy.notInGuild", kind: "race", why: "the daily claim's throw picker Submit: runChipClaim refused outside a server at the press, so only a forged Submit meets it" },
	{ file: "features/economy/chipClaim.ts", within: "playClaimRound", anchor: "copy.failed", kind: "failure" },
	// ── economy/coinMarketPanel.ts, 🏪dero-market (2026-10 item 267 Session 2a) ──
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketPress", anchor: "sections: [copy.notInGuild", kind: "state" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketPress", anchor: "sections: [copy.closed", kind: "state" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketPress", anchor: "sections: [state]", kind: "state" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketPress", anchor: "copy.failed", kind: "failure" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketSubmit", anchor: "sections: [copy.notInGuild", kind: "race", why: "the trade modal's Submit: handleMarketPress refused outside a server at the press, so only a forged Submit meets it" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketSubmit", anchor: "sections: [copy.invalidAmount", kind: "race", why: "the trade modal's Submit: an amount that is no whole number of coins is typed into the modal, so only its Submit can meet it" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketSubmit", anchor: "sections: [copy.closed", kind: "race", why: "the trade modal's Submit: the press refused a server with chips off, so a Submit meets it only when an admin switched chips off while the modal stood open" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketSubmit", anchor: "sections: [refusal]", kind: "race", why: "the trade modal's Submit: the press read the cap, the chips and the coins, so a refusal here means another trade (in any server, since both wallets are global) spent them while the modal stood open, or the amount typed passes what is left" },
	{ file: "features/economy/coinMarketPanel.ts", within: "handleMarketSubmit", anchor: "copy.failed", kind: "failure" },

	// ── economy/chipEconomySubcommands.ts ──
	{ file: "features/economy/chipEconomySubcommands.ts", within: "toggle", kind: "state" },
	{ file: "features/economy/chipEconomySubcommands.ts", within: "runChipSubcommand", anchor: "sections: [copy.notInGuild", kind: "state" },
	{ file: "features/economy/chipEconomySubcommands.ts", within: "runChipSubcommand", anchor: "sections: [copy.setupRequired", kind: "state" },
	{ file: "features/economy/chipEconomySubcommands.ts", within: "runChipSubcommand", anchor: "sections: [copy.economyOff", kind: "state" },
	{ file: "features/economy/chipEconomySubcommands.ts", within: "runChipSubcommand", anchor: "copy.failed", kind: "failure" },

	// ── economy/vaultGrant.ts ──
	{ file: "features/economy/vaultGrant.ts", within: "runVaultGrant", count: 2, kind: "state" },

	// ── events/deleteEvent.ts ──
	{ file: "features/events/deleteEvent.ts", within: "deleteEvent", count: 2, kind: "state" },

	// ── events/kvkSeasonSubcommand.ts ──
	{ file: "features/events/kvkSeasonSubcommand.ts", within: "runKvkSeason", anchor: "sections: [configureReminders.setupRequired", kind: "state" },
	{ file: "features/events/kvkSeasonSubcommand.ts", within: "runKvkSeason", anchor: "sections: [`${configureReminders.invalidInputsHeader}\\n$", kind: "state" },
	{ file: "features/events/kvkSeasonSubcommand.ts", within: "runKvkSeason", anchor: "sections: [`${configureReminders.dateConflictsHeader}\\n$", kind: "state" },
	{ file: "features/events/kvkSeasonSubcommand.ts", within: "runKvkSeason", anchor: "checklistEmptyError", kind: "race", why: "the reminder checklist modal's Submit with nothing ticked: only the Submit can read it" },

	// ── events/listEvents.ts ──
	{ file: "features/events/listEvents.ts", within: "listEvents", kind: "state" },

	// ── fortune/respondWithFortune.ts ──
	{ file: "features/fortune/respondWithFortune.ts", within: "respondWithFortune", kind: "state" },

	// ── leaderboard/configureLeaderboardTracking.ts ──
	{ file: "features/leaderboard/configureLeaderboardTracking.ts", within: "configureLeaderboardTracking", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardTracking.ts", within: "configureLeaderboardTracking", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardTracking.ts", within: "configureLeaderboardTracking", anchor: "embed", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardTracking.ts", within: "configureLeaderboardTracking", anchor: "Could not save the toggle", kind: "failure" },

	// ── leaderboard/configureLeaderboardWeekStart.ts ──
	{ file: "features/leaderboard/configureLeaderboardWeekStart.ts", within: "configureLeaderboardWeekStart", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardWeekStart.ts", within: "configureLeaderboardWeekStart", anchor: "sections: [\"Pick Sunday or Monday from the dropdown.\"", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardWeekStart.ts", within: "configureLeaderboardWeekStart", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardWeekStart.ts", within: "configureLeaderboardWeekStart", anchor: "await showEmbedNotice(interaction, infoEmbed(", kind: "state" },
	{ file: "features/leaderboard/configureLeaderboardWeekStart.ts", within: "configureLeaderboardWeekStart", anchor: "Could not save the setting", kind: "failure" },

	// ── leaderboard/leaderboardChannelHandlers.ts ──
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "sections: [\"This button was issued for a different serve", kind: "state" },
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "sections: [\"You need Administrator permission to remove ", kind: "state" },
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "await showEmbedNotice(interaction, infoEmbed(", kind: "state" },
	{ file: "features/leaderboard/leaderboardChannelHandlers.ts", within: "handleLeaderboardChannelDelete", anchor: "Could not remove the leaderboard channel", kind: "failure" },

	// ── leveling/accountProfile.ts ──
	{ file: "features/leveling/accountProfile.ts", within: "showAccountProfile", count: 4, kind: "state" },

	// ── leveling/achievementsView.ts ──
	{ file: "features/leveling/achievementsView.ts", within: "showAchievements", count: 3, kind: "state" },

	// ── leveling/levelSettingsSubcommands.ts ──
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [levelingCopy.errors.outsideGuild", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [levelingCopy.errors.noData", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [refusal", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [\"Give both a level and a role to add a reward", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "sections: [\"Give a multiplier too. Use 0 to remove an ex", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "showErrorNotice(interaction, levelingCopy.errors.noData", kind: "failure" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "infoEmbed(\"Nothing changed\", \"You did not set an", kind: "state" },
	{ file: "features/leveling/levelSettingsSubcommands.ts", within: "runLevelSettings", anchor: "Could not save those settings", kind: "failure" },

	// ── leveling/levelsStandings.ts ──
	{ file: "features/leveling/levelsStandings.ts", within: "showLevelsStandings", count: 2, kind: "state" },

	// ── leveling/xpSubcommands.ts ──
	{ file: "features/leveling/xpSubcommands.ts", within: "runXpSubcommand", anchor: "sections: [levelingCopy.errors.outsideGuild", kind: "state" },
	{ file: "features/leveling/xpSubcommands.ts", within: "runXpSubcommand", anchor: "sections: [levelingCopy.errors.noData", kind: "state" },
	{ file: "features/leveling/xpSubcommands.ts", within: "runXpSubcommand", anchor: "sections: [levelingCopy.errors.botMember", kind: "state" },
	{ file: "features/leveling/xpSubcommands.ts", within: "runXpSubcommand", anchor: "showErrorNotice(interaction, levelingCopy.errors.noData", kind: "failure" },

	// ── platform/verseSubcommand.ts ──
	{ file: "features/platform/verseSubcommand.ts", within: "runVerseSubcommand", kind: "state" },

	// ── polls/PollDispatcher.ts ──
	{ file: "features/polls/PollDispatcher.ts", within: "handlePollVote", anchor: "sections: [\"This poll is no longer active.\"", kind: "state" },
	{ file: "features/polls/PollDispatcher.ts", within: "handlePollVote", anchor: "sections: [\"Please vote from within the server.\"", kind: "state" },
	{ file: "features/polls/PollDispatcher.ts", within: "handlePollVote", anchor: "is recorded", kind: "private", why: "the member's ballot: a public line naming their pick would end the secret vote a poll button promises" },
	{ file: "features/polls/PollDispatcher.ts", within: "handlePollVote", anchor: "Could not record your vote", kind: "failure" },

	// ── power-ups/PowerUps.ts ──
	{ file: "features/power-ups/PowerUps.ts", within: "handlePowerUpButton", anchor: "sections: [\"This control is no longer available.\"", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "handlePowerUpButton", anchor: "sections: [\"This button only works inside a server.\"", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "handlePowerUpButton", anchor: "sections: [rokCommanderCopy.responses.noWizardPowers", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "handlePowerUpButton", anchor: "This control is not wired up yet.", kind: "failure" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "sections: [\"This only works inside a server.\"", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "sections: [\"This server is not set up yet.\"", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "Could not set up the announcements role", kind: "failure" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "Could not resolve your membership", kind: "failure" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "You're off the announcement ping list", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "You're on the announcement ping list", kind: "state" },
	{ file: "features/power-ups/PowerUps.ts", within: "runToggleNotificationRole", anchor: "Could not update your notifications", kind: "failure" },

	// ── renderer/renderAnalyticsSubcommand.ts ──
	{ file: "features/renderer/renderAnalyticsSubcommand.ts", within: "runRenderAnalyticsSubcommand", kind: "state" },

	// ── schedule/announceStream.ts ──
	{ file: "features/schedule/announceStream.ts", within: "announceStream", count: 4, kind: "state" },

	// ── schedule/configureStreamSchedule.ts ──
	{ file: "features/schedule/configureStreamSchedule.ts", within: "configureStreamSchedule", count: 6, kind: "state" },

	// ── schedule/decreeEditHandlers.ts ──
	{ file: "features/schedule/decreeEditHandlers.ts", within: "handleEditButton", count: 5, kind: "state" },
	{ file: "features/schedule/decreeEditHandlers.ts", within: "refuseEdit", kind: "race", why: "the decree edit modal's Submit: a forged or stale modal, a role taken away or a decree deleted while it stood open, or a value only the Submit can read; a Submit opens no modal, so it is answered privately" },

	// ── schedule/goLiveSoon.ts ──
	{ file: "features/schedule/goLiveSoon.ts", within: "goLiveSoon", kind: "state" },
	{ file: "features/schedule/goLiveSoon.ts", within: "answerGoLiveRefusal", anchor: "c.postFailed", kind: "failure" },
	{ file: "features/schedule/goLiveSoon.ts", within: "answerGoLiveRefusal", anchor: "sections: [message", kind: "state" },

	// ── schedule/pauseAllSchedules.ts ──
	{ file: "features/schedule/pauseAllSchedules.ts", within: "pauseAllSchedules", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/schedule/pauseAllSchedules.ts", within: "pauseAllSchedules", anchor: "sections: [c.noEvents", kind: "state" },
	{ file: "features/schedule/pauseAllSchedules.ts", within: "pauseAllSchedules", anchor: "sections: [c.allAlreadyPaused(events.length)", kind: "state" },
	{ file: "features/schedule/pauseAllSchedules.ts", within: "pauseAllSchedules", anchor: "c.failed", kind: "failure" },

	// ── schedule/pauseSchedule.ts ──
	{ file: "features/schedule/pauseSchedule.ts", within: "pauseOneSchedule", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/schedule/pauseSchedule.ts", within: "pauseOneSchedule", anchor: "sections: [getPluginCopy(config).pauseSchedule.notFound", kind: "state" },
	{ file: "features/schedule/pauseSchedule.ts", within: "pauseOneSchedule", anchor: "sections: [c.alreadyPaused(event.name)", kind: "state" },
	{ file: "features/schedule/pauseSchedule.ts", within: "pauseOneSchedule", anchor: "c.failed", kind: "failure" },

	// ── schedule/resumeAllSchedules.ts ──
	{ file: "features/schedule/resumeAllSchedules.ts", within: "resumeAllSchedules", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/schedule/resumeAllSchedules.ts", within: "resumeAllSchedules", anchor: "sections: [c.noEvents", kind: "state" },
	{ file: "features/schedule/resumeAllSchedules.ts", within: "resumeAllSchedules", anchor: "sections: [c.noneCurrentlyPaused", kind: "state" },
	{ file: "features/schedule/resumeAllSchedules.ts", within: "resumeAllSchedules", anchor: "c.failed", kind: "failure" },

	// ── schedule/resumeSchedule.ts ──
	{ file: "features/schedule/resumeSchedule.ts", within: "resumeOneSchedule", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/schedule/resumeSchedule.ts", within: "resumeOneSchedule", anchor: "sections: [getPluginCopy(config).pauseSchedule.notFound", kind: "state" },
	{ file: "features/schedule/resumeSchedule.ts", within: "resumeOneSchedule", anchor: "sections: [c.alreadyActive(event.name)", kind: "state" },
	{ file: "features/schedule/resumeSchedule.ts", within: "resumeOneSchedule", anchor: "c.failed", kind: "failure" },

	// ── schedule/ScheduleControls.ts ──
	{ file: "features/schedule/ScheduleControls.ts", within: "handleScheduleControl", count: 3, kind: "state" },
	{ file: "features/schedule/ScheduleControls.ts", within: "runConfigureHowTo", kind: "state" },

	// ── setup/adoptionChoice.ts ──
	{ file: "features/setup/adoptionChoice.ts", within: "handleChooseButton", count: 2, kind: "state" },
	{ file: "features/setup/adoptionChoice.ts", within: "handleChoiceSubmit", kind: "race", why: "the channel choice modal's Submit, gated again: an admin role can be taken away while the modal is open" },

	// ── setup/arcadeSettingsSubcommands.ts ──
	{ file: "features/setup/arcadeSettingsSubcommands.ts", within: "runArcadeSettingSubcommand", anchor: "sections: [configCopy.notInGuild", kind: "state" },
	{ file: "features/setup/arcadeSettingsSubcommands.ts", within: "runArcadeSettingSubcommand", anchor: "sections: [configCopy.setupRequired", kind: "state" },
	{ file: "features/setup/arcadeSettingsSubcommands.ts", within: "runArcadeSettingSubcommand", anchor: "configCopy.saveFailed", kind: "failure" },

	// ── setup/channelVisibilitySubcommands.ts ──
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "runChannelsSubcommand", anchor: "sections: [responses.ownerOnly", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "runChannelsSubcommand", anchor: "sections: [responses.setupChannelsPending", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "runChannelsSubcommand", anchor: "\"Unknown subcommand\"", kind: "failure" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleHide", anchor: "sections: [`Pick one of the channels from the dropdown.`", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleHide", anchor: "sections: [`**${displayName}** is already hidden. Use /s", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleHide", anchor: "sections: [`That channel is not configured on this guild", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleHide", anchor: "sections: [`Channel not found in Discord. It may have be", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleHide", anchor: "Failed to update channel permissions.", kind: "failure" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleShow", anchor: "sections: [`Pick one of the channels from the dropdown.`", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleShow", anchor: "sections: [`**${displayName}** is already visible. Use /", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleShow", anchor: "sections: [`That channel is not configured on this guild", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleShow", anchor: "sections: [`Channel not found in Discord.`", kind: "state" },
	{ file: "features/setup/channelVisibilitySubcommands.ts", within: "handleShow", anchor: "Failed to update channel permissions.", kind: "failure" },

	// ── setup/configureAutoHeal.ts ──
	{ file: "features/setup/configureAutoHeal.ts", within: "configureAutoHeal", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/setup/configureAutoHeal.ts", within: "configureAutoHeal", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/setup/configureAutoHeal.ts", within: "configureAutoHeal", anchor: "await showEmbedNotice(interaction, infoEmbed(", kind: "state" },
	{ file: "features/setup/configureAutoHeal.ts", within: "configureAutoHeal", anchor: "Could not save the toggle", kind: "failure" },

	// ── setup/headquartersSteps.ts ──
	{ file: "features/setup/headquartersSteps.ts", within: "handleStepButton", kind: "state" },
	{ file: "features/setup/headquartersSteps.ts", within: "openPriorityModal", kind: "state" },
	{ file: "features/setup/headquartersSteps.ts", within: "handlePrioritySubmit", anchor: "voiceCopy.priority.notAdmin", kind: "race", why: "the voice priority modal's Submit, gated again: an admin role can be taken away while the modal is open" },
	{ file: "features/setup/headquartersSteps.ts", within: "handlePrioritySubmit", anchor: "voiceCopy.priority.duplicate", kind: "race", why: "the voice priority modal's Submit with one category picked twice: only the Submit can read it" },
	{ file: "features/setup/headquartersSteps.ts", within: "openTimezoneModal", kind: "state" },
	{ file: "features/setup/headquartersSteps.ts", within: "handleTimezoneSubmit", anchor: "timezoneCopy.notAdmin", kind: "race", why: "the server timezone modal's Submit, gated again: an admin role can be taken away while the modal is open" },
	{ file: "features/setup/headquartersSteps.ts", within: "handleTimezoneSubmit", anchor: "setupCopy.headquarters.staleStep", kind: "race", why: "the server timezone modal's Submit carrying a zone not on the list: only a crafted Submit can, and only the Submit can read it" },

	// ── setup/renameChannel.ts ──
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "sections: [\"Run this in a server, not a DM.\"", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "sections: [\"Pick a slot from the dropdown, that value is", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "sections: [\"This server has not been set up yet. Run /se", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "sections: [\"That channel slot is not currently set up in", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "sections: [\"Could not find the live channel. It may have", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "await showEmbedNotice(interaction, infoEmbed(", kind: "state" },
	{ file: "features/setup/renameChannel.ts", within: "renameChannel", anchor: "Could not rename the channel", kind: "failure" },

	// ── setup/rulesEdit.ts ──
	{ file: "features/setup/rulesEdit.ts", within: "handleRulesEditButton", count: 2, kind: "state" },
	{ file: "features/setup/rulesEdit.ts", within: "handleRulesEditSubmit", anchor: "rulesEdit.expired", kind: "race", why: "the rules editor's Submit after the config went: the press found it" },
	{ file: "features/setup/rulesEdit.ts", within: "handleRulesEditSubmit", anchor: "noWizardPowers", kind: "race", why: "the rules editor's Submit, gated again: an admin role can be taken away while the modal is open" },
	{ file: "features/setup/rulesEdit.ts", within: "handleRulesEditSubmit", anchor: "rulesEdit.empty", kind: "race", why: "the rules editor's Submit with the post emptied: only the Submit can read it" },
	{ file: "features/setup/rulesEdit.ts", within: "handleRulesEditSubmit", anchor: "rulesEdit.failed", kind: "failure" },
	{ file: "features/setup/rulesEdit.ts", within: "replyPrivately", kind: "state" },

	// ── setup/selfDestruct.ts ──
	{ file: "features/setup/selfDestruct.ts", within: "refuseNonOwner", kind: "state" },
	{ file: "features/setup/selfDestruct.ts", within: "handleSelfDestruct", kind: "state" },
	{ file: "features/setup/selfDestruct.ts", within: "handleSelfDestructModal", kind: "race", why: "the self destruct modal's Submit from outside a server: the press is server only, so only a forged Submit meets it" },
	{ file: "features/setup/selfDestruct.ts", within: "runChoice", kind: "race", why: "the self destruct modal's Submit with a choice no modal offers: only a Submit built from an older modal sends one" },
	{ file: "features/setup/selfDestruct.ts", within: "handleConfirmModal", kind: "race", why: "the confirm modal's Submit with the wrong word typed: only the Submit can read it" },

	// ── suggestion-box/SuggestionBox.ts ──
	{ file: "features/suggestion-box/SuggestionBox.ts", within: "handleModalSubmit", anchor: "suggestionBoxCopy.empty", kind: "race", why: "the suggestion modal's Submit with only blank space typed: only the Submit can read it" },
	{ file: "features/suggestion-box/SuggestionBox.ts", within: "handleModalSubmit", anchor: "suggestionBoxCopy.outsideGuild", kind: "race", why: "the suggestion modal's Submit from outside a server: the command is server only, so only a cache race or a forged Submit meets it" },

	// ── voice/listenHandler.ts ──
	{ file: "features/voice/listenHandler.ts", within: "answeredCooldownAtPress", kind: "state" },

	// ── voice/voiceRoomControlHandlers.ts ──
	{ file: "features/voice/voiceRoomControlHandlers.ts", within: "handleVoiceRoomControl", kind: "state" },
	// The voice queue's 🗒️admin-log buttons (2026-10 item 267): admin only, a stale press, a move at the edge.
	{ file: "features/voice/voiceQueueLog.ts", within: "refuse", kind: "state" },

	// ── main.ts ──
	{ file: "main.ts", within: "gracefulShutdown", anchor: "commandExecuteFailure", count: 4, kind: "failure" },
	{ file: "main.ts", within: "gracefulShutdown", anchor: "sections: [rokCommanderCopy.responses.setupRequired", kind: "state" },
	{ file: "main.ts", within: "gracefulShutdown", anchor: "sections: [rokCommanderCopy.responses.noWizardPowers", kind: "state" },
	{ file: "main.ts", within: "gracefulShutdown", anchor: "earlyAccessEmbed(access.generalReleaseAt", kind: "state" },

	// ── utils/answerInChannel.ts ──
	{ file: "utils/answerInChannel.ts", within: "askerOnly", kind: "state" },
];

// Every error embed handed to a channel answer, which pings its member where it posts. Owner
// rule 1 allows that to a real failure alone, so every entry here is a failure; a state goes
// through a notice helper instead (showPendingNotice once the answer was begun).
const CHANNEL_ERROR_INVENTORY: readonly NoticeEntry[] = [
	{ file: "commands/admin/setup.ts", within: "execute", anchor: "responses.setupFailed", count: 3, kind: "failure" },
	{ file: "commands/utility/dero.ts", within: "tell", anchor: "tellCopy.failed", kind: "failure" },
	{ file: "commands/utility/dero.ts", within: "bringDeroIntoCall", anchor: "callCopy.connectFailed", kind: "failure" },
	{ file: "commands/utility/dero.ts", within: "bringDeroIntoCall", anchor: "tellCopy.failed", kind: "failure" },
	{ file: "features/community/configureOnboarding.ts", within: "handleConfigureOnboardingButton", anchor: "communityCopy.onboarding.readFailed", kind: "failure" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "provisionFromDraft", anchor: "gameRoomsCopy.errors.createFailed", kind: "failure", why: "a blackjack table whose board could not be dealt" },
	{ file: "features/game-rooms/challengeBoard.ts", within: "answerOpenRefusal", kind: "failure", why: "only ROOM_OPEN_FAILURES reach it: a permission Dero lacks, a create Discord refused" },
	{ file: "features/game-rooms/partyGames.ts", within: "hostHangman", anchor: "gameRoomsCopy.partyGames.noChannel", kind: "failure", why: "the round's board could not post in the channel found (startHangmanRound answered failed)" },
	{ file: "features/games/blackjackHandler.ts", within: "runBlackjack", anchor: "c.noChannel", kind: "failure", why: "the table could not post (startBlackjackTable answered failed)" },
	{ file: "features/games/hangmanHandler.ts", within: "runHangman", anchor: "gamesCopy.hangman.noChannel", kind: "failure", why: "the board could not post (startHangmanRound answered failed)" },
	{ file: "features/setup/arcadeSettingsSubcommands.ts", within: "switchArcade", anchor: "arcadeCopy.offFailed : arcadeCopy.onFailed", kind: "failure" },
	{ file: "features/setup/selfDestruct.ts", within: "runArcadeOnly", anchor: "arcadeCopy.offFailed", kind: "failure" },
	{ file: "features/suggestion-box/SuggestionBox.ts", within: "handleModalSubmit", anchor: "Could not send your suggestion", kind: "failure" },
];

// ── the scan ──────────────────────────────────────────────────────────

// A top level function, const or class, and a method inside a class: what names a site's place.
const TOP_LEVEL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(?:export\s+)?(?:const|let)\s+(\w+)\s*[=:]|^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;
const CLASS_METHOD = /^(?:\t| {2}| {4})(?:(?:public|private|protected|static|async|override)\s+)*(\w+)\s*\(/;
const NOT_A_METHOD = new Set(["if", "for", "while", "switch", "return", "await", "catch", "constructor"]);

function sourceFiles(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

// The named function each line sits in (`Class.method` inside a class), by line index.
function enclosingNames(lines: readonly string[]): string[] {
	let topLevel = "(module)";
	let inClass = false;
	let method: string | null = null;
	return lines.map((raw) => {
		const opened = TOP_LEVEL.exec(raw);
		if (opened) {
			topLevel = opened[1] ?? opened[2] ?? opened[3] ?? topLevel;
			inClass = opened[3] !== undefined;
			method = null;
		} else if (inClass) {
			const named = CLASS_METHOD.exec(raw);
			if (named?.[1] && !NOT_A_METHOD.has(named[1])) method = named[1];
		}
		return method ? `${topLevel}.${method}` : topLevel;
	});
}

// Every notice call in one file: its helpers everywhere, a wrapper in the file that defines it and the files it is called from.
function scanFile(file: string, source: string): NoticeSite[] {
	const names = [...NOTICE_HELPERS, ...NOTICE_WRAPPERS.filter((wrapper) => wrapper.file === file || wrapper.calledFrom?.includes(file)).map((wrapper) => wrapper.name)];
	const call = new RegExp(`(?<![\\w.])(?:${names.join("|")})\\(`);
	const declaration = new RegExp(`function\\s+(?:${names.join("|")})\\(`);
	const lines = source.split(/\r?\n/);
	const within = enclosingNames(lines);
	const sites: NoticeSite[] = [];
	lines.forEach((raw, index) => {
		const text = raw.trim();
		if (text.startsWith("//") || text.startsWith("*") || declaration.test(text) || !call.test(text)) return;
		sites.push({ file, within: within[index] ?? "(module)", line: index + 1, text });
	});
	return sites;
}

// ── the channel error scan ────────────────────────────────────────────
// An error embed handed to a channel answer posts in 💬dero-commands (or a Headquarters
// channel) and pings its member there, which owner rule 1 allows a real failure alone: a
// state is a notice (2026-10 item 263). The channel answers are answerInChannel, askInChannel
// and the send of a slow answer begun with beginChannelAnswer (or beginProfileAnswer, which is
// it). A call is read whole across its lines, and an embed built into a variable first is
// caught by the variable's name.
const CHANNEL_ANSWER_CALLS = ["answerInChannel", "askInChannel"];
const PENDING_ANSWER = /(\w+)\s*=\s*await\s+begin\w*Answer\(|(\w+)\s*:\s*PendingChannelAnswer\b/g;
const ERROR_EMBED_VARIABLE = /(\w+)\s*=\s*\[?errorEmbed\(/g;

// The text from an opening parenthesis to its match, so a call spread over lines is read whole.
function callBody(source: string, openAt: number): string {
	let depth = 0;
	for (let index = openAt; index < source.length; index++) {
		if (source[index] === "(") depth++;
		else if (source[index] === ")" && --depth === 0) return source.slice(openAt, index + 1);
	}
	return source.slice(openAt);
}

/** Every channel answer in one file that carries an error embed. */
function scanChannelErrors(file: string, source: string): NoticeSite[] {
	const pending = [...source.matchAll(PENDING_ANSWER)].map((match) => match[1] ?? match[2]).filter((name): name is string => !!name);
	const embedVariables = [...source.matchAll(ERROR_EMBED_VARIABLE)].map((match) => match[1]!);
	const callees = [...CHANNEL_ANSWER_CALLS, ...[...new Set(pending)].map((name) => `${name}\\.send`)];
	const call = new RegExp(`(?<![\\w.])(?:${callees.join("|")})\\(`, "g");
	const carriesError = (body: string): boolean => body.includes("errorEmbed(") || embedVariables.some((name) => new RegExp(`\\b${name}\\b`).test(body));
	const lines = source.split(/\r?\n/);
	const within = enclosingNames(lines);
	const sites: NoticeSite[] = [];
	for (const match of source.matchAll(call)) {
		const body = callBody(source, match.index + match[0].length - 1);
		if (!carriesError(body)) continue;
		const lineIndex = source.slice(0, match.index).split("\n").length - 1;
		sites.push({ file, within: within[lineIndex] ?? "(module)", line: lineIndex + 1, text: `${match[0]}${body.slice(1)}`.replace(/\s+/g, " ") });
	}
	return sites;
}

function scanSource(scan: (file: string, source: string) => NoticeSite[]): NoticeSite[] {
	return sourceFiles(SOURCE_ROOT).flatMap((path) => {
		const file = relative(SOURCE_ROOT, path).split(sep).join("/");
		return file === "utils/textModal.ts" ? [] : scan(file, readFileSync(path, "utf8"));
	});
}

// ── the audit ─────────────────────────────────────────────────────────

const entriesFor = (site: NoticeSite, inventory: readonly NoticeEntry[]): NoticeEntry[] =>
	inventory.filter((entry) => entry.file === site.file && entry.within === site.within && (entry.anchor === undefined || site.text.includes(entry.anchor)));

const describeSite = (site: NoticeSite): string => `${site.file}:${site.line} (${site.within}) ${site.text}`;
const describeEntry = (entry: NoticeEntry): string => `${entry.file} ${entry.within} "${entry.anchor ?? "*"}"`;
const inSortedFolder = (file: string): boolean => SORTED_FOLDERS.some((folder) => file.startsWith(folder));

/** Everything wrong between the sites found and an inventory. Pure, so the failing cases below can feed it made up sites. */
function auditNotices(sites: readonly NoticeSite[], inventory: readonly NoticeEntry[], unsortedAllowed: boolean) {
	return {
		unlisted: sites.filter((site) => entriesFor(site, inventory).length !== 1).map(describeSite),
		stale: inventory
			.map((entry) => ({ entry, matched: sites.filter((site) => entriesFor(site, inventory)[0] === entry).length }))
			.filter(({ entry, matched }) => matched !== (entry.count ?? 1))
			.map(({ entry, matched }) => `${describeEntry(entry)} expected ${entry.count ?? 1}, found ${matched}`),
		answers: inventory.filter((entry) => entry.kind === "answer").map(describeEntry),
		unsorted: inventory.filter((entry) => entry.kind === "unsorted" && (!unsortedAllowed || inSortedFolder(entry.file))).map(describeEntry),
		unexplained: inventory.filter((entry) => ["private", "race", "replaced"].includes(entry.kind) && !entry.why?.trim()).map(describeEntry),
		// Owner rule 1: only a failure keeps the pack's error title, which showErrorNotice always shows.
		errorTitledStates: sites
			.filter((site) => site.text.includes("showErrorNotice("))
			.filter((site) => entriesFor(site, inventory)[0]?.kind !== "failure")
			.map(describeSite),
	};
}

/** Everything wrong between the channel error embeds found and their inventory: the notice audit's listing checks, and any kind but a failure. */
function auditChannelErrors(sites: readonly NoticeSite[], inventory: readonly NoticeEntry[]) {
	const { unlisted, stale } = auditNotices(sites, inventory, false);
	return { unlisted, stale, notFailures: inventory.filter((entry) => entry.kind !== "failure").map(describeEntry) };
}

describe("the channel error inventory", () => {
	const sites = scanSource(scanChannelErrors);
	const audit = auditChannelErrors(sites, CHANNEL_ERROR_INVENTORY);

	it("finds the channel error embeds at all (the scan reads the source tree)", () => {
		expect(sites.length).toBeGreaterThan(10);
	});

	it("lists every error embed handed to a channel answer, each by exactly one entry", () => {
		expect(audit.unlisted).toEqual([]);
	});

	it("matches every entry as many times as it says, so no entry outlives its site", () => {
		expect(audit.stale).toEqual([]);
	});

	it("posts an error embed with its ping for a real failure alone", () => {
		expect(audit.notFailures).toEqual([]);
	});
});

describe("the notice inventory", () => {
	const sites = scanSource(scanFile);
	const audit = auditNotices(sites, INVENTORY, UNSORTED_ALLOWED);

	it("finds the notice sites at all (the scan reads the source tree)", () => {
		expect(sites.length).toBeGreaterThan(300);
	});

	it("lists every notice site, each by exactly one entry", () => {
		expect(audit.unlisted).toEqual([]);
	});

	it("matches every entry as many times as it says, so no entry outlives its site", () => {
		expect(audit.stale).toEqual([]);
	});

	it("holds no answer behind a notice helper", () => {
		expect(audit.answers).toEqual([]);
	});

	it("sorts every site, so none is left unsorted anywhere", () => {
		expect(audit.unsorted).toEqual([]);
	});

	it("gives every private, race and replaced site its reason", () => {
		expect(audit.unexplained).toEqual([]);
	});

	it("keeps the error title for failures alone, in every folder", () => {
		expect(audit.errorTitledStates).toEqual([]);
	});
});

// The deliberately failing cases: made up sites fed through the same audit, proving it
// catches what the real tree must never hold.
describe("the notice inventory's audit", () => {
	const site: NoticeSite = { file: "features/games/example.ts", within: "answerTheMember", line: 1, text: "await showNotice(interaction, { title: t, sections: [gamesCopy.example.result] });" };

	it("fails on an answer listed behind a notice helper", () => {
		const audit = auditNotices([site], [{ file: site.file, within: site.within, kind: "answer" }], true);
		expect(audit.answers).toEqual([`${site.file} answerTheMember "*"`]);
	});

	it("fails on a notice call nobody listed", () => {
		expect(auditNotices([site], [], true).unlisted).toHaveLength(1);
	});

	it("fails on an entry whose site is gone", () => {
		expect(auditNotices([], [{ file: site.file, within: site.within, kind: "state" }], true).stale).toHaveLength(1);
	});

	it("fails on an unsorted site in a sorted folder, and on any unsorted site once Phase 1c forbids them", () => {
		const elsewhere: NoticeEntry = { file: "features/setup/example.ts", within: "x", kind: "unsorted" };
		expect(auditNotices([], [{ file: site.file, within: site.within, kind: "unsorted" }], true).unsorted).toHaveLength(1);
		expect(auditNotices([], [elsewhere], true).unsorted).toEqual([]);
		expect(auditNotices([], [elsewhere], false).unsorted).toHaveLength(1);
	});

	it("fails on a state that keeps the error title", () => {
		const errorSite: NoticeSite = { ...site, text: "await showErrorNotice(interaction, gamesCopy.example.notYourTurn);" };
		expect(auditNotices([errorSite], [{ file: site.file, within: site.within, kind: "state" }], true).errorTitledStates).toHaveLength(1);
	});

	it("names a call by the function it sits in, inside a class too", () => {
		const source = ["export class Panel {", "\tasync open(interaction) {", "\t\tawait showNotice(interaction, words);", "\t}", "}", "async function other() {", "\tawait showErrorNotice(i, m);", "}"].join("\n");
		expect(scanFile("features/x.ts", source).map((found) => found.within)).toEqual(["Panel.open", "other"]);
	});
});

describe("the channel error inventory's audit", () => {
	const source = [
		"async function refuse(interaction) {",
		"\tconst answer = await beginChannelAnswer(interaction, \"member\");",
		"\tawait answer.send({",
		"\t\tembeds: [errorEmbed(copy.notYourTurn)],",
		"\t});",
		"\tconst embed = errorEmbed(copy.full);",
		"\tawait answerInChannel(interaction, \"member\", { embeds: [embed] });",
		"\tawait answer.send({ content: copy.done });",
		"}",
	].join("\n");

	it("finds an error embed in a pending answer's send across lines, and one held in a variable", () => {
		expect(scanChannelErrors("features/x.ts", source).map((found) => [found.within, found.line])).toEqual([
			["refuse", 3],
			["refuse", 7],
		]);
	});

	it("fails on a state listed among the channel error embeds", () => {
		const sites = scanChannelErrors("features/x.ts", source);
		const audit = auditChannelErrors(sites, [{ file: "features/x.ts", within: "refuse", count: 2, kind: "state" }]);
		expect(audit.notFailures).toHaveLength(1);
		expect(auditChannelErrors(sites, []).unlisted).toHaveLength(2);
	});
});
