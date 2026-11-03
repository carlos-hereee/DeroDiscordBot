// src/db/models/EventOverride.ts
import mongoose from "mongoose";
import { v4 } from "uuid";

const Schema = mongoose.Schema;

// ── EventOverride model ─────────────────────────────────────────────
// What:  per-occurrence override of an Event's title, description, or fire
//        time. Anchored on (eventId, originalOccurrence) so the underlying
//        event document is never mutated for an "edit once" action, the
//        override is read at fire time and merged on top of the event
//        payload. "Edit permanently" mutates the event directly and does
//        not write an EventOverride row.
// Who:   written by the apply-once branch of the decree edit flow (slash
//        command + button + modal → eventOverrideStore.create). Read by
//        ReminderJob.fireReminder (override merge before embed render) and
//        by NextUpBoard (override merge for upcoming-decree posts).
// When:  one row per overridden occurrence per event. The unique compound
//        index on (eventId, originalOccurrence) prevents an admin from
//        applying two conflicting overrides to the same fire window.
// Where: external collection in the bot's Mongo. Independent of the Event
//        document so that removing an event also leaves its override
//        history intact for audit purposes.
const eventOverrideSchema = new Schema(
	{
		overrideId: { type: String, required: true, unique: true, default: v4 },
		// FK back to Event. Stored as the application-level eventId (uuid)
		// rather than ObjectId so the override survives a remote-events
		// migration and so the schema matches ReminderLog's eventId shape.
		eventId: { type: String, required: true, ref: "Event", index: true },
		// Guild scope. Mirrors how every other guild-scoped collection
		// stores it; supports a "find all overrides in a guild" query
		// without joining on Event.
		guildId: { type: String, required: true, index: true },
		// The unmodified occurrence Date the override applies to. The
		// scheduler computes the next occurrence per cron tick and queries
		// EventOverride with this exact Date as the anchor, any override
		// that targets a different occurrence of the same event leaves
		// this fire untouched.
		originalOccurrence: { type: Date, required: true },
		// All three override fields are optional so an admin can adjust
		// only one dimension (e.g., shift the fire time without rewriting
		// the title). The merge logic at fire time treats `undefined` as
		// "use the event's value" and a present value as "use this override".
		overrideTitle: { type: String, required: false, default: null },
		overrideDescription: { type: String, required: false, default: null },
		overrideTime: { type: Date, required: false, default: null },
	},
	{ timestamps: true }
);

// ── compound unique index ──
// Enforces the "one override per occurrence" invariant at the DB layer so
// even a race between two admins editing the same decree at the same time
// resolves to a single winner. The store's apply path catches the duplicate
// key error and returns a typed result the caller surfaces as "an override
// already exists for this occurrence, apply via /edit-decree to override
// the override".
eventOverrideSchema.index({ eventId: 1, originalOccurrence: 1 }, { unique: true });

const EventOverrideModel = mongoose.model("EventOverride", eventOverrideSchema);
export default EventOverrideModel;
