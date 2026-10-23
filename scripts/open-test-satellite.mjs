// Seat members of a second server at a live Hold'em table through a satellite channel,
// for the two guild check of 2026-10 item 244 Phase 5a (satellite rooms).
//
// Why this exists: Phase 5a builds the satellite engine and nothing a member can press to
// reach it. The network board, the network host option and the consent that lead a member
// to a satellite are Phase 5b. Until then this is the one way to open a satellite, so the
// engine can be played end to end in two real servers.
//
// What it does, once: finds the host's open Hold'em room in the host server, marks it a
// network table, opens a satellite in the remote server's arcade category for the named
// members, draws the table there, and exits. It writes the room row and creates one
// channel; nothing else. The RUNNING bot then serves every press in the satellite, because
// a press finds its table through the row, not through this process.
//
// Usage (from the bot repo root, after `npm run build`, with the bot running on the same
// build and the same .env):
//   node scripts/open-test-satellite.mjs <hostGuildId> <hostUserId> <remoteGuildId> <remoteUserId> [<remoteUserId> ...]
//
// Before running it: the host starts a Hold'em challenge in the host server and presses
// Start, so the room is open and its table is taking buy ins. Both servers must have run
// /setup, and each remote member must be in the remote server and NOT in the host server.
// After it: the remote member presses Buy in in the new channel, the host deals in the
// host room, and one hand is played from both servers.
//
// It logs in a second session with the bot's own token for the few seconds it runs,
// beside the running bot's session, and logs out once the table has been drawn.

import "dotenv/config.js";
import mongoose from "mongoose";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { gameRoomStore } from "../dist/db/stores/gameRoomStore.js";
import { openSatelliteWithTable } from "../dist/features/game-rooms/satelliteSeats.js";
import { describeSatelliteRefusal, whenRelayed } from "../dist/features/game-rooms/satelliteRooms.js";

const [hostGuildId, hostUserId, remoteGuildId, ...remoteUserIds] = process.argv.slice(2);
if (!hostGuildId || !hostUserId || !remoteGuildId || remoteUserIds.length === 0) {
	console.error("Usage: node scripts/open-test-satellite.mjs <hostGuildId> <hostUserId> <remoteGuildId> <remoteUserId> [<remoteUserId> ...]");
	process.exit(1);
}

const uri = process.env.MONGOOSE_URI;
const token = process.env.DISCORD_TOKEN;
if (!uri || !token) {
	console.error("MONGOOSE_URI and DISCORD_TOKEN must both be set. Check DeroDiscordBot/.env");
	process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

try {
	await mongoose.connect(uri);
	const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
	await client.login(token);
	await ready;

	const room = await gameRoomStore.findOpenByHost(hostGuildId, hostUserId);
	if (!room || room.game !== "holdem" || room.status !== "playing") {
		console.error(`No open Hold'em room for host ${hostUserId} in server ${hostGuildId}. Start a Hold'em challenge there and press Start first.`);
		process.exitCode = 1;
	} else {
		// The network host option is Phase 5b's; this helper sets the flag it will set.
		const networked = (await gameRoomStore.update(hostGuildId, room.roomId, { network: true })) ?? room;
		const remoteGuild = await client.guilds.fetch(remoteGuildId);
		const opened = await openSatelliteWithTable(networked, remoteGuild, remoteUserIds);
		// The table reaches the satellite on the relay chain; wait for it before logging out.
		await whenRelayed(room.roomId);

		if (opened.ok) {
			console.log(`Satellite open in server ${remoteGuildId}: channel ${opened.channelId}, seating ${remoteUserIds.join(", ")} at room ${room.roomId}.`);
		} else {
			console.error(`Satellite refused (${opened.reason}): ${describeSatelliteRefusal(opened.reason, room)}`);
			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error("Opening the test satellite failed:", error);
	process.exitCode = 1;
} finally {
	await client.destroy();
	await mongoose.disconnect();
}
