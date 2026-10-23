import EventModel from "@db/models/Event.js";
import { useRemoteEvents } from "@utils/config.js";
import { remoteEventStore } from "@db/stores/remoteEventStore.js";

// ── eventStore ──
// What: the bot's single entry point for event reads and writes. Delegates either to
//   the local Mongoose `Event` model (legacy) or to the remote nexious-server API
//   (Future-A) based on the USE_REMOTE_EVENTS env flag.
// Who: every slash command, scheduler tick, and HTTP route in this bot.
// When: the flag flips to true AFTER F4's migration script copies existing events from
//   the local Mongo DB to the platform DB. Until then, default-off keeps the bot
//   running on its own DB exactly as before.
// Where: this file is the boundary between business logic and storage. Slash commands
//   never see the local-vs-remote distinction; they get the same shape from either path.
// How: each method peeks at useRemoteEvents and routes accordingly. The remote helpers
//   require guildId for HMAC + ownership checks server-side; the local helpers accept
//   it as a defense-in-depth filter when present.

// Returned events keep field shapes identical between the two paths so callers do not
// need to know which one they're hitting. Mongoose Documents have extra methods (.save(),
// .toObject()) that nothing in the bot currently relies on, confirmed via grep.
type EventLike = {
	eventId: string;
	guildId: string;
	name: string;
	description: string;
	imageUrl: string | null;
	type: "recurring" | "one-time";
	intervalHours: number;
	firstOccurrence: Date;
	seasonEnd: Date | null;
	reminderOffsets: number[];
	prepSteps: { id: string; label: string; order: number }[];
	mentionRoleId: string | null;
	paused: boolean;
	pausedUntil: Date | null;
	active: boolean;
};

export const eventStore = {
	// ── findAll ──
	// Used by the scheduler to scan every guild's events on the cron tick. Local mode
	// queries Mongo directly. Remote mode CANNOT scan globally (the API requires a
	// guildId), so callers must iterate guilds themselves and call findByGuildId. We
	// keep this method on the interface for legacy compatibility but throw loudly under
	// remote mode so the scheduler refactor is forced before the flag flips.
	async findAll(): Promise<EventLike[]> {
		if (useRemoteEvents) {
			// Loud failure rather than silent empty array, scheduler must be refactored
			// to iterate guilds before the flag is enabled.
			throw new Error(
				"eventStore.findAll() is not available under USE_REMOTE_EVENTS, refactor caller to iterate guilds and use findByGuildId"
			);
		}
		return EventModel.find({ active: true }) as unknown as Promise<EventLike[]>;
	},

	// ── findById ──
	// Look up a single event by its eventId. The legacy interface omits guildId, most
	// callers do their own cross-guild check on the returned doc, so we keep that
	// signature, but in remote mode we cannot satisfy a guildId-less call. Fail loudly
	// and require callers to thread the guildId through (see findByIdInGuild below).
	async findById(eventId: string): Promise<EventLike | null> {
		if (useRemoteEvents) {
			throw new Error(
				"eventStore.findById(eventId) requires guildId under USE_REMOTE_EVENTS, call findByIdInGuild(eventId, guildId) instead"
			);
		}
		return EventModel.findOne({ eventId }) as unknown as Promise<EventLike | null>;
	},

	// ── findByIdInGuild ──
	// Guild-scoped variant. Works under both flag states. New code should always prefer
	// this; the legacy findById signature stays for backward compatibility on call
	// sites that are still being refactored.
	async findByIdInGuild(eventId: string, guildId: string): Promise<EventLike | null> {
		if (useRemoteEvents) {
			return remoteEventStore.findByIdInGuild(eventId, guildId) as Promise<EventLike | null>;
		}
		// Local mode: filter by guildId too as defense in depth. The cross-guild guard
		// in slash commands already does this, but doing it at the store layer means
		// future callers cannot accidentally bypass it.
		return EventModel.findOne({ eventId, guildId }) as unknown as Promise<EventLike | null>;
	},

	async findByGuildId(guildId: string): Promise<EventLike[]> {
		if (useRemoteEvents) {
			return remoteEventStore.findByGuildId(guildId) as unknown as Promise<EventLike[]>;
		}
		return EventModel.find({ guildId, active: true }) as unknown as Promise<EventLike[]>;
	},

	// ── create ──
	// data shape varies between callers (/stream setup, /stream announce,
	// GuildEventManager for /configure-kvk-season, and POST /api/events), they all
	// build the document fields inline before calling. Accept the union here; remote mode requires guildId on
	// the input (callers all pass it today).
	async create(data: {
		guildId: string;
		name: string;
		description?: string;
		type: "recurring" | "one-time";
		intervalHours?: number;
		firstOccurrence: Date;
		seasonEnd?: Date | null;
		reminderOffsets?: number[];
		prepSteps?: { id: string; label: string; order: number }[];
		mentionRoleId?: string | null;
		imageUrl?: string | null;
		[key: string]: unknown;
	}): Promise<EventLike> {
		if (useRemoteEvents) {
			return remoteEventStore.create(data) as unknown as Promise<EventLike>;
		}
		return EventModel.create(data) as unknown as Promise<EventLike>;
	},

	// ── update ──
	// Legacy two-arg signature. Local mode tolerates it. Remote mode needs guildId, so
	// callers must use updateInGuild. This method preserves the legacy entry point for
	// the few call sites that haven't been threaded yet, they'll surface the error
	// the moment the flag flips.
	async update(eventId: string, data: Record<string, unknown>): Promise<EventLike | null> {
		if (useRemoteEvents) {
			throw new Error(
				"eventStore.update(eventId, data) requires guildId under USE_REMOTE_EVENTS, call updateInGuild(eventId, guildId, data) instead"
			);
		}
		return EventModel.findOneAndUpdate({ eventId }, { $set: data }, { new: true }) as unknown as Promise<EventLike | null>;
	},

	async updateInGuild(eventId: string, guildId: string, data: Record<string, unknown>): Promise<EventLike | null> {
		if (useRemoteEvents) {
			return remoteEventStore.update(eventId, guildId, data) as unknown as Promise<EventLike | null>;
		}
		// Local mode: scope the update by guildId too. Mongo's findOneAndUpdate with
		// a missing guildId match returns null, same null-on-not-found shape callers
		// already handle.
		return EventModel.findOneAndUpdate(
			{ eventId, guildId },
			{ $set: data },
			{ new: true }
		) as unknown as Promise<EventLike | null>;
	},

	// ── delete (soft) ──
	// Same legacy/in-guild split as update.
	async delete(eventId: string): Promise<EventLike | null> {
		if (useRemoteEvents) {
			throw new Error(
				"eventStore.delete(eventId) requires guildId under USE_REMOTE_EVENTS, call deleteInGuild(eventId, guildId) instead"
			);
		}
		return EventModel.findOneAndUpdate(
			{ eventId },
			{ $set: { active: false } },
			{ new: true }
		) as unknown as Promise<EventLike | null>;
	},

	async deleteInGuild(eventId: string, guildId: string): Promise<EventLike | null> {
		if (useRemoteEvents) {
			return remoteEventStore.delete(eventId, guildId) as unknown as Promise<EventLike | null>;
		}
		return EventModel.findOneAndUpdate(
			{ eventId, guildId },
			{ $set: { active: false } },
			{ new: true }
		) as unknown as Promise<EventLike | null>;
	},
};
