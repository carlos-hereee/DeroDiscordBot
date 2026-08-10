import EventOverrideModel from "@db/models/EventOverride.js";

// ── eventOverrideStore ──────────────────────────────────────────────
// Thin Mongoose wrapper for the EventOverride collection. Business logic
// (modal validation, permission gates, Discord rendering) lives in the
// feature module that calls into this store, not here.

interface ICreateEventOverride {
	eventId: string;
	guildId: string;
	originalOccurrence: Date;
	overrideTitle?: string | null;
	overrideDescription?: string | null;
	overrideTime?: Date | null;
}

interface IFindOverrideQuery {
	eventId: string;
	originalOccurrence: Date;
}

export interface IEventOverride {
	overrideId: string;
	eventId: string;
	guildId: string;
	originalOccurrence: Date;
	overrideTitle: string | null;
	overrideDescription: string | null;
	overrideTime: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export const eventOverrideStore = {
	// Used by the apply-once branch of the decree edit flow. Upserts the
	// override row so a re-edit of the same occurrence replaces the prior
	// override values atomically rather than triggering a duplicate-key
	// error on the compound unique index.
	async upsert(data: ICreateEventOverride): Promise<IEventOverride> {
		const doc = await EventOverrideModel.findOneAndUpdate(
			{ eventId: data.eventId, originalOccurrence: data.originalOccurrence },
			{
				$set: {
					guildId: data.guildId,
					overrideTitle: data.overrideTitle ?? null,
					overrideDescription: data.overrideDescription ?? null,
					overrideTime: data.overrideTime ?? null,
				},
				$setOnInsert: {
					eventId: data.eventId,
					originalOccurrence: data.originalOccurrence,
				},
			},
			{ upsert: true, new: true, runValidators: true }
		).lean();
		return doc as unknown as IEventOverride;
	},

	// Used by ReminderJob at fire time and by NextUpBoard at render time
	// to merge override values on top of the event payload before
	// embedding/sending. Returns null when no override exists for the
	// occurrence, the caller treats null as "use the event's values".
	async findOne(query: IFindOverrideQuery): Promise<IEventOverride | null> {
		const doc = await EventOverrideModel.findOne({
			eventId: query.eventId,
			originalOccurrence: query.originalOccurrence,
		}).lean();
		return doc as unknown as IEventOverride | null;
	},

	// Used by NextUpBoard to fetch overrides for a window of upcoming
	// occurrences in a single query. The route returns an empty array
	// (not null) when no overrides exist so the caller can spread it
	// directly into a Map without a null check.
	async findByEventInRange(eventId: string, fromOccurrence: Date, toOccurrence: Date): Promise<IEventOverride[]> {
		const docs = await EventOverrideModel.find({
			eventId,
			originalOccurrence: { $gte: fromOccurrence, $lte: toOccurrence },
		}).lean();
		return docs as unknown as IEventOverride[];
	},
};
