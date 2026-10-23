// ── Fortune response pools ────────────────────────────────────────────────
// Static const arrays, mirroring the greeter's icebreakers.ts pattern: zero
// runtime load, immutable, extended by editing the array. Each entry pairs the
// terse VERDICT shown inside the orb window with the longer Dero-voiced FLAVOR
// shown as the embed text, so the animation and the words always agree. The
// verdict strings MUST match scripts/render-orbs.mjs (the orb file is looked up by
// the verdict's slug), so edit both lists together.
//
// Deliberately NOT threaded through the pluginId copy packs, the fortune reading is a
// plain bot feature, not a Company Uno platform plugin (see the master plan v3 scope).

export type FortuneTier = "common" | "ultra";

export interface Fortune {
	verdict: string; // terse die line in the orb window (matches a rendered orb by slug)
	flavor: string; // longer Dero-voiced line shown as the embed text
}

// The everyday reading. Balanced like the real magic 8 ball but a touch sunnier:
// 11 positive, 5 neutral, 4 negative, so a yes still means something while the toy
// leaves people smiling more often than not. Non-advice by design.
export const COMMON_FORTUNES: Fortune[] = [
	// Positive (11)
	{ verdict: "IT IS CERTAIN", flavor: "Dero nods slowly. It is written, and it is certain." },
	{ verdict: "WITHOUT A DOUBT", flavor: "Yes, and it will be glorious. Without a doubt." },
	{ verdict: "YES DEFINITELY", flavor: "Yes. Do not overthink it." },
	{ verdict: "RELY ON IT", flavor: "The oracle is eighty percent sure. Round up and rely on it." },
	{ verdict: "OUTLOOK GOOD", flavor: "Dero flips through the archive. The outlook is good." },
	{ verdict: "MOST LIKELY", flavor: "The winds whisper: most likely." },
	{ verdict: "SIGNS POINT TO YES", flavor: "Dero consults the ledger. Signs point to yes." },
	{ verdict: "ABSOLUTELY", flavor: "Absolutely, and tell them Dero sent you." },
	{ verdict: "SHIP IT", flavor: "Company Uno says: ship it." },
	{ verdict: "THE RUNES ALIGN", flavor: "The runes align. Proceed, mortal." },
	{ verdict: "DERO APPROVES", flavor: "Bold move. Dero approves." },
	// Neutral (5)
	{ verdict: "ASK AGAIN LATER", flavor: "The scrolls are smudged. Ask again after coffee." },
	{ verdict: "TOO CLOSE TO CALL", flavor: "The council is split. Too close to call." },
	{ verdict: "STILL LOADING", flavor: "The prophecy is still loading. Try again." },
	{ verdict: "A RESOUNDING MAYBE", flavor: "Mortal, the answer is a resounding maybe." },
	{ verdict: "UNCLEAR", flavor: "Dero shrugs in a majestic way. Unclear." },
	// Negative (4)
	{ verdict: "NOT TODAY", flavor: "Not today. The stars are buffering." },
	{ verdict: "MY SOURCES SAY NO", flavor: "No, but respect for asking. My sources say no." },
	{ verdict: "DON'T COUNT ON IT", flavor: "Hard no from the spirits today. Do not count on it." },
	{ verdict: "VERY DOUBTFUL", flavor: "Not without a second opinion, mortal. Very doubtful." },
];

// The rare gold reading. All positive on purpose: gold is the jackpot, so hitting
// it always means good news, which is also what makes the Luck Buff genuinely buy
// luck. Verdicts match scripts/render-orbs.mjs ULTRA_VERDICTS.
export const ULTRA_FORTUNES: Fortune[] = [
	{ verdict: "WITHOUT DOUBT", flavor: "Dero sets down his mug. Even the oracle is sure. Without a doubt." },
	{ verdict: "DESTINY SAYS YES", flavor: "The gold scroll unrolls itself. Destiny says yes, loudly." },
	{ verdict: "THE STARS ALIGN", flavor: "The stars, the ledger, and the vibes all agree. They align for you." },
	{ verdict: "IT IS YOUR MOMENT", flavor: "Dero rarely speaks this clearly. Go. It is your moment." },
	{ verdict: "A CERTAINTY", flavor: "The archive glows gold. This is the timeline where it works out. A certainty." },
	{ verdict: "GO NOW", flavor: "Once in a hundred readings the gold light appears. It appeared for you. Go now." },
];

// Slug a verdict to its rendered orb filename. MUST match the slug in
// scripts/render-orbs.mjs so the bot finds the file the renderer wrote.
export function verdictSlug(verdict: string): string {
	return verdict
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
