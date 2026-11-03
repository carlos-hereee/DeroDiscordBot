// ── xpRules ────────────────────────────────────────────────────────────────
// The decisions an earn event needs, kept PURE and separate from the three
// listeners that make them. Same split versusResolve.ts / versusHandler.ts and
// hangmanState.ts / hangmanHandler.ts already draw: no discord.js, no store, no
// I/O, no module state, and the rng is injectable so a test can pin a roll.
//
// What:  may this event earn (restrictions), how much is it worth (the roll and
//        the multipliers), and does the guild's window allow it yet.
// Who:   messageXp and reactionXp for every event; voiceXp for the multiplier
//        half only, since an approved voice channel is its own allow list.
// When:  on the message path, so every function here is arithmetic over data the
//        caller already holds. Nothing here reads anything.
// Where: this is the half of the earn path worth unit testing, and it is exactly
//        the half that is impossible to test through a Discord listener.
//
// ⚠️ NOTHING HERE ACCEPTS MESSAGE TEXT, and that is structural rather than
// incidental. rollXp takes a range and a multiplier and has no parameter a
// message body could be passed through, so per word or length based xp cannot be
// added by accident: it would require deliberately changing a signature. That
// matters because length based xp is the most gameable mode in this category AND
// the only reason the bot would ever need the privileged MessageContent intent,
// which src/main.ts deliberately does not request.

export type RestrictionMode = "exclude" | "only";

export interface MultiplierRule {
	// roleId or channelId, depending on which list this came from.
	id: string;
	multiplier: number;
}

// ── isRestricted ────────────────────────────────────────────────────────────
// One mode plus one list, never a blacklist and a whitelist as siblings.
//
// "exclude" (the default): the list names where xp is NOT earned. An empty list
// means everywhere earns, which is why the default configuration cannot silently
// zero a guild out.
//
// "only": the list names the ONLY places xp is earned. An empty list under this
// mode means NOWHERE earns, which is a real state an admin can reach, so the
// setup command echoes a live preview ("XP is earned in 14 of 17 channels")
// rather than letting them discover it from a member's complaint.
//
// Arcane ships both semantics as adjacent settings and their own restrictions
// page opens with a DANGER banner calling that misconfiguration their largest
// support item, because adding one channel to the whitelist silently kills xp
// everywhere else. One mode plus one list makes that particular mistake
// unrepresentable: there is no second list to disagree with the first.
export function isRestricted(
	mode: RestrictionMode,
	restrictedIds: readonly string[],
	candidateIds: readonly string[]
): boolean {
	const listed = candidateIds.some((id) => restrictedIds.includes(id));
	if (mode === "only") {
		// Nothing configured means nothing qualifies. Stated rather than special
		// cased, because the honest reading of "only these" with an empty list is
		// "only nothing".
		return !listed;
	}
	return listed;
}

// ── resolveMultiplier ───────────────────────────────────────────────────────
// Every rule whose id the member or channel matches, combined by ONE explicit
// stacking rule so two admins reading the same config reach the same number.
//
//   stack = false (the default): the HIGHEST single applicable multiplier wins.
//   stack = true:  applicable multipliers multiply together.
//
// False is the default deliberately. Under stacking, a member holding three
// boosted roles earns a surprising multiple of everyone else, and the surprise
// lands on the admin as "why is this person miles ahead" rather than as a
// setting they remember choosing.
//
// A rule with a non finite or non positive multiplier is IGNORED rather than
// applied, so one bad row edited directly into Mongo cannot zero out or invert a
// guild's earning.
export function resolveMultiplier(rules: readonly MultiplierRule[], matchIds: readonly string[], stack: boolean): number {
	const applicable = rules
		.filter((rule) => matchIds.includes(rule.id))
		.map((rule) => rule.multiplier)
		.filter((multiplier) => Number.isFinite(multiplier) && multiplier > 0);

	if (applicable.length === 0) return 1;
	if (stack) return applicable.reduce((product, multiplier) => product * multiplier, 1);
	return Math.max(...applicable);
}

// ── rollXp ──────────────────────────────────────────────────────────────────
// A random award inside [min, max], multiplied and floored, with a floor of 1 so
// a small multiplier can never make an event worth nothing at all (a member who
// sees "you earned 0" reads the feature as broken).
//
// FLOORS here, where levelCurve ROUNDS. The two are different on purpose: the
// curve's rounding is a pricing decision copied from Arcane and is pinned by
// its own tests, while an award is a payout and flooring it means the bot never
// pays a fraction of a point more than the configured range implies.
//
// rng is injectable and defaults to Math.random, matching versusResolve and
// hangmanState, so a test can pin the exact award rather than assert a range.
export function rollXp(min: number, max: number, multiplier = 1, rng: () => number = Math.random): number {
	// A misconfigured range (max below min, a NaN from a hand edited row) must
	// still pay something sane rather than produce NaN and poison a $inc.
	const low = Number.isFinite(min) && min > 0 ? Math.floor(min) : 1;
	const high = Number.isFinite(max) && max >= low ? Math.floor(max) : low;
	const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

	const base = low + Math.floor(rng() * (high - low + 1));
	return Math.max(1, Math.floor(base * safeMultiplier));
}
