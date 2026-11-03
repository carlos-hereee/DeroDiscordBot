import type { Client, Guild } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { readAdoptedChannelIds } from "./adoption.js";
import { arcadeSwitchesToWrite } from "./arcadeDefaults.js";
import { demolishCategory, demolishChannels } from "./selfDestruct.js";

// ── arcadeSwitch ──────────────────────────────────────────────────────────
// What:  /arcade off and on (post-launch plan item 14). Off deletes the
//        🎮 ARCADE GAMES category and every channel in it, matches in progress
//        included; on brings it back.
// Who:   commands/admin/dero-config.ts, behind the ADMIN_COMMANDS runtime gate.
// Where: off is remembered with the per slot opt out the boot sweep and the delete
//        watcher already honor, GuildConfig.userRemovedChannels, rather than a new
//        flag (the plan left the field to this phase): every arcade spec goes on the
//        list, so repairMissingChannels never resolves the arcade category again, and
//        it stays off across restarts. On takes them off the list and runs the same
//        boot sweep now, which rebuilds the channels and finds or makes the category.
//        The teardown itself is selfDestruct's demolishChannels and demolishCategory,
//        so the arcade cannot come down differently from a self destruct.
// How:   off ① writes the opt out and nulls the arcade ids and their intro anchors in
//        ONE write, BEFORE any delete, so ChannelDeleteWatcher sees nothing to rebuild
//        (and still closes each deleted room's GameRoom row); ② deletes the tracked
//        channels; ③ deletes the category and anything left under it.

/** The arcade's managed channel fields, read off the specs so a new arcade channel joins the switch by itself. */
function arcadeFields(): string[] {
	return GuildSetupManager.CHANNEL_SPECS.filter((spec) => spec.categoryField === "gamesCategoryId").map((spec) => spec.configField);
}

// 🕹️games' second message, the Challenge Board, has an anchor of its own that is not
// a channel field, so it is released by name alongside the per channel anchors.
const ARCADE_FLAT_ANCHORS = ["arcadeGamesBoardId"];

interface ArcadeRow {
	gamesCategoryId?: string | null;
	userRemovedChannels?: string[] | null;
	[field: string]: unknown;
}

async function readRow(guildId: string): Promise<ArcadeRow> {
	const row = await guildConfigStore.findByGuildId(guildId);
	if (!row) throw new Error(`no GuildConfig for guild ${guildId}`);
	return row as unknown as ArcadeRow;
}

/** True when every arcade slot is opted out and no category is recorded, which is what off leaves behind. */
function isArcadeOff(row: ArcadeRow, fields: readonly string[]): boolean {
	const removed = new Set(row.userRemovedChannels ?? []);
	return !row.gamesCategoryId && fields.every((field) => removed.has(field));
}

export type ArcadeOffOutcome = "off" | "already-off";
export type ArcadeOnOutcome = "on" | "pending" | "already-on";

/** Delete the arcade category and every channel in it, and keep it off across restarts. */
export async function turnArcadeOff(guild: Guild): Promise<ArcadeOffOutcome> {
	const fields = arcadeFields();
	const row = await readRow(guild.id);
	if (isArcadeOff(row, fields)) return "already-off";

	const adoptedIds = new Set(readAdoptedChannelIds(row));
	const channelIds = fields.map((field) => row[field] as string | null | undefined);
	const categoryId = row.gamesCategoryId;
	const removed = new Set([...(row.userRemovedChannels ?? []), ...fields]);

	// ①
	await guildConfigStore.update(guild.id, {
		userRemovedChannels: [...removed],
		gamesCategoryId: null,
		...Object.fromEntries(fields.map((field) => [field, null])),
		...Object.fromEntries([...fields, ...ARCADE_FLAT_ANCHORS].map((anchor) => [`introMessageIds.${anchor}`, null])),
	});
	console.warn(`[arcade-off] demolishing the arcade in guild ${guild.id}`);
	// ② and ③
	await demolishChannels(guild, channelIds, adoptedIds, "arcade-off");
	await demolishCategory(guild, categoryId, "gamesCategoryId", adoptedIds, "arcade-off");
	return "off";
}

/**
 * Bring the arcade back. "pending" means the opt out is lifted but the sweep did not
 * build every channel just now (auto heal is off, the homebase was self destructed,
 * or Discord refused), so the reply can say so honestly.
 */
export async function turnArcadeOn(client: Client, guild: Guild): Promise<ArcadeOnOutcome> {
	const fields = arcadeFields();
	const row = await readRow(guild.id);
	const removed = row.userRemovedChannels ?? [];
	if (row.gamesCategoryId && !fields.some((field) => removed.includes(field))) return "already-on";

	// The rebuilt arcade starts with its switches on, except one this server turned off
	// (2026-10 item 257, owner item 11).
	await guildConfigStore.update(guild.id, { userRemovedChannels: removed.filter((field) => !fields.includes(field)), ...arcadeSwitchesToWrite(row) });
	await GuildSetupManager.ensureHomebase(client, guild);
	// The intros come back with the channels; this also posts 🕹️games' Challenge Board.
	await GuildSetupManager.refreshIntroEmbeds(client, guild);

	const after = await readRow(guild.id);
	return after.gamesCategoryId && fields.every((field) => after[field]) ? "on" : "pending";
}
