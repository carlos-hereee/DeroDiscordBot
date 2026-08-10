// the shape of a game event as it exists in the application layer
// this is what everything outside the DB works with
export interface IGameEvent {
	eventId: string;
	name: string;
	description: string;
	type: "recurring" | "one-time";
	intervalHours: number;
	firstOccurrence: Date;
	// Optional public https image URL rendered in this event's embeds (a banner
	// on go-live + decree, a thumbnail on reminders). Same `?` + `| null` shape
	// as seasonEnd / mentionRoleId: Mongoose marks `required:false, default:null`
	// fields as truly optional in the inferred document type, and every read site
	// treats undefined and null identically as "no image".
	imageUrl?: string | null;
	// nullable AND optional: KvK events have a season anchor (inherited
	// from GuildConfig.kvkSeasonEnd at create time), regular announcements
	// leave it null and never auto archive. ReminderScheduler and
	// ScheduleBoard guard with truthy checks before reading it.
	//
	// The `?` (optional property) is required, not just `| undefined`.
	// Mongoose's inferred document type marks the field as truly optional
	// when the schema sets `required: false`, and TypeScript distinguishes
	// `T | undefined` (required prop, may be undefined) from `T?` (prop
	// may be absent). Without `?` here every Mongoose-typed event flowing
	// into a function that takes IGameEvent fails with TS2345
	// ("property is optional in source but required in target"). Treat
	// undefined the same as null at every read site, there is no
	// semantic difference between "field absent" and "field explicitly null".
	seasonEnd?: Date | null;
	reminderOffsets: readonly number[]; // ← was number[]
	// NOTE: there is no per-event channel field. reminders always post to the
	// guild's announcements channel, resolved at fire time from GuildConfig.
	// keeping this invariant at the type level prevents a future UI from
	// accidentally reintroducing a channel picker on the event form.
	guildId: string;
	prepSteps: readonly IPrepStep[]; // ← was IPrepStep[]
	active: boolean;
	// Optional per-event override of the role mentioned when this fires.
	// Same `?` reasoning as seasonEnd above: Mongoose's inferred document
	// type marks `required: false` fields as truly optional (T?), so the
	// interface must use `?` not `| undefined` or call sites that read a
	// freshly fetched document fail with TS2345. ReminderJob and
	// TestReminderJob both treat undefined and null identically and fall
	// back to GuildConfig.memberRoleId.
	mentionRoleId?: string | null;
	// Pause flag, when true, ReminderScheduler skips this event on every
	// cron tick. Same `?` + `| null` shape as seasonEnd / mentionRoleId /
	// pausedUntil: Mongoose infers `required: false, default: false` as
	// `boolean | null | undefined`, and TypeScript will not assign that
	// to a plain `boolean`. Treat falsy (false, null, undefined) as "not
	// paused" at every call site, the schema default writes `false` on
	// creation, legacy rows load as `undefined`, and /continue-schedule
	// explicitly writes `false`, so the three states are semantically
	// identical.
	paused?: boolean | null;
	// Optional auto-resume timestamp paired with paused:true. Same `?`
	// reasoning as seasonEnd / mentionRoleId, Mongoose marks
	// `required:false` fields as truly optional in the inferred document
	// type. Null means "paused indefinitely". ReminderScheduler clears
	// both paused and pausedUntil when this date passes.
	pausedUntil?: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
}

// sub-type for prep steps, mirrors the sub-schema in the Mongoose model
export interface IPrepStep {
	id: string;
	label: string; // e.g. "Activate stats token"
	order: number; // display order in the reminder embed
}

// what the admin passes in when creating an event
// eventId is excluded because the store generates it
export type TCreateEventInput = Omit<IGameEvent, "eventId" | "createdAt" | "updatedAt">;

// what the admin can update, everything optional except eventId
export type TUpdateEventInput = Partial<Omit<IGameEvent, "eventId" | "createdAt" | "updatedAt">>;

// template shape used by BOT_CONSTANTS, id not yet assigned
export type TPrepStepTemplate = Omit<IPrepStep, "id">;
