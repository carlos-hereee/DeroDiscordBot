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
// component type in its own map. Used by hangman's authoring and guess modals.
export const GAME_ROOM_MODAL_PREFIX = "gameroomModal";

// customId shape: `gameroom:<action>:<tail>[:<arg>]`.
//
// `tail` is a roomId for every action except `new`, which carries a game slug because
// no room exists yet at that point. `arg` is used only by `vis`.
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
	// Host picks Invite only or Open to all. hostOnly: it is their draft.
	vis: { hostOnly: true, playersOnly: false },
	// Host opens the member picker.
	invite: { hostOnly: true, playersOnly: false },
	// A member volunteers for an open-to-all challenge. Deliberately ungated: the
	// whole point is that anyone may take it up.
	join: { hostOnly: false, playersOnly: false },
	// Host provisions the room from the pool they gathered.
	start: { hostOnly: true, playersOnly: false },
	// Host abandons the draft before it becomes a room.
	cancel: { hostOnly: true, playersOnly: false },

	// ── in the room (Phase 3, plus the game controls Phase 4 adds) ──
	// Delete the room's channel now rather than waiting out the archive window.
	// hostOnly, with the admin override applied in the handler: an admin clearing a
	// room is moderation, and an admin is not a player.
	archive: { hostOnly: true, playersOnly: false },
	// End the match early. playersOnly because a spectator forfeiting someone else's
	// game is the obvious griefing shape, and the room's own players are the only
	// people whose surrender means anything.
	forfeit: { hostOnly: false, playersOnly: true },
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
	// Battleship: re-lay your own fleet, before the first shot only.
	reroll: { hostOnly: false, playersOnly: true },
} as const satisfies Record<string, { hostOnly: boolean; playersOnly: boolean }>;

export type GameRoomAction = keyof typeof GAME_ROOM_ACTIONS;

export interface ParsedGameRoomCustomId {
	action: GameRoomAction;
	// The roomId for every action but `new`, where it is the game slug instead.
	tail: string;
	// Present only on `vis`. Undefined elsewhere.
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
