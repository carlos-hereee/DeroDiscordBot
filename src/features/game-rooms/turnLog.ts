import { EmbedBuilder, type Embed } from "discord.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── turnLog ──────────────────────────────────────────────────────────
// What:  the This turn block every game's board carries (2026-10 item 263 R3-29): one turn's
//        moves, newest last, at the bottom of the board embed's description, trimmed to fit
//        Discord's limits; and the split of one move's lines between the turn that just ended
//        and the turn now on the clock.
// Who:   Monopoly (its board, where the block began in item 254), Hold'em, Battleship,
//        Blackjack and Hangman, each building its board embed through turnBlockLines, and
//        turnBoard.postTurnBoard, which writes a finished turn's last lines onto its kept board
//        through setTurnBlock.
// Does NOT: decide what a turn is. Each game says where its turn ends (Monopoly at the turn
//        handoff line, Hold'em at a street, Battleship at a shot, Blackjack at a hand, Hangman
//        at a guess) and hands this module its lines.

// How much of the embed's 4096 character description the turn's lines may take, so the status,
// map and seat lines above them always fit beside a long turn (Monopoly's budget since item 254;
// every other game's description above the block is shorter than Monopoly's).
export const TURN_LINES_BUDGET = 2400;

/**
 * The block for a turn's lines: the This turn header, then every line that fits the budget,
 * newest last, with the count of earlier lines the budget left out. Empty for a turn with no
 * line yet, so a board shows no header over nothing. A turn longer than the budget keeps its
 * newest lines on the board; the ones it leaves out are still in the transcript.
 */
export function turnBlockLines(lines: readonly string[], budget: number = TURN_LINES_BUDGET): string[] {
	if (lines.length === 0) return [];
	const shown: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		used += lines[index].length + 1;
		if (used > budget && shown.length > 0) break;
		shown.unshift(lines[index]);
	}
	const hidden = lines.length - shown.length;
	const copy = gameRoomsCopy.turnBoard;
	return [`**${copy.thisTurnLabel}**`, ...(hidden > 0 ? [copy.earlierThisTurn(hidden)] : []), ...shown];
}

/**
 * `description` with its This turn block replaced by `block`: everything from the block's
 * header line down is cut, and `block` (already labelled the way the room shows lines) is
 * set after one blank line. A description with no block yet gains one; an empty `block`
 * leaves the description without one. The block is always the description's tail, which is
 * what lets a kept board's block be rewritten without rebuilding the rest of the board.
 */
export function withTurnBlock(description: string, block: readonly string[]): string {
	const header = `**${gameRoomsCopy.turnBoard.thisTurnLabel}**`;
	const lines = description.split("\n");
	const at = lines.indexOf(header);
	const head = (at < 0 ? lines : lines.slice(0, at)).join("\n").trimEnd();
	if (block.length === 0) return head;
	return head ? `${head}\n\n${block.join("\n")}` : block.join("\n");
}

/** `embed` (built here or read off a posted message) with its block set to `block`. */
export function setTurnBlock(embed: EmbedBuilder | Embed, block: readonly string[]): EmbedBuilder {
	const builder = embed instanceof EmbedBuilder ? embed : EmbedBuilder.from(embed);
	const description = withTurnBlock(builder.data.description ?? "", block);
	return description ? builder.setDescription(description) : builder.setDescription(null);
}

// ── the split at a turn's end ─────────────────────────────────────────
/** How one move's lines split between the turn that just ended and the turn now on the clock. */
export interface TurnSplit {
	// Every line of the turn that just ended, for its kept board, or null while the turn runs on.
	finishedShown: string[] | null;
	// The lines of this move that belong to the finished turn, which no message carried yet.
	finishedNew: string[];
	// The turn on the clock's lines so far, which its board carries (and the game stores).
	current: string[];
	// The lines of this move that belong to the turn on the clock.
	currentNew: string[];
}

/**
 * Split one move's `lines` against the turn's `earlier` lines. `cut` is where in `lines` a new
 * turn begins: null while the turn runs on (every line joins it), an index when the turn ended
 * on this move (the lines before it close the old turn, the rest open the new one), and
 * `lines.length` when the turn ended with nothing opening yet (Monopoly's last turn).
 */
export function splitTurnAt(earlier: readonly string[], lines: readonly string[], cut: number | null): TurnSplit {
	if (cut === null) return { finishedShown: null, finishedNew: [], current: [...earlier, ...lines], currentNew: [...lines] };
	const finishedNew = lines.slice(0, cut);
	const currentNew = lines.slice(cut);
	return { finishedShown: [...earlier, ...finishedNew], finishedNew, current: currentNew, currentNew };
}
