import {
	SlashCommandBuilder,
	SlashCommandSubcommandGroupBuilder,
	ChatInputCommandInteraction,
	type RepliableInteraction,
	MessageFlags,
	ChannelType,
	type Client,
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
import { asChallengeReach, isChallengeReach } from "@features/game-rooms/challengeReach.js";
import { scheduleNetworkBoardRefresh } from "@features/game-rooms/networkBoard.js";
import { seatOutBlockedServers } from "@features/game-rooms/satelliteSeats.js";
import { CHALLENGE_REACHES, type ChallengeReach } from "@features/game-rooms/roomTypes.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";

// ── /dero-config ──────────────────────────────────────────────────────
// What:  every per guild voice setting in one admin command: the kill switch,
//        Listen on or off, the monthly cap, and the three allowlists later
//        phases authorize against. The voice itself is not a setting: Dero
//        speaks with DERO_DEFAULT_VOICE_ID, so enable works straight away.
//        The `arcade` group holds the arcade settings (2026-10 item 244): the
//        monthly arcade post switch, the challenge reach (Phase 4) and the network
//        block list (Phase 5b), stored on GuildConfig rather than DeroVoiceConfig
//        because none has anything to do with the voice. Item 245 Phase 4b kept the group where it is and gave
//        the whole command a button on the admin guide, which runs this same run.
// Who:   server admins, gated at runtime by ADMIN_COMMANDS in main.ts (guild
//        owner or the bot's admin role). It carries no Discord default
//        permission, which would hide it from that admin role.
// When:  on demand. Every write is idempotent with an explicit "already X"
//        reply, so repeating a command never reads as a fake change.
// Where: writes DeroVoiceConfig through deroVoiceConfigStore. Read by the Listen
//        button and handler and by the spend meter. The arcade group writes
//        GuildConfig.arcadeMonthlyPost, read by features/ratings/monthlyArcadePost.ts,
//        GuildConfig.challengeReach, read by features/game-rooms/challengeReach.ts, and
//        GuildConfig.blockedNetworkGuildIds, read by the network board and every
//        remote join (features/game-rooms/networkBoard.ts and networkJoin.ts); a new
//        block also ends the satellites already linking the two servers, both ways
//        (satelliteSeats, Phase 5c).
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
const SERVER_OPTION = "server";

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
			.addSubcommand((sub) =>
				sub
					.setName("reach")
					.setDescription(ratingsCopy.config.reach)
					// Fixed choices, so Discord offers exactly the three reaches; the handler
					// still narrows the value, since a choice is the client's suggestion.
					.addStringOption((option) =>
						option
							.setName("mode")
							.setDescription(ratingsCopy.config.reachOption)
							.setRequired(true)
							.addChoices(...CHALLENGE_REACHES.map((reach) => ({ name: ratingsCopy.config.reachName(reach), value: reach })))
					)
			)
			// The network block list (2026-10 item 244 Phase 5b). A server id rather than a
			// server picker, because the server to block is one Dero shares a network with,
			// not one the admin is in, and Discord has no option type for that.
			.addSubcommand((sub) =>
				sub
					.setName("block-server")
					.setDescription(ratingsCopy.config.blockServer)
					.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(ratingsCopy.config.serverIdOption).setRequired(true))
			)
			.addSubcommand((sub) =>
				sub
					.setName("unblock-server")
					.setDescription(ratingsCopy.config.unblockServer)
					.addStringOption((option) => option.setName(SERVER_OPTION).setDescription(ratingsCopy.config.serverIdOption).setRequired(true))
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

// The same idempotent shape for the challenge reach (2026-10 item 244 Phase 4). A row
// that never stored it reads as "server", the schema's default and today's behavior.
// Rooms already playing are untouched; the next open, choice or rematch reads the new value.
async function setChallengeReach(guildId: string, storedValue: unknown, reach: ChallengeReach): Promise<EmbedBuilder> {
	const title = ratingsCopy.config.title;
	if (asChallengeReach(storedValue) === reach) return info(ratingsCopy.config.reachUnchanged(reach), title);
	await guildConfigStore.update(guildId, { challengeReach: reach });
	// The server joined or left the network, or neither: the board refresh decides, and a
	// server that left loses its board message there (2026-10 item 244 Phase 5b).
	scheduleNetworkBoardRefresh();
	return info(ratingsCopy.config.reachSet(reach), title);
}

// The submitted mode is checked rather than trusted: Discord offers only the fixed
// choices, but an interaction's values are user input, and an unknown one is refused
// rather than read as a default that would quietly widen the reach.
async function setReachFromOption(guildId: string, storedValue: unknown, mode: string): Promise<EmbedBuilder> {
	if (!isChallengeReach(mode)) return errorEmbed(ratingsCopy.config.reachUnknown);
	return setChallengeReach(guildId, storedValue, mode);
}

// The network block list (2026-10 item 244 Phase 5b), the same idempotent shape: an
// unchanged list says so and writes nothing. The id is user input, so it is checked for a
// snowflake's shape, and this server's own id is refused, since a server cannot keep
// itself off its own tables. A change redraws the network boards, and a new block seats
// out the seats already taken between the two servers (Phase 5c, owner decision
// 2026-10-24), fire and forget after the write, since the sweep can outrun Discord's
// three second reply window and the block stands whatever it finds.
async function editNetworkBlock(
	client: Client,
	guildId: string,
	storedList: readonly string[] | null | undefined,
	sub: "block-server" | "unblock-server",
	rawId: string
): Promise<EmbedBuilder> {
	const title = ratingsCopy.config.blockTitle;
	const serverId = rawId.trim();
	if (!BOT_CONSTANTS.NETWORK.SERVER_ID_PATTERN.test(serverId)) return errorEmbed(ratingsCopy.config.serverIdInvalid);
	if (serverId === guildId) return errorEmbed(ratingsCopy.config.blockSelf);

	const present = (storedList ?? []).includes(serverId);
	if (sub === "block-server") {
		if (present) return info(ratingsCopy.config.alreadyBlocked(serverId), title);
		await guildConfigStore.addBlockedNetworkGuild(guildId, serverId);
		scheduleNetworkBoardRefresh();
		void seatOutBlockedServers(client, guildId, serverId).catch((error) =>
			console.error(`[dero-config] seating out the seats between ${guildId} and blocked server ${serverId} failed`, error)
		);
		return info(ratingsCopy.config.blocked(serverId), title);
	}
	if (!present) return info(ratingsCopy.config.notBlocked(serverId), title);
	await guildConfigStore.removeBlockedNetworkGuild(guildId, serverId);
	scheduleNetworkBoardRefresh();
	return info(ratingsCopy.config.unblocked(serverId), title);
}

/** The slice of a GuildConfig row the arcade group reads. */
interface ArcadeSettings {
	challengeReach?: unknown;
	arcadeMonthlyPost?: boolean | null;
	blockedNetworkGuildIds?: readonly string[] | null;
}

/** The arcade group's reply, one setting per subcommand. */
async function arcadeAnswer(
	client: Client,
	guildId: string,
	settings: ArcadeSettings,
	sub: string,
	options: CommandOptionReader
): Promise<EmbedBuilder> {
	if (sub === "reach") return setReachFromOption(guildId, settings.challengeReach, options.getString("mode", true));
	if (sub === "block-server" || sub === "unblock-server") {
		return editNetworkBlock(client, guildId, settings.blockedNetworkGuildIds, sub, options.getString(SERVER_OPTION, true));
	}
	return setMonthlyPost(guildId, settings.arcadeMonthlyPost, options.getBoolean("enabled", true));
}

function isListKind(group: string | null): group is ListKind {
	return group === "role" || group === "channel" || group === "voicechannel";
}

/** The one handler the slash command and the admin guide's /dero-config button share. */
export async function run(interaction: RepliableInteraction, options: CommandOptionReader): Promise<void> {
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
		const group = options.getSubcommandGroup(false);
		const sub = options.getSubcommand(true);
		if (group === "arcade") {
			const embed = await arcadeAnswer(interaction.client, guildId, guildConfig, sub, options);
			await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
			return;
		}
		const current = await deroVoiceConfigStore.findByGuildId(guildId);

		let embed: EmbedBuilder;
		if (isListKind(group)) {
			const id =
				group === "role"
					? options.getRole(LISTS.role.option, true).id
					: options.getChannel(LISTS[group].option, true).id;
			embed = await editList(guildId, current, group, sub, id);
		}
		else if (sub === "enable") embed = await enable(guildId, current);
		else if (sub === "disable") embed = await disable(guildId, current);
		else if (sub === "listen") embed = await setListen(guildId, current, options.getBoolean("enabled", true));
		else if (sub === "cap") embed = await setCap(guildId, current, options.getInteger("dollars", true));
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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await run(interaction, interaction.options);
}
