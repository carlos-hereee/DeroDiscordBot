import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

// ── Listen text ────────────────────────────────────────────────────────────
// What:  turn the post a Listen button rides on into the words Dero speaks.
// Who:   listenHandler, once per click, before the cache lookup (so the cache key
//        is the CLEANED text and two posts that read the same share one clip).
// When:  every Listen press. Pure, no I/O.
// Where: the source is always a message the bot itself authored (the bot may
//        read its own posts without the MessageContent intent). Only the fortune
//        reply and the welcome carry a Listen row, and a fortune with a member's
//        typed question gets none (owner decision 2026-10-14), so nothing here
//        has to tell Dero's words apart from a member's.
// How:   ① take the message content, or the first embed's description when the
//        content is empty; ② drop what speech cannot carry (custom emoji, links,
//        timestamps, emoji pictographs) and say "someone" for a member or role
//        mention; ③ strip markdown markers; ④ cut at the last sentence end that
//        fits the Listen limit, falling back to the last word when no sentence
//        ends inside it.

export interface ListenSourceMessage {
	content: string;
	embeds: ReadonlyArray<{ description: string | null }>;
}

export interface PreparedListenText {
	text: string;
	truncated: boolean;
}

const MENTION_WORD = "someone";
const EVERYONE_WORD = "everyone";

// ② tokens
const USER_OR_ROLE_MENTION = /<@[!&]?\d+>/g;
const CHANNEL_MENTION = /<#\d+>/g;
// </fortune:123> renders as "/fortune"; speak the command name.
const SLASH_COMMAND_MENTION = /<\/([\w -]+):\d+>/g;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const DISCORD_TIMESTAMP = /<t:-?\d+(?::[tTdDfFR])?>/g;
const MASS_MENTION = /@(?:everyone|here)\b/g;
// [label](https://…) keeps the label; a bare or angle bracketed URL is dropped.
const MARKDOWN_LINK = /\[([^\]]*)\]\(<?https?:\/\/[^)]*\)/g;
const BARE_LINK = /<?https?:\/\/[^\s>]+>?/g;
// Unicode emoji, plus the joiner, variation selector and keycap marks that build
// them. Speech engines either skip these or read their names aloud, and neither
// is the post. An alternation rather than a character class: the variation
// selector and the keycap mark are combining characters, which a class would
// visually fuse with their neighbour (eslint no-misleading-character-class).
const PICTOGRAPHS = /\p{Extended_Pictographic}|\u{200D}|\u{FE0F}|\u{20E3}/gu;

// ③ markdown
const CODE_FENCE = /```\w*/g;
// Quote, heading, subtext and list markers at the start of a line.
const LINE_PREFIX = /^[ \t]*(?:>{1,3}|#{1,3}|-#|[-*•])[ \t]+/gm;
const PAIRED_MARKERS = /\*\*|__|~~|\|\||\*|`/g;
// A lone underscore is italics only at a word edge; inside a word (snake_case)
// it is part of the word and stays.
const EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;

const WHITESPACE = /\s+/g;
const SPACE_BEFORE_PUNCTUATION = /\s+([.,!?;:])/g;
// A sentence ends at . ! or ? (closing quotes or brackets may follow), but only
// where whitespace or the end of the text comes next, so "3.5" and "e.g" do not
// count.
const SENTENCE_END = /[.!?]["'”’)\]]*(?=\s|$)/g;

/** ① The text of the post itself: its content, else its first embed's description. */
export function readListenSource(message: ListenSourceMessage): string {
	const content = message.content.trim();
	if (content) return content;
	return message.embeds[0]?.description?.trim() ?? "";
}

/** ② and ③: the post as plain speakable prose, whitespace collapsed. */
export function cleanListenText(raw: string): string {
	return raw
		.replace(MARKDOWN_LINK, "$1")
		.replace(BARE_LINK, "")
		.replace(USER_OR_ROLE_MENTION, MENTION_WORD)
		.replace(MASS_MENTION, EVERYONE_WORD)
		.replace(CHANNEL_MENTION, "")
		.replace(SLASH_COMMAND_MENTION, "/$1")
		.replace(CUSTOM_EMOJI, "")
		.replace(DISCORD_TIMESTAMP, "")
		.replace(PICTOGRAPHS, "")
		.replace(CODE_FENCE, "")
		.replace(LINE_PREFIX, "")
		.replace(PAIRED_MARKERS, "")
		.replace(EDGE_UNDERSCORE, "")
		.replace(WHITESPACE, " ")
		.replace(SPACE_BEFORE_PUNCTUATION, "$1")
		.trim();
}

/** ④ Cut `text` to at most `maxChars`, at a sentence end when one fits. */
export function truncateAtSentence(text: string, maxChars: number): PreparedListenText {
	if (text.length <= maxChars) return { text, truncated: false };

	let cut = -1;
	for (const match of text.matchAll(SENTENCE_END)) {
		const end = (match.index ?? 0) + match[0].length;
		if (end > maxChars) break;
		cut = end;
	}
	if (cut > 0) return { text: text.slice(0, cut).trim(), truncated: true };

	// No sentence ends inside the limit: stop at the last whole word instead of
	// mid word, which speech renders as a garbled fragment.
	const window = text.slice(0, maxChars);
	const lastSpace = window.lastIndexOf(" ");
	return { text: (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim(), truncated: true };
}

/** The whole pipeline: read, clean, cut. An empty `text` means nothing to read. */
export function prepareListenText(
	message: ListenSourceMessage,
	maxChars: number = BOT_CONSTANTS.DERO_VOICE_LISTEN_MAX_CHARS
): PreparedListenText {
	return truncateAtSentence(cleanListenText(readListenSource(message)), maxChars);
}
