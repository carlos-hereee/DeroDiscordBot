import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { deroVoiceSpendStore } from "@db/stores/deroVoiceSpendStore.js";
import { resolveServerPlanAccess } from "@features/entitlements/serverPlanAccess.js";
import { usdToCents } from "./pricing.js";

// ── spend meter ────────────────────────────────────────────────────────────
// What:  reserve speech spend against a guild's monthly cap BEFORE a provider
//        call, and give it back if the call fails.
// Who:   listenHandler and callSpeech for speech out, turnLoop for speech to
//        text. Every paid provider call goes through tryReserve first, with no
//        exceptions.
// When:  only on a clip cache miss. A cache hit costs nothing and never touches
//        the meter.
// Where: the cap is the guild's voice CEILING from the platform server
//        (serverPlanAccess: $2 uncovered, $5 covered by the Dero server plan
//        or a Company Uno subscription, 2026-10 item 262), read at reservation
//        time. A stored DeroVoiceConfig.monthlyCapUsd is read for ONE value
//        only: 0 is still the second kill switch and refuses every call. Any
//        other stored number is ignored, because rows carry the old schema
//        seed and a stored $5 must not outrank an uncovered guild's $2.
// How:   ① compute the UTC month key; ② make sure the month's row exists;
//        ③ one conditional atomic $inc that only matches while the estimate
//        plus this amount still fits under the cap. Two clicks racing at the cap
//        cannot both pass, because the check and the increment are one write.
//        The reservation remembers its month, so a refund that lands after
//        midnight UTC on the 1st still credits the month that was charged.

const MONGO_DUPLICATE_KEY = 11000;
const MONTH_DIGITS = 2;
const KILL_SWITCH_CAP_USD = 0;

export interface SpendReservation {
	guildId: string;
	month: string;
	cents: number;
	ttsChars: number;
	// Present only on a speech to text reservation.
	sttSeconds?: number;
}

export type ReserveResult = { status: "ok"; reservation: SpendReservation } | { status: "capReached" };

/** The "YYYY-MM" key for `now`, always in UTC so every host agrees on the month. */
export function monthKey(now: Date): string {
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(MONTH_DIGITS, "0")}`;
}

// A stored 0 is the kill switch and short circuits before the network read,
// so a switched off guild costs no server call either.
async function capUsdFor(guildId: string, storedCapUsd: number | undefined, now?: Date): Promise<number> {
	if (storedCapUsd === KILL_SWITCH_CAP_USD) return KILL_SWITCH_CAP_USD;
	return (await resolveServerPlanAccess(guildId, now)).voiceCeilingUsd;
}

/**
 * Reserve `cents` of this month's budget. Returns capReached, with nothing
 * written, when the reservation would take the month past the guild's cap.
 * The cap is the server's ceiling for the guild, or 0 when the guild stored 0.
 */
export async function tryReserve(
	guildId: string,
	cents: number,
	options: { ttsChars?: number; sttSeconds?: number; now?: Date } = {}
): Promise<ReserveResult> {
	const month = monthKey(options.now ?? new Date());
	const config = await deroVoiceConfigStore.findByGuildId(guildId);
	const capCents = usdToCents(await capUsdFor(guildId, config?.monthlyCapUsd, options.now));
	// sttSeconds rides along only when there is some, so a speech out
	// reservation keeps exactly the shape it always had.
	const usage = {
		cents,
		ttsChars: options.ttsChars ?? 0,
		...(options.sttSeconds ? { sttSeconds: options.sttSeconds } : {}),
	};

	try {
		await deroVoiceSpendStore.ensureMonth(guildId, month);
	}
	catch (error) {
		// Two first reservations of a month can race the upsert. The loser's
		// duplicate key error means the row now exists, which is all this step
		// needs; anything else is a real failure for the caller.
		if ((error as { code?: number } | null)?.code !== MONGO_DUPLICATE_KEY) throw error;
	}

	const updated = await deroVoiceSpendStore.reserve(guildId, month, capCents, usage);
	if (!updated) return { status: "capReached" };
	return { status: "ok", reservation: { guildId, month, ...usage } };
}

/**
 * Give back a reservation whose provider call failed. Never throws: it runs on a
 * failure path, and a refund error must not replace the provider error the
 * member is about to be told about. A lost refund over counts the estimate,
 * which only makes the cap stricter.
 */
export async function refund(reservation: SpendReservation): Promise<void> {
	try {
		await deroVoiceSpendStore.refund(reservation.guildId, reservation.month, {
			cents: reservation.cents,
			ttsChars: reservation.ttsChars,
			...(reservation.sttSeconds ? { sttSeconds: reservation.sttSeconds } : {}),
		});
	}
	catch (error) {
		console.warn(`[dero-voice] refund failed guild=${reservation.guildId} cents=${reservation.cents}`, error);
	}
}

/** This month's estimate in cents, for /dero-config status. 0 when nothing was spent. */
export async function currentMonthCents(guildId: string, now: Date = new Date()): Promise<number> {
	const row = await deroVoiceSpendStore.findMonth(guildId, monthKey(now));
	return row?.estimatedCents ?? 0;
}
