// ── Dero: Creator Lab copy (2026-11 item 283 Phases 4 and 5) ──
// What:  every line /creator-lab-connect, the analysis DM and the weekly tips DM show. Platform copy, not pack copy:
//        Creator Lab belongs to a creator's Company Uno account rather than to a server, the DM has
//        no guild at all, and the command answers the same wherever it is typed, so there is no
//        guildConfig whose pack could voice it (the serverPlanCopy precedent).
// House rule: no dashes in user facing copy.

export const creatorLabConnectCopy = {
	title: "🔗 Your Creator Lab code",
	code: (code: string, minutes: number): string =>
		[
			`**\`${code}\`**`,
			`Paste it in the Creator Lab tab of your Company Uno dashboard within ${minutes} minutes. A new code replaces this one.`,
			"Once linked, Dero sends you a short read of each new video you analyze, here in your DMs.",
		].join("\n\n"),
	unavailable: "Creator Lab messages from Dero are not switched on yet.",
	failed: "Dero could not make a code just now. Try /creator-lab-connect again in a moment.",
};

export const SENTIMENT_WORDS: Record<string, string> = {
	positive: "🟢 Positive",
	mixed: "🟡 Mixed",
	critical: "🔴 Critical",
};

const PLATFORM_NAMES: Record<string, string> = { youtube: "YouTube", twitch: "Twitch" };

export const analysisDmCopy = {
	title: (videoTitle: string): string => `📊 Creator Lab read: ${videoTitle}`,
	intro: (count: number, platform: string, source: string): string =>
		source === "chat"
			? `Dero read ${count} chat messages from your ${PLATFORM_NAMES[platform] ?? platform} stream. Here is what your viewers kept coming back to.`
			: `Dero read ${count} comments on your ${PLATFORM_NAMES[platform] ?? platform} video. Here is what your viewers kept coming back to.`,
	footer: "Open Creator Lab on your Company Uno dashboard for the full read and your habit loop.",
};

// Phase 5: the weekly growth tips a paid creator with little comment activity gets by DM. The niche
// word reads inside a sentence, so it is lower case; an unknown niche reads as plain "your niche".
const NICHE_WORDS: Record<string, string> = {
	comedy: "comedy",
	gaming: "gaming",
	education: "education",
	music: "music",
	lifestyle: "lifestyle",
	variety: "variety content",
};

export const tipsDmCopy = {
	title: "💡 Your Creator Lab tips this week",
	intro: (niche: string): string =>
		`Your newest videos do not have many comments yet, so Dero cannot read patterns from them. Here is what tends to work in ${NICHE_WORDS[niche] ?? "your niche"}.`,
	tipName: (index: number): string => `Tip ${index + 1}`,
	footer: "New tips arrive each week while your comments grow. Change your niche in Creator Lab on your Company Uno dashboard.",
};
