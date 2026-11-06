// src/db/stores/ageGateDailyCountStore.ts
import { AgeGateDailyCount } from "@db/models/AgeGateDailyCount.js";

// ── Age gate daily count store ───────────────────────────────────────────
// One method, a single atomic $inc + upsert per day, mirroring the one conditional write
// style chipWalletStore and serverVaultStore already use for a claim: no read, then a
// write, just one write that either creates the day's row or adds to it.

export const ageGateDailyCountStore = {
	async increment(status: "confirmed" | "declined", answeredAt: Date): Promise<void> {
		const date = answeredAt.toISOString().slice(0, 10); // UTC "YYYY-MM-DD"
		await AgeGateDailyCount.findOneAndUpdate({ date }, { $inc: { [status]: 1 } }, { upsert: true });
	},
};
