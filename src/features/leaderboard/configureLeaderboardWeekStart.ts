import { type RepliableInteraction, type SlashCommandSubcommandBuilder } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { setupCopy } from "@features/setup/setupCopy.js";
import { showEmbedNotice, showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { answerInChannel } from "@utils/answerInChannel.js";

// Mirrors the GuildConfig weekStart enum. Local union (zero runtime) so the
// command, the schema, and /leaderboard's thisWeekRange all speak the same two
// values without coupling to the Mongoose doc shape.
type WeekStart = "sunday" | "monday";

// Human-readable boundary phrasing, kept identical to the /leaderboard embed
// title labels so the two surfaces never disagree on what "this week" means.
const BOUNDARY_LABEL: Record<WeekStart, string> = {
	sunday: "Sunday to Saturday",
	monday: "Monday to Sunday",
};

// ── /server leaderboard week-start ─────────────────────────────────
// What:  sets which weekday the leaderboard's "This week" window is anchored
//        to. "sunday" (default) runs Sun to Sat; "monday" runs Mon to Sun.
// Who:   admins. Read at runtime by /leaderboard's thisWeekRange and embed
//        title, and (once it ships) by Phase 2's LeaderboardBoard.
// When:  on demand. Same idempotency contract as /server leaderboard tracking
//        and /server auto-heal: no silent re-writes, an explicit
//        "already that way" reply on a no-op invocation.
// Where: writes GuildConfig.weekStart via guildConfigStore.update.
// How:   ① guildId gate; ② config existence gate; ③ value validation, because
//        guildConfigStore.update runs findOneAndUpdate WITHOUT runValidators,
//        so the schema enum will not catch a bad value on write; ④ idempotent
//        write with a confirmation that states the resulting boundary.

/** The options this handler reads, added to the merged command's subcommand. */
export function addWeekStartOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		.addStringOption((option) =>
			option
				.setName("start")
				.setDescription("Which day the leaderboard week begins on")
				.setRequired(true)
				.addChoices(
					{ name: "Sunday (week runs Sun to Sat)", value: "sunday" },
					{ name: "Monday (week runs Mon to Sun)", value: "monday" }
				)
		);
}

export async function configureLeaderboardWeekStart(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["Run this in a server, not a DM."] });
		return;
	}

	// Defensive validation. The slash-command choices restrict input at the
	// Discord layer, but guildConfigStore.update does not run schema validators,
	// so a value reaching the DB via any other path must be rejected here rather
	// than silently written to the enum field.
	const startRaw = options.getString("start", true);
	if (startRaw !== "sunday" && startRaw !== "monday") {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["Pick Sunday or Monday from the dropdown."] });
		return;
	}
	const start: WeekStart = startRaw;

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.leaderboard, sections: ["This server has not been set up yet. Run /setup first."] });
		return;
	}

	// weekStart defaults to "sunday" on legacy rows missing the field (Mongoose
	// applies the schema default on load), so this comparison is accurate even
	// before the first write.
	const current: WeekStart = config.weekStart === "monday" ? "monday" : "sunday";
	if (current === start) {
		await showEmbedNotice(interaction, infoEmbed(
					"Leaderboard week start already set",
					`The leaderboard week already starts on ${start === "monday" ? "Monday" : "Sunday"} (weeks run ${BOUNDARY_LABEL[start]}). No change made.`,
					COLORS.SCHEDULE
				));
		return;
	}

	try {
		await guildConfigStore.update(guildId, { weekStart: start });
		adminLog.emitFor(interaction, guildId, "config.change", { subject: setupCopy.adminLog.subjects.weekStart, detail: setupCopy.adminLog.set(start) });
		// A confirmation of work done is an answer, so it posts in 🛠️server-config and pings the admin who ran it (owner rule 1, 2026-10 item 263 R3-11).
		await answerInChannel(interaction, "admin", { embeds: [infoEmbed(
					"📅 Leaderboard week start updated",
					`The leaderboard's "This week" view now runs ${BOUNDARY_LABEL[start]}. The boundary is shown in the leaderboard title so members always know the window.`,
					COLORS.SCHEDULE
				)] });
	} catch (err) {
		console.error("[configure week-start] update failed", err);
		await showErrorNotice(interaction, "Could not save the setting. Try again or check the bot's logs.");
	}
}
