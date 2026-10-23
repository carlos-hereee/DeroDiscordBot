// ── /fortune user-facing copy ─────────────────────────────────────────────
// Feature-local copy module. Centralizes every string the command shows so none
// is hardcoded in the handler, WITHOUT threading through the pluginId copy packs
// (the fortune command is not a platform plugin, master plan v3). If it ever
// graduates into a real plugin, this content moves into the pack + copyOverrides
// system so it becomes per-guild voiceable and admin-editable.

export const fortuneCopy = {
	commandDescription: "Ask Dero the Oracle a question and receive a (definitely not real) reading",
	questionOptionDescription: "The question you want Dero to read (optional)",
	privateOptionDescription: "Only you see the reading (default: everyone in the channel sees it)",

	title: "🔮 Dero reads your fortune",
	ultraTitle: "✨ An Ultra Reading ✨",

	// Always shown on both tiers, the "for fun only" guardrail that keeps any
	// answer from reading as real advice.
	disclaimerFooter: "Company Uno • for fun only, not actual advice",

	// Prefixes the echoed question in the embed. The question is only ever
	// rendered inside an embed with mention parsing disabled, so it cannot ping.
	questionLabel: (question: string): string => `*You asked:* ${question}`,

	cooldownMessage: (seconds: number): string =>
		`Dero needs a moment to recharge his crystal ball. Try again in ${seconds}s.`,

	// Words drawn into the fortune scene card (2026-10 item 243 Phase 4). The
	// verdict itself comes from fortunes.ts, so only the frame is here.
	scene: {
		askedBy: "A reading for",
		ultraBadge: "ULTRA",
	},
};

// ── /secret-code user-facing copy ──────────────────────────────────────────
// Same feature-local pattern as fortuneCopy above: centralized, no hardcoded
// strings in the handler. Dero voice, always shown ephemerally.
export const secretCodeCopy = {
	commandDescription: "Redeem a secret code for a permanent luck buff on your readings",
	codeOptionDescription: "The secret phrase you have uncovered",

	// percent is the user's resulting effective ultra chance.
	granted: (percent: number): string =>
		`🔮 The words ring true. Dero tips his crown, and fate bends a little in your favor. Your readings now lean lucky at ${percent} percent. Ask well.`,
	unchanged: (percent: number): string =>
		`Dero knows those words, but the blessing you already carry (${percent} percent) is the stronger one. Your greatest blessing is always the one that remains.`,
	invalid: "Those words mean nothing to the crystal ball. Seek a truer phrase, mortal.",
};
