import mongoose from "mongoose";
import { v4 } from "uuid";

const Schema = mongoose.Schema;

// sub-schema for prep steps with metadata
const prepStepSchema = new Schema({
	id: { type: String, required: true, default: v4 },
	label: { type: String, required: true }, // e.g. "Activate stats token"
	order: { type: Number, required: true }, // display order in the reminder embed
});

const eventSchema = new Schema(
	{
		eventId: { type: String, required: true, unique: true, default: v4 },
		name: { type: String, required: true }, // e.g. "Ruins"
		description: { type: String, default: "" },
		// ── optional event image (v1.6 Phase 4, media attachments) ──────
		// What:  public https URL of an image rendered in this event's Discord
		//        embeds, a large banner on go-live and decree posts, a small
		//        thumbnail on reminders. null means no image and the embeds post
		//        as text exactly as before.
		// Who:   set by the dashboard upload flow (the client + server half of
		//        the media-attachments feature). The bot only persists and
		//        renders it; the create/update handler passes it straight through
		//        and the embed sites read it with GuildConfig.defaultEventImageUrl
		//        as the fallback.
		// When:  optional and additive, legacy events load null and render
		//        unchanged, so no backfill.
		// How:   plain nullable String. URL validation / whitelisting is the
		//        server-and-client half's responsibility; the bot trusts the
		//        stored value (it only ever reaches setImage/setThumbnail).
		imageUrl: { type: String, default: null },
		type: { type: String, required: true, enum: ["recurring", "one-time"] },
		intervalHours: { type: Number, required: true }, // e.g. 36 or 84
		firstOccurrence: { type: Date, required: true }, // anchor point for schedule calculation
		// What:  optional season anchor. KvK events inherit this from
		//        GuildConfig.kvkSeasonEnd at create time so admins never
		//        type the same date twice. Regular announcements (the
		//        new "regular" announcementType) leave it null and never
		//        auto archive, they live until an admin retires them.
		// Who:   ReminderScheduler skips its season-end branch when the
		//        field is null, ScheduleBoard hides the "Season ends"
		//        line for that event, and embedBuilder treats it as
		//        "no season" in the schedule embed.
		// When:  legacy events (created before this change) all have a
		//        Date here, so widening the type is backward compatible.
		// Where: required:false instead of required:true for the new
		//        regular events. Mongoose stores the absent field as
		//        null which the readers above guard against.
		seasonEnd: { type: Date, required: false, default: null },
		reminderOffsets: { type: [Number], default: [30, 15] }, // minutes before event
		// NOTE: there is no per-event channel override. the source of truth for
		// where a reminder posts is guildConfig.announcementsChannelId, resolved
		// fresh by ReminderJob on every fire. this keeps the home base
		// announcement channel as the one place an admin can move reminders,
		// and guarantees legacy documents that still carry a stray channelId
		// field are silently ignored by mongoose strict mode.
		guildId: { type: String, required: true }, // Discord server ID
		prepSteps: { type: [prepStepSchema], default: [] },
		active: { type: Boolean, default: true }, // soft delete flag

		// ── per-event mention role override ────────────────────────────
		// What:  optional role id to ping in place of the guild-wide
		//        memberRoleId when this event fires. Streamer schedules
		//        ping a "stream notifications" subscriber role; ROK KvK
		//        events still ping the alliance member role; one-off
		//        announcements can target a leadership role only.
		// Who:   ReminderJob.fireReminder reads this first, falling back
		//        to GuildConfig.memberRoleId, then @here. TestReminderJob
		//        applies the same precedence so the test fire mirrors the
		//        real fire's mention surface.
		// When:  set at event create time by /stream setup
		//        or any future command that needs a non-default audience.
		//        Legacy events (created before this field existed) load
		//        with null, so the fallback to memberRoleId preserves
		//        existing behavior.
		// Where: nullable string, Mongoose stores absent as null which
		//        the ?? fallback in ReminderJob handles uniformly.
		mentionRoleId: { type: String, required: false, default: null },

		// ── pause flag ─────────────────────────────────────────────────
		// What:  when true, ReminderScheduler skips this event entirely
		//        on every cron tick. The event still exists, still shows
		//        up on the schedule board (with a "paused" tag), still
		//        appears in /event-list, it just does not fire reminders
		//        until /schedule resume flips this back to false (or
		//        pausedUntil expires and the scheduler auto-resumes).
		// Who:   ReminderScheduler (gates the fire decision and handles
		//        the pausedUntil auto-resume), ScheduleBoard (renders the
		//        paused tag), the /schedule pause and /schedule resume
		//        commands (write these fields).
		// When:  flipped on demand by the streamer when they want to take
		//        a week (or several) off.
		// Where: required:false with default:false so legacy events load as
		//        not paused, which matches the old behavior exactly.
		paused: { type: Boolean, required: false, default: false },

		// ── optional pause expiry ──────────────────────────────────────
		// What:  when set together with paused:true, the scheduler will
		//        automatically flip paused back to false on the next cron
		//        tick at or after this date. Persisted (not setTimeout) so
		//        the auto-resume survives a bot restart. Null means
		//        "paused indefinitely", only /schedule resume clears it.
		// Who:   /schedule pause writes this when the streamer passes a
		//        days argument. /schedule resume clears both paused and
		//        pausedUntil. ReminderScheduler reads it.
		// When:  optional. Most streamer pauses will be open-ended ("I'm
		//        going on vacation, I'll resume when I'm back") and leave
		//        this null. The duration arg exists for the case where the
		//        streamer knows the exact return date.
		// Where: nullable so legacy events and indefinite pauses both
		//        load cleanly. Auto-resume runs in ReminderScheduler before
		//        the per-event paused check so a just-expired pause does
		//        not skip its own resume tick.
		pausedUntil: { type: Date, required: false, default: null },
	},
	{ timestamps: true } // adds createdAt + updatedAt automatically
);

// Hot-path index for the reminder scheduler. Every per-minute cron tick runs
// EventModel.find({ guildId, active: true }) once per guild (see eventStore
// .findByGuildId / .findAll). Without this compound index those are collection
// scans, so tick duration grows linearly with the Event collection and
// eventually overruns the 60s budget, the condition the overlap guard in
// ReminderScheduler exists to survive. The field order is { guildId, active }
// because guildId is the high-selectivity equality match and active narrows
// within it; this same index also serves the guild-scoped findByGuildId reads
// the dashboard and ActivityTracker issue. Not unique: a guild legitimately
// has many active events.
eventSchema.index({ guildId: 1, active: 1 });

const EventModel = mongoose.model("Event", eventSchema);
export default EventModel;
