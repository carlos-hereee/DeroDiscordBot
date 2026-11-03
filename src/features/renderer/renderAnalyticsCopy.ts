import type { RenderAnalyticsPeriod, SizingHint } from "./renderAnalytics.js";

// ── render analytics admin copy ──────────────────────────────────────
// Every string /platform analytics and the render digest show. Feature local and outside the copy packs,
// like levelingCopy and gamesCopy, because only the platform owner ever reads it
// and it has no kingdom or streamer voice to choose between (bot rule 5 lets
// admin facing ephemeral copy be practical). It formats; it computes nothing.

const PERIOD_LABELS: Record<RenderAnalyticsPeriod, string> = {
	"this-month": "this month",
	"last-month": "last month",
	"all-time": "all time",
};

const HINT_LABELS: Record<SizingHint, string> = {
	evergreen: "evergreen",
	"long-tail": "long tail",
	none: "no hint",
};

function percent(rate: number | null): string {
	return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function kilobytes(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

export const renderAnalyticsCopy = {
	command: {
		analyticsDescription: "The most served cards, with per surface totals and the memory tier",
		surfaceOption: "One render surface, for example account or level-up",
		periodOption: "Which months to count (default this month)",
		periodChoices: {
			"this-month": "This month",
			"last-month": "Last month",
			"all-time": "All time",
		} satisfies Record<RenderAnalyticsPeriod, string>,
	},
	errors: {
		notOwner: "Only the platform owner can read render analytics. The counts are platform wide, not per server.",
		readFailed: "Render analytics could not be read from the database. Nothing was changed; try again in a minute.",
	},
	periodLabel: (period: RenderAnalyticsPeriod) => PERIOD_LABELS[period],
	title: (period: RenderAnalyticsPeriod, surface: string | null) =>
		surface ? `Render analytics: ${surface}, ${PERIOD_LABELS[period]}` : `Render analytics, ${PERIOD_LABELS[period]}`,
	surfacesHeading: "**Surfaces**",
	memoryHeading: "**Memory tier**",
	topHeading: "**Top 10**",
	noRows: (period: RenderAnalyticsPeriod) => `No render rows for ${PERIOD_LABELS[period]} yet.`,
	noRowsForSurface: (surface: string, period: RenderAnalyticsPeriod) => `No rows for ${surface} in ${PERIOD_LABELS[period]}.`,
	surfaceLine: (line: { surface: string; rows: number; bytes: number; hits: number; draws: number; hitRate: number | null; hint: SizingHint }) =>
		`\`${line.surface}\`: ${line.rows} keys, ${kilobytes(line.bytes)}, ${line.hits} hits, ${line.draws} draws, ` +
		`hit rate ${percent(line.hitRate)}, ${HINT_LABELS[line.hint]}`,
	cardsLine: (count: number, capacity: number) => `Cards in memory: ${count} of ${capacity}`,
	avatarsLine: (count: number, capacity: number) => `Avatars in memory: ${count} of ${capacity}`,
	growMemoryLine: (share: number) => `S3 served more than ${Math.round(share * 100)}% of hits: grow the memory tier.`,
	droppedLine: (count: number) => `Lookups dropped since boot (too many writes pending): ${count}`,
	topLine: (rank: number, row: { surface: string; version: number; keyHash: string; hits: number }) =>
		`${rank}. \`${row.surface}\` v${row.version} \`${row.keyHash}\`: ${row.hits} hits`,
	truncatedNote: "(cut to fit Discord's limit)",
	digestTitle: "Weekly render digest, this month to date",
};
