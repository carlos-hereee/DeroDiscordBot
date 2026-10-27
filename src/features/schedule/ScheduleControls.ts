import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { registerButton } from "@handlers/interactionRegistry.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { postGoLiveAnnouncement } from "@features/schedule/postGoLiveAnnouncement.js";
import { pauseAllGuildEvents, resumeAllGuildEvents, IBulkScheduleResult } from "@features/schedule/scheduleBulkControls.js";
import { refreshSchedule } from "@features/schedule/ScheduleBoard.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { beginChannelAnswer } from "@utils/answerInChannel.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── Schedule channel controls (item 36) ────────────────────────────────
// The pinned schedule board carries ONE dynamic, phase-gated control row,
// rebuilt by ScheduleBoard.refreshSchedule on every refresh (so it tracks the
// live state without a second pinned message):
//
//   - Go Live Now, ALWAYS present. Streamers announce going live whether or
//     not a recurring schedule exists, so this never hides.
//   - then exactly one state button:
//       • no events configured        → "Set up your schedule" (how-to reply)
//       • events, at least one active → "Pause reminders"  (pauses all)
//       • events, all paused          → "Resume reminders" (resumes all)
//
// Pause/Resume is a single toggle: clicking it flips every event, then the
// board refresh re-reads state and swaps the button to its opposite. This
// replaces the old two-button (Pause all + Resume all) panel, where one button
// was always a no-op, and the standalone power-up panel for the schedule
// channel (those controls now live here on the board).
//
// All four actions are owner/admin gated via gateOwnerOrAdmin. discord.js note:
// message.edit must pass embeds AND components or the buttons drop, ScheduleBoard
// passes both on every send and edit.
//
// Note: this module imports refreshSchedule from ScheduleBoard while ScheduleBoard
// imports buildScheduleControlRow from here. The cycle is safe: both are hoisted
// function declarations used only at call time (refresh on click, row build on
// refresh), never during module init.

const BUTTON_PREFIX = "schedule_controls";
const GO_LIVE_NOW_CUSTOM_ID = `${BUTTON_PREFIX}:go_live_now`;
const CONFIGURE_CUSTOM_ID = `${BUTTON_PREFIX}:configure`;
const PAUSE_ALL_CUSTOM_ID = `${BUTTON_PREFIX}:pause_all`;
const RESUME_ALL_CUSTOM_ID = `${BUTTON_PREFIX}:resume_all`;

export interface IScheduleControlState {
	// the guild has at least one stored event (the active-flag set, which can
	// include an already-fired one-time event the platform has not closed yet)
	hasEvents: boolean;
	// every event in that set is currently paused
	allPaused: boolean;
}

/**
 * Build the schedule board's control row from the live schedule state. Called by
 * ScheduleBoard.refreshSchedule (which computes the state from the events it
 * already loaded) on every send + edit, so the phase button is always current.
 */
export function buildScheduleControlRow(state: IScheduleControlState): ActionRowBuilder<ButtonBuilder> {
	const goLive = new ButtonBuilder()
		.setCustomId(GO_LIVE_NOW_CUSTOM_ID)
		.setLabel("Go Live Now")
		.setEmoji("📺")
		// Success (green) reads as "go"; avoids the emergency framing of Danger.
		.setStyle(ButtonStyle.Success);

	let stateButton: ButtonBuilder;
	if (!state.hasEvents) {
		// No schedule yet, a pause/resume control would be meaningless, so offer
		// the how-to instead.
		stateButton = new ButtonBuilder()
			.setCustomId(CONFIGURE_CUSTOM_ID)
			.setLabel("Set up your schedule")
			.setEmoji("🗓️")
			.setStyle(ButtonStyle.Primary);
	} else if (state.allPaused) {
		// Everything is paused → the only sensible next action is resume.
		stateButton = new ButtonBuilder()
			.setCustomId(RESUME_ALL_CUSTOM_ID)
			.setLabel("Resume reminders")
			.setEmoji("▶️")
			.setStyle(ButtonStyle.Success);
	} else {
		// At least one event is still firing → offer pause-all.
		stateButton = new ButtonBuilder()
			.setCustomId(PAUSE_ALL_CUSTOM_ID)
			.setLabel("Pause reminders")
			.setEmoji("⏸️")
			.setStyle(ButtonStyle.Secondary);
	}

	return new ActionRowBuilder<ButtonBuilder>().addComponents(goLive, stateButton);
}

// ── handler ─────────────────────────────────────────────────────────────

async function handleScheduleControl(interaction: ButtonInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await showErrorNotice(interaction, "This button only works inside a server.");
		return;
	}

	// Every schedule control is owner/admin only. Persistent buttons cannot rely
	// on a slash command's permission filter, so re-verify the clicker here.
	const config = await guildConfigStore.findByGuildId(guildId);
	const allowed = await gateOwnerOrAdmin(interaction, config);
	if (!allowed) {
		await showErrorNotice(interaction, rokCommanderCopy.responses.noWizardPowers);
		return;
	}

	const action = interaction.customId.split(":")[1];
	switch (action) {
		case "go_live_now":
			await runGoLiveNow(interaction, guildId);
			return;
		case "configure":
			await runConfigureHowTo(interaction);
			return;
		case "pause_all":
			await runBulkSchedule(interaction, guildId, "paused");
			return;
		case "resume_all":
			await runBulkSchedule(interaction, guildId, "resumed");
			return;
		default:
			// Stale button from an older board (customId no longer recognized).
			await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: ["This control is no longer available."] });
	}
}

async function runGoLiveNow(interaction: ButtonInteraction, guildId: string): Promise<void> {
	// Fire the equivalent of /events stream soon when:now via the shared helper. Note +
	// role override are null, the button is the one-tap shortcut; the slash
	// command remains the path for richer inputs.
	const result = await postGoLiveAnnouncement(interaction.client, guildId, "now", null, null);
	const c = rokCommanderCopy.goLiveSoon;
	if (result.ok) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [c.posted] });
		return;
	}
	const errorMsg =
		result.reason === "setup-required" ? c.setupRequired : result.reason === "invalid-lead-time" ? c.invalidLeadTime : c.postFailed;
	await showErrorNotice(interaction, errorMsg);
}

async function runConfigureHowTo(interaction: ButtonInteraction): Promise<void> {
	// A button cannot launch a slash command, so the "set up your schedule"
	// affordance points the admin at the commands that do.
	await showNotice(interaction, { title: getPluginCopy(null).notice.schedule, sections: [[
			"**Set up your schedule with one of these:**",
			"• `/events stream weekly` for a recurring stream or event",
			"• `/events stream announce` for a one-off event at a specific date and time",
			"• `/events kvk-season` for a full KvK season of events",
			"",
			"Once at least one schedule exists, this button becomes a Pause/Resume toggle.",
		].join("\n")] });
}

async function runBulkSchedule(interaction: ButtonInteraction, guildId: string, action: "paused" | "resumed"): Promise<void> {
	// Acknowledged first (a write per schedule), the summary posting in 🎛️admin-controls
	// (2026-10 item 257 Phase 5).
	const answer = await beginChannelAnswer(interaction, "admin");
	const result = action === "paused" ? await pauseAllGuildEvents(guildId) : await resumeAllGuildEvents(guildId);
	if (result.changed > 0) {
		const detail = action === "paused" ? setupCopy.adminLog.pausedCount(result.changed) : setupCopy.adminLog.resumedCount(result.changed);
		adminLog.emitFor(interaction, guildId, "schedule.update", { subject: setupCopy.adminLog.allSchedules, detail });
	}
	// Refresh the board so the toggle flips to its opposite and paused tags
	// update. Fire-and-forget, the DB writes are the source of truth and the
	// next refresh tick reconciles regardless.
	refreshSchedule(interaction.client, guildId).catch((err) => console.error(`[schedule-controls] refresh after ${action} failed`, err));
	await answer.send({ content: summarizeBulk(result, action) });
}

function summarizeBulk(result: IBulkScheduleResult, action: "paused" | "resumed"): string {
	if (result.total === 0) return "There are no schedules on this server yet.";
	if (result.changed === 0) {
		return action === "paused" ? "Every schedule was already paused." : "Nothing was paused, so there is nothing to resume.";
	}
	const verb = action === "paused" ? "⏸️ Paused" : "▶️ Resumed";
	const noun = result.changed === 1 ? "schedule" : "schedules";
	const tail = result.failed > 0 ? ` (${result.failed} could not be updated, check the bot's logs)` : "";
	return `${verb} ${result.changed} ${noun}${tail}.`;
}

/**
 * Register the schedule control handler. Called once at boot from main.ts before
 * the InteractionCreate listener installs.
 */
export function registerScheduleControlHandlers(): void {
	registerButton(BUTTON_PREFIX, handleScheduleControl);
}
