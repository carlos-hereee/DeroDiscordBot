import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { creatorId } from "@utils/config.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import {
	buildRenderAnalyticsReport,
	RENDER_ANALYTICS_PERIODS,
	type RenderAnalyticsPeriod,
	type RenderAnalyticsReport,
} from "@features/renderer/renderAnalytics.js";
import { renderAnalyticsCopy } from "@features/renderer/renderAnalyticsCopy.js";

// ── /render-analytics ──────────────────────────────────────────────────────
// What:  the platform owner's read of render cache analytics (2026-10 item 244):
//        per surface totals, the memory tier, and the most served cards.
// Who:   the platform owner ONLY (CREATOR_DISCORD_ID). The rows are platform
//        wide, so a guild admin seeing them would see every other server's
//        traffic. The Administrator default only hides it from members' pickers;
//        the owner check in execute is the real gate, and an empty creatorId
//        refuses everyone.
// Where: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS: that runtime gate
//        requires a /setup config in the guild, and the owner must be able to
//        run this from any server the bot is in. It reads only; it never writes.
//
// ⚠️ `data` IS DELIBERATELY UNANNOTATED, for the same reason as xp.ts:
// .addSubcommand() narrows the builder away from SlashCommandBuilder.

export const RENDER_ANALYTICS_SUBCOMMANDS = ["top10"] as const;

// Discord rejects an embed whose description passes 4096 characters.
const EMBED_DESCRIPTION_LIMIT = 4096;

const copy = renderAnalyticsCopy;

export const data = new SlashCommandBuilder()
	.setName("render-analytics")
	.setDescription(copy.command.description)
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addSubcommand((sub) =>
		sub
			.setName("top10")
			.setDescription(copy.command.top10Description)
			.addStringOption((option) => option.setName("surface").setDescription(copy.command.surfaceOption).setRequired(false))
			.addStringOption((option) =>
				option
					.setName("period")
					.setDescription(copy.command.periodOption)
					.setRequired(false)
					.addChoices(...RENDER_ANALYTICS_PERIODS.map((period) => ({ name: copy.command.periodChoices[period], value: period })))
			)
	);

/** True only for the platform owner; an unset CREATOR_DISCORD_ID refuses everyone. */
export function isPlatformOwner(userId: string): boolean {
	return creatorId !== "" && userId === creatorId;
}

function isPeriod(value: string | null): value is RenderAnalyticsPeriod {
	return value !== null && (RENDER_ANALYTICS_PERIODS as readonly string[]).includes(value);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	if (!isPlatformOwner(interaction.user.id)) {
		await interaction.reply({ embeds: [errorEmbed(copy.errors.notOwner)], flags: MessageFlags.Ephemeral });
		return;
	}
	const subcommand = interaction.options.getSubcommand();
	if (subcommand !== "top10") {
		await interaction.reply({ embeds: [errorEmbed(copy.errors.unknownSubcommand(subcommand))], flags: MessageFlags.Ephemeral });
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
		console.warn(`[render-analytics] building the ${period} report${surface ? ` for ${surface}` : ""} failed`, error);
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
