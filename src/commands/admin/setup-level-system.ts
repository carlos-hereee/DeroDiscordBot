import {
	ChannelType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type Role,
} from "discord.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { getLevelingConfig, invalidateLevelingConfig } from "@features/leveling/levelingConfig.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";

// ── /setup-level-system ────────────────────────────────────────────────────
// What:  every per-guild knob of the leveling system. Rates, the curve, where
//        level ups post, which channels and roles earn, approved voice
//        channels, role rewards, multipliers, and the master switch.
// Who:   admins only, gated THREE ways (see the note below).
// When:  on demand. Rare, which is why the config read elsewhere is TTL cached
//        and why this command invalidates that cache on every write.
// Where: writes GuildConfig.leveling only. It creates NOTHING.
//
// ⚠️ THE NAME BREAKS THE REPO'S configure-* FAMILY ON PURPOSE (the owner's
// decision). Every sibling is configure-something (configure-leaderboard-
// tracking, configure-auto-heal, configure-rok-reminders). This one is
// setup-level-system so that an admin typing "/setup" in the picker sees the
// homebase builder AND the leveling setup side by side, which is exactly the
// moment they are most likely to want it. Do not "correct" it back.
//
// ⚠️ AND BECAUSE OF THAT NAME, THE DESCRIPTION MUST SAY IT BUILDS NOTHING.
// /setup creates channels and roles. This one only writes config. An admin who
// reads "setup" and expects provisioning will otherwise wonder why no channel
// appeared.
//
// ⚠️ ADMIN GATING IS TWO INDEPENDENT MECHANISMS AND BOTH ARE NEEDED.
//   ① .setDefaultMemberPermissions(Administrator) is what actually HIDES the
//      command in a non-admin's picker. It is a Discord-side filter.
//   ② BOT_CONSTANTS.ADMIN_COMMANDS is the runtime gate in main.ts, checked
//      against interaction.commandName, which catches anyone who reaches the
//      command anyway (an admin permission overwrite, a stale client).
// Neither is a substitute for the other, and note that configure-leaderboard-
// tracking is an admin command that is NOT in ADMIN_COMMANDS, so that Set is
// not the definition of "admin command".
//
// ⚠️ SUBCOMMANDS, NOT 25 TOP LEVEL OPTIONS. Discord caps a command at 25 options
// AND forbids a command from carrying both subcommands and top level options, so
// the leveling subtree (which has more settings than that) has to be grouped.
// The grouping is by CONCERN, so an admin changing rates never scrolls past
// reward roles.
//
// `data` is deliberately UNANNOTATED: .addSubcommand() narrows the builder away
// from SlashCommandBuilder, so an explicit annotation would not compile. Never
// cast to any, never cast to SlashCommandBuilder. See mini-game.ts.

const LIMITS = BOT_CONSTANTS.LEVELING.LIMITS;

export const data = new SlashCommandBuilder()
	.setName("setup-level-system")
	.setDescription("Configure XP and levels for this server. Writes settings only, creates no channels or roles.")
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addSubcommand((sub) =>
		sub
			.setName("show")
			.setDescription("Show the current leveling settings and a live preview of what earns XP")
	)
	.addSubcommand((sub) =>
		sub
			.setName("toggle")
			.setDescription("Turn leveling on or off for this server. Turning it off destroys no data.")
			.addBooleanOption((option) => option.setName("enabled").setDescription("On or off").setRequired(true))
	)
	.addSubcommand((sub) =>
		sub
			.setName("rates")
			.setDescription("Set how much XP each source pays and how often")
			.addIntegerOption((option) =>
				option.setName("message-min").setDescription("Lowest XP per message").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("message-max").setDescription("Highest XP per message").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("message-cooldown").setDescription("Seconds between message awards").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("reaction-min").setDescription("Lowest XP per reaction").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("reaction-max").setDescription("Highest XP per reaction").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("reaction-cooldown").setDescription("Seconds between reaction awards").setRequired(false)
			)
			.addStringOption((option) =>
				option
					.setName("reaction-awards")
					.setDescription("Who a reaction pays")
					.setRequired(false)
					.addChoices(
						{ name: "The member who reacted", value: "reactor" },
						{ name: "The member who was reacted to", value: "author" },
						{ name: "Both", value: "both" }
					)
			)
			.addIntegerOption((option) =>
				option.setName("voice-per-minute").setDescription("XP per minute in an approved voice channel").setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("curve")
			.setDescription("Set how steeply levels get harder")
			.addStringOption((option) =>
				option
					.setName("preset")
					.setDescription("Which curve to use")
					.setRequired(false)
					.addChoices(
						{ name: "Dero (the default, quadratic)", value: "dero" },
						{ name: "Linear (gentler)", value: "linear" },
						{ name: "Exponential (steeper)", value: "exponential" },
						{ name: "Flat (every level costs the same)", value: "flat" }
					)
			)
			.addNumberOption((option) =>
				option.setName("multiplier").setDescription("Scale every level's cost. 1 is normal.").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("max-level").setDescription("Highest reachable level. 0 means uncapped.").setRequired(false)
			)
			.addStringOption((option) =>
				option
					.setName("milestones")
					.setDescription("Which levels get the loud celebration")
					.setRequired(false)
					.addChoices(
						{ name: "Prime levels (2, 3, 5, 7, 11, ...)", value: "prime" },
						{ name: "Every N levels", value: "everyN" }
					)
			)
			.addIntegerOption((option) =>
				option.setName("every-n").setDescription("Used only when milestones is Every N levels").setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("announce")
			.setDescription("Set where and how loudly level ups post. They never ping anyone.")
			.addStringOption((option) =>
				option
					.setName("mode")
					.setDescription("Where level ups post")
					.setRequired(false)
					.addChoices(
						{ name: "The announcements channel", value: "announcements" },
						{ name: "Wherever the XP was earned", value: "current" },
						{ name: "Milestone levels only", value: "milestone" },
						{ name: "Do not post at all", value: "off" }
					)
			)
			.addChannelOption((option) =>
				option
					.setName("channel")
					.setDescription("Post level ups here instead of the announcements channel")
					.addChannelTypes(ChannelType.GuildText)
					.setRequired(false)
			)
			.addStringOption((option) =>
				option.setName("emoji").setDescription("The reaction Dero adds to a milestone card").setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("restrictions")
			.setDescription("Choose where XP is earned. One mode, one list.")
			.addStringOption((option) =>
				option
					.setName("mode")
					.setDescription("Whether the list blocks earning or is the only place it happens")
					.setRequired(false)
					.addChoices(
						{ name: "Exclude: everything earns EXCEPT the list", value: "exclude" },
						{ name: "Only: nothing earns EXCEPT the list", value: "only" }
					)
			)
			.addChannelOption((option) =>
				option.setName("add-channel").setDescription("Add a channel to the list").setRequired(false)
			)
			.addChannelOption((option) =>
				option.setName("remove-channel").setDescription("Remove a channel from the list").setRequired(false)
			)
			.addRoleOption((option) => option.setName("add-role").setDescription("Add a role to the list").setRequired(false))
			.addRoleOption((option) =>
				option.setName("remove-role").setDescription("Remove a role from the list").setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("voice")
			.setDescription("Approve voice channels for XP. No channel is approved until you add one.")
			.addChannelOption((option) =>
				option
					.setName("approve")
					.setDescription("Start paying XP in this voice channel")
					.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
					.setRequired(false)
			)
			.addChannelOption((option) =>
				option
					.setName("unapprove")
					.setDescription("Stop paying XP in this voice channel")
					.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
					.setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("min-members").setDescription("How many people must be present before anyone earns").setRequired(false)
			)
			.addIntegerOption((option) =>
				option.setName("decay-after").setDescription("Minutes before a long session starts paying less").setRequired(false)
			)
			.addNumberOption((option) =>
				option.setName("decay-factor").setDescription("What a decayed award is multiplied by, 0 to 1").setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("rewards")
			.setDescription("Grant a role when a member reaches a level")
			.addIntegerOption((option) => option.setName("level").setDescription("The level that grants it").setRequired(false))
			.addRoleOption((option) => option.setName("role").setDescription("The role to grant").setRequired(false))
			.addIntegerOption((option) =>
				option.setName("remove-level").setDescription("Remove the reward configured for this level").setRequired(false)
			)
			.addBooleanOption((option) =>
				option
					.setName("stack")
					.setDescription("Keep every reward earned (on) or only the highest (off)")
					.setRequired(false)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("multipliers")
			.setDescription("Pay a role or a channel more XP than the rest")
			.addRoleOption((option) => option.setName("role").setDescription("The role to boost").setRequired(false))
			.addChannelOption((option) => option.setName("channel").setDescription("The channel to boost").setRequired(false))
			.addNumberOption((option) =>
				option.setName("multiplier").setDescription("What to multiply by. 0 removes the boost.").setRequired(false)
			)
			.addBooleanOption((option) =>
				option
					.setName("stack")
					.setDescription("Combine every applicable multiplier (on) or take the highest (off)")
					.setRequired(false)
			)
	);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const guildId = interaction.guildId;
	if (!guildId || !interaction.guild) {
		await interaction.reply({ embeds: [errorEmbed(levelingCopy.errors.outsideGuild)], flags: MessageFlags.Ephemeral });
		return;
	}

	const config = await guildConfigStore.findByGuildId(guildId);
	if (!config) {
		await interaction.reply({
			embeds: [errorEmbed("This server has not been set up yet. Run /setup first.")],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const context = await getLevelingConfig(guildId);
	if (!context) {
		await interaction.reply({ embeds: [errorEmbed(levelingCopy.errors.noData)], flags: MessageFlags.Ephemeral });
		return;
	}

	const subcommand = interaction.options.getSubcommand();
	const settings = context.settings;
	// Every branch below builds a $set patch of DOTTED paths rather than replacing
	// the whole subtree. Replacing it would silently wipe every setting the admin
	// did not happen to mention in this one invocation.
	const patch: Record<string, unknown> = {};
	const notes: string[] = [];

	switch (subcommand) {
		case "show":
			await interaction.reply({ embeds: [buildPreview(interaction, context)], flags: MessageFlags.Ephemeral });
			return;

		case "toggle": {
			const enabled = interaction.options.getBoolean("enabled", true);
			patch["leveling.enabled"] = enabled;
			notes.push(
				enabled
					? "Leveling is ON. Members earn XP for chatting, reacting, approved voice channels and Dero's games."
					: "Leveling is OFF. Nothing new is recorded and nothing posts. **No data was deleted**, and turning it back on resumes exactly where it left off."
			);
			break;
		}

		case "rates": {
			applyClampedInt(interaction, "message-min", "leveling.message.min", LIMITS.MIN_XP, LIMITS.MAX_XP, patch, notes);
			applyClampedInt(interaction, "message-max", "leveling.message.max", LIMITS.MIN_XP, LIMITS.MAX_XP, patch, notes);
			applyClampedInt(
				interaction,
				"message-cooldown",
				"leveling.message.cooldownSeconds",
				LIMITS.MIN_COOLDOWN_SECONDS,
				BOT_CONSTANTS.LEVELING.MAX_COOLDOWN_SECONDS,
				patch,
				notes
			);
			applyClampedInt(interaction, "reaction-min", "leveling.reaction.min", LIMITS.MIN_XP, LIMITS.MAX_XP, patch, notes);
			applyClampedInt(interaction, "reaction-max", "leveling.reaction.max", LIMITS.MIN_XP, LIMITS.MAX_XP, patch, notes);
			applyClampedInt(
				interaction,
				"reaction-cooldown",
				"leveling.reaction.cooldownSeconds",
				LIMITS.MIN_COOLDOWN_SECONDS,
				BOT_CONSTANTS.LEVELING.MAX_COOLDOWN_SECONDS,
				patch,
				notes
			);
			applyClampedInt(
				interaction,
				"voice-per-minute",
				"leveling.voice.perMinute",
				LIMITS.MIN_XP,
				LIMITS.MAX_XP,
				patch,
				notes
			);

			const awards = interaction.options.getString("reaction-awards");
			if (awards) patch["leveling.reaction.awards"] = awards;

			// A max below its min would make every roll collapse to the min, so it is
			// corrected here rather than left to surprise somebody later. Resolved
			// against the PATCHED values so setting both in one go behaves.
			reconcileRange(patch, settings.message.min, settings.message.max, "leveling.message.min", "leveling.message.max", notes, "message");
			reconcileRange(
				patch,
				settings.reaction.min,
				settings.reaction.max,
				"leveling.reaction.min",
				"leveling.reaction.max",
				notes,
				"reaction"
			);
			break;
		}

		case "curve": {
			const preset = interaction.options.getString("preset");
			if (preset) patch["leveling.curve"] = preset;

			const multiplier = interaction.options.getNumber("multiplier");
			if (multiplier !== null) {
				const clamped = clamp(multiplier, LIMITS.MIN_CURVE_MULTIPLIER, LIMITS.MAX_CURVE_MULTIPLIER);
				patch["leveling.curveMultiplier"] = clamped;
				if (clamped !== multiplier) notes.push(noteClamped("Curve multiplier", multiplier, clamped));
			}

			const maxLevel = interaction.options.getInteger("max-level");
			if (maxLevel !== null) {
				// 0 is the honest way to say "uncapped" through an integer option,
				// because Discord has no nullable integer.
				patch["leveling.maxLevel"] = maxLevel <= 0 ? null : clamp(maxLevel, 2, LIMITS.MAX_SETTABLE_LEVEL);
			}

			const milestones = interaction.options.getString("milestones");
			if (milestones) patch["leveling.milestoneMode"] = milestones;
			const everyN = interaction.options.getInteger("every-n");
			if (everyN !== null) patch["leveling.milestoneEveryN"] = clamp(everyN, 2, 100);
			break;
		}

		case "announce": {
			const mode = interaction.options.getString("mode");
			if (mode) patch["leveling.announceMode"] = mode;

			const channel = interaction.options.getChannel("channel");
			if (channel) patch["leveling.announceChannelId"] = channel.id;

			const emoji = interaction.options.getString("emoji");
			if (emoji) patch["leveling.reactionEmoji"] = emoji.trim();

			notes.push("Level up messages never ping anyone, whatever channel they post in.");
			break;
		}

		case "restrictions": {
			const mode = interaction.options.getString("mode");
			if (mode) patch["leveling.restrictionMode"] = mode;

			const channels = editList(
				settings.restrictedChannels,
				interaction.options.getChannel("add-channel")?.id,
				interaction.options.getChannel("remove-channel")?.id
			);
			if (channels) patch["leveling.restrictedChannels"] = channels;

			const roles = editList(
				settings.restrictedRoles,
				interaction.options.getRole("add-role")?.id,
				interaction.options.getRole("remove-role")?.id
			);
			if (roles) patch["leveling.restrictedRoles"] = roles;

			const resolvedMode = (patch["leveling.restrictionMode"] as string) ?? settings.restrictionMode;
			const resolvedChannels = (patch["leveling.restrictedChannels"] as string[]) ?? settings.restrictedChannels;
			// The DANGER case, stated plainly rather than discovered from a member's
			// complaint: "only" with an empty list means nowhere earns.
			if (resolvedMode === "only" && resolvedChannels.length === 0) {
				notes.push("⚠️ Mode is **only** and no channel is listed, so **no channel earns XP at all** right now.");
			}
			break;
		}

		case "voice": {
			const approved = editList(
				settings.voice.approvedChannels,
				interaction.options.getChannel("approve")?.id,
				interaction.options.getChannel("unapprove")?.id
			);
			if (approved) {
				patch["leveling.voice.approvedChannels"] = approved;
				if (approved.length === 0) {
					notes.push("No voice channel is approved, so **nobody earns voice XP** until you approve one.");
				}
			}

			applyClampedInt(
				interaction,
				"min-members",
				"leveling.voice.minMembers",
				LIMITS.MIN_VOICE_MEMBERS,
				LIMITS.MAX_VOICE_MEMBERS,
				patch,
				notes
			);
			applyClampedInt(interaction, "decay-after", "leveling.voice.decayAfterMinutes", 1, 1440, patch, notes);

			const decayFactor = interaction.options.getNumber("decay-factor");
			if (decayFactor !== null) {
				const clamped = clamp(decayFactor, 0, 1);
				patch["leveling.voice.decayFactor"] = clamped;
				if (clamped !== decayFactor) notes.push(noteClamped("Decay factor", decayFactor, clamped));
			}
			break;
		}

		case "rewards": {
			const stack = interaction.options.getBoolean("stack");
			if (stack !== null) patch["leveling.stackRewards"] = stack;

			const removeLevel = interaction.options.getInteger("remove-level");
			let rewards = settings.rewards;
			if (removeLevel !== null) {
				rewards = rewards.filter((reward) => reward.level !== removeLevel);
				notes.push(`Removed the reward for level ${removeLevel}.`);
			}

			const level = interaction.options.getInteger("level");
			const role = interaction.options.getRole("role");
			if (level !== null && role) {
				const refusal = refuseReward(interaction, role as Role);
				if (refusal) {
					await interaction.reply({ embeds: [errorEmbed(refusal)], flags: MessageFlags.Ephemeral });
					return;
				}
				const clampedLevel = clamp(level, 2, LIMITS.MAX_SETTABLE_LEVEL);
				rewards = [...rewards.filter((reward) => reward.level !== clampedLevel), { level: clampedLevel, roleId: role.id }];
				notes.push(`Reaching level ${clampedLevel} now grants <@&${role.id}>.`);
			} else if ((level !== null) !== Boolean(role)) {
				await interaction.reply({
					embeds: [errorEmbed("Give both a level and a role to add a reward, or use remove-level on its own.")],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (rewards !== settings.rewards) patch["leveling.rewards"] = rewards.sort((a, b) => a.level - b.level);
			break;
		}

		case "multipliers": {
			const stack = interaction.options.getBoolean("stack");
			if (stack !== null) patch["leveling.stackMultipliers"] = stack;

			const multiplier = interaction.options.getNumber("multiplier");
			const role = interaction.options.getRole("role");
			const channel = interaction.options.getChannel("channel");

			if ((role || channel) && multiplier === null) {
				await interaction.reply({
					embeds: [errorEmbed("Give a multiplier too. Use 0 to remove an existing boost.")],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (role && multiplier !== null) {
				patch["leveling.roleMultipliers"] = upsertMultiplier(
					settings.roleMultipliers.map((rule) => ({ roleId: rule.id, multiplier: rule.multiplier })),
					"roleId",
					role.id,
					multiplier
				);
				notes.push(multiplier > 0 ? `<@&${role.id}> now earns ${multiplier}x.` : `Removed the boost on <@&${role.id}>.`);
			}
			if (channel && multiplier !== null) {
				patch["leveling.channelMultipliers"] = upsertMultiplier(
					settings.channelMultipliers.map((rule) => ({ channelId: rule.id, multiplier: rule.multiplier })),
					"channelId",
					channel.id,
					multiplier
				);
				notes.push(multiplier > 0 ? `<#${channel.id}> now earns ${multiplier}x.` : `Removed the boost on <#${channel.id}>.`);
			}
			break;
		}

		default:
			// Unreachable for a member: Discord will not send a subcommand the builder
			// never declared. Only a developer adding one above without a branch here
			// reaches it, so fail loudly rather than silently doing nothing.
			console.error(`[setup-level-system] no branch for subcommand '${subcommand}'`);
			await interaction.reply({ embeds: [errorEmbed(levelingCopy.errors.noData)], flags: MessageFlags.Ephemeral });
			return;
	}

	if (Object.keys(patch).length === 0) {
		await interaction.reply({
			embeds: [infoEmbed("Nothing changed", "You did not set any option, so nothing was written.", COLORS.ACCOUNT)],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		await guildConfigStore.update(guildId, patch);
		// ⚠️ Drop the cached read immediately. Without this the admin waits up to a
		// TTL before their change takes effect, which reads as "did that save?".
		invalidateLevelingConfig(guildId);

		await interaction.reply({
			embeds: [
				infoEmbed(
					"Leveling settings updated",
					[...notes, "", `Run \`/setup-level-system show\` to see everything as it stands now.`].join("\n"),
					COLORS.ACCOUNT
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	} catch (error) {
		console.error("[setup-level-system] update failed", error);
		await interaction.reply({
			embeds: [errorEmbed("Could not save those settings. Try again or check the bot's logs.")],
			flags: MessageFlags.Ephemeral,
		});
	}
}

// ── the live preview ───────────────────────────────────────────────────────
// "XP is earned in 14 of 17 channels" is the whole point. Arcane's restrictions
// page opens with a DANGER banner because their equivalent settings silently
// kill earning everywhere and an admin only finds out from a member. A count an
// admin can read at a glance makes that state impossible to miss.
function buildPreview(
	interaction: ChatInputCommandInteraction,
	context: NonNullable<Awaited<ReturnType<typeof getLevelingConfig>>>
) {
	const settings = context.settings;
	const textChannels =
		interaction.guild?.channels.cache.filter((channel) => channel.type === ChannelType.GuildText) ?? new Map();
	const total = textChannels.size;
	const earning = [...textChannels.values()].filter((channel) => {
		const listed = settings.restrictedChannels.includes(channel.id) || (channel.parentId ? settings.restrictedChannels.includes(channel.parentId) : false);
		return settings.restrictionMode === "only" ? listed : !listed;
	}).length;

	const lines = [
		`**Status** ${settings.enabled ? "ON" : "OFF"}`,
		`**Curve** ${settings.curve}, multiplier ${settings.curveMultiplier}${settings.maxLevel ? `, capped at level ${settings.maxLevel}` : ""}`,
		`**Milestones** ${settings.milestoneMode === "prime" ? "prime levels (2, 3, 5, 7, 11, ...)" : `every ${settings.milestoneEveryN} levels`}`,
		"",
		`**Messages** ${settings.message.enabled ? `${settings.message.min} to ${settings.message.max} XP every ${settings.message.cooldownSeconds}s` : "off"}`,
		`**Reactions** ${settings.reaction.enabled ? `${settings.reaction.min} to ${settings.reaction.max} XP every ${settings.reaction.cooldownSeconds}s, pays the ${settings.reaction.awards}` : "off"}`,
		`**Voice** ${settings.voice.perMinute} XP per minute, ${settings.voice.minMembers}+ members, decays after ${settings.voice.decayAfterMinutes} minutes`,
		"",
		`**XP is earned in ${earning} of ${total} text channels** (mode: ${settings.restrictionMode})`,
		settings.voice.approvedChannels.length === 0
			? "**No voice channel is approved**, so nobody earns voice XP."
			: `**Approved voice channels** ${settings.voice.approvedChannels.map((id) => `<#${id}>`).join(", ")}`,
		settings.restrictedRoles.length > 0
			? `**Restricted roles** ${settings.restrictedRoles.map((id) => `<@&${id}>`).join(", ")}`
			: "",
		"",
		`**Level ups** ${settings.announceMode === "off" ? "do not post" : `post to ${settings.announceChannelId ? `<#${settings.announceChannelId}>` : context.announcementsChannelId ? `<#${context.announcementsChannelId}>` : "the announcements channel"}`}, and never ping anyone`,
		settings.rewards.length > 0
			? `**Role rewards** ${settings.rewards.map((reward) => `level ${reward.level} grants <@&${reward.roleId}>`).join(", ")}`
			: "**Role rewards** none configured",
	].filter(Boolean);

	return infoEmbed("Leveling settings", lines.join("\n"), COLORS.ACCOUNT);
}

// ── helpers ────────────────────────────────────────────────────────────────

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const noteClamped = (label: string, given: number, used: number): string =>
	`${label} was ${given}, which is outside the allowed range, so it was set to ${used}.`;

function applyClampedInt(
	interaction: ChatInputCommandInteraction,
	optionName: string,
	path: string,
	low: number,
	high: number,
	patch: Record<string, unknown>,
	notes: string[]
): void {
	const given = interaction.options.getInteger(optionName);
	if (given === null) return;
	const used = clamp(given, low, high);
	patch[path] = used;
	if (used !== given) notes.push(noteClamped(optionName, given, used));
}

// A max below its min collapses every roll to the min, which reads as the range
// being ignored. Corrected against the values that will actually be stored.
function reconcileRange(
	patch: Record<string, unknown>,
	currentMin: number,
	currentMax: number,
	minPath: string,
	maxPath: string,
	notes: string[],
	label: string
): void {
	const min = (patch[minPath] as number | undefined) ?? currentMin;
	const max = (patch[maxPath] as number | undefined) ?? currentMax;
	if (max >= min) return;
	patch[maxPath] = min;
	notes.push(`The ${label} maximum was below its minimum, so both are now ${min}.`);
}

// Returns the new list, or null when neither option was given, so the caller can
// tell "no change requested" from "changed to empty".
function editList(current: readonly string[], add?: string, remove?: string): string[] | null {
	if (!add && !remove) return null;
	let next = [...current];
	if (remove) next = next.filter((id) => id !== remove);
	if (add && !next.includes(add)) next.push(add);
	return next;
}

function upsertMultiplier<K extends "roleId" | "channelId">(
	current: Array<Record<K, string> & { multiplier: number }>,
	key: K,
	id: string,
	multiplier: number
): Array<Record<K, string> & { multiplier: number }> {
	const without = current.filter((rule) => rule[key] !== id);
	// 0 is how an admin removes a boost through a numeric option, since Discord
	// has no "clear this" affordance.
	if (multiplier <= 0) return without;
	return [...without, { [key]: id, multiplier } as Record<K, string> & { multiplier: number }];
}

// ── the reward role refusal, at CONFIG time ────────────────────────────────
// ⚠️ THIS IS A SECURITY REFUSAL, NOT A CONVENIENCE CHECK. A leveling bot handing
// out Administrator because somebody chatted a lot is a security incident, not a
// bug. Refused here with a clear message, and refused AGAIN at grant time in
// Phase 4, because a config row can be edited directly in Mongo.
//
// The hierarchy and managed checks are refusals too rather than warnings: a role
// the bot can never assign is a reward that will never be granted, and accepting
// it would be selling something that does not exist.
function refuseReward(interaction: ChatInputCommandInteraction, role: Role): string | null {
	if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) {
		return levelingCopy.errors.rewardRolePrivileged;
	}
	// Integration and Nitro booster roles can never be assigned by a bot.
	if (role.managed) return levelingCopy.errors.rewardRoleManaged;

	// ⚠️ Administrator does NOT bypass role hierarchy. The bot ships with the
	// Administrator permission integer and still cannot touch a role above its own.
	const me = interaction.guild?.members.me;
	if (me && me.roles.highest.comparePositionTo(role) <= 0) return levelingCopy.errors.rewardRoleTooHigh;

	return null;
}
