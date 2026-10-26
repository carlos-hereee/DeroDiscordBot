// ── gameRoomActions ──────────────────────────────────────────────────
// What:  the customId namespace for every game room control, and the gate each one
//        carries. One registered prefix, sub-routed on the action word, exactly the
//        way POWERUP_ACTIONS routes the folded power-up controls.
// Who:   gameRoomsEmbeds (builds the customIds), gameRoomHandlers (routes them).
// When:  read on every click of a `gameroom:` button.
// Where: its own module rather than living beside the handler, because the embeds
//        need the prefix to BUILD a customId and the handler needs the table to ROUTE
//        one. A single import from both directions would otherwise be a cycle.
// How:   `as const satisfies Record<...>` so a typo in a key is a compile error while
//        the literal key types survive for the handler's lookup.

export const GAME_ROOM_PREFIX = "gameroom";

// The select menu prefix, registered separately from the buttons because the registry
// keys each component type in its own map.
export const GAME_ROOM_SELECT_PREFIX = "gameroomSelect";

// The modal prefix, registered separately again because the registry keys each
// component type in its own map. Used by hangman's authoring and guess modals and by
// Monopoly's trade and sealed bid modals.
export const GAME_ROOM_MODAL_PREFIX = "gameroomModal";

// customId shape: `gameroom:<action>:<tail>[:<arg>]`.
//
// `tail` is a roomId for every action except `new`, which carries a game slug because
// no room exists yet at that point. `arg` is used by `vis`, `auctions`, `referee`, `approval`, `casual`,
// `hmove`, `hseats`, `mbuy`, `mjail`, `mtradeAccept`, `mtradeReject` and `mauction`.
//
// ⚠️ EVERY ENTRY HERE HAS A BUTTON THAT EMITS IT AND A BRANCH THAT ANSWERS IT. Phase 3
// deliberately declared only archive and forfeit for that reason, and Phase 4 adds the
// rest in the same commit as the board that emits them. Keep that property: an action
// listed here with no branch turns the honest "this control is no longer available"
// reply into a lie, and a member cannot tell a retired button from a broken one.
export const GAME_ROOM_ACTIONS = {
	// ── the board (Phase 4) ──
	// Start a challenge. Carries a GAME SLUG, not a roomId: this is the one action
	// that runs before a room exists. Any member may start one, so no gate.
	new: { hostOnly: false, playersOnly: false },
	// Host picks Invite only, Open to all, or Open to the network (2026-10 item 244
	// Phase 5b, which the handler allows the host alone). hostOnly: it is their draft.
	vis: { hostOnly: true, playersOnly: false },
	// Host opens the member picker.
	invite: { hostOnly: true, playersOnly: false },
	// A member volunteers for an open-to-all challenge. Deliberately ungated: the
	// whole point is that anyone may take it up.
	join: { hostOnly: false, playersOnly: false },
	// Host provisions the room from the pool they gathered. HOST_STRICT_ACTIONS below
	// takes the router's admin override away from it.
	start: { hostOnly: true, playersOnly: false },
	// The host plays Dero instead (coin flip, dice roll and rps drafts only): the draft
	// closes and one solo round is played against Dero (post-launch plan item 13).
	// Strict host only, like `start`, since it ends the host's challenge.
	dero: { hostOnly: true, playersOnly: false },
	// Host abandons the draft before it becomes a room.
	cancel: { hostOnly: true, playersOnly: false },
	// Hold'em, Monopoly and Battleship drafts (2026-10 item 250 Phase 5): the host opens the
	// private picker of how many Dero bots sit down at the start. The one door a bot comes
	// through, and the host's alone, so strict like `start`.
	bots: { hostOnly: true, playersOnly: false },
	// The same three drafts (2026-10 item 254, Arcade 6): Rated or Casual, with the value to
	// set in the arg. Casual fills the empty seats with Dero bots, so it is the bot door
	// too and strict like `bots`.
	casual: { hostOnly: true, playersOnly: false },
	// Monopoly drafts only: the host turns auctions on or off for the match, with the
	// value to set in the arg. hostOnly for the same reason as `vis`: it is their draft.
	auctions: { hostOnly: true, playersOnly: false },
	// Monopoly drafts only: the host makes Dero the match's voice referee, or not, the
	// same shape and the same gate as `auctions`.
	referee: { hostOnly: true, playersOnly: false },

	// ── the host controls (2026-10 item 244 Phase 4) ──
	// Every one is the host's, with the router's admin override, and each is re-checked
	// on the select or reply it opens, since those are reachable without the button.
	// Turn approval of each joiner on or off, with the value to set in the arg. A draft
	// control, like `vis`.
	approval: { hostOnly: true, playersOnly: false },
	// Open the private answer panel for the members waiting on approval. On the draft
	// card and on a Hold'em table, so it is not a draft only control.
	requests: { hostOnly: true, playersOnly: false },
	// Open the private picker to remove a member: from the draft's pool before the
	// start, from a Hold'em, Battleship or Monopoly room during play.
	kick: { hostOnly: true, playersOnly: false },

	// ── in the room (Phase 3, plus the game controls Phase 4 adds) ──
	// Delete the room's channel now rather than waiting out the archive window.
	// hostOnly, with the admin override applied in the handler: an admin clearing a
	// room is moderation, and an admin is not a player.
	archive: { hostOnly: true, playersOnly: false },
	// End the match early. playersOnly because a spectator forfeiting someone else's
	// game is the obvious griefing shape, and the room's own players are the only
	// people whose surrender means anything.
	forfeit: { hostOnly: false, playersOnly: true },
	// Start a rematch in the same channel from a FINISHED room's result card. Any player
	// at the table may start it and hosts it, and every player of the finished match is
	// seated again; a spectator may not, for the same reason they cannot forfeit. One
	// per finished room, via rematchedFromRoomId and the channel release claim.
	rematch: { hostOnly: false, playersOnly: true },
	// The in-room game control: the coin/dice button, rps's secret pick prompt, and
	// hangman's guess modal. playersOnly is the whole reason spectators cannot
	// influence a match they are only watching.
	move: { hostOnly: false, playersOnly: true },
	// Hangman only: the host opens the authoring modal to set the word. hostOnly is
	// the point rather than a convenience, since the author is precisely the one
	// person who must not then guess it.
	author: { hostOnly: true, playersOnly: false },
	// Battleship: the pull-based private board (Q8). playersOnly because it renders
	// the viewer's OWN fleet, and a spectator has no fleet to see; it is also the
	// surface that would leak a position if it were ever public, so the gate matters
	// more here than its ephemeral reply already implies.
	board: { hostOnly: false, playersOnly: true },
	// Battleship: re-lay your own fleet, during setup only (post-launch plan item 17).
	reroll: { hostOnly: false, playersOnly: true },
	// Battleship: lock your fleet in. The battle starts when both captains are ready.
	bready: { hostOnly: false, playersOnly: true },

	// ── hold em ──
	// Buying in is how you BECOME a player, so it cannot be playersOnly: that gate
	// reads room.playerIds, which this action is what adds you to.
	hjoin: { hostOnly: false, playersOnly: false },
	// Dealing is the host's call, both for the first hand and every one after.
	hstart: { hostOnly: true, playersOnly: false },
	// Fold, check, call, raise and all in, with the choice in the customId's arg.
	hmove: { hostOnly: false, playersOnly: true },
	// The private peek at your own two cards.
	hcards: { hostOnly: false, playersOnly: true },
	// Leave the table for good: a live hand is folded and the seat is given up.
	// playersOnly, and the handler also requires a seat, because an invite room's
	// playerIds carries invitees who never bought in.
	hleave: { hostOnly: false, playersOnly: true },
	// End the whole table now on the standings as they are. The host's call, like
	// dealing, with the router's usual admin override for clearing a stuck table.
	hend: { hostOnly: true, playersOnly: false },
	// I'm back, for a seat that sits out after two timeouts in a row. playersOnly,
	// and the handler also requires that the clicker's own seat is sitting out.
	hback: { hostOnly: false, playersOnly: true },
	// Set the buy in on a chip table before anybody sits (2026-10 item 250 Phase 5). In
	// HOST_STRICT_ACTIONS: it decides what every player pays from their wallet.
	hbuyin: { hostOnly: true, playersOnly: false },
	// Open seats or Close seats while the tournament runs (2026-10 item 244 Phase 4),
	// with the value to set in the arg. The host's call, like dealing. A late joiner
	// takes a seat through `hjoin`, the same door as Buy in.
	hseats: { hostOnly: true, playersOnly: false },

	// ── monopoly (2026-10 item 241) ──
	// Every one is playersOnly and none is hostOnly: the host is just another seat,
	// and the handler still checks the clicker is the seat on the clock, because
	// playersOnly only proves they are at the table.
	// Roll the dice for your turn.
	mroll: { hostOnly: false, playersOnly: true },
	// Buy the unowned lot you landed on, at list price. The lot id rides the arg so a
	// stale Buy button from an earlier landing cannot buy a lot you are no longer on.
	mbuy: { hostOnly: false, playersOnly: true },
	// Pass on the lot you landed on; it stays with the bank.
	mskip: { hostOnly: false, playersOnly: true },
	// End your turn and hand the clock on.
	mend: { hostOnly: false, playersOnly: true },
	// Get out of jail: pay bail, use a card, or roll for doubles, with the choice in the arg.
	mjail: { hostOnly: false, playersOnly: true },
	// The private peek at your own seat: chips, lots and jail cards, ephemeral. The
	// plan's Session 5b `mcards` peek is this one; a second action would be a
	// duplicate of it (rule 19).
	minventory: { hostOnly: false, playersOnly: true },
	// Open the private build picker. Building is the seat on the clock's, before its
	// roll; the picker and the build both check that.
	mbuild: { hostOnly: false, playersOnly: true },
	// Start a trade, or review the open one. Any seat still in the match may trade at
	// any time (the standard rule), so the handler does NOT require the turn.
	mtrade: { hostOnly: false, playersOnly: true },
	// Answer the open trade: accept is the counterparty's, reject is either party's
	// (declining, or withdrawing an offer). The arg is the trade's openedAt, so an
	// answer button from an older offer cannot settle a newer one.
	mtradeAccept: { hostOnly: false, playersOnly: true },
	mtradeReject: { hostOnly: false, playersOnly: true },
	// Open the sealed bid modal while a lot is up for auction. Every seat still in
	// the match may bid, so the turn is not required either.
	mauction: { hostOnly: false, playersOnly: true },
	// Pay the debt the match is waiting on. The debtor need not be the seat on the
	// clock (a card can charge a rival), so the engine checks the payer, not the turn.
	mpaydebt: { hostOnly: false, playersOnly: true },
} as const satisfies Record<string, { hostOnly: boolean; playersOnly: boolean }>;

export type GameRoomAction = keyof typeof GAME_ROOM_ACTIONS;

// ── the host's alone, with no admin override (post-launch plan item 18) ──
// What:  the hostOnly actions the router does NOT let an admin press for the host.
// Who:   gameRoomHandlers, at the hostOnly gate.
// Where: every other hostOnly action keeps the override, because clearing a stuck room
//        or removing a member is moderation. Starting a match is not: the host decides
//        when their own challenge begins, so an admin pressing Start would play the
//        host's hand for them. An admin may still kick, manage and cancel.
// The table's buy in (2026-10 item 250 Phase 5) is strict for the same reason: it is what
// every player pays from their own wallet, the host's call and nobody else's.
export const HOST_STRICT_ACTIONS: ReadonlySet<GameRoomAction> = new Set<GameRoomAction>(["start", "dero", "hbuyin", "bots", "casual"]);

// ── the controls a satellite may press (2026-10 item 244 Phase 5a) ──
// What:  the actions a member seated through a satellite channel may take there: their
//        own seat's controls at a network Hold'em table, which is the one game a satellite
//        mirrors today. Buy in (or Take a seat), act, peek at their own cards, leave, and
//        come back from sitting out.
// Who:   gameRoomHandlers refuses every other action from a satellite before any gate
//        runs, and satelliteRooms strips every other button from the mirrored table.
// Where: ⚠️ AN ALLOWLIST, NOT "EVERYTHING BUT hostOnly". The router's hostOnly gate grants
//        an admin override through gateOwnerOrAdmin, which reads the CLICKER's permissions,
//        and in a satellite the clicker is a member of another guild: an Administrator of
//        their own server would pass it and run the host's table. A press from a satellite
//        must never reach that gate, and a new action is refused there until somebody
//        decides it belongs here. Satellite tests pin that no entry is hostOnly.
export const SATELLITE_ACTIONS: ReadonlySet<GameRoomAction> = new Set<GameRoomAction>(["hjoin", "hmove", "hcards", "hleave", "hback"]);

export interface ParsedGameRoomCustomId {
	action: GameRoomAction;
	// The roomId for every action but `new`, where it is the game slug instead.
	tail: string;
	// Present on the actions the customId comment above lists. Undefined elsewhere.
	arg?: string;
}

// Parse a game room customId without trusting any part of it.
//
// A stale button from an older bot version is the ordinary case here, not an attack:
// customIds live forever in Discord's message history, so a control retired two
// deploys ago is still clickable by anyone scrolling back. Returning null rather than
// throwing is what lets the handler answer honestly instead of crashing.
export function parseGameRoomCustomId(customId: string): ParsedGameRoomCustomId | null {
	const [prefix, action, tail, arg] = customId.split(":");
	if (prefix !== GAME_ROOM_PREFIX || !action || !tail) return null;
	if (!(action in GAME_ROOM_ACTIONS)) return null;
	return { action: action as GameRoomAction, tail, arg };
}
