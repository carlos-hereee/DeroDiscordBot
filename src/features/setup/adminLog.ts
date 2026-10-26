import { EmbedBuilder, TextChannel, type Client, type ColorResolvable } from "discord.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLogEvent } from "@base/constants/BOT_LOG_EVENTS.js";
import { COLORS } from "@base/copy/brand.js";
import { setupCopy, type AdminLogLineInput } from "./setupCopy.js";

// ── adminLog ──────────────────────────────────────────────────────────────
// What:  the ONE admin audit emitter (post-launch plan item 11). Every admin action
//        that changes what a server's members see becomes one row in BotLog and one
//        embed in that server's 🗒️admin-log channel.
// Who:   schedule and event changes (Discord and the dashboard routes), /dero-config,
//        /server, /leveling and /arcade setting changes, Community and Onboarding,
//        power-up toggles, voice list and budget edits, and every step of self destruct. Phase 5 adds
//        chip grants, vault top ups and bot seats, whose kinds are declared here now so
//        those callers have nothing to invent.
// When:  AFTER the audited action succeeded, fire and forget: `emit` returns at once,
//        logs its own failures and never throws into the caller, so a dead log
//        channel can never fail the action it records (project rule 7).
// Where: persistence goes first, through botLogStore under `admin_log:<kind>`, so the
//        trail survives a deleted channel or a failed post. The channel is read from
//        GuildConfig.adminLogChannelId on every call rather than cached, because a
//        repair or a self destruct moves it.
// How:   ① persist the row; ② resolve the channel, skipping quietly when the guild
//        has none yet (a legacy row before its first boot repair); ③ post one embed
//        with every mention disabled, since naming an admin must never ping them,
//        falling back to the plain text line when Discord refuses the embed.
//
// ⚠️ Do NOT add a second audit emitter elsewhere. The plan's reuse map names this
// file as the only one, and two emitters would drift into two trails.

/** Every kind of line the admin log carries. Phase 5 kinds are declared, not yet emitted. */
export const ADMIN_LOG_KINDS = [
	"schedule.create",
	"schedule.update",
	"schedule.delete",
	"event.create",
	"event.update",
	"event.delete",
	"config.change",
	"powerup.toggle",
	"voice.allowlist",
	"voice.cap",
	"selfdestruct.attempt",
	"chip.grant",
	"vault.topup",
	"bot.slot",
] as const;

export type AdminLogKind = (typeof ADMIN_LOG_KINDS)[number];

// ── the embed's color, by the family a kind belongs to ──
// A Record over the kind union, so a kind added above without a family is a compile
// error here. The colors are existing brand keys, so the log reads like the rest of
// the bot: the admin purple for settings, the schedule green for schedules and
// events, the error red for the one destructive step, the leaderboard gold for chips,
// and the arcade violet for bot seats.
type AdminLogFamily = "settings" | "schedules" | "destructive" | "economy" | "bots";

const ADMIN_LOG_FAMILIES: Record<AdminLogKind, AdminLogFamily> = {
	"schedule.create": "schedules",
	"schedule.update": "schedules",
	"schedule.delete": "schedules",
	"event.create": "schedules",
	"event.update": "schedules",
	"event.delete": "schedules",
	"config.change": "settings",
	"powerup.toggle": "settings",
	"voice.allowlist": "settings",
	"voice.cap": "settings",
	"selfdestruct.attempt": "destructive",
	"chip.grant": "economy",
	"vault.topup": "economy",
	"bot.slot": "bots",
};

const FAMILY_COLORS: Record<AdminLogFamily, ColorResolvable> = {
	settings: COLORS.ADMIN,
	schedules: COLORS.SCHEDULE,
	destructive: COLORS.ERROR,
	economy: COLORS.LEADERBOARD,
	bots: COLORS.ARCADE,
};

/**
 * Who acted: a member, by their Discord id, or a source with no member behind it
 * (the dashboard routes, which carry no Discord user, and Dero's own scheduled work).
 */
export type AdminLogActor = { userId: string } | { source: "dashboard" | "dero" };

/** Short, already safe values only: ids, names an admin chose, numbers, flags. Never member written text. */
export type AdminLogValue = string | number | boolean | null;

export interface AdminLogPayload {
	// What the line is about (an event's name, a setting's name).
	subject?: string;
	// What changed, in a few words ("paused until Friday", "on").
	detail?: string;
	// Anything else worth keeping in BotLog. Persisted, never posted.
	[key: string]: AdminLogValue | undefined;
}

/** The slice of a Guild the emitter needs. A discord.js Guild fits; a dashboard route passes `{ id, client }`. */
export interface AdminLogGuild {
	id: string;
	client: Client;
}

export interface AdminLogEntry {
	guild: AdminLogGuild;
	kind: AdminLogKind;
	actor: AdminLogActor;
	payload?: AdminLogPayload;
}

/** What one write did, for tests and for callers that await it. */
export interface AdminLogResult {
	persisted: boolean;
	posted: boolean;
}

// ── helpers ──

function renderActor(actor: AdminLogActor): string {
	if ("userId" in actor) return `<@${actor.userId}>`;
	return actor.source === "dashboard" ? setupCopy.adminLog.actorDashboard : setupCopy.adminLog.actorDero;
}

function actorForStorage(actor: AdminLogActor): Record<string, string> {
	return "userId" in actor ? { actorId: actor.userId } : { actorSource: actor.source };
}

// Undefined values are dropped rather than stored as null, so a row carries only
// what the caller actually said.
function definedEntries(payload: AdminLogPayload): Record<string, AdminLogValue> {
	return Object.fromEntries(Object.entries(payload).filter((entry): entry is [string, AdminLogValue] => entry[1] !== undefined));
}

async function resolveLogChannel(guild: AdminLogGuild): Promise<TextChannel | null> {
	const config = await guildConfigStore.findByGuildId(guild.id);
	const channelId = (config as unknown as { adminLogChannelId?: string | null } | null)?.adminLogChannelId;
	if (!channelId) return null;
	const channel = await guild.client.channels.fetch(channelId).catch(() => null);
	return channel instanceof TextChannel ? channel : null;
}

/** The embed one audit entry posts as: its words from setupCopy, its color by family, its time. */
export function buildAdminLogEmbed(entry: AdminLogLineInput): EmbedBuilder {
	const { title, fields } = setupCopy.adminLog.embedParts(entry);
	return new EmbedBuilder()
		.setTitle(title)
		.setColor(FAMILY_COLORS[ADMIN_LOG_FAMILIES[entry.kind]])
		.addFields(fields)
		.setTimestamp(entry.atSeconds * 1000);
}

// One embed per entry; when Discord refuses it (a missing Embed Links permission is the
// usual cause), the same entry goes out as the plain line instead, so the channel never
// loses an entry the embed could not carry. A failed fallback throws to write().
async function postEntry(channel: TextChannel, entry: AdminLogLineInput): Promise<void> {
	try {
		await channel.send({ embeds: [buildAdminLogEmbed(entry)], allowedMentions: { parse: [] } });
	} catch (error) {
		console.warn(`[admin-log] the ${entry.kind} embed was refused in channel ${channel.id}; posting the text line instead`, error);
		await channel.send({ content: setupCopy.adminLog.line(entry), allowedMentions: { parse: [] } });
	}
}

// ── the emitter ──

/**
 * Persist one audit row and post its embed. Never throws: each step catches and
 * logs its own failure, and the result says which steps landed.
 */
async function write({ guild, kind, actor, payload = {} }: AdminLogEntry): Promise<AdminLogResult> {
	const result: AdminLogResult = { persisted: false, posted: false };

	try {
		await botLogStore.log(guild.id, adminLogEvent(kind), { ...actorForStorage(actor), ...definedEntries(payload) });
		result.persisted = true;
	} catch (error) {
		console.error(`[admin-log] persisting ${kind} for guild ${guild.id} failed`, error);
	}

	try {
		const channel = await resolveLogChannel(guild);
		if (!channel) return result;
		await postEntry(channel, {
			kind,
			atSeconds: Math.floor(Date.now() / 1000),
			actor: renderActor(actor),
			subject: payload.subject,
			detail: payload.detail,
		});
		result.posted = true;
	} catch (error) {
		console.error(`[admin-log] posting ${kind} to the admin log of guild ${guild.id} failed`, error);
	}
	return result;
}

/** Fire and forget: record one admin action without waiting on, or failing, the caller. */
function emit(entry: AdminLogEntry): void {
	void write(entry);
}

/** The slice of an interaction that says who acted and reaches Discord. */
export interface AdminLogInteraction {
	client: Client;
	user: { id: string };
}

/**
 * emit() for the common case, an admin action taken through a command, button or
 * modal: the member who pressed it is the actor. Takes the guild id rather than
 * interaction.guild, which is null on an uncached guild.
 */
function emitFor(interaction: AdminLogInteraction, guildId: string, kind: AdminLogKind, payload?: AdminLogPayload): void {
	emit({ guild: { id: guildId, client: interaction.client }, kind, actor: { userId: interaction.user.id }, payload });
}

export const adminLog = { emit, emitFor, write };
