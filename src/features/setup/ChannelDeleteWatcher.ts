import { Client, Events, DMChannel, NonThreadGuildBasedChannel, GuildChannel, CategoryChannel, ChannelType } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// ── ChannelDeleteWatcher ──────────────────────────────────────────────
// What:  realtime single channel self heal. Subscribes to the Discord
//        gateway `channelDelete` event and rebuilds a homebase channel the
//        moment it is deleted. Complements the boot sweep inside
//        GuildSetupManager.ensureHomebase; see CLAUDE.md for the full self
//        heal story.
// Who:   registered once per process, from main.ts inside the ready handler
//        alongside startScheduler / registerActivityListeners / startApiServer.
//        Consumed by every guild the bot is in because Discord pushes
//        channelDelete events over the gateway connection we already have
//        open for slash commands and reminders.
// When:  fires when Discord reports a channel deletion. Cooldown guard below
//        bails out if a repair for the same guild + channel field happened
//        within the last 60s so a runaway delete/create loop cannot pound
//        Mongo or Discord's REST API.
// Where: delegates all rebuild mechanics to GuildSetupManager.repairOneChannel
//        so the boot sweep and the realtime path share one primitive. The
//        only logic that is unique to this module is the cooldown, the
//        spec lookup by channel id, and the category-gone short circuit.
// How:   ① filter non guild / DM / thread channels (typing narrow).
//        ② load GuildConfig. If none, not our guild, ignore.
//        ③ match the deleted channel id against CHANNEL_SPECS. If nothing
//           matches, the deleted channel is not a homebase channel and we
//           ignore it. If the category itself was deleted, ignore (boot
//           sweep owns full rebuilds).
//        ④ consult cooldown map. if throttled, log + bail.
//        ⑤ verify the category is still alive in Discord. If not, bail
//           and let ensureHomebase handle the full rebuild on next wake.
//        ⑥ run the ownership probe to refuse posting into a foreign
//           homebase. this is the same probe ensureHomebase uses on boot.
//        ⑦ delegate to GuildSetupManager.repairOneChannel, then call
//           GuildSetupManager.postRepairNotices for the single repaired
//           channel so the inner sanctum gets the audit line.
//        Errors after the cooldown gate are logged and swallowed, the
//        gateway connection must never crash because of a repair fault.

// ── cooldown map ──────────────────────────────────────────────────────
// Key format: `${guildId}:${configField}`. configField is the GuildConfig
// key (e.g. "introChannelId") rather than the live channel id because the
// id changes on every rebuild and we need the cooldown to persist across
// the rebuild to catch thrash.
// Value: epoch millis of the last successful repair for that slot.
// Scope: module local Map. in memory only. on process restart the boot
// sweep handles whatever happened while we were down, so losing cooldown
// state on restart is acceptable.
const repairCooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;

// Exposed for tests so a fresh suite does not inherit cooldown state from
// a prior test run.
export function __resetRepairCooldownsForTests(): void {
	repairCooldowns.clear();
}

export function registerChannelDeleteWatcher(client: Client): void {
	client.on(Events.ChannelDelete, async (channel: DMChannel | NonThreadGuildBasedChannel) => {
		try {
			// ① narrow: we only care about guild channels. DM channels have no
			//    `guild` property so this guard filters them out entirely.
			if (!("guild" in channel) || !channel.guild) return;
			const guild = (channel as GuildChannel).guild;

			// ② load GuildConfig. missing row → this guild never completed a
			//    homebase build. ignore. (the autoSetup on guildCreate will
			//    handle new guilds; ensureHomebase handles reinstalls.)
			const stored = await guildConfigStore.findByGuildId(guild.id);
			if (!stored) return;

			// auto-heal toggle gate. when off, the admin has explicitly
			// opted out of automatic channel rebuilds. log a single
			// line citing the toggle so the admin can find it again,
			// then bail before any repair work happens. The boot
			// sweep honors the same flag so restart will not undo
			// the admin's decision.
			if (!stored.autoHealEnabled) {
				console.log(
					`[realtime-repair] skipped channel delete in guild ${guild.id} because autoHealEnabled is false; run /configure-auto-heal enabled:True to resume.`
				);
				return;
			}

			// self-destruct gate. demolishHomebase sets homebaseDestroyed=true
			// BEFORE deleting any channel, so this fires for every channel it
			// removes, skip rebuild so the teardown is not undone mid-demolish.
			// Run /setup to rebuild. The boot sweep honors the same flag.
			if (stored.homebaseDestroyed) {
				console.log(
					`[realtime-repair] skipped channel delete in guild ${guild.id} because the homebase was self-destructed; run /setup to rebuild.`
				);
				return;
			}

			// ③ match the deleted channel id to one of the six homebase fields.
			//    also short circuit if the deleted channel IS the category,
			//    that is a full rebuild case and we leave it to the boot sweep
			//    so we do not fight an admin who is intentionally removing
			//    the bot.
			if (channel.id === stored.categoryId) {
				console.warn(LOG_MESSAGES.setup.realtimeRepairCategoryGone(guild.id));
				return;
			}

			const spec = GuildSetupManager.CHANNEL_SPECS.find(
				(s) => (stored as unknown as Record<string, string | null | undefined>)[s.configField] === channel.id
			);
			if (!spec) return; // not a homebase channel

			// per-channel user-removed gate. when the admin explicitly removed
			// THIS specific slot via a slash command's follow-up button (eg
			// /configure-leaderboard-tracking → Remove leaderboard channel),
			// the configField is in userRemovedChannels and we skip rebuild
			// even though autoHealEnabled is on. This supersedes auto-heal at
			// the slot level. The boot sweep honors the same flag. Defense
			// in depth: the slash command handler also writes the flag BEFORE
			// triggering the delete, so under correct ordering this gate is
			// a backup; under incorrect ordering this gate still wins.
			const userRemovedSlots = ((stored as unknown as { userRemovedChannels?: string[] }).userRemovedChannels ?? []) as string[];
			if (userRemovedSlots.includes(spec.configField)) {
				console.log(
					`[realtime-repair] skipped rebuild of ${spec.configField} in guild ${guild.id} because the admin removed it explicitly; re-enable the related feature to restore.`
				);
				return;
			}

			// ④ cooldown gate. scope the key to guild + configField so two
			//    different channels in the same guild can repair in parallel
			//    without colliding, and so the same logical channel slot is
			//    throttled across id rotations.
			const cooldownKey = `${guild.id}:${spec.configField}`;
			const last = repairCooldowns.get(cooldownKey) ?? 0;
			const now = Date.now();
			if (now - last < COOLDOWN_MS) {
				console.warn(LOG_MESSAGES.setup.realtimeRepairCooldownHit(spec.displayName, guild.id));
				return;
			}

			console.log(LOG_MESSAGES.setup.realtimeRepairStarted(spec.displayName, guild.id));

			// ⑤ verify category still exists. if the admin just nuked the
			//    whole category the child channel delete events will fire
			//    alongside the category delete, we do NOT want to rebuild
			//    child channels under a dead category. let ensureHomebase
			//    handle the full rebuild on next wake.
			const category = await guild.channels.fetch(stored.categoryId).catch(() => null);
			if (!category || category.type !== ChannelType.GuildCategory) {
				console.warn(LOG_MESSAGES.setup.realtimeRepairCategoryGone(guild.id));
				return;
			}

			// ⑥ ownership probe. Refuse repair ONLY when the homebase is positively
			//    foreign (anchor authored by a different bot). "unknown" (missing or
			//    deleted anchor) proceeds to repair, same rule as the boot sweep, so
			//    a deleted schedule message never blocks a legitimate channel repair.
			const ownership = await GuildSetupManager.isHomebaseOwnedByThisBot(client, guild.id, stored);
			if (ownership === "foreign") {
				console.warn(LOG_MESSAGES.setup.realtimeRepairForeignHomebase(guild.id));
				return;
			}

			// ⑦ delegate to the shared primitive. repairOneChannel returns
			//    the merged stored so we have the fresh adminChannelId if the
			//    admin channel itself was the one deleted.
			const result = await GuildSetupManager.repairOneChannel(
				guild,
				category as CategoryChannel,
				spec,
				stored as unknown as Record<string, unknown> & { adminRoleId?: string | null }
			);

			// post the audit notice into the (possibly freshly rebuilt) inner
			// sanctum. postRepairNotices swallows its own send failures so a
			// missing perms error on the notice does not cancel the repair.
			await GuildSetupManager.postRepairNotices(
				client,
				guild.id,
				result.stored.adminChannelId as string,
				[spec.displayName]
			);

			// record successful repair for the cooldown gate.
			repairCooldowns.set(cooldownKey, Date.now());
			console.log(LOG_MESSAGES.setup.realtimeRepairCompleted(spec.displayName, guild.id));
		} catch (error) {
			// best effort. never crash the gateway listener, an unhandled
			// throw here propagates through discord.js and can wedge other
			// event handlers. log and move on; boot sweep will catch any
			// repair that could not land at runtime.
			const name =
				"name" in channel && typeof (channel as GuildChannel).name === "string" ? (channel as GuildChannel).name : "unknown";
			const guildId = "guild" in channel && channel.guild ? channel.guild.id : "unknown";
			console.error(LOG_MESSAGES.setup.realtimeRepairFailed(name, guildId), error);
		}
	});
}
