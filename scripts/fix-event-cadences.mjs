// ── fix-event-cadences: correct stale ROK event interval hours ───────────────
// What: corrects existing Event documents whose intervalHours was written from
//   the old (wrong) rok-events.json constants. Ancient Ruins moves from 36 to
//   40, Altar of Darkness moves from 84 to 86. The match is by name + type +
//   active so we never touch unrelated events that happen to share an interval.
//   Idempotent, running twice does NOT double-bump anything because the second
//   run finds no documents at the wrong interval.
// Who: operators running this once after deploying the rok-events.json fix.
//   Not part of the runtime path. Safe to re-run.
// When: AFTER deploying the new rok-events.json constants. Running it before
//   the deploy is harmless but pointless because /configure-kvk-season would
//   immediately recreate events at the old (wrong) cadence.
// Where: connects to the bot's local Mongo (MONGOOSE_URI). Today (2026-04-26)
//   USE_REMOTE_EVENTS is OFF in production, so events live in the bot DB.
//   When the F4 cutover happens and events move to the platform DB, this
//   script will need a sibling targeting MIGRATION_TARGET_URI, for now the
//   bot DB is the only place that holds wrong-cadence events.
// How:
//   ① Connect to source (bot DB).
//   ② Find every active Event with name "Ancient Ruins" and intervalHours 36,
//      OR name "Altar of Darkness" and intervalHours 84.
//      Filtering by the OLD value is critical for idempotency: a re-run sees
//      zero matches because the prior run already corrected them.
//   ③ Set intervalHours to the new value (40 / 86).
//   ④ Log a per-document summary so the operator can audit which guilds were
//      affected. DRY_RUN=1 prints the same audit without writing.
//
// Usage (from the bot repo root):
//   node scripts/fix-event-cadences.mjs
//   DRY_RUN=1 node scripts/fix-event-cadences.mjs
//   LIMIT_GUILD=910668785856413707 node scripts/fix-event-cadences.mjs
//
// DRY_RUN=1     prints what would happen without writing.
// LIMIT_GUILD=X scopes the fix to one Discord guildId. Combine with DRY_RUN=1
//               to preview a single guild before running the full migration.

import "dotenv/config.js";
import mongoose from "mongoose";

const sourceUri = process.env.MONGOOSE_URI;
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const limitGuild = (process.env.LIMIT_GUILD ?? "").trim();

if (!sourceUri) {
	console.error("MONGOOSE_URI not set. Check DeroDiscordBot/.env");
	process.exit(1);
}

// ── corrections table ────────────────────────────────────────
// What: maps each event name to the (old, new) intervalHours pair. The match
//   by old value is what makes the script idempotent, once a doc has been
//   corrected its intervalHours no longer matches the OLD predicate so a
//   re-run is a no-op.
// Where: keep this in sync with rok-events.json. If a future game patch
//   shifts a cadence again, add another entry here AND update the JSON.
const CORRECTIONS = [
	{ name: "Ancient Ruins", oldInterval: 36, newInterval: 40 },
	{ name: "Altar of Darkness", oldInterval: 84, newInterval: 86 },
];

const sourceConn = await mongoose.createConnection(sourceUri).asPromise();
console.log(`Source: ${sourceConn.name}`);
if (limitGuild) console.log(`Scope:  guildId=${limitGuild} (single-guild mode)`);
console.log(dryRun ? "DRY RUN, no writes will be made\n" : "LIVE RUN, writes are real\n");

// strict:false so we can read the document fields without a full schema decl.
const Event = sourceConn.model(
	"Event",
	new mongoose.Schema({}, { strict: false, collection: "events" })
);

const counters = {
	scanned: 0,
	corrected: 0,
	skippedAlreadyCorrect: 0,
	errors: 0,
};

for (const { name, oldInterval, newInterval } of CORRECTIONS) {
	// Build the filter. We match by name + active + the OLD intervalHours so a
	// re-run after correction returns zero docs (idempotency). LIMIT_GUILD adds
	// a guildId clause when set.
	const filter = {
		name,
		active: true,
		intervalHours: oldInterval,
	};
	if (limitGuild) filter.guildId = limitGuild;

	const candidates = await Event.find(filter).lean();
	counters.scanned += candidates.length;

	if (candidates.length === 0) {
		console.log(`  · no documents found for ${name} at intervalHours=${oldInterval} (already corrected or none exist)`);
		continue;
	}

	console.log(`  Found ${candidates.length} ${name} document(s) at intervalHours=${oldInterval} → ${newInterval}`);
	for (const doc of candidates) {
		const tag = `${doc.eventId ?? doc._id} guild=${doc.guildId}`;
		if (dryRun) {
			console.log(`    + would update ${tag}`);
			counters.corrected++;
			continue;
		}
		try {
			await Event.updateOne({ _id: doc._id }, { $set: { intervalHours: newInterval } });
			console.log(`    + updated   ${tag}`);
			counters.corrected++;
		} catch (err) {
			counters.errors++;
			console.error(`    ✗ failed   ${tag}: ${err.message}`);
		}
	}

	// Sanity check: count any docs already at the NEW interval. If both old
	// and new exist for the same name, the operator likely has duplicate
	// events from a prior partial run or a manual correction. Surface it
	// without failing, this script's job is to advance docs from old to new,
	// not to deduplicate.
	const alreadyCorrect = await Event.countDocuments({
		name,
		active: true,
		intervalHours: newInterval,
		...(limitGuild ? { guildId: limitGuild } : {}),
	});
	if (alreadyCorrect > 0) {
		counters.skippedAlreadyCorrect += alreadyCorrect;
		console.log(`    (info) ${alreadyCorrect} ${name} document(s) already at intervalHours=${newInterval}, left untouched)`);
	}
}

console.log("\n── Cadence fix summary ──");
console.log(`  scanned (at old intervalHours)  ${counters.scanned}`);
console.log(`  corrected                       ${counters.corrected}`);
console.log(`  already at new intervalHours    ${counters.skippedAlreadyCorrect}`);
console.log(`  errors                          ${counters.errors}`);

if (dryRun) {
	console.log("\nDRY RUN complete. Re-run without DRY_RUN=1 to apply.");
} else {
	console.log("\nFix complete. Next steps:");
	console.log("  1. Spot-check one corrected event in MongoDB Atlas.");
	console.log("  2. Watch the next reminder fire in #announcements, should align with the canonical schedule.");
	console.log("  3. Refresh the schedule board (any event mutation triggers it; or restart the bot).");
}

await sourceConn.close();
process.exit(counters.errors > 0 ? 1 : 0);
