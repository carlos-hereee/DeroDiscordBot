import {
	type SlashCommandSubcommandBuilder,
	type RepliableInteraction,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	EmbedBuilder,
	MessageFlags,
} from "discord.js";
import { GuildEventManager } from "@features/events/GuildEventManager.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { kvkConfirmationEmbed } from "@utils/embedBuilder.js";
import { addDays, parseEventDate, parseEventDateTime } from "@utils/dateParser.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { showErrorNotice, showNotice } from "@utils/textModal.js";
import { getPluginCopy } from "@base/copy/getCopy.js";

const { configureReminders } = rokCommanderCopy;

// ── /events kvk-season ───────────────────────────────────────────────────────
// What:  the Rise of Kingdoms season builder: prebuilt reminders for a KvK
//        season from the days left and the next ruins, altar and Kau dates.
// Who:   commands/admin/events.ts adds it to /events as `kvk-season` and runs it
//        from the slash command or the /events button on the admin guide. Admins
//        only, through /events in BOT_CONSTANTS.ADMIN_COMMANDS. It reads the
//        kingdom pack's copy directly and applies no pack check of its own.
// Where: GuildEventManager creates the events; this module exports no `data` or
//        `execute`, so neither command loader registers it.

/** The /events kvk-season options: the season's days left and the three next dates. */
export function addKvkSeasonOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
	return sub
		// ── season ───────────────────────────────────────────────
		.addIntegerOption((option) =>
			option
				.setName("days-remaining")
				.setDescription("How many days remain in the current KvK season?")
				.setRequired(true)
				.setMinValue(1)
				.setMaxValue(60)
		)

		// ── ancient ruins ────────────────────────────────────────────
		.addStringOption((option) =>
			option
				.setName("ruins-date-time")
				.setDescription("Next Ancient Ruins date, format: MM/DD @HH e.g. 03/20 @12")
				.setRequired(true)
		)

		// ── altar of darkness ────────────────────────────────────────
		.addStringOption((option) =>
			option
				.setName("altar-date-time")
				.setDescription("Next Altar of Darkness date, format: MM/DD @HH e.g. 03/20 @12")
				.setRequired(true)
		)

		// ── trial of kau karuak ──────────────────────────────────────
		.addStringOption((option) =>
			option.setName("kau-date").setDescription("Trial of Kau Karuak Easy date, format: MM/DD e.g. 03/14").setRequired(true)
		);
}

// NOTE: the old `channel` option has been removed. reminders always post to
// the guild's announcements channel (guildConfig.announcementsChannelId),
// which the bot auto-creates during onboarding. asking the admin to pick a
// channel every time they ran this command was dead weight since the home
// base already has exactly one announcement channel.

/** Runs /events kvk-season, for the slash command and the admin guide's /events button alike. */
export async function runKvkSeason(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
	const daysRemaining = options.getInteger("days-remaining", true);
	const ruinsInput = options.getString("ruins-date-time", true);
	const altarInput = options.getString("altar-date-time", true);
	const kauInput = options.getString("kau-date", true);

	// ── resolve the announcements channel from guild config ─────
	// the source of truth for "where do reminders go" is the guild's
	// configured announcements channel, not a per-command option. if
	// /setup has not run yet this command cannot proceed.
	const config = await guildConfigStore.findByGuildId(interaction.guildId!);
	if (!config?.announcementsChannelId) {
		await showErrorNotice(interaction, configureReminders.setupRequired);
		return;
	}
	const announcementsChannelId = config.announcementsChannelId;

	// ── parse ─────────────────────────────────────────────────
	const ruinsFirst = parseEventDateTime(ruinsInput);
	const altarFirst = parseEventDateTime(altarInput);
	const kauEasy = parseEventDate(kauInput);

	// ── validate ──────────────────────────────────────────────
	const errors: string[] = [];

	if (!ruinsFirst) errors.push(configureReminders.ruinsInvalid);
	if (!altarFirst) errors.push(configureReminders.altarInvalid);
	if (!kauEasy) errors.push(configureReminders.kauInvalid);

	if (errors.length > 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.kvkSeason, sections: [`${configureReminders.invalidInputsHeader}\n${configureReminders.bulletList(errors)}`] });
		return;
	}

	// safely assert non-null after validation
	const seasonEnd = new Date();
	seasonEnd.setUTCDate(seasonEnd.getUTCDate() + daysRemaining);
	seasonEnd.setUTCHours(0, 0, 0, 0);

	const kauNormal = addDays(kauEasy!, 14);
	const kauHard = addDays(kauNormal, 17);
	const kauNightmare = addDays(kauHard, 6);

	// ── season range checks ───────────────────────────────────
	const rangeErrors: string[] = [];

	if (ruinsFirst! >= seasonEnd) rangeErrors.push(configureReminders.ruinsAfterSeason);
	if (altarFirst! >= seasonEnd) rangeErrors.push(configureReminders.altarAfterSeason);
	if (kauEasy! >= seasonEnd) rangeErrors.push(configureReminders.kauAfterSeason);

	if (rangeErrors.length > 0) {
		await showNotice(interaction, { title: getPluginCopy(null).notice.kvkSeason, sections: [`${configureReminders.dateConflictsHeader}\n${configureReminders.bulletList(rangeErrors)}`] });
		return;
	}

	// ── confirmation embed ────────────────────────────────────
	// still passes channelId through so the confirmation preview can show the
	// admin exactly where the reminders will post, even though it is no longer
	// a user-supplied option.
	const confirmEmbed = kvkConfirmationEmbed({
		seasonEnd,
		ruinsFirst: ruinsFirst!,
		altarFirst: altarFirst!,
		kauEasy: kauEasy!,
		kauNormal,
		kauHard,
		kauNightmare,
		channelId: announcementsChannelId,
	});

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId("confirm_rok_config")
			.setLabel(configureReminders.confirmButtonLabel)
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId("edit_rok_config")
			.setLabel(configureReminders.editButtonLabel)
			.setStyle(ButtonStyle.Secondary)
	);

	const confirmMessage = await interaction.reply({
		embeds: [confirmEmbed],
		components: [row],
		flags: MessageFlags.Ephemeral,
	});

	// ── await button press ───────────────────────────────────
	try {
		const confirmation = await confirmMessage.awaitMessageComponent({ componentType: ComponentType.Button, time: 120_000 });

		if (confirmation.customId === "edit_rok_config") {
			await confirmation.update({
				content: configureReminders.cancelled,
				embeds: [],
				components: [],
			});
			return;
		}

		if (confirmation.customId === "confirm_rok_config") {
			// ── ① checklist prompt ─────────────────────────────
			// What:  second ephemeral step. Admin already confirmed the
			//        dates; now they pick which preparation checklist
			//        gets baked into every event created by this call.
			// Who:   only the admin who ran the command sees it, same
			//        ephemeral reply is being edited, so Discord scopes
			//        visibility automatically.
			// When:  immediately after "Confirm dates are correct".
			// Where: the resolved customChecklist (or undefined) is
			//        passed to GuildEventManager.configureKvKSeason,
			//        which forwards it to every eventStore.create call.
			// How:   we show three buttons, Accept defaults, Customize,
			//        Skip. Customize opens a modal; the other two resolve
			//        immediately. On modal submit the text is split on
			//        newlines, trimmed, and empty lines are dropped.
			const checklistRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId("checklist_accept")
					.setLabel(configureReminders.checklistAcceptButtonLabel)
					.setStyle(ButtonStyle.Success),
				new ButtonBuilder()
					.setCustomId("checklist_customize")
					.setLabel(configureReminders.checklistCustomizeButtonLabel)
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId("checklist_skip")
					.setLabel(configureReminders.checklistSkipButtonLabel)
					.setStyle(ButtonStyle.Secondary)
			);

			const checklistEmbed = new EmbedBuilder()
				.setTitle(configureReminders.checklistPromptTitle)
				.setDescription(configureReminders.checklistPromptDescription);

			await confirmation.update({
				embeds: [checklistEmbed],
				components: [checklistRow],
			});

			// ── ② resolve the admin's checklist choice ─────────
			// Default to undefined (meaning "use per event type defaults
			// from rok-events.json"). Only Customize with at least one
			// non empty line flips this to a concrete array.
			let customChecklist: readonly string[] | undefined;
			let resolutionMessage: string = configureReminders.checklistResolvedAccept;

			try {
				// await the three way button press. 120s matches the
				// earlier confirmation window for consistency. On timeout
				// or modal error we fall through to defaults.
				const choice = await confirmMessage.awaitMessageComponent({
					componentType: ComponentType.Button,
					time: 120_000,
				});

				if (choice.customId === "checklist_accept") {
					customChecklist = undefined;
					resolutionMessage = configureReminders.checklistResolvedAccept;
					await choice.update({
						content: configureReminders.settingUp,
						embeds: [],
						components: [],
					});
				} else if (choice.customId === "checklist_skip") {
					// Semantically identical to Accept at persist time,
					// both leave customChecklist undefined so defaults
					// apply. We keep them separate so the admin's intent
					// ("I'll configure later") reads clearly in the
					// resolved reply.
					customChecklist = undefined;
					resolutionMessage = configureReminders.checklistResolvedSkipped;
					await choice.update({
						content: configureReminders.settingUp,
						embeds: [],
						components: [],
					});
				} else if (choice.customId === "checklist_customize") {
					// ── Customize: open modal ──────────────────
					// Discord requires showModal() be the first ack of
					// the component interaction. We cannot deferUpdate
					// before showing a modal. After modal submit we come
					// back and edit the original ephemeral via the
					// submission interaction's update().
					const modal = new ModalBuilder()
						.setCustomId("checklist_modal")
						.setTitle(configureReminders.checklistModalTitle);

					const input = new TextInputBuilder()
						.setCustomId("checklist_items")
						.setLabel(configureReminders.checklistModalInputLabel)
						.setStyle(TextInputStyle.Paragraph)
						.setPlaceholder(configureReminders.checklistModalInputPlaceholder)
						.setRequired(true)
						.setMaxLength(4000);

					modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

					await choice.showModal(modal);

					// awaitModalSubmit is scoped to this interaction so we
					// do not accidentally capture another admin's modal.
					// filter is defensive, Discord should already scope
					// this to the same interaction, but the custom id
					// filter guards against any stray submission.
					const submission = await choice.awaitModalSubmit({
						time: 180_000,
						filter: (i) => i.user.id === choice.user.id && i.customId === "checklist_modal",
					});

					const raw = submission.fields.getTextInputValue("checklist_items");

					// Parse: split on newline, trim each line, drop empty
					// lines. This is the one place the raw admin input is
					// sanitized, GuildEventManager trusts its caller.
					const parsed = raw
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter((line) => line.length > 0);

					if (parsed.length === 0) {
						// Admin submitted only whitespace or empty lines.
						// Bail out of the modal branch with an error and
						// stop the whole command, safer than silently
						// falling back to defaults, because the admin
						// clearly intended to customize.
						await showNotice(submission, { title: getPluginCopy(null).notice.kvkSeason, sections: [configureReminders.checklistEmptyError] });
						return;
					}

					customChecklist = parsed;
					resolutionMessage = configureReminders.checklistResolvedCustom(parsed.length);

					// Ack the modal so Discord stops spinning, then edit the
					// original slash command ephemeral into the "settingUp"
					// state. ModalSubmitInteraction does not expose update()
					// the way ButtonInteraction does (the types only permit
					// it after isFromMessage() narrowing), so the clean path
					// is deferUpdate on the submission + editReply on the
					// parent interaction. End result is identical to the
					// Accept/Skip branches above.
					await submission.deferUpdate();
					await interaction.editReply({
						content: configureReminders.settingUp,
						embeds: [],
						components: [],
					});
				}
			} catch {
				// Timeout on the checklist prompt OR on the modal submit.
				// Either way we fall back to defaults so the admin's date
				// work is never wasted, the season gets configured with
				// per event type defaults from rok-events.json.
				customChecklist = undefined;
				resolutionMessage = configureReminders.checklistPromptTimedOut;
				await interaction.editReply({
					content: configureReminders.settingUp,
					embeds: [],
					components: [],
				});
			}

			// ── ③ persist the season ────────────────────────────
			// GuildEventManager handles the "undefined means defaults"
			// contract. All resolvePrepSteps logic lives there, not here.
			await GuildEventManager.configureKvKSeason(interaction, {
				seasonEnd,
				ruinsFirst: ruinsFirst!,
				altarFirst: altarFirst!,
				kauEasy: kauEasy!,
				kauNormal,
				kauHard,
				kauNightmare,
				customChecklist,
			});

			// ── ④ surface the checklist resolution ──────────────
			// configureKvKSeason already edited the reply with the
			// "configured" message. We append the checklist resolution
			// so the audit trail shows both: what was scheduled and
			// which checklist was applied.
			try {
				await interaction.followUp({
					content: resolutionMessage,
					flags: MessageFlags.Ephemeral,
				});
			} catch {
				// Non critical, if the follow up fails the primary
				// reply still stands and the events are persisted.
			}
		}
	} catch {
		await interaction.editReply({
			content: configureReminders.timedOut,
			embeds: [],
			components: [],
		});
	}
}
