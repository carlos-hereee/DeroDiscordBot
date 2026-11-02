// ── Dero: Creator Lab copy (2026-11 item 283 Phase 4) ──
// What:  every line /creator-lab-connect and the analysis DM show. Platform copy, not pack copy:
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
