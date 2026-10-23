import {
	SlashCommandBuilder,
	SlashCommandSubcommandGroupBuilder,
	ChatInputCommandInteraction,
	MessageFlags,
	ChannelType,
	type EmbedBuilder,
} from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore, type DeroVoiceListField } from "@db/stores/deroVoiceConfigStore.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import { errorEmbed, infoEmbed } from "@utils/embedBuilder.js";
import { COLORS } from "@base/copy/brand.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { currentMonthCents } from "@features/voice/spendMeter.js";
import { formatUsd } from "@features/voice/pricing.js";
import { isTtsKeyConfigured } from "@features/voice/elevenLabsTts.js";
import { voiceSessions } from "@features/voice/voiceSessions.js";
import { resolveDeroVoiceId } from "@features/voice/deroVoiceId.js";
import { ratingsCopy } from "@features/ratings/ratingsCopy.js";

// ── /dero-config ──────────────────────────────────────────────────────
// What:  every per guild voice setting in one admin command: the kill switch,
//        Listen on or off, the monthly cap, and the three allowlists later
//        phases authorize against. The voice itself is not a setting: Dero
//        speaks with DERO_DEFAULT_VOICE_ID, so enable works straight away.
//        The `arcade` group holds the arcade settings (2026-10 item 244): today
//        the monthly arcade post switch, stored on GuildConfig rather than
//        DeroVoiceConfig because it has nothing to do with the voice. Item 245
//        Phase 4b (the command merge) has not run yet, so this group is a new
//        name that phase must fold into its command layout.
// Who:   server admins, gated at runtime by ADMIN_COMMANDS in main.ts (guild
//        owner or the bot's admin role). It carries no Discord default
//        permission, which would hide it from that admin role.
// When:  on demand. Every write is idempotent with an explicit "already X"
//        reply, so repeating a command never reads as a fake change.
// Where: writes DeroVoiceConfig through deroVoiceConfigStore. Read by the Listen
//        button and handler and by the spend meter. The arcade group writes
//        GuildConfig.arcadeMonthlyPost, read by features/ratings/monthlyArcadePost.ts.
// How:   ① guild gate (rejects DM use); ② setup gate (a guild that never ran
//        /setup has no admin role for the runtime gate to check); ③ dispatch on
//        the subcommand group or subcommand; ④ one ephemeral embed reply.
//
// ⚠️ DISABLE NEVER DELETES. It flips `enabled` and nothing else, so enable
// restores the guild exactly as it was, lists and cap included. It
// (and a cap of 0) DOES end a live voice call at once: that is a session, not a
// setting, and a kill switch that left Dero talking would not be one.

const c = voiceCopy.config;
const VOICE_ID_TAIL_LENGTH = 4;

type ListKind = "role" | "channel" | "voicechannel";

// Where Dero may post (announcement channels included) and where it may join.
// Stage channels are left out of the voice list on purpose: the plan allowlists
// ordinary voice channels only.
const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const VOICE_CHANNEL_TYPES = [ChannelType.GuildVoice] as const;

// One row per allowlist: the option it reads, the stored field, how an id renders.
const LISTS: Record<ListKind, { field: DeroVoiceListField; option: string; mention: (id: string) => string; title: string }> = {
	role: { field: "allowedRoleIds", option: "role", mention: (id) => `<@&${id}>`, title: c.listTitle.roles },
	channel: { field: "allowedChannelIds", option: "channel", mention: (id) => `<#${id}>`, title: c.listTitle.channels },
	voicechannel: { field: "allowedVoiceChannelIds", option: "channel", mention: (id) => `<#${id}>`, title: c.listTitle.voiceChannels },
};

/** The last characters of a voice id, the only part any reply ever shows. */
export function voiceIdTail(id: string): string {
	return id.slice(-VOICE_ID_TAIL_LENGTH);
}

function listGroup(kind: ListKind, description: string): SlashCommandSubcommandGroupBuilder {
	const group = new SlashCommandSubcommandGroupBuilder().setName(kind).setDescription(description);
	for (const action of ["add", "remove"] as const) {
		group.addSubcommand((sub) => {
			sub.setName(action).setDescription(action === "add" ? c.sub.add : c.sub.remove);
			if (kind === "role") {
				return sub.addRoleOption((option) => option.setName("role").setDescription(c.sub.roleOption).setRequired(true));
			}
			return sub.addChannelOption((option) =>
				option
					.setName("channel")
					.setDescription(kind === "channel" ? c.sub.channelOption : c.sub.voiceChannelOption)
					.setRequired(true)
					.addChannelTypes(...(kind === "channel" ? TEXT_CHANNEL_TYPES : VOICE_CHANNEL_TYPES))
			);
		});
	}
	return group;
}

export const data = new SlashCommandBuilder()
	.setName("dero-config")
	.setDescription(c.commandDescription)
	.addSubcommand((sub) => sub.setName("status").setDescription(c.sub.status))
	.addSubcommand((sub) => sub.setName("enable").setDescription(c.sub.enable))
	.addSubcommand((sub) => sub.setName("disable").setDescription(c.sub.disable))
	.addSubcommand((sub) =>
		sub
			.setName("listen")
			.setDescription(c.sub.listen)
			.addBooleanOption((option) => option.setName("enabled").setDescription(c.sub.listenOption).setRequired(true))
	)
	.addSubcommand((sub) =>
		sub
			.setName("cap")
			.setDescription(c.sub.cap)
			.addIntegerOption((option) =>
				option
					.setName("dollars")
					.setDescription(c.sub.capOption)
					.setRequired(true)
					.setMinValue(0)
					.setMaxValue(BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD)
			)
	)
	.addSubcommandGroup(listGroup("role", c.sub.roleGroup))
	.addSubcommandGroup(listGroup("channel", c.sub.channelGroup))
	.addSubcommandGroup(listGroup("voicechannel", c.sub.voiceChannelGroup))
	.addSubcommandGroup((group) =>
		group
			.setName("arcade")
			.setDescription(ratingsCopy.config.group)
			.addSubcommand((sub) =>
				sub
					.setName("monthly-post")
					.setDescription(ratingsCopy.config.monthlyPost)
					// A boolean like `listen`, so the two on and off switches in this command read the same.
					.addBooleanOption((option) => option.setName("enabled").setDescription(ratingsCopy.config.monthlyPostOption).setRequired(true))
			)
	);

// ── handlers, one per subcommand ──

const info = (body: string, title: string = c.statusTitle): EmbedBuilder => infoEmbed(title, body, COLORS.ADMIN);

async function status(guildId: string, current: IDeroVoiceConfig | null): Promise<EmbedBuilder> {
	const spentCents = await currentMonthCents(guildId);
	const voiceId = resolveDeroVoiceId(current);
	return info(
		c.statusBody({
			enabled: current?.enabled ?? false,
			voiceIdTail: voiceIdTail(voiceId),
			isDefaultVoice: voiceId === BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID,
			listenEnabled: current?.listenEnabled ?? true,
			keyConfigured: isTtsKeyConfigured(),
			roles: current?.allowedRoleIds.length ?? 0,
			channels: current?.allowedChannelIds.length ?? 0,
			voiceChannels: current?.allowedVoiceChannelIds.length ?? 0,
			spentUsd: formatUsd(spentCents),
			capUsd: current?.monthlyCapUsd ?? BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD,
		})
	);
}

async function enable(guildId: string, current: IDeroVoiceConfig | null): Promise<EmbedBuilder> {
	if (current?.enabled) return info(c.alreadyEnabled);
	await deroVoiceConfigStore.upsert(guildId, { enabled: true });
	return info(c.enabledBody, c.enabledTitle);
}

// The kill switch ends this guild's live call, if there is one, and says so in
// the admin's reply (the call's own channel gets its line from voiceSessions).
// Called BEFORE the write, so the switch fails closed: a save that throws below
// has still sent Dero out of the call.
function endCallForKillSwitch(guildId: string): string | null {
	const channelId = voiceSessions.get(guildId)?.channelId;
	if (!channelId) return null;
	voiceSessions.leave(guildId, "switched_off");
	return c.leftCall(channelId);
}

const withLine = (body: string, line: string | null): string => (line ? `${body}\n\n${line}` : body);

async function disable(guildId: string, current: IDeroVoiceConfig | null): Promise<EmbedBuilder> {
	// Even an "already off" disable ends a call, so the command always means "stop".
	const leftCall = endCallForKillSwitch(guildId);
	if (!current?.enabled) return info(withLine(c.alreadyDisabled, leftCall));
	await deroVoiceConfigStore.upsert(guildId, { enabled: false });
	return info(withLine(c.disabledBody, leftCall), c.disabledTitle);
}

async function setListen(guildId: string, current: IDeroVoiceConfig | null, on: boolean): Promise<EmbedBuilder> {
	if ((current?.listenEnabled ?? true) === on) return info(c.listenUnchanged(on));
	await deroVoiceConfigStore.upsert(guildId, { listenEnabled: on });
	return info(c.listenSet(on));
}

async function setCap(guildId: string, current: IDeroVoiceConfig | null, dollars: number): Promise<EmbedBuilder> {
	// The option's bounds are a hint Discord enforces in its client; this clamp is the gate.
	const usd = Math.min(Math.max(Math.trunc(dollars), 0), BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD);
	// A cap of 0 is the second kill switch, so it ends a live call the same way.
	const leftCall = usd === 0 ? endCallForKillSwitch(guildId) : null;
	if ((current?.monthlyCapUsd ?? BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD) === usd) return info(withLine(c.capUnchanged(usd), leftCall));
	await deroVoiceConfigStore.upsert(guildId, { monthlyCapUsd: usd });
	return info(withLine(c.capSet(usd), leftCall));
}

async function editList(
	guildId: string,
	current: IDeroVoiceConfig | null,
	kind: ListKind,
	action: string,
	id: string
): Promise<EmbedBuilder> {
	const list = LISTS[kind];
	const mention = list.mention(id);
	const present = current?.[list.field].includes(id) ?? false;
	if (action === "add") {
		if (present) return info(c.listAlreadyThere(mention), list.title);
		await deroVoiceConfigStore.addToList(guildId, list.field, id);
		return info(c.listAdded(mention), list.title);
	}
	if (!present) return info(c.listNotThere(mention), list.title);
	await deroVoiceConfigStore.removeFromList(guildId, list.field, id);
	return info(c.listRemoved(mention), list.title);
}

// Same idempotent shape as the voice switches: an unchanged value says so and writes nothing.
// A row that never stored the field reads as ON, the schema's default.
async function setMonthlyPost(guildId: string, storedValue: boolean | null | undefined, on: boolean): Promise<EmbedBuilder> {
	const title = ratingsCopy.config.title;
	if ((storedValue ?? true) === on) return info(ratingsCopy.config.monthlyPostUnchanged(on), title);
	await guildConfigStore.update(guildId, { arcadeMonthlyPost: on });
	return info(ratingsCopy.config.monthlyPostSet(on), title);
}

function isListKind(group: string | null): group is ListKind {
	return group === "role" || group === "channel" || group === "voicechannel";
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	// ① guild gate
	const guildId = interaction.guildId;
	if (!guildId) {
		await interaction.reply({ embeds: [errorEmbed(c.notInGuild)], flags: MessageFlags.Ephemeral });
		return;
	}

	// ② setup gate
	const guildConfig = await guildConfigStore.findByGuildId(guildId);
	if (!guildConfig) {
		await interaction.reply({ embeds: [errorEmbed(c.setupRequired)], flags: MessageFlags.Ephemeral });
		return;
	}

	try {
		// ③ dispatch. The arcade group needs only the GuildConfig the setup gate already read.
		const group = interaction.options.getSubcommandGroup(false);
		const sub = interaction.options.getSubcommand(true);
		if (group === "arcade") {
			const embed = await setMonthlyPost(guildId, guildConfig.arcadeMonthlyPost, interaction.options.getBoolean("enabled", true));
			await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
			return;
		}
		const current = await deroVoiceConfigStore.findByGuildId(guildId);

		let embed: EmbedBuilder;
		if (isListKind(group)) {
			const id =
				group === "role"
					? interaction.options.getRole(LISTS.role.option, true).id
					: interaction.options.getChannel(LISTS[group].option, true).id;
			embed = await editList(guildId, current, group, sub, id);
		}
		else if (sub === "enable") embed = await enable(guildId, current);
		else if (sub === "disable") embed = await disable(guildId, current);
		else if (sub === "listen") embed = await setListen(guildId, current, interaction.options.getBoolean("enabled", true));
		else if (sub === "cap") embed = await setCap(guildId, current, interaction.options.getInteger("dollars", true));
		else embed = await status(guildId, current);

		// ④
		await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
	}
	catch (err) {
		console.error(`[dero-config] failed guild=${guildId}`, err);
		await interaction
			.reply({ embeds: [errorEmbed(c.saveFailed)], flags: MessageFlags.Ephemeral })
			.catch(() => undefined);
	}
}
