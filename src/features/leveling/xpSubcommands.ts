import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	MessageFlags,
	type RepliableInteraction,
	type SlashCommandSubcommandGroupBuilder,
	type User,
} from "discord.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { memberLevelStore } from "@db/stores/memberLevelStore.js";
import { xpPeriodStore } from "@db/stores/xpPeriodStore.js";
import { awardXp } from "@features/leveling/awardXp.js";
import { levelFromTotalXp, totalXpForLevel } from "@features/leveling/levelCurve.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { showEmbedNotice, showErrorNotice } from "@utils/textModal.js";

// ── /leveling xp ───────────────────────────────────────────────────────────
// What:  admin correction of a member's xp, plus the two reset paths and a
//        full data export.
// Who:   commands/admin/leveling.ts adds this group to /leveling and runs it from
//        the slash command or the /leveling button on the admin guide. Admins
//        only, through /leveling in BOT_CONSTANTS.ADMIN_COMMANDS (the server owner
//        or the /setup admin role); no Discord default permission, which would
//        hide it from that admin role.
// When:  rarely, and every destructive branch asks first.
// Where: writes MemberLevel and XpPeriod through their stores. It never touches
//        PlayerActivity or anything the participation leaderboard reads.
//
// ⚠️ THE TWO RESET SUBCOMMANDS ARE THE ONLY DESTRUCTIVE OPERATIONS IN THE WHOLE
// LEVELING FEATURE. Both require a confirm click. Nothing else in leveling
// deletes anything: turning the feature off, changing a curve, or restricting a
// channel all leave every row intact.

const LIMITS = BOT_CONSTANTS.LEVELING.LIMITS;

// ── the declared subcommand set ────────────────────────────────────────────
// Exported so xpSubcommands.test.ts can assert the BUILDER below declares exactly these and
// nothing else, in both directions. mini-game.ts uses a dispatch table for the
// same guard; this command's branches are not uniform handlers (they take
// different options and some ask for confirmation), so the list is the single
// source of truth instead, and the switch's `default` fails loudly at runtime
// for anything that slips past it.
export const XP_SUBCOMMANDS = [
	"add",
	"remove",
	"set-xp",
	"set-level",
	"reset-member",
	"reset-server",
	"export",
] as const;

// How long the confirm button stays live. Long enough to read the warning,
// short enough that a forgotten prompt cannot be clicked an hour later.
const CONFIRM_WINDOW_MS = 30_000;

// Ceiling on an export. A guild past this gets a truncated file AND is told so
// in the reply: a silent cap reads as "that is everyone", which is exactly the
// failure the community workaround for Arcane's missing export suffers from
// (it scrapes their web leaderboard and drops everyone past the first 100).
const EXPORT_ROW_CAP = 5000;

/** The /leveling xp group's seven subcommands. */
export function addXpSubcommands(group: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
	return group
		.addSubcommand((sub) =>
			sub
				.setName("add")
				.setDescription("Give a member XP")
				.addUserOption((option) => option.setName("member").setDescription("Who to give it to").setRequired(true))
				.addIntegerOption((option) => option.setName("amount").setDescription("How much XP").setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("remove")
				.setDescription("Take XP away from a member")
				.addUserOption((option) => option.setName("member").setDescription("Who to take it from").setRequired(true))
				.addIntegerOption((option) => option.setName("amount").setDescription("How much XP").setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("set-xp")
				.setDescription("Set a member's total XP to an exact number")
				.addUserOption((option) => option.setName("member").setDescription("Whose total to set").setRequired(true))
				.addIntegerOption((option) => option.setName("amount").setDescription("Their new total XP").setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("set-level")
				.setDescription("Put a member at the start of a level")
				.addUserOption((option) => option.setName("member").setDescription("Whose level to set").setRequired(true))
				.addIntegerOption((option) => option.setName("level").setDescription("Their new level").setRequired(true))
		)
		.addSubcommand((sub) =>
			sub
				.setName("reset-member")
				.setDescription("Delete one member's XP, record and achievements. Asks first.")
				.addUserOption((option) => option.setName("member").setDescription("Who to reset").setRequired(true))
		)
		.addSubcommand((sub) =>
			sub.setName("reset-server").setDescription("Delete EVERY member's leveling data in this server. Asks first.")
		)
		.addSubcommand((sub) =>
			sub.setName("export").setDescription("Download this server's leveling data as a JSON file")
		);
}

/** Runs one /leveling xp subcommand, for the slash command and the admin guide alike. */
export async function runXpSubcommand(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId) {
		await showErrorNotice(interaction, levelingCopy.errors.outsideGuild);
		return;
	}

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await showErrorNotice(interaction, levelingCopy.errors.noData);
		return;
	}
	const settings = context.settings;
	const levelOf = (totalXp: number): number =>
		levelFromTotalXp(totalXp, settings.curve, settings.curveMultiplier, settings.maxLevel);

	const subcommand = options.getSubcommand();
	const target = subcommand === "reset-server" || subcommand === "export" ? null : options.getUser("member", true);

	if (target?.bot) {
		await showErrorNotice(interaction, levelingCopy.errors.botMember);
		return;
	}

	switch (subcommand) {
		case "add": {
			const amount = Math.max(1, options.getInteger("amount", true));
			// Routed through awardXp rather than the store, deliberately: adding xp
			// that crosses a level SHOULD celebrate, and awardXp is what knows how.
			// source "admin" writes through immediately rather than buffering.
			await awardXp({
				client: interaction.client,
				guildId,
				userId: target!.id,
				username: displayNameOf(interaction, target!),
				amount,
				source: "admin",
			});
			await reply(interaction, "XP added", `Gave ${amount.toLocaleString()} XP to <@${target!.id}>.`);
			return;
		}

		case "remove": {
			const amount = Math.max(1, options.getInteger("amount", true));
			// NOT routed through awardXp: it takes positive amounts only, and taking
			// xp away must never fire a celebration. A negative $inc can drive a total
			// below zero, which levelCurve resolves to level 1 rather than throwing.
			const updated = await memberLevelStore.incrementAndReturn(
				guildId,
				target!.id,
				displayNameOf(interaction, target!),
				{ totalXp: -amount }
			);
			await reply(
				interaction,
				"XP removed",
				`Took ${amount.toLocaleString()} XP from <@${target!.id}>. They are now level ${levelOf(updated?.totalXp ?? 0)} on ${(updated?.totalXp ?? 0).toLocaleString()} XP.`
			);
			return;
		}

		case "set-xp": {
			const amount = Math.max(0, options.getInteger("amount", true));
			await setExactly(interaction, guildId, target!, amount, levelOf(amount));
			return;
		}

		case "set-level": {
			const level = clamp(options.getInteger("level", true), 1, LIMITS.MAX_SETTABLE_LEVEL);
			// The member lands at the START of that level, on exactly the cumulative
			// cost of reaching it, so their progress bar reads empty rather than
			// inheriting whatever fraction they happened to have.
			const totalXp = totalXpForLevel(level, settings.curve, settings.curveMultiplier);
			await setExactly(interaction, guildId, target!, totalXp, level);
			return;
		}

		case "reset-member": {
			const confirmed = await confirm(
				interaction,
				"Reset this member?",
				`This deletes <@${target!.id}>'s XP, their per game record and every achievement they hold in this server. It cannot be undone.`
			);
			if (!confirmed) return;

			await memberLevelStore.deleteMember(guildId, target!.id);
			// Their period rows go too, so a reset member is genuinely absent from
			// this week's board rather than lingering at the bottom of it.
			await xpPeriodStore.deleteMember(guildId, target!.id);
			await interaction.editReply({
				embeds: [infoEmbed("Member reset", `<@${target!.id}> now has no leveling data in this server.`, COLORS.ACCOUNT)],
				components: [],
			});
			return;
		}

		case "reset-server": {
			const memberCount = await memberLevelStore.countInGuild(guildId);
			const confirmed = await confirm(
				interaction,
				"Reset EVERY member?",
				`This deletes leveling data for **${memberCount.toLocaleString()} members** in this server: every XP total, every game record, every achievement. It cannot be undone.\n\nIf you only want to stop leveling, run \`/leveling settings toggle enabled:false\` instead. That keeps every row.`
			);
			if (!confirmed) return;

			await memberLevelStore.deleteGuild(guildId);
			await xpPeriodStore.deleteGuild(guildId);
			await interaction.editReply({
				embeds: [infoEmbed("Server reset", `Cleared leveling data for ${memberCount.toLocaleString()} members.`, COLORS.ACCOUNT)],
				components: [],
			});
			return;
		}

		case "export": {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });

			const rows = await memberLevelStore.topByTotalXp(guildId, EXPORT_ROW_CAP);
			const payload = {
				guildId,
				exportedAt: new Date().toISOString(),
				curve: { preset: settings.curve, multiplier: settings.curveMultiplier, maxLevel: settings.maxLevel },
				memberCount: rows.length,
				truncated: rows.length >= EXPORT_ROW_CAP,
				members: rows.map((row) => ({
					userId: row.userId,
					username: row.username,
					totalXp: row.totalXp,
					level: levelOf(row.totalXp),
					messages: row.messages,
					reactionsGiven: row.reactionsGiven,
					voiceMinutes: row.voiceMinutes,
					fortuneReadings: row.fortuneReadings,
					games: Object.fromEntries(row.games ?? new Map()),
					unlocked: row.unlocked,
				})),
			};

			const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
				name: `leveling-${guildId}-${payload.exportedAt.slice(0, 10)}.json`,
			});

			await interaction.editReply({
				embeds: [
					infoEmbed(
						"Leveling data export",
						payload.truncated
							? `⚠️ This server has more than ${EXPORT_ROW_CAP.toLocaleString()} members with XP, so the file holds the top ${EXPORT_ROW_CAP.toLocaleString()} by total XP and the rest are **not** included.`
							: `${rows.length.toLocaleString()} members, ordered by total XP.`,
						COLORS.ACCOUNT
					),
				],
				files: [file],
			});
			return;
		}

		default:
			// Unreachable for a member: Discord will not send a subcommand the builder
			// never declared. Only a developer adding one above without a branch here
			// gets here, so fail loudly rather than silently doing nothing.
			console.error(`[leveling xp] no branch for subcommand '${subcommand}'`);
			await showErrorNotice(interaction, levelingCopy.errors.noData);
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const displayNameOf = (interaction: RepliableInteraction, user: User): string =>
	interaction.guild?.members.cache.get(user.id)?.displayName ?? user.globalName ?? user.username;

async function reply(interaction: RepliableInteraction, title: string, description: string): Promise<void> {
	await showEmbedNotice(interaction, infoEmbed(title, description, COLORS.ACCOUNT));
}

// Write an absolute total and move the announcement high water mark with it.
//
// ⚠️ announcedLevel is set to the new level deliberately. It is a high water
// mark, not a level, so leaving it high after a correction DOWN would mean the
// member could never be announced again as they climbed back, and leaving it low
// after a correction UP would fire a celebration for a level an admin quietly
// granted. Matching it to the new level makes an admin correction silent, which
// is what a correction should be.
async function setExactly(
	interaction: RepliableInteraction,
	guildId: string,
	target: User,
	totalXp: number,
	level: number
): Promise<void> {
	await memberLevelStore.setTotalXp(guildId, target.id, displayNameOf(interaction, target), totalXp, level);
	await reply(
		interaction,
		"XP set",
		`<@${target.id}> is now level ${level} on ${totalXp.toLocaleString()} XP. Corrections are silent: no level up was announced.`
	);
}

// ── the confirm gate ───────────────────────────────────────────────────────
// An inline collector on this interaction's own ephemeral reply, matching the
// pattern configure-rok-reminders and challengeFlow already use. Not a
// registered persistent button: the prompt is meaningful only inside this one
// invocation, and a persistent handler would have to re-verify the admin and
// re-resolve the target from a customId.
//
// Returns false on decline AND on timeout, and in both cases the prompt is
// rewritten so a stale message can never be clicked into a deletion later.
async function confirm(interaction: RepliableInteraction, title: string, warning: string): Promise<boolean> {
	const confirmId = `xp:confirm:${interaction.id}`;
	const cancelId = `xp:cancel:${interaction.id}`;

	await interaction.reply({
		embeds: [infoEmbed(title, `${warning}\n\nThis prompt expires in ${CONFIRM_WINDOW_MS / 1000} seconds.`, COLORS.ERROR)],
		components: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(confirmId).setLabel("Yes, delete it").setStyle(ButtonStyle.Danger),
				new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
			),
		],
		flags: MessageFlags.Ephemeral,
	});

	const message = await interaction.fetchReply();
	const click = await message
		.awaitMessageComponent({
			componentType: ComponentType.Button,
			// Pins the clicker AND this invocation, so an admin cannot be caught by
			// somebody else's prompt and a stale prompt cannot resolve this one.
			filter: (i) => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId),
			time: CONFIRM_WINDOW_MS,
		})
		.catch(() => null);

	if (!click || click.customId === cancelId) {
		await interaction
			.editReply({
				embeds: [infoEmbed("Cancelled", "Nothing was deleted.", COLORS.ACCOUNT)],
				components: [],
			})
			.catch(() => undefined);
		return false;
	}

	// Acknowledge the click before the deletion runs, because the delete itself
	// can outlast Discord's three second window on a large guild.
	await click.deferUpdate().catch(() => undefined);
	return true;
}
