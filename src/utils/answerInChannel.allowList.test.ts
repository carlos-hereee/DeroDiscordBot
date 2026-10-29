import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ── the private reply allow list (2026-10 item 257 Phase 5) ──────────────────
// What:  reruns the private reply audit's grep over every source file and holds each
//        line it finds to this list, which says why that line may still answer privately.
//        Since Phase 5 an answer posts in 💬dero-commands or a Dero Headquarters channel
//        (utils/answerInChannel.ts); the survivors are the fallbacks Discord forces, the
//        one no channel fallback, and private data.
// Why:   a new private reply is the bug the owner's live test found ("Only you can see
//        this • Dismiss message"), and nothing else would notice one slipping back in. A
//        new line fails here until it is routed through answerInChannel or listed with its
//        reason, and a listed line that disappears fails too, so the list never goes stale.
// How:   the grep is companyuno-discord/docs/handoffs/dero-private-reply-audit-2026-10.md's
//        (`MessageFlags.Ephemeral` or `ephemeral: true`), plus every use of a file's PRIVATE
//        flag constant (`...PRIVATE` or `(PRIVATE)`), matched by file and a piece of the line
//        rather than a line number, which moves with every edit above it.

const SOURCE_ROOT = join(__dirname, "..");
const PRIVATE_LINE = /MessageFlags\.Ephemeral|ephemeral: true|\.\.\.PRIVATE\b|\(PRIVATE\)/;

type Reason = "fallback" | "no channel" | "private data";

interface AllowedLine {
	file: string;
	/** A piece of the line, unique enough within its file, or the whole trimmed line with `exact`. */
	contains: string;
	exact?: boolean;
	/** How many lines in the file it covers. */
	count?: number;
	reason: Reason;
	why: string;
}

const ALLOWED: readonly AllowedLine[] = [
	// ── utils/textModal.ts: the notice, the confirm and their fallbacks ──
	{ file: "utils/textModal.ts", contains: ".deferReply({ flags: MessageFlags.Ephemeral })", exact: true, reason: "fallback", why: "acknowledgeTextModal: a modal opened by a slash command cannot deferUpdate, so its close is a private defer deleted at once" },
	{ file: "utils/textModal.ts", contains: "flags: MessageFlags.Ephemeral,", count: 3, reason: "fallback", why: "showNotice's default, showErrorNotice's and confirmFallback's replies, used only when Discord refuses the modal or the interaction can no longer open one" },
	{ file: "utils/textModal.ts", contains: "const fallback = (): InteractionReplyOptions => ({ embeds: [embed], flags: MessageFlags.Ephemeral });", reason: "fallback", why: "showEmbedNotice's fallback, for a refused modal and for an embed with fields or an image a modal cannot show" },

	// ── utils/answerInChannel.ts: the one sanctioned no channel fallback ──
	{ file: "utils/answerInChannel.ts", contains: "await settle(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }), \"the private defer\"", reason: "no channel", why: "beginChannelAnswer with no channel stored (setup not rerun): the slow answer's private defer" },
	{ file: "utils/answerInChannel.ts", contains: "const response = await settle(() => interaction.reply({ ...prompt, flags: MessageFlags.Ephemeral", reason: "no channel", why: "askInChannel with no channel stored: the private prompt every confirm gave before" },
	{ file: "utils/answerInChannel.ts", contains: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });", exact: true, reason: "fallback", why: "acknowledgeQuietly: a slash command answered only in a channel takes a private defer deleted at once" },
	{ file: "utils/answerInChannel.ts", contains: "const reply: InteractionReplyOptions = { ...answer, flags: MessageFlags.Ephemeral", reason: "no channel", why: "answerPrivately: answerInChannel with no channel stored, or a post the channel refused" },

	// ── game-rooms/pickerModal.ts: the select modal's fallbacks ──
	{ file: "features/game-rooms/pickerModal.ts", contains: "flags: MessageFlags.Ephemeral,", reason: "fallback", why: "showPicker's select message, used only when Discord refuses the select modal" },
	{ file: "features/game-rooms/pickerModal.ts", contains: "if (interaction.isModalSubmit()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });", reason: "fallback", why: "a select modal opened by a slash command cannot deferUpdate, so its slow pick takes a private defer" },
	{ file: "features/game-rooms/challengeBoard.ts", contains: "gameRoomsCopy.creation.editUnavailable, flags: MessageFlags.Ephemeral", reason: "fallback", why: "Edit settings' fallback, used only when Discord refuses the settings modal (2026-10 item 263 Phase 2a)" },

	// ── notices whose modal Discord refused ──
	{ file: "features/community/enableCommunity.ts", contains: "flags: MessageFlags.Ephemeral,", reason: "fallback", why: "the Community already on notice's fallback, used only when Discord refuses the modal" },
	{ file: "features/setup/adoptionChoice.ts", contains: "flags: MessageFlags.Ephemeral }));", reason: "fallback", why: "the channel choice modal's fallback, used only when Discord refuses the modal" },
	{ file: "features/setup/headquartersSteps.ts", contains: "flags: MessageFlags.Ephemeral }));", count: 2, reason: "fallback", why: "the voice priority and server timezone modals' fallbacks, used only when Discord refuses the modal" },
	{ file: "features/economy/coinMarketPanel.ts", contains: "copy.modalRefused, flags: MessageFlags.Ephemeral", reason: "fallback", why: "🏪dero-market's trade modal fallback, used only when Discord refuses the modal (2026-10 item 267 Session 2a)" },

	// ── private data: a hand, a fleet, a sealed bid, trade terms ──
	{ file: "features/game-rooms/turnPrompt.ts", contains: "flags: MessageFlags.Ephemeral,", reason: "private data", why: "the turn modal's fallback carries the member's hand, used only when Discord refuses the modal" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", contains: "const PRIVATE = { flags: MessageFlags.Ephemeral } as const;", reason: "private data", why: "the flag for the hole cards fallback below" },
	{ file: "features/game-rooms/roomHoldemHandlers.ts", contains: "...PRIVATE,", reason: "private data", why: "Show cards: the presser's own hole cards, when Discord refuses the private view modal" },
	{ file: "features/game-rooms/roomBattleship.ts", contains: "export const PRIVATE = { flags: MessageFlags.Ephemeral } as const;", reason: "private data", why: "the flag for the private board fallback in roomBattleshipHandlers" },
	{ file: "features/game-rooms/roomBattleshipHandlers.ts", contains: "...PRIVATE,", reason: "private data", why: "View board: the presser's own unfired fleet, when Discord refuses the private view modal" },
	{ file: "features/game-rooms/roomMonopolyAuction.ts", contains: "const PRIVATE = { flags: MessageFlags.Ephemeral } as const;", reason: "private data", why: "the flag for the sealed bid below" },
	{ file: "features/game-rooms/roomMonopolyAuction.ts", contains: "await interaction.deferReply(PRIVATE);", reason: "private data", why: "a Monopoly bid is sealed: its confirmation carries the amount" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", contains: "const PRIVATE = { flags: MessageFlags.Ephemeral } as const;", reason: "private data", why: "the flag for the trade surfaces below (risk M6: the terms never reach a channel before an accept)" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", contains: "openOfferReply(room.roomId, state.pendingTrade,", count: 2, reason: "private data", why: "the open offer's terms, shown only to the two players in it" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", contains: "await interaction.deferReply(PRIVATE);", reason: "private data", why: "the offer modal's answer, whose engine refusal can name a lot in the unaccepted terms" },
	{ file: "features/game-rooms/roomMonopolyTrade.ts", contains: "await interaction.followUp({ embeds: [errorEmbed(outcome.reason)], ...PRIVATE });", reason: "private data", why: "an answer's refusal, which can name a lot in the unaccepted terms" },
	{ file: "features/platform/verseSubcommand.ts", contains: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });", reason: "private data", why: "the platform owner's cross server Verse counts; no Verse metric is ever shown in a server (owner decision 2)" },
	{ file: "features/renderer/renderAnalyticsSubcommand.ts", contains: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });", reason: "private data", why: "the platform owner's cross server render analytics, which no server's admins may read" },
	{ file: "commands/utility/dero.ts", contains: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });", exact: true, reason: "private data", why: "/dero plan hands the server owner a one time claim code; in a channel anyone could redeem it first (2026-10 item 262)" },
	{ file: "features/voice/listenHandler.ts", contains: "await interaction.deferReply({ flags: MessageFlags.Ephemeral });", reason: "private data", why: "Listen reads a post aloud to the presser alone, as the 2.0.0 announcement promises; a clip in a channel would play for everyone" },

	// ── no channel: the answers self destruct gives while it deletes every channel ──
	{ file: "features/setup/selfDestruct.ts", contains: "await interaction.reply({ embeds: [infoEmbed(c.deletingTitle,", count: 2, reason: "no channel", why: "Deleting: posted as every channel it could post in is deleted" },
	{ file: "features/setup/selfDestruct.ts", contains: "await interaction.followUp({ content: c.deleteFailed, flags: MessageFlags.Ephemeral })", count: 2, reason: "no channel", why: "a failed demolish, answered beside the deleting line" },
	{ file: "features/setup/selfDestruct.ts", contains: "await interaction.followUp({ content: c.channelsDone, flags: MessageFlags.Ephemeral })", reason: "no channel", why: "the channels are gone, so there is nowhere left to post" },
	{ file: "features/setup/selfDestruct.ts", contains: ".followUp({ content: failed.length === 0 ? c.deleteDone : c.deletePartial(failed), flags: MessageFlags.Ephemeral })", reason: "no channel", why: "the data is gone with the channels, so there is nowhere left to post" },
];

interface FoundLine {
	file: string;
	line: number;
	text: string;
}

function sourceFiles(folder: string): string[] {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

// Every private reply line in the source, the audit's grep and the PRIVATE uses together.
function grepPrivateLines(): FoundLine[] {
	return sourceFiles(SOURCE_ROOT).flatMap((path) => {
		const file = relative(SOURCE_ROOT, path).split(sep).join("/");
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.map((text, index) => ({ file, line: index + 1, text: text.trim() }))
			.filter(({ text }) => PRIVATE_LINE.test(text) && !text.startsWith("//") && !text.startsWith("*"));
	});
}

// The one entry a line belongs to; a line two entries could claim is a list too vague to trust.
function entriesFor(found: FoundLine): AllowedLine[] {
	return ALLOWED.filter((entry) => entry.file === found.file && (entry.exact ? found.text === entry.contains : found.text.includes(entry.contains)));
}

describe("the private reply allow list", () => {
	const found = grepPrivateLines();

	it("finds the survivors at all (the grep reads the source tree)", () => {
		expect(found.length).toBeGreaterThan(0);
	});

	it("allows every private reply line, each by exactly one reason", () => {
		const unlisted = found.filter((line) => entriesFor(line).length !== 1).map((line) => `${line.file}:${line.line} ${line.text}`);
		expect(unlisted).toEqual([]);
	});

	it("matches every entry as many times as it says, so no entry outlives its line", () => {
		const counts = ALLOWED.map((entry) => ({
			entry: `${entry.file} "${entry.contains}"`,
			expected: entry.count ?? 1,
			actual: found.filter((line) => entriesFor(line)[0] === entry).length,
		}));
		expect(counts.filter((row) => row.actual !== row.expected)).toEqual([]);
	});

	it("gives every entry a reason in words", () => {
		expect(ALLOWED.filter((entry) => entry.why.trim().length === 0)).toEqual([]);
	});
});
