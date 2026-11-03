// src/db/models/GameRequest.ts
import mongoose from "mongoose";

// ── GameRequest ──
// What:  one row per game a member asked the arcade to add, per guild, with the
//        members who voted for it (2026-10 item 245 Phase 4a). Opened from the
//        "Don't see your favorite game?" button on the 📋arcade-rules card.
// Who:   written and read by features/game-rooms/gameRequests.ts only, through
//        gameRequestStore. Rendered privately to the member who pressed the button.
// Where: guild scoped like every other row here (invariant 2). Deliberately NOT the
//        PollDispatcher's model: a poll has fixed options and a boot broadcast, and
//        this pool grows from what members type.
//
// ⚠️ nameKey IS THE IDENTITY, name IS ONLY THE LABEL. nameKey is the trimmed,
// lowercased name, and the unique index on { guildId, nameKey } is what makes
// "Chess" and "  chess " the same request even when two members add it in the same
// second: the second insert fails with 11000 and is refused as a duplicate.

export interface IGameRequest {
	guildId: string;
	nameKey: string;
	name: string;
	addedBy: string;
	// One entry per member, enforced by $addToSet in the store rather than by a
	// read then write, so a double press cannot vote twice.
	voterIds: string[];
	createdAt: Date;
}

const gameRequestSchema = new mongoose.Schema<IGameRequest>(
	{
		guildId: { type: String, required: true },
		nameKey: { type: String, required: true },
		name: { type: String, required: true },
		addedBy: { type: String, required: true },
		voterIds: { type: [String], default: [] },
	},
	// createdAt breaks a tie in votes (the older request ranks first); nothing reads an
	// updatedAt, so none is kept.
	{ timestamps: { createdAt: true, updatedAt: false } }
);

// ⚠️ REQUIRED, not an optimization: it is the duplicate refusal that holds under a race.
gameRequestSchema.index({ guildId: 1, nameKey: 1 }, { unique: true });

export const GameRequest = mongoose.model<IGameRequest>("GameRequest", gameRequestSchema);
