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

// customId shape: `gameroom:<action>:<roomId>`.
//
// ⚠️ ONLY THE CONTROLS PHASE 3 ACTUALLY HANDLES ARE LISTED. The plan's namespace also
// reserves new / vis / invite / join / start / cancel for the challenge board, and
// `move` for the in-room game controls. None of those have a button that emits them or
// a branch that answers them yet, and declaring them here would make an unknown-control
// reply ("this control is no longer available") impossible to tell from a real gap.
// Phase 4 adds its entries in the same commit as its buttons.
export const GAME_ROOM_ACTIONS = {
	// Delete the room's channel now rather than waiting out the archive window.
	// hostOnly, with the admin override applied in the handler: an admin clearing a
	// room is moderation, and an admin is not a player.
	archive: { hostOnly: true, playersOnly: false },
	// End the match early. playersOnly because a spectator forfeiting someone else's
	// game is the obvious griefing shape, and the room's own players are the only
	// people whose surrender means anything.
	forfeit: { hostOnly: false, playersOnly: true },
} as const satisfies Record<string, { hostOnly: boolean; playersOnly: boolean }>;

export type GameRoomAction = keyof typeof GAME_ROOM_ACTIONS;

// Parse `gameroom:<action>:<roomId>` without trusting either half.
//
// A stale button from an older bot version is the ordinary case here, not an attack:
// customIds live forever in Discord's message history, so a control retired two
// deploys ago is still clickable by anyone scrolling back. Returning null rather than
// throwing is what lets the handler answer honestly instead of crashing.
export function parseGameRoomCustomId(customId: string): { action: GameRoomAction; roomId: string } | null {
	const [prefix, action, roomId] = customId.split(":");
	if (prefix !== GAME_ROOM_PREFIX || !action || !roomId) return null;
	if (!(action in GAME_ROOM_ACTIONS)) return null;
	return { action: action as GameRoomAction, roomId };
}
