import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	LabelBuilder,
	ModalBuilder,
	StringSelectMenuBuilder,
	TextChannel,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type Client,
	type ColorResolvable,
	type EmbedBuilder,
	type ModalSubmitInteraction,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { COLORS } from "@base/copy/brand.js";
import { partyGameStore } from "@db/stores/partyGameStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { infoEmbed } from "@utils/embedBuilder.js";
import { parseEventDateTimeMinutes } from "@utils/dateParser.js";
import { DEFAULT_SERVER_TIMEZONE, resolveServerTimezone } from "@utils/tzParser.js";
import { gateOwnerOrAdmin } from "@utils/permissions.js";
import { adminLog } from "@features/setup/adminLog.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IPartyGame } from "@db/models/PartyGame.js";
import { answerInChannel, beginChannelAnswer, type AnswerChannelConfig } from "@utils/answerInChannel.js";
import { showNotice } from "@utils/textModal.js";

// ── partyGamesSchedule ───────────────────────────────────────────────
// What:  scheduling a party game (post-launch plan item 3): the admin's modal, the
//        announcement in 📢announcements, the RSVP card in 🔜upcoming-events with I will
//        attend and I won't attend, and the one admin log line for each.
// Who:   partyGames.ts opens the modal from the 🎉party-games card; main.ts registers
//        the modal submit and the RSVP buttons through registerPartyGameHandlers there.
// When:  the modal on an admin's press, the buttons on any member's.
// Where: the PartyGame row is the truth (see the model's note on why the list is not
//        kept on the card); the card is redrawn from the row after every press.
// How:   parsePartyGameForm is pure so its rules are testable without Discord; the
//        handlers only translate between it, the store and the two channels.
//
// It schedules; partyGamesOpen.ts opens. At the start time the 5 minute game room sweep
// opens the game by itself, hosted by the admin who scheduled it, through a claim on the
// row that survives a deploy (2026-10 item 254, Arcade 4), and the RSVP card drawn here
// says where the game is or why it could not open.
//
// 🔜upcoming-events is the homebase channel that already existed (nextDecreeChannelId,
// read only for members, written by Dero), so the RSVP card joins the "what is coming
// next" posts there rather than a second channel of the same name being built.

export const PARTY_MODAL_PREFIX = "party_games";
export const PARTY_RSVP_PREFIX = "party_rsvp";
const SCHEDULE_ACTION = "schedule";

/**
 * The games a party can be scheduled for: hangman, and the two table games a party can
 * fill (2026-10 item 254, Arcade 4). A hand kept mirror of PartyGame's PARTY_GAME_SLUGS
 * (the model imports no feature), pinned equal by this module's test.
 */
export const PARTY_GAMES = ["hangman", "holdem", "monopoly"] as const;
export type PartyGameSlug = (typeof PARTY_GAMES)[number];

const FIELD = { game: "game", start: "start", duration: "duration", max: "max" } as const;

// ── the form ──────────────────────────────────────────────────────────

export interface PartyGameForm {
	game: PartyGameSlug;
	startAt: Date;
	durationMinutes: number;
	maxAttendees: number;
}

export type PartyGameFormResult = { ok: true; form: PartyGameForm } | { ok: false; error: string };

export interface RawPartyGameForm {
	game: string | undefined;
	start: string;
	duration: string;
	max: string;
}

const WHOLE_NUMBER = /^\d+$/;

/**
 * Read the schedule modal's answers into a party game, or the first thing to fix. The
 * start is "MM/DD @HH:MM" like /events stream announce, read in the server's timezone
 * (2026-10 item 263 Phase 4c; UTC until an admin picks one). A date already past this
 * year that falls in an earlier month is read as next year (scheduling January in
 * December); any other past time is refused rather than quietly moved a year out.
 */
export function parsePartyGameForm(raw: RawPartyGameForm, now: Date = new Date(), timezone: string = DEFAULT_SERVER_TIMEZONE): PartyGameFormResult {
	const words = gameRoomsCopy.partyGames;
	if (!raw.game || !(PARTY_GAMES as readonly string[]).includes(raw.game)) return { ok: false, error: words.badGame };

	const thisYear = now.getUTCFullYear();
	let startAt = parseEventDateTimeMinutes(raw.start, thisYear, timezone);
	if (!startAt) return { ok: false, error: words.badStart(timezone) };
	if (startAt <= now && startAt.getUTCMonth() < now.getUTCMonth()) startAt = parseEventDateTimeMinutes(raw.start, thisYear + 1, timezone);
	if (!startAt || startAt <= now) return { ok: false, error: words.pastStart };

	const minDuration = BOT_CONSTANTS.PARTY_GAME_MIN_DURATION_MINUTES;
	const maxDuration = BOT_CONSTANTS.PARTY_GAME_MAX_DURATION_MINUTES;
	const duration = raw.duration.trim();
	const durationMinutes = Number(duration);
	if (!WHOLE_NUMBER.test(duration) || durationMinutes < minDuration || durationMinutes > maxDuration) {
		return { ok: false, error: words.badDuration(minDuration, maxDuration) };
	}

	const maxCap = BOT_CONSTANTS.PARTY_GAME_MAX_ATTENDEES;
	const max = raw.max.trim();
	const maxAttendees = Number(max);
	if (!WHOLE_NUMBER.test(max) || maxAttendees > maxCap) return { ok: false, error: words.badMax(maxCap) };

	return { ok: true, form: { game: raw.game as PartyGameSlug, startAt, durationMinutes, maxAttendees } };
}

/** The schedule modal, with the owner's defaults filled in and the server's timezone named. */
export function buildScheduleModal(timezone: string = DEFAULT_SERVER_TIMEZONE): ModalBuilder {
	const words = gameRoomsCopy.partyGames;
	const text = (id: string, style: TextInputStyle, value?: string, placeholder?: string): TextInputBuilder => {
		const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(true);
		if (value) input.setValue(value);
		if (placeholder) input.setPlaceholder(placeholder);
		return input;
	};
	return new ModalBuilder()
		.setCustomId(`${PARTY_MODAL_PREFIX}:${SCHEDULE_ACTION}`)
		.setTitle(words.modalTitle)
		// The zone line is the modal's fifth and last component, Discord's cap.
		.addTextDisplayComponents(new TextDisplayBuilder().setContent(words.zoneLine(timezone)))
		.addLabelComponents(
			new LabelBuilder().setLabel(words.gameLabel).setStringSelectMenuComponent(
				new StringSelectMenuBuilder()
					.setCustomId(FIELD.game)
					.setMinValues(1)
					.setMaxValues(1)
					.addOptions(PARTY_GAMES.map((game, index) => ({ label: words.gameLabels[game], value: game, default: index === 0 })))
			),
			new LabelBuilder().setLabel(words.startLabel(timezone)).setTextInputComponent(text(FIELD.start, TextInputStyle.Short, undefined, words.startPlaceholder)),
			new LabelBuilder()
				.setLabel(words.durationLabel)
				.setTextInputComponent(text(FIELD.duration, TextInputStyle.Short, String(BOT_CONSTANTS.PARTY_GAME_DEFAULT_DURATION_MINUTES))),
			new LabelBuilder().setLabel(words.maxLabel).setTextInputComponent(text(FIELD.max, TextInputStyle.Short, String(BOT_CONSTANTS.PARTY_GAME_DEFAULT_MAX_ATTENDEES)))
		);
}

// ── the RSVP card ─────────────────────────────────────────────────────

const toSeconds = (date: Date): number => Math.floor(new Date(date).getTime() / 1000);

/** The RSVP card for a party game, drawn from its row. */
export function rsvpCard(row: IPartyGame, partyChannelId: string | null): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
	const words = gameRoomsCopy.partyGames;
	const shown = BOT_CONSTANTS.PARTY_GAME_NAMES_SHOWN;
	const listOf = (ids: string[]): string => (ids.length ? words.names(ids, shown) : words.nobodyYet);
	const description = [words.cardDescription(row.hostId, toSeconds(row.startAt), row.durationMinutes, partyChannelId)];
	const outcome = openOutcomeLine(row);
	if (outcome) description.push("", outcome);
	const embed = infoEmbed(words.cardTitle(words.gameLabels[row.game]), description.join("\n"), COLORS.ARCADE as ColorResolvable).addFields(
		{ name: words.attendingTitle(row.attendeeIds.length, row.maxAttendees), value: listOf(row.attendeeIds) },
		{ name: words.decliningTitle(row.declinedIds.length), value: listOf(row.declinedIds) }
	);
	const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${PARTY_RSVP_PREFIX}:yes:${row.partyGameId}`).setLabel(words.attendLabel).setEmoji("✅").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${PARTY_RSVP_PREFIX}:no:${row.partyGameId}`).setLabel(words.declineLabel).setEmoji("❌").setStyle(ButtonStyle.Secondary)
	);
	return { embeds: [embed], components: [buttons] };
}

// What the timed open did, read off the row so every redraw of the card keeps it: a link
// to the game, why it could not open, or nothing before the start time.
function openOutcomeLine(row: Pick<IPartyGame, "openedLink" | "openFailure">): string | null {
	const words = gameRoomsCopy.partyGames;
	if (row.openedLink) return words.openedLine(row.openedLink);
	if (row.openFailure) return words.notOpenedLine(words.openFailures[row.openFailure]);
	return null;
}

// ── the modal submit ─────────────────────────────────────────────────

interface PartyChannels extends AnswerChannelConfig {
	partyGamesChannelId: string | null;
	announcementsChannelId: string | null;
	nextDecreeChannelId: string | null;
	adminRoleId: string | null;
	timezone?: string | null;
}

async function textChannel(client: Client, channelId: string | null): Promise<TextChannel | null> {
	if (!channelId) return null;
	const channel = await client.channels.fetch(channelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

/**
 * The schedule modal's submit: re-gate the admin (a modal is reachable without its
 * button), read the form, store the game, post the card and the announcement, and log
 * it. The announcement is fire and forget after the card, which is the part members act on.
 * Its answers post in 🎰arcade-control, and a refused member's in 💬dero-commands, since
 * they cannot read Headquarters (2026-10 item 257 Phase 5).
 */
export async function handleScheduleSubmit(interaction: ModalSubmitInteraction): Promise<void> {
	const [, action] = interaction.customId.split(":");
	if (action !== SCHEDULE_ACTION) return;
	const words = gameRoomsCopy.partyGames;
	const guildId = interaction.guildId;
	if (!guildId) return;

	const config = (await guildConfigStore.findByGuildId(guildId)) as unknown as PartyChannels | null;
	if (!(await gateOwnerOrAdmin(interaction, config))) {
		await answerInChannel(interaction, "member", { content: words.adminsOnly }, { config });
		return;
	}

	// Read by name: the store returns a hydrated document, whose fields are getters.
	const timezone = resolveServerTimezone(config?.timezone);
	const parsed = parsePartyGameForm(
		{
			game: interaction.fields.getStringSelectValues(FIELD.game)[0],
			start: interaction.fields.getTextInputValue(FIELD.start),
			duration: interaction.fields.getTextInputValue(FIELD.duration),
			max: interaction.fields.getTextInputValue(FIELD.max),
		},
		new Date(),
		timezone
	);
	if (!parsed.ok) {
		await answerInChannel(interaction, "arcade", { content: parsed.error }, { config });
		return;
	}

	const rsvpChannel = await textChannel(interaction.client, config?.nextDecreeChannelId ?? null);
	if (!rsvpChannel) {
		await answerInChannel(interaction, "arcade", { content: words.noRsvpChannel }, { config });
		return;
	}
	const answer = await beginChannelAnswer(interaction, "arcade", { config });

	const { form } = parsed;
	const row = await partyGameStore.create({
		guildId,
		partyGameId: randomUUID(),
		game: form.game,
		hostId: interaction.user.id,
		startAt: form.startAt,
		durationMinutes: form.durationMinutes,
		maxAttendees: form.maxAttendees,
	});
	const partyChannelId = config?.partyGamesChannelId ?? null;
	const card = await rsvpChannel.send({ ...rsvpCard(row, partyChannelId), allowedMentions: { parse: [] } });
	await partyGameStore.setMessages(guildId, row.partyGameId, { rsvpChannelId: rsvpChannel.id, rsvpMessageId: card.id });

	const gameLabel = words.gameLabels[form.game];
	adminLog.emitFor(interaction, guildId, "event.create", {
		subject: words.logSubject(gameLabel),
		detail: words.logScheduled(toSeconds(form.startAt), form.durationMinutes, form.maxAttendees),
		partyGameId: row.partyGameId,
		startAt: form.startAt.toISOString(),
		durationMinutes: form.durationMinutes,
		maxAttendees: form.maxAttendees,
	});
	void announce(interaction.client, config, row, gameLabel, rsvpChannel.id);

	await answer.send({ content: words.scheduled(rsvpChannel.id, timezone) });
}

// The 📢announcements line. Fire and forget after the card (house rule 7): a missing
// channel or a failed post is logged, and the RSVP card already stands on its own.
async function announce(client: Client, config: PartyChannels | null, row: IPartyGame, gameLabel: string, rsvpChannelId: string): Promise<void> {
	const words = gameRoomsCopy.partyGames;
	try {
		const channel = await textChannel(client, config?.announcementsChannelId ?? null);
		if (!channel) return;
		const embed = infoEmbed(
			words.announcementTitle,
			words.announcement(row.hostId, gameLabel, toSeconds(row.startAt), row.durationMinutes, config?.partyGamesChannelId ?? null, rsvpChannelId),
			COLORS.ARCADE as ColorResolvable
		);
		const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
		await partyGameStore.setMessages(row.guildId, row.partyGameId, { announcementMessageId: message.id });
	} catch (error) {
		console.warn("[party-games] the announcement did not post", { guildId: row.guildId, partyGameId: row.partyGameId, error });
	}
}

// ── the RSVP buttons ─────────────────────────────────────────────────

/** True once the game's start plus its running time has passed. */
export function isPartyOver(row: Pick<IPartyGame, "startAt" | "durationMinutes">, now: Date = new Date()): boolean {
	return new Date(row.startAt).getTime() + row.durationMinutes * 60_000 <= now.getTime();
}

/**
 * Which way a press moved the list across its cap, for the admin log: "full" when it
 * took the last seat, "reopened" when it freed one, null otherwise or with no cap.
 */
export function capCrossing(max: number, before: number, after: number): "full" | "reopened" | null {
	if (max <= 0) return null;
	if (before < max && after >= max) return "full";
	if (before >= max && after < max) return "reopened";
	return null;
}

export async function handleRsvpButton(interaction: ButtonInteraction): Promise<void> {
	const [, choice, partyGameId] = interaction.customId.split(":");
	const words = gameRoomsCopy.partyGames;
	const guildId = interaction.guildId;
	if (!guildId || !partyGameId || (choice !== "yes" && choice !== "no")) return;

	const before = await partyGameStore.findById(guildId, partyGameId);
	if (!before) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [words.gone] });
		return;
	}
	if (isPartyOver(before)) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [words.over] });
		return;
	}

	const after =
		choice === "yes"
			? await partyGameStore.attend(guildId, partyGameId, interaction.user.id, before.maxAttendees)
			: await partyGameStore.decline(guildId, partyGameId, interaction.user.id);
	if (!after) {
		await showNotice(interaction, { title: gameRoomsCopy.notices.partyGames, sections: [choice === "yes" ? words.full : words.gone] });
		return;
	}

	const config = (await guildConfigStore.findByGuildId(guildId)) as unknown as PartyChannels | null;
	// The card the press came from, redrawn in place: the press itself is the answer.
	await interaction.update(rsvpCard(after, config?.partyGamesChannelId ?? null));

	const crossing = capCrossing(after.maxAttendees, before.attendeeIds.length, after.attendeeIds.length);
	if (!crossing) return;
	// Dero noticed the list cross its cap, so Dero is the actor, not the member who pressed.
	adminLog.emit({
		guild: { id: guildId, client: interaction.client },
		kind: "event.update",
		actor: { source: "dero" },
		payload: {
			subject: words.logSubject(words.gameLabels[after.game]),
			detail: crossing === "full" ? words.logFull(after.maxAttendees) : words.logReopened(after.maxAttendees),
			partyGameId,
		},
	});
}
