// Re-arm the per-version feature announcement so the next bot boot reposts it.
//
// Why this exists: postFeatureAnnouncements is idempotent per (guild, version)
// via a BotLog row keyed `feature_announced:<version>`. That is correct for a
// real release (post once, never spam on reboot), but it fights you while you
// iterate on the announcement COPY and redeploy the SAME version: the first
// 1.6.0 boot logs the row, and every later 1.6.0 boot skips. Deleting the row
// lets the corrected copy post again.
//
// Usage (from the bot repo root):
//   node scripts/reset-feature-announcement.mjs            # current package.json version, delete
//   node scripts/reset-feature-announcement.mjs 1.6.0      # explicit version, delete
//   node scripts/reset-feature-announcement.mjs --check    # report only, delete nothing
//
// After it deletes rows, RESTART the bot. The announcement posts on ClientReady,
// not on build, so a rebuild alone never reposts.

import "dotenv/config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const uri = process.env.MONGOOSE_URI;
if (!uri) {
	console.error("MONGOOSE_URI not set. Check DeroDiscordBot/.env");
	process.exit(1);
}

// Resolve the target version: an explicit CLI arg wins, otherwise read the bot's
// package.json (one level up from scripts/) so the default always matches what
// the running bot would announce.
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const versionArg = args.find((a) => !a.startsWith("--"));

let version = versionArg;
if (!version) {
	const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));
	version = pkg.version;
}
if (!version) {
	console.error("Could not determine a version. Pass one explicitly, e.g. `node scripts/reset-feature-announcement.mjs 1.6.0`.");
	process.exit(1);
}

const event = `feature_announced:${version}`;

// strict:false + explicit collection so this script does not depend on the real
// schema; matches the convention in inspect-guildconfig.mjs.
const BotLog = mongoose.model("BotLog", new mongoose.Schema({}, { strict: false, collection: "botlogs" }));

try {
	await mongoose.connect(uri);
	console.log(`\nDatabase: ${mongoose.connection.name}`);
	console.log(`Event key: ${event}\n`);

	const rows = await BotLog.find({ event }).lean();

	if (rows.length === 0) {
		// No row means idempotency is NOT what is blocking the post. The announcement
		// was never logged as sent for any guild, so the cause is upstream of the
		// idempotency check. Point the operator at the real suspects.
		console.log("Found 0 rows. Idempotency is NOT blocking the announcement.");
		console.log("Nothing to reset. If the announcement still is not posting, check:");
		console.log("  1. Did the bot actually RESTART? It posts on ClientReady, not on build.");
		console.log("  2. Boot logs for a line like:");
		console.log("       [feature-announcement] version " + version + ", posted to X guild(s), skipped Y");
		console.log("     No line at all means BOT_VERSION was empty (package.json unreadable in dist).");
		console.log("  3. The guild's setupComplete is true and announcementsChannelId / adminChannelId are set");
		console.log("     (run `node scripts/inspect-guildconfig.mjs`). A missing channel defers the post.");
	} else {
		console.log(`Found ${rows.length} guild(s) already marked as announced for ${version}:`);
		for (const r of rows) console.log(`  guildId ${r.guildId}  (logged ${r.createdAt})`);

		if (checkOnly) {
			console.log("\n--check mode: nothing deleted. Re-run without --check to clear these and re-arm the post.");
		} else {
			const result = await BotLog.deleteMany({ event });
			console.log(`\nDeleted ${result.deletedCount} row(s). RESTART the bot to repost the ${version} announcement.`);
		}
	}
	console.log();
} catch (err) {
	console.error("Reset failed:", err);
	process.exitCode = 1;
} finally {
	await mongoose.disconnect();
}
