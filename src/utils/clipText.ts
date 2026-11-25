// ── clipText ────────────────────────────────────────────────────────────────
// What:  members' text cut to fit a message Discord accepts (2026-11 item 420, L13): one text to
//        a length, or a list of texts to one message's room, every line kept.
// Who:   personalReminders' list and todoHandlers' My todos.

const CLIP_MARK = "…";

/** `text`, or its start and a mark that it was cut, never longer than `maxLength`. */
export function clipText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength < CLIP_MARK.length) return "";
	const kept = text.slice(0, maxLength - CLIP_MARK.length);
	// A cut between the two halves of an emoji leaves a lone half that draws as a broken box.
	const endsMidEmoji = /[\uD800-\uDBFF]$/.test(kept);
	return (endsMidEmoji ? kept.slice(0, -1) : kept) + CLIP_MARK;
}

/**
 * One drawn line per text, which joined by newlines fit `room`: each text is clipped to an equal
 * share of what the lines' own words, numbers and links leave. `drawLine` draws a line around its
 * text, and everything it adds survives whole.
 */
export function fitLines(texts: readonly string[], drawLine: (text: string, index: number) => string, room: number): string[] {
	if (texts.length === 0) return [];
	const newlines = texts.length - 1;
	const around = texts.reduce((total, _text, index) => total + drawLine("", index).length, 0);
	const share = Math.max(0, Math.floor((room - newlines - around) / texts.length));
	return texts.map((text, index) => drawLine(clipText(text, share), index));
}
