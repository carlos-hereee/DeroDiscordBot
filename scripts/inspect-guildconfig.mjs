// One-off inspection script. Reads every GuildConfig document in the bot's
// Mongo database and prints the fields the plugin proxy cares about.
//
// Usage: from the bot repo root, run
//   node scripts/inspect-guildconfig.mjs
//
// Why a standalone script instead of mongosh: mongosh is an extra install.
// The bot already has mongoose + dotenv in node_modules; this script reuses
// them to avoid adding a dependency for a read-only diagnostic.
//
// What it checks: the four fields the proxy and reminder pipeline need.
//   - announcementsChannelId (where reminders post)
//   - memberRoleId (who gets pinged; falls back to @here when null)
//   - scheduleChannelId + scheduleMessageId (schedule board anchor)
// Missing/null values are highlighted so first-time-setup gaps are obvious.

import "dotenv/config.js";
import mongoose from "mongoose";

const uri = process.env.MONGOOSE_URI;
if (!uri) {
	console.error("MONGOOSE_URI not set. Check DeroDiscordBot/.env");
	process.exit(1);
}

// Minimal schema, we only read, so schema strictness doesn't matter. The real
// schema lives in src/db/models/GuildConfig.ts. We use { strict: false } so this
// script keeps working even if the real schema adds fields later.
const GuildConfig = mongoose.model("GuildConfig", new mongoose.Schema({}, { strict: false, collection: "guildconfigs" }));

const mask = (v) => (v == null || v === "" ? "∅ (missing)" : v);

try {
	await mongoose.connect(uri);
	const docs = await GuildConfig.find({}).lean();
	console.log(`\nFound ${docs.length} GuildConfig document(s) in ${mongoose.connection.name}\n`);

	if (docs.length === 0) {
		console.log("No guilds configured yet. Run /setup in a Discord server to create one.");
	}

	for (const doc of docs) {
		console.log("─".repeat(60));
		console.log(`guildId:                ${doc.guildId}`);
		console.log(`configId:               ${doc.configId}`);
		console.log(`setupComplete:          ${doc.setupComplete}`);
		console.log(`adminRoleId:            ${mask(doc.adminRoleId)}`);
		console.log(`memberRoleId:           ${mask(doc.memberRoleId)}  ${doc.memberRoleId ? "" : "← reminders will @here"}`);
		console.log(`announcementsChannelId: ${mask(doc.announcementsChannelId)}`);
		console.log(`scheduleChannelId:      ${mask(doc.scheduleChannelId)}`);
		console.log(
			`scheduleMessageId:      ${mask(doc.scheduleMessageId)}  ${doc.scheduleMessageId ? "" : "← board not posted yet"}`
		);
		console.log(`createdAt:              ${doc.createdAt}`);
		console.log(`updatedAt:              ${doc.updatedAt}`);
	}
	console.log("─".repeat(60));
	console.log();
} catch (err) {
	console.error("Inspection failed:", err);
	process.exitCode = 1;
} finally {
	await mongoose.disconnect();
}
