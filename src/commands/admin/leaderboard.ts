import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, type EmbedBuilder } from "discord.js";
import { activityStore } from "@db/stores/activityStore.js";
import { eventStore } from "@db/stores/eventStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { leaderboardEmbed } from "@utils/embedBuilder.js";
import { thisWeekRange, thisMonthRange, weekBoundaryTitle, type WeekStart } from "@features/leaderboard/leaderboardWindow.js";
import { answerInChannel, type AnswerChannelConfig } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── /leaderboard ──────────────────────────────────────────────────────
// What:  show participation rankings for an event or across every event
//        the guild has run. Replaces the legacy "type an event id by hand"
//        UX with an autocomplete dropdown that lists every event by name
//        and offers an "All time" option at the top.
// Who:   any member of the guild. Reads only, never mutates the activity
//        store. Not admin-gated because mortals viewing their own
//        ranking is the whole point of a leaderboard.
// When:  on demand. Future enhancement: a LeaderboardBoard module will
//        auto-post / auto-refresh in the leaderboard channel so members
//        do not have to type this command every time they want to check
//        standings. Captured as FUTURE_PLANS 11e.
// Where: this command is the only data surface for live leaderboard
//        views until LeaderboardBoard lands.
// How:   ① autocomplete on `event` lists every event by name + sentinel
//           "All time" as the first option;
//        ② execute branches on the sentinel: all-time path aggregates
//           across every event the guild owns; per-event path scopes to
//           one event. Both paths use the server-side aggregation in
//           activityStore.findAllGroupedByPlayerInEvents so the rendering
//           logic below is identical between branches.

// Sentinel values for the three guild-wide views. Picked underscore-fenced
// strings so they are impossible to collide with a real eventId (those are
// v4 uuids). All-time is the broadest; This month and This week narrow the
// aggregation window by eventOccurrence so streamers can see "how is my
// stream community ranking THIS week" without scrolling past every event
// they have ever run.
const ALL_TIME_SENTINEL = "__alltime__";
const THIS_MONTH_SENTINEL = "__thismonth__";
const THIS_WEEK_SENTINEL = "__thisweek__";

// thisWeekRange / thisMonthRange / weekBoundaryTitle moved to
// @features/leaderboard/leaderboardWindow so the pinned LeaderboardBoard
// reuses the same window math instead of forking a copy.

// /leaderboard intentionally does NOT setDefaultMemberPermissions. As of
// the 2026-04-24 public/admin command guide split it is a member command,
// mortals viewing their own ranking is the whole point of a leaderboard
// and the command only ever READS activity data. The admin-gate check in
// main.ts's ADMIN_COMMANDS was also dropped for the same reason.
export const data = new SlashCommandBuilder()
	.setName("leaderboard")
	.setDescription("Show participation rankings for an event or across all time")
	.addStringOption((option) =>
		option
			.setName("event")
			.setDescription("Pick an event or a time window. The leaderboard states its week boundary.")
			.setRequired(true)
			.setAutocomplete(true)
	)
	.addBooleanOption((option) =>
		option.setName("public").setDescription("Post publicly in channel? Default: only you can see it").setRequired(false)
	);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}
	// findByGuildId returns every event (active and retired) so members can
	// look up past rankings too. We do NOT filter to active events here
	// because a "season just ended" leaderboard is exactly the kind of
	// thing members want to scroll back through.
	const events = await eventStore.findByGuildId(interaction.guildId);
	// All time first so it is the default highlighted suggestion. Slice
	// events to 24 instead of 25 to leave room for the sentinel, Discord's
	// hard limit is 25 total autocomplete entries.
	// Three rolling-window views at the top of the dropdown, then events by
	// name. Slice events to 22 instead of 25 to leave room for the three
	// sentinels, Discord's hard limit is 25 total autocomplete entries.
	const choices = [
		{ name: "🌟 All time (across all events)", value: ALL_TIME_SENTINEL },
		{ name: "📅 This month", value: THIS_MONTH_SENTINEL },
		{ name: "📅 This week", value: THIS_WEEK_SENTINEL },
		...events.slice(0, 22).map((e) => ({ name: e.name, value: e.eventId })),
	];
	await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["❌ Run this in a server, not a DM."] });
		return;
	}

	const eventValue = interaction.options.getString("event", true);
	const isPublic = interaction.options.getBoolean("public") ?? false;

	// Loaded once for both the weekStart window and pack-aware embed rendering.
	// A null config (guild not set up) falls back to defaults / rok-commander.
	const config = await guildConfigStore.findByGuildId(guildId);

	// ── guild-wide branches (all time / this month / this week) ──
	// Three views share the same aggregation primitive; the difference is
	// the optional dateRange filter. Each view pulls every event in the
	// guild and lets the activityStore handle the per-occurrence date
	// match server-side. This keeps one render path covering three
	// sentinels and avoids duplicating embed-build / reply logic per
	// branch.
	const isGuildWideView =
		eventValue === ALL_TIME_SENTINEL || eventValue === THIS_MONTH_SENTINEL || eventValue === THIS_WEEK_SENTINEL;
	if (isGuildWideView) {
		const guildEvents = await eventStore.findByGuildId(guildId);
		const eventIds = guildEvents.map((e) => e.eventId);

		let dateRange: { from: Date; to: Date } | undefined;
		let title: string;
		let emptyMessage: string;
		if (eventValue === THIS_MONTH_SENTINEL) {
			dateRange = thisMonthRange();
			title = "This month";
			emptyMessage = "No activity recorded this month yet.";
		} else if (eventValue === THIS_WEEK_SENTINEL) {
			// Anchor the week window to the guild's configured weekStart (item 17).
			// A null config (guild has not run /setup) or any unexpected value
			// falls back to Sunday, matching the pre-config hardcoded behavior so
			// existing guilds render identically.
			const weekStart: WeekStart = config?.weekStart === "monday" ? "monday" : "sunday";
			dateRange = thisWeekRange(weekStart);
			// State the boundary in the title so "this week" is never ambiguous.
			title = weekBoundaryTitle(weekStart);
			emptyMessage = "No activity recorded this week yet.";
		} else {
			dateRange = undefined;
			title = "All time";
			emptyMessage = "No activity recorded across any events yet.";
		}

		const records = await activityStore.findAllGroupedByPlayerInEvents(eventIds, dateRange);
		if (!records.length) {
			await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: [emptyMessage] });
			return;
		}
		const ranked = records.slice(0, 10).map(
			(r: { username: string; totalScore: number; eventsAttended: number; totalAcknowledged: number }) => ({
				username: r.username,
				totalScore: r.totalScore,
				eventsAttended: r.eventsAttended,
				totalAcknowledged: r.totalAcknowledged,
			})
		);
		await answerWithStandings(interaction, leaderboardEmbed(title, ranked, config), isPublic, config);
		return;
	}

	// ── per-event branch ─────────────────────────────────────────
	// findByIdInGuild scopes the lookup to this guild, works under both
	// the legacy local-DB path and the Future-A remote API path. eventValue
	// here is a real eventId because the autocomplete dropdown handed it to
	// the user; we still validate because nothing prevents a user from
	// typing a free-form value into the field.
	const event = await eventStore.findByIdInGuild(eventValue, guildId);
	if (!event) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["❌ Event not found. Pick one from the dropdown."] });
		return;
	}

	// Use the same aggregation primitive as the all-time branch with a
	// single-element eventIds set. Server-side aggregation is more efficient
	// than fetching all records and grouping in memory, and it keeps the
	// two branches sharing one code path through the embed render.
	const records = await activityStore.findAllGroupedByPlayerInEvents([event.eventId]);
	if (!records.length) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["No activity recorded for this event yet."] });
		return;
	}

	const ranked = records.slice(0, 10).map(
		(r: { username: string; totalScore: number; eventsAttended: number; totalAcknowledged: number }) => ({
			username: r.username,
			totalScore: r.totalScore,
			eventsAttended: r.eventsAttended,
			totalAcknowledged: r.totalAcknowledged,
		})
	);

	await answerWithStandings(interaction, leaderboardEmbed(event.name, ranked, config), isPublic, config);
}

// The standings: posted where the command ran when the member asked for a public answer,
// and otherwise in 💬dero-commands (2026-10 item 257 Phase 5) instead of the private reply
// they were, since a table with fields cannot ride a notice modal.
async function answerWithStandings(interaction: ChatInputCommandInteraction, embed: EmbedBuilder, isPublic: boolean, config: AnswerChannelConfig | null): Promise<void> {
	if (isPublic) {
		await interaction.reply({ embeds: [embed] });
		return;
	}
	await answerInChannel(interaction, "member", { embeds: [embed] }, { config });
}
