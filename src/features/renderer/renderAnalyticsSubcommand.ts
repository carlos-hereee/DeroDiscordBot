import { MessageFlags, type ChatInputCommandInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { isPlatformOwner } from "@utils/permissions.js";
import {
	buildRenderAnalyticsReport,
	RENDER_ANALYTICS_PERIODS,
	type RenderAnalyticsPeriod,
	type RenderAnalyticsReport,
} from "@features/renderer/renderAnalytics.js";
import { renderAnalyticsCopy } from "@features/renderer/renderAnalyticsCopy.js";
import { showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

// ── /platform analytics ────────────────────────────────────────────────────
// What:  the platform owner's read of render cache analytics (2026-10 item 244):
//        per surface totals, the memory tier, and the most served cards.
// Who:   commands/admin/platform.ts adds it to /platform as `analytics` and runs it.
//        The platform owner ONLY (CREATOR_DISCORD_ID, through isPlatformOwner). The
//        rows are platform wide, so a guild admin seeing them would see every other
//        server's traffic. /platform carries no Discord default permission, so it
//        shows in every member's picker; the owner check here is the whole gate, and
//        an empty creatorId refuses everyone.
// Where: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS: that runtime gate
//        requires a /setup config in the guild, and the owner must be able to
//        run this from any server the bot is in. It reads only; it never writes.
//        renderAnalyticsDigest.ts reuses formatRenderAnalyticsReport for the DM digest.

// Discord rejects an embed whose description passes 4096 characters.
const EMBED_DESCRIPTION_LIMIT = 4096;

const copy = renderAnalyticsCopy;

/** The /platform analytics options: an optional surface and an optional period. */
export function addRenderAnalyticsOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) => option.setName("surface").setDescription(copy.command.surfaceOption).setRequired(false))
		.addStringOption((option) =>
			option
				.setName("period")
				.setDescription(copy.command.periodOption)
				.setRequired(false)
				.addChoices(...RENDER_ANALYTICS_PERIODS.map((period) => ({ name: copy.command.periodChoices[period], value: period })))
		);
}

function isPeriod(value: string | null): value is RenderAnalyticsPeriod {
	return value !== null && (RENDER_ANALYTICS_PERIODS as readonly string[]).includes(value);
}

/** Runs /platform analytics for the platform owner, refusing everyone else first. */
export async function runRenderAnalyticsSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.ownerTools, sections: [copy.errors.notOwner] });
		return;
	}

	const rawPeriod = interaction.options.getString("period");
	const period: RenderAnalyticsPeriod = isPeriod(rawPeriod) ? rawPeriod : "this-month";
	const surface = interaction.options.getString("surface")?.trim().toLowerCase() || null;

	// Two aggregates can outlast Discord's three second reply window on a cold Atlas connection.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });
	try {
		const report = await buildRenderAnalyticsReport({ period, surface });
		await interaction.editReply({ embeds: [infoEmbed(copy.title(period, surface), formatRenderAnalyticsReport(report))] });
	}
	catch (error) {
		console.warn(`[platform analytics] building the ${period} report${surface ? ` for ${surface}` : ""} failed`, error);
		await interaction.editReply({ embeds: [errorEmbed(copy.errors.readFailed)] });
	}
}

/** The embed description for a report, cut at a line boundary to Discord's 4096 character limit. */
export function formatRenderAnalyticsReport(report: RenderAnalyticsReport): string {
	const lines = report.surface ? surfaceOnlyLines(report, report.surface) : overviewLines(report);
	return fitToLimit(lines, EMBED_DESCRIPTION_LIMIT);
}

function overviewLines(report: RenderAnalyticsReport): string[] {
	if (report.surfaces.length === 0) return [copy.noRows(report.period), "", ...memoryLines(report)];
	return [
		copy.surfacesHeading,
		...report.surfaces.map((surface) => copy.surfaceLine(surface)),
		"",
		...memoryLines(report),
		"",
		copy.topHeading,
		...topLines(report),
	];
}

function surfaceOnlyLines(report: RenderAnalyticsReport, surface: string): string[] {
	if (report.top.length === 0) return [copy.noRowsForSurface(surface, report.period)];
	return [...report.surfaces.map((line) => copy.surfaceLine(line)), "", copy.topHeading, ...topLines(report)];
}

function memoryLines({ memory, droppedWrites }: RenderAnalyticsReport): string[] {
	const lines = [copy.memoryHeading, copy.cardsLine(memory.cards, memory.cardCapacity), copy.avatarsLine(memory.avatars, memory.avatarCapacity)];
	if (memory.growMemoryTier) lines.push(copy.growMemoryLine(BOT_CONSTANTS.RENDER_ANALYTICS.GROW_MEMORY_S3_SHARE));
	if (droppedWrites > 0) lines.push(copy.droppedLine(droppedWrites));
	return lines;
}

function topLines(report: RenderAnalyticsReport): string[] {
	return report.top.map((row, index) => copy.topLine(index + 1, row));
}

// Drops whole lines from the end rather than cutting one mid word, and says so,
// so a long report never reads as complete when it is not.
function fitToLimit(lines: string[], limit: number): string {
	const full = lines.join("\n");
	if (full.length <= limit) return full;
	const kept: string[] = [];
	let length = copy.truncatedNote.length + 1;
	for (const line of lines) {
		if (length + line.length + 1 > limit) break;
		kept.push(line);
		length += line.length + 1;
	}
	return [...kept, copy.truncatedNote].join("\n");
}
