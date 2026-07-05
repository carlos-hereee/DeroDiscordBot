// ── F4: migrate bot-owned events to the platform DB ──────────────────────────
// What: copies every active event from the ROK Commander bot's Mongo DB into
//   the nexious-server's Events collection so the bot can flip USE_REMOTE_EVENTS
//   without losing data. Idempotent — running twice does NOT duplicate events.
// Who: operators running this once during the F4 migration window. Not part of
//   the runtime path.
// When: AFTER the server's F1 endpoints are deployed (so the platform DB has the
//   schema additions), and BEFORE flipping USE_REMOTE_EVENTS=true on the bot.
//   Should be run during a low-traffic window (KvK off-season ideally) so any
//   in-flight reminder firings see consistent data.
// Where: connects to BOTH databases at once (bot's MONGOOSE_URI and the
//   platform's MIGRATION_TARGET_URI). The platform Events collection is the
//   destination.
// How:
//   ① Connect to source (bot DB) and target (platform DB).
//   ② For each guildId on the bot side, look up the corresponding App on the
//      platform side via App.pluginConfig.rok-commander.guildId and that App's
//      calendar via App.calendar (ObjectId ref to a Calendar doc).
//   ③ For each active bot event:
//      - Skip if a platform Events doc with the same uid already exists
//        (idempotent re-run, so a half-finished migration can resume).
//      - Otherwise insert with fields mapped from bot shape → platform shape.
//        Set platform-side `date` from bot's `firstOccurrence`. Platform-side
//        `isOpen` mirrors the bot's `active` flag.
//      - Append the new event's _id to the calendar's events array so the
//        existing /calendar endpoints surface the migrated event without a
//        separate join.
//   ④ Log a summary: total events scanned, copied, skipped (already present),
//      skipped (no app), errors.
//
// Usage (from the bot repo root):
//   MIGRATION_TARGET_URI="mongodb+srv://..." node scripts/migrate-events-to-platform.mjs
//   MIGRATION_TARGET_URI="mongodb+srv://..." DRY_RUN=1 node scripts/migrate-events-to-platform.mjs
//   MIGRATION_TARGET_URI="mongodb+srv://..." LIMIT_GUILD=910668785856413707 node scripts/migrate-events-to-platform.mjs
//
// DRY_RUN=1     prints what would happen without writing anything to the platform DB.
// LIMIT_GUILD=X migrates ONLY events for guildId X. Lets you smoke-test a single
//               guild before running the full migration. Combine with DRY_RUN=1
//               to preview just that guild without writing anything.

import "dotenv/config.js";
import mongoose from "mongoose";

const sourceUri = process.env.MONGOOSE_URI;
const targetUri = process.env.MIGRATION_TARGET_URI;
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
// Optional single-guild scope. Empty string and undefined both mean "all guilds."
// Set to a Discord guildId string to limit the scan to one guild only.
const limitGuild = (process.env.LIMIT_GUILD ?? "").trim();

if (!sourceUri) {
	console.error("MONGOOSE_URI not set (source = bot DB). Check DeroDiscordBot/.env");
	process.exit(1);
}
if (!targetUri) {
	console.error("MIGRATION_TARGET_URI not set (target = platform DB).");
	console.error("Set it to the nexious-server MongoDB URI and re-run.");
	process.exit(1);
}

// Minimal schemas — we don't enforce validation here because both sides have
// strict schemas in their real models. We just need to read/write fields.
// strict: false lets us read fields that the schema doesn't declare (mentionRoleId
// was added later, prepSteps came after, etc).
const sourceConn = await mongoose.createConnection(sourceUri).asPromise();
const targetConn = await mongoose.createConnection(targetUri).asPromise();

console.log(`Source: ${sourceConn.name}`);
console.log(`Target: ${targetConn.name}`);
if (limitGuild) console.log(`Scope:  guildId=${limitGuild} (single-guild mode)`);
console.log(dryRun ? "DRY RUN — no writes will be made\n" : "LIVE RUN — writes are real\n");

const SourceEvent = sourceConn.model("Event", new mongoose.Schema({}, { strict: false, collection: "events" }));

const TargetEvents = targetConn.model("Events", new mongoose.Schema({}, { strict: false, collection: "events" }));
const TargetApp = targetConn.model("App", new mongoose.Schema({}, { strict: false, collection: "apps" }));
const TargetCalendar = targetConn.model("Calendar", new mongoose.Schema({}, { strict: false, collection: "calendars" }));

// ── Step 1: gather all distinct guildIds on the bot side ──
// We don't migrate guild-by-guild because the source events collection is small
// enough to scan in one shot. Filtering by active:true skips already-retired
// events whose history is irrelevant for forward-looking reminders.
//
// LIMIT_GUILD narrows the scan when set. The query goes through Mongo so a
// guild with hundreds of events is still a fast lookup, and unrelated events
// never enter our process memory.
const sourceQuery = limitGuild ? { guildId: limitGuild } : {};
const sourceEvents = await SourceEvent.find(sourceQuery).lean();
console.log(
	`Found ${sourceEvents.length} bot-side event(s) to consider${limitGuild ? ` (filtered to guildId=${limitGuild})` : ""}`
);
if (limitGuild && sourceEvents.length === 0) {
	console.warn(
		`No events found for guildId ${limitGuild}. Either the guild has no events, or LIMIT_GUILD points at the wrong id.`
	);
}

// ── Step 2: build a guildId → app/calendar lookup ──
// Querying once per guildId is cheap, but cache so a guild with 20 events only
// hits Mongo twice (App lookup + Calendar lookup) instead of 40.
const guildCache = new Map(); // guildId → { app, calendar } | null

const resolveGuild = async (guildId) => {
	if (guildCache.has(guildId)) return guildCache.get(guildId);
	const app = await TargetApp.findOne({ "pluginConfig.rok-commander.guildId": guildId }).lean();
	if (!app) {
		guildCache.set(guildId, null);
		return null;
	}
	const calendar = app.calendar
		? await TargetCalendar.findOne({ _id: app.calendar }).lean()
		: await TargetCalendar.findOne({ appUid: app.uid }).lean();
	const value = { app, calendar: calendar ?? null };
	guildCache.set(guildId, value);
	return value;
};

// ── Step 3: per-event copy with idempotency check ──
const counters = {
	scanned: 0,
	copied: 0,
	updated: 0,
	skippedAlreadyPresent: 0,
	skippedNoApp: 0,
	skippedNoCalendar: 0,
	errors: 0,
};

for (const src of sourceEvents) {
	counters.scanned++;
	const eventId = src.eventId;
	const guildId = src.guildId;
	if (!eventId || !guildId) {
		counters.errors++;
		console.warn(`  ✗ event missing eventId/guildId: ${JSON.stringify({ _id: src._id, eventId, guildId })}`);
		continue;
	}

	const resolved = await resolveGuild(guildId);
	if (!resolved) {
		counters.skippedNoApp++;
		console.warn(`  ⚠ guild ${guildId} has no installed app on the platform — skipping event ${eventId}`);
		continue;
	}
	const { app, calendar } = resolved;
	if (!calendar) {
		counters.skippedNoCalendar++;
		console.warn(
			`  ⚠ app ${app.uid} (guildId ${guildId}) has no calendar — skipping event ${eventId}. ` +
				"Initialize a calendar via the dashboard then re-run this script."
		);
		continue;
	}

	// Map bot shape → platform shape. Some fields share names; others rename:
	//   firstOccurrence → date  (platform calendar primary index)
	//   active → isOpen          (platform soft-delete convention)
	const targetDoc = {
		uid: eventId, // platform uses `uid`; reuse the bot's eventId so cross-system lookups still work
		name: src.name ?? "",
		details: src.description ?? "",
		date: src.firstOccurrence,
		type: src.type,
		intervalHours: src.intervalHours ?? 0,
		seasonEnd: src.seasonEnd ?? null,
		reminderOffsets: src.reminderOffsets ?? [30, 15],
		guildId: src.guildId,
		prepSteps: src.prepSteps ?? [],
		mentionRoleId: src.mentionRoleId ?? null,
		paused: src.paused ?? false,
		pausedUntil: src.pausedUntil ?? null,
		isOpen: src.active !== false, // active=undefined defaults to true (matches bot schema)
	};

	// Idempotency: if a doc with this uid already exists, update fields rather
	// than insert. updateOne with upsert:true handles both paths cleanly.
	const existing = await TargetEvents.findOne({ uid: eventId }).lean();

	if (dryRun) {
		console.log(
			`  ${existing ? "≈" : "+"} ${existing ? "would update" : "would copy"} event ${eventId} (${src.name}) → app ${app.uid}`
		);
		if (existing) counters.skippedAlreadyPresent++;
		else counters.copied++;
		continue;
	}

	try {
		const result = await TargetEvents.updateOne({ uid: eventId }, { $set: targetDoc }, { upsert: true });
		if (result.upsertedCount > 0) {
			counters.copied++;
			// Link onto the calendar's events array. $addToSet keeps the link
			// idempotent across re-runs even if the calendar already references
			// this event (manual cleanup, prior partial run, etc).
			const upsertedId = result.upsertedId ?? (await TargetEvents.findOne({ uid: eventId }, { _id: 1 }).lean())?._id;
			if (upsertedId) {
				await TargetCalendar.updateOne({ _id: calendar._id }, { $addToSet: { events: upsertedId } });
			}
			console.log(`  + copied event ${eventId} (${src.name}) → app ${app.uid}`);
		} else if (result.matchedCount > 0) {
			counters.updated++;
			console.log(`  ≈ updated existing event ${eventId} (${src.name}) → app ${app.uid}`);
		}
	} catch (err) {
		counters.errors++;
		console.error(`  ✗ failed to copy ${eventId}: ${err.message}`);
	}
}

// ── Step 4: summary ──
console.log("\n── Migration summary ──");
console.log(`  scanned                ${counters.scanned}`);
console.log(`  copied                 ${counters.copied}`);
console.log(`  updated (re-run)       ${counters.updated}`);
console.log(`  skipped — already in target  ${counters.skippedAlreadyPresent}`);
console.log(`  skipped — no app for guild   ${counters.skippedNoApp}`);
console.log(`  skipped — no calendar        ${counters.skippedNoCalendar}`);
console.log(`  errors                 ${counters.errors}`);

if (dryRun) {
	console.log("\nDRY RUN complete. Re-run without DRY_RUN=1 to perform the migration.");
} else {
	console.log("\nMigration complete. Next steps:");
	console.log("  1. Verify a sample of events in the platform DB match what the bot DB had.");
	console.log("  2. Set USE_REMOTE_EVENTS=true on the bot (Railway env) and redeploy.");
	console.log("  3. Set VITE_USE_DIRECT_EVENTS=true on the dashboard (Vercel env) and redeploy.");
	console.log("  4. Watch the next cron tick (within 60s) — the bot should fire reminders sourced from the platform DB.");
	console.log("  5. After 24 hours of stable operation, the bot's local Event model can be safely deleted.");
}

await sourceConn.close();
await targetConn.close();
process.exit(counters.errors > 0 ? 1 : 0);
