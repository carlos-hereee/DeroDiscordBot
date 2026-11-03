// src/db/models/FortuneBuff.ts
import mongoose from "mongoose";

// ── per-user fortune luck state (FUTURE_PLANS item 88, v1) ──────────────────
// One row per Discord user who has either redeemed a secret code or simply rolled
// a fortune (/mini-game fortune or a Fortune button). Global on purpose (no
// guildId): a user's luck follows them across
// every guild the bot serves and into DMs.
//   • weight    the permanent ultra-reading probability a redeemed code granted
//               (0.19 / 0.43 / 0.83). Absent = the 0.03 base rate. Only the HIGHEST
//               weight earned is kept (fortuneBuffStore.grantIfHigher).
//   • dryStreak consecutive non-gold readings, the pity counter. Resets to 0 on any
//               gold; once it reaches PITY_THRESHOLD the next reading is forced gold.
//   • code      the code that set the current weight, for auditing.
export interface IFortuneBuff {
	userId: string;
	weight?: number;
	dryStreak: number;
	code?: string;
}

const fortuneBuffSchema = new mongoose.Schema<IFortuneBuff>(
	{
		userId: { type: String, required: true, unique: true },
		weight: { type: Number }, // optional: absent means the base rate
		dryStreak: { type: Number, default: 0 },
		code: { type: String },
	},
	{ timestamps: true }
);

export const FortuneBuff = mongoose.model<IFortuneBuff>("FortuneBuff", fortuneBuffSchema);
