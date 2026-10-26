import { Client, TextChannel, Message, DiscordAPIError } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { scheduleBoardEmbed, IScheduleField } from "@utils/embedBuilder.js";
import { getUpcomingOccurrences } from "@features/events/occurrenceCalculator.js";
import { IGameEvent } from "@features/events/event.types.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
import { buildScheduleControlRow } from "@features/schedule/ScheduleControls.js";

// ── ScheduleBoard ─────────────────────────────────────────────────────
// Owns a single pinned message per guild that lives in the event-schedule
// channel created during /setup. The message is kept in sync with the
// active events for the guild. All call sites that mutate events or fire
// reminders trigger a refresh, plus a startup sweep and an hourly safety
// tick in ReminderScheduler.
//
// Invariants:
//  1. One message per guild. Stored on GuildConfig.scheduleMessageId.
//  2. Edit in place whenever possible. If the message was deleted by an
//     admin we recover by posting a new one and updating the stored id.
//  3. Never throw. Refresh failures are logged and swallowed so they
//     cannot block the triggering action (event create, reminder fire,
//     etc).
//  4. If the guild has not finished /setup (no scheduleChannelId) we bail
//     quietly. Setup will reach its own terminal state eventually.

/**
 * Refresh the schedule board for a single guild. Safe to call fire and
 * forget, swallows any error and logs it. Returns nothing.
 */
export async function refreshSchedule(client: Client, guildId: string): Promise<void> {
	try {
		const config = await guildConfigStore.findByGuildId(guildId);
		// self-destructed guild: homebase channels are gone, nothing to refresh.
		if (config?.homebaseDestroyed) return;
		if (!config?.scheduleChannelId) {
			// guild has not finished its home base build yet. silent bail is
			// correct, autoSetup will take care of this state transition.
			return;
		}

		const channel = await client.channels.fetch(config.scheduleChannelId).catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) {
			console.error(LOG_MESSAGES.schedule.channelMissing(config.scheduleChannelId, guildId));
			return;
		}

		const events = await eventStore.findByGuildId(guildId);
		const now = new Date();
		// Season ended state only applies to KvK events. Regular announcements
		// (seasonEnd null/undefined) are filtered out of the calculation
		// entirely because they have no season scope. Truthy check covers
		// both null and the undefined Mongoose returns when the field was
		// never set on a document. If a guild has only regular events the
		// schedule never enters the "season ended" rendering.
		const kvkEvents = events.filter((e) => Boolean(e.seasonEnd));
		const seasonEnded = kvkEvents.length > 0 && kvkEvents.every((e) => new Date(e.seasonEnd as Date).getTime() <= now.getTime());

		// ── canonical guild season anchor ──
		// What:  unix timestamp of the earliest non-null seasonEnd across the
		//        guild's KvK events. Rendered ONCE at the top of the embed
		//        description (replaces the per-row "Season ends" line).
		// Who:   read by scheduleBoardEmbed only.
		// When:  null when the guild has zero KvK events (regular-announcements
		//        guild) or a fully-ended season (kvkEvents already swept).
		//        scheduleBoardEmbed treats null as "omit the banner".
		// How:   earliest is a defensive choice. /events kvk-season writes
		//        the same seasonEnd to every event, but if a future flow allows
		//        per-event season extensions the earliest still represents the
		//        season anchor every event respects.
		const guildSeasonEndTs =
			kvkEvents.length === 0
				? null
				: Math.floor(
						Math.min(...kvkEvents.map((e) => new Date(e.seasonEnd as Date).getTime())) / 1000
				  );

		const fields: IScheduleField[] = events
			.map((event) => toField(event as IGameEvent))
			// chronological sort so Mortals see the soonest event first.
			// events with no upcoming occurrence (null ts) sink to the bottom.
			// scheduleBoardEmbed re-sorts the completed block descending by
			// firstOccurrenceTs after partitioning, so this ordering only
			// affects the active block.
			.sort((a, b) => {
				if (a.nextOccurrenceTs === null && b.nextOccurrenceTs === null) return 0;
				if (a.nextOccurrenceTs === null) return 1;
				if (b.nextOccurrenceTs === null) return -1;
				return a.nextOccurrenceTs - b.nextOccurrenceTs;
			});

		const embed = scheduleBoardEmbed(fields, config.announcementsChannelId ?? null, { seasonEnded, guildSeasonEndTs }, config);

		// Phase-gated control row: Go Live always, plus Set-up (no events) /
		// Pause (some active) / Resume (all paused). Computed from the events
		// already loaded above so the toggle reflects live state on every refresh.
		const hasEvents = events.length > 0;
		const allPaused = hasEvents && events.every((event) => event.paused === true);
		const controlRow = buildScheduleControlRow({ hasEvents, allPaused });

		await postOrEdit(channel, config.scheduleMessageId ?? null, embed, guildId, controlRow);
	} catch (error) {
		console.error(LOG_MESSAGES.schedule.unexpectedError(guildId), error);
	}
}

/**
 * Refresh every guild the bot is installed in. Used on bot startup and
 * by the hourly cron tick in ReminderScheduler. Errors in any single
 * guild do not stop the sweep.
 */
export async function refreshAllSchedules(client: Client): Promise<void> {
	for (const [guildId] of client.guilds.cache) {
		await refreshSchedule(client, guildId);
	}
}

// ── private helpers ────────────────────────────────────────────────────

function toField(event: IGameEvent): IScheduleField {
	const [next] = getUpcomingOccurrences(event, 1);

	// for one-time events whose firstOccurrence is still in the future,
	// getUpcomingOccurrences returns [firstOccurrence]. once that date
	// passes it returns []. the null branch below shows _awaiting next
	// season_ in the embed.
	const nextOccurrenceTs = next ? Math.floor(next.getTime() / 1000) : null;

	// Regular announcements have no seasonEnd, so we omit the timestamp
	// (null). Retained for backwards compatibility with consumers that
	// still read seasonEndTs per row, but the schedule embed no longer
	// renders it in row bodies, the banner moved to the description.
	const seasonEndTs = event.seasonEnd ? Math.floor(new Date(event.seasonEnd).getTime() / 1000) : null;

	const firstOccurrenceMs = new Date(event.firstOccurrence).getTime();
	// ── isCompleted: one-time events whose date already passed ──
	// What:  partitions one-time events into "active" (date still future) and
	//        "completed" (date passed) so scheduleBoardEmbed can render them
	//        in separate blocks. Recurring events are NEVER completed within
	//        a live season, they recur forever until seasonEnd swaps the
	//        whole board into the season-ended state.
	// When:  evaluated on every refresh tick against Date.now(). A one-time
	//        event flips from active to completed the moment its
	//        firstOccurrence passes; the next refresh after that moment
	//        renders it in the completed block.
	// Where: scheduleBoardEmbed reads this flag to partition fields and to
	//        choose between buildActiveField (full body) and
	//        buildCompletedField (minimal body, "Concluded" date only).
	const isCompleted = event.type === "one-time" && firstOccurrenceMs < Date.now();

	return {
		name: event.name,
		type: event.type,
		nextOccurrenceTs,
		intervalHours: event.type === "recurring" ? event.intervalHours : null,
		seasonEndTs,
		// Forward the live paused flag straight to the embed builder.
		// Coerce the Mongoose-inferred `boolean | null | undefined` down
		// to a clean boolean so IScheduleField stays narrow, the embed
		// builder never needs to distinguish "false" from "unset". All
		// three falsy states map to "not paused", which matches how the
		// scheduler and /events pause both interpret the field.
		paused: event.paused === true,
		firstOccurrenceTs: Math.floor(firstOccurrenceMs / 1000),
		isCompleted,
	};
}

async function postOrEdit(
	channel: TextChannel,
	existingMessageId: string | null,
	embed: ReturnType<typeof scheduleBoardEmbed>,
	guildId: string,
	controlRow: ReturnType<typeof buildScheduleControlRow>
): Promise<void> {
	// resolve our own bot id up front so the stale data guards below can
	// compare authors cheaply without hitting Discord twice.
	const selfId = channel.client.user?.id;

	// happy path: edit the existing message.
	if (existingMessageId) {
		// What: track whether the stored id turned out to be stale (wrong
		//       author or 50005 from Discord). When set, we drop into the
		//       self heal block below which clears the persisted id and
		//       falls through to the post path.
		// Who:  the owner runs separate Mongo databases for dev and prod, so
		//       a mismatched author always means stale data (rotated bot
		//       account, DB seeded from a sibling environment, etc) and never
		//       a legitimate "another bot owns this" scenario.
		// When: at most once per stale id per guild. After self heal the new
		//       message id belongs to this bot and subsequent refreshes
		//       follow the edit path normally.
		let staleAuthor = false;

		try {
			const existing = await channel.messages.fetch(existingMessageId);

			// pre check: compare authorship before paying the round trip
			// cost of an edit that Discord will reject with 50005.
			if (selfId && existing.author.id !== selfId) {
				staleAuthor = true;
			} else {
				// Components reapplied on every edit so the control row
				// persists. Without this, an edit that omitted
				// components would still preserve them (Discord.js
				// default), but reapplying makes the contract explicit
				// at every call site and covers the case where the
				// button row shape changes between releases.
				await existing.edit({ embeds: [embed], components: [controlRow] });
				return;
			}
		} catch (error) {
			// 10008 Unknown Message → admin deleted it. 10003 Unknown Channel
			// → channel was wiped. 50005 → cache race: pre check missed the
			// authorship mismatch but Discord caught it. all three resolve the
			// same way: clear the persisted id, drop into the post path, post
			// a fresh message we own.
			if (error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003)) {
				console.warn(LOG_MESSAGES.schedule.storedMessageDeleted(existingMessageId, guildId));
			} else if (error instanceof DiscordAPIError && error.code === 50005) {
				staleAuthor = true;
			} else {
				console.error(LOG_MESSAGES.schedule.editFailed(existingMessageId, guildId), error);
				// do not fall through on unknown errors. another refresh will retry.
				return;
			}
		}

		if (staleAuthor) {
			// What: the whole homebase in this guild's GuildConfig belongs to
			//       a different bot (rotated token, stale data from a sibling
			//       environment, or a prior shared-DB era). the bot must NOT
			//       post in that channel, that would pollute the other bot's
			//       home base.
			// Who:  detected by author mismatch on the stored scheduleMessageId
			//       (either pre-check or Discord 50005).
			// When: at most once per guild per stale-data lifetime. the recovery
			//       writes a fresh GuildConfig, so subsequent refreshes hit the
			//       happy edit path.
			// Where: flows into rebuildHomebase below which deletes the stale
			//        config and runs autoSetup to create this bot's own (dev)
			//        suffixed category and channels. the old channels stay
			//        untouched in Discord because they belong to the other bot.
			// How:   return from postOrEdit without posting. rebuildHomebase is
			//        awaited inside the caller so we don't fall through to the
			//        post path in the wrong channel.
			console.warn(LOG_MESSAGES.schedule.staleAuthor(existingMessageId, guildId));
			await rebuildHomebase(channel.guild, guildId);
			return;
		}
	}

	// recovery path (or first post ever): send a new message, pin it, persist the id.
	let message: Message;
	try {
		// Send the schedule board with the same dynamic control row the edit
		// path uses, so a fresh post and an in-place refresh produce identical
		// surfaces (caller passes the row built from live schedule state).
		message = await channel.send({ embeds: [embed], components: [controlRow] });
	} catch (error) {
		console.error(LOG_MESSAGES.schedule.postFailed(guildId), error);
		return;
	}

	// No pin: the schedule channel is read-only, so the board stays put without one
	// (2026-06 pinning policy, only the member-writable introductions channel is
	// pinned, where member chatter would otherwise bury a message).
	await guildConfigStore.update(guildId, { scheduleMessageId: message.id });
}

// ── rebuildHomebase ────────────────────────────────────────────────────
// What: recovery from the "GuildConfig in my DB points to a homebase that
//       is no longer ours" state. Runs autoSetup with force:true so a fresh
//       category and channels owned by THIS bot are built. Critically does
//       NOT call deleteByGuildId, in the shared MongoDB cluster scenario
//       (dev and prod bots pointed at the same collection) that delete
//       would nuke the other bot's row. Foreign rows are never touched.
// Who:  called from postOrEdit when the stored schedule message is authored
//       by a different bot, and from any other caller that detects the
//       same invariant violation in the future.
// When: rare. only fires when DB data is stale against reality (rotated
//       bot account, cross-environment seeding, manual DB edits, or two
//       bots sharing a Mongo collection).
// Where: leaves the OLD category/channels in Discord untouched, they
//        belong to the other bot and we have no right to delete them.
//        the new category picks up the "(dev)" suffix automatically via
//        GuildSetupManager.resolveCategoryName when NODE_ENV=development.
// How:   autoSetup(force:true) bypasses the early-return guard on existing
//        config. If the row in our DB is ours (just stale), autoSetup
//        updates it in place with the new channel ids. If the row is
//        foreign (shared cluster), autoSetup will hit the duplicate-key
//        guard on its insert path and bail loudly without overwriting.
//        Either branch keeps prod state safe.
async function rebuildHomebase(guild: TextChannel["guild"], guildId: string): Promise<void> {
	try {
		console.warn(LOG_MESSAGES.schedule.rebuildingHomebase(guildId));
		await GuildSetupManager.autoSetup(guild, { guildId, ownerId: guild.ownerId }, { force: true });
	} catch (error) {
		console.error(LOG_MESSAGES.schedule.rebuildHomebaseFailed(guildId), error);
	}
}
