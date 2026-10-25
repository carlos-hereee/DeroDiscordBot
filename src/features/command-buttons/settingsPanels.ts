import type { Guild, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { ratingsCopy } from "@features/ratings/ratingsCopy.js";
import type { OptionChoice } from "@handlers/commandOptions.js";
import * as channelsCommand from "@commands/admin/channels.js";
import * as configureCommand from "@commands/admin/configure.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import * as levelSystemCommand from "@commands/admin/setup-level-system.js";
import { findLeaf, listLeaves, type FormField } from "./commandForm.js";
import type { FormValue } from "./formOptionReader.js";
import type { LeafCall, PanelControl, PanelSwitch, PickControl, SettingsPanel } from "./settingsPanel.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the admin settings panels ────────────────────────────────────────────────
// What:  what each admin command's settings modal holds (post-launch plan item 9):
//        /configure, /channels, /dero-config and /setup-level-system, each read from
//        the server as it stands now.
// Who:   adminCommandLauncher, when an admin guide button names one of these
//        commands: the panel opens first, and its saved reply offers the command's
//        other subcommands.
// Why these settings and not the plan's lists: the owner's decision (2026-10-25) was
//        that each modal holds only its command's real switches and choices, while
//        numbers and lists that need several fields (rates, rewards, renames, the
//        arcade's reach and block list, arcade on and off) stay on their subcommand
//        forms. /economy waits for Phase 5, beside the chip economy it would switch.
// How:   every control's change is a call to one of the command's own leaves, with
//        the options its slash command would send, so a panel never writes anything
//        the command could not. Choices and channel types are read off the command's
//        own builder, so a panel cannot offer a value the command would refuse.

/** Who opened the panel, and where. */
export interface PanelContext {
	guild: Guild;
	userId: string;
}

/** One command's panel: the leaves it holds, and how to read it for a server. */
export interface PanelDefinition {
	/** Leaf paths the panel holds; the saved reply offers the command's other leaves. */
	covered: readonly string[];
	/** The panel as the server stands now, or null when this member should get the command's pick list instead. */
	load(context: PanelContext): Promise<SettingsPanel | null>;
}

const copy = commandButtonsCopy.panels;
type CommandJson = { data: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody } };

// ── helpers ──────────────────────────────────────────────────────────────────

function fieldOf(command: CommandJson, path: string, option: string): FormField | null {
	return findLeaf(listLeaves(command.data.toJSON()), path)?.fields.find((field) => field.name === option) ?? null;
}

const choicesOf = (command: CommandJson, path: string, option: string): readonly OptionChoice[] => fieldOf(command, path, option)?.choices ?? [];
const call = (path: string, values: Record<string, FormValue> = {}): LeafCall => ({ path, values: new Map(Object.entries(values)) });
const flag = (value: boolean): FormValue => ({ kind: "boolean", value });
const word = (value: string): FormValue => ({ kind: "string", value });

// A list entry Discord no longer has (a deleted role or channel) is left out of the
// preset: a select cannot show it, and leaving it out keeps it from being read as
// removed. Its subcommand's remove still takes it off the list.
function cachedRoles(guild: Guild, ids: readonly string[]): Map<string, FormValue> {
	const present = new Map<string, FormValue>();
	for (const id of ids) {
		const role = guild.roles.cache.get(id);
		if (role) present.set(id, { kind: "role", value: role });
	}
	return present;
}

function cachedChannels(guild: Guild, ids: readonly string[]): Map<string, FormValue> {
	const present = new Map<string, FormValue>();
	for (const id of ids) {
		const channel = guild.channels.cache.get(id);
		if (channel) present.set(id, { kind: "channel", value: channel });
	}
	return present;
}

// One allowlist of /dero-config as a select: each added entry is one `<group> add`,
// each removed one `<group> remove`, the way an admin would run them by hand.
function listControl(params: {
	id: string;
	kind: PickControl["kind"];
	group: "role" | "channel" | "voicechannel";
	option: string;
	label: string;
	description: string;
	current: Map<string, FormValue>;
}): PickControl {
	const channelTypes = params.kind === "channels" ? fieldOf(deroConfigCommand, `${params.group} add`, params.option)?.channelTypes ?? undefined : undefined;
	return {
		id: params.id,
		kind: params.kind,
		label: params.label,
		description: params.description,
		channelTypes,
		current: params.current,
		callsFor: ({ added, removed }) => [
			...added.map((value) => call(`${params.group} add`, { [params.option]: value })),
			...removed.map((value) => call(`${params.group} remove`, { [params.option]: value })),
		],
	};
}

// ── /configure ───────────────────────────────────────────────────────────────

const configurePanel: PanelDefinition = {
	covered: ["auto-heal", "leaderboard-tracking", "week-start"],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const switches: PanelSwitch[] = [
			{ value: "auto-heal", label: copy.configure.autoHeal, description: copy.configure.autoHealHint, on: config.autoHealEnabled ?? true, callsFor: (on) => [call("auto-heal", { enabled: flag(on) })] },
			{
				value: "leaderboard-tracking",
				label: copy.configure.tracking,
				description: copy.configure.trackingHint,
				on: config.leaderboardTrackingEnabled ?? true,
				callsFor: (on) => [call("leaderboard-tracking", { enabled: flag(on) })],
			},
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			{
				id: "week",
				kind: "choice",
				label: copy.configure.weekLabel,
				description: copy.configure.weekHint,
				choices: choicesOf(configureCommand, "week-start", "start"),
				current: config.weekStart === "monday" ? "monday" : "sunday",
				callsFor: (value) => [call("week-start", { start: word(value) })],
			},
		];
		return { title: copy.configure.title, controls };
	},
};

// ── /channels ────────────────────────────────────────────────────────────────

// Hide and show are the server owner's alone (channels.ts, TWO GATES), so an admin
// who is not the owner gets the pick list, where rename is theirs and hide and show
// still answer with the owner only refusal.
const channelsPanel: PanelDefinition = {
	covered: ["hide", "show", "list"],
	async load({ guild, userId }) {
		if (!channelsCommand.canChangeVisibility(userId, guild.ownerId)) return null;
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config?.categoryId) return null;
		const switches: PanelSwitch[] = channelsCommand.hideableChannelStates(config).map((channel) => ({
			value: channel.value,
			label: channel.name,
			on: !channel.hidden,
			callsFor: (visible) => [call(visible ? "show" : "hide", { channel: word(channel.value) })],
		}));
		return { title: copy.channels.title, controls: [{ id: "visible", kind: "switches", label: copy.channels.label, description: copy.channels.hint, switches }] };
	},
};

// ── /dero-config ─────────────────────────────────────────────────────────────

const voiceSub = voiceCopy.config.sub;

const deroConfigPanel: PanelDefinition = {
	covered: ["enable", "disable", "listen", "cap", "role add", "role remove", "channel add", "channel remove", "voicechannel add", "voicechannel remove", "arcade monthly-post"],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const voice = await deroVoiceConfigStore.findByGuildId(guild.id);
		const capField = fieldOf(deroConfigCommand, "cap", "dollars");
		const switches: PanelSwitch[] = [
			{ value: "voice", label: copy.deroConfig.voice, description: voiceSub.enable, on: voice?.enabled ?? false, callsFor: (on) => [call(on ? "enable" : "disable")] },
			{ value: "listen", label: copy.deroConfig.listen, description: voiceSub.listen, on: voice?.listenEnabled ?? true, callsFor: (on) => [call("listen", { enabled: flag(on) })] },
			{
				value: "monthly-post",
				label: copy.deroConfig.monthlyPost,
				description: ratingsCopy.config.monthlyPost,
				on: config.arcadeMonthlyPost ?? true,
				callsFor: (on) => [call("arcade monthly-post", { enabled: flag(on) })],
			},
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			listControl({ id: "roles", kind: "roles", group: "role", option: "role", label: copy.deroConfig.roles, description: copy.deroConfig.rolesHint, current: cachedRoles(guild, voice?.allowedRoleIds ?? []) }),
			listControl({ id: "channels", kind: "channels", group: "channel", option: "channel", label: copy.deroConfig.channels, description: voiceSub.channelGroup, current: cachedChannels(guild, voice?.allowedChannelIds ?? []) }),
			listControl({
				id: "voice-channels",
				kind: "channels",
				group: "voicechannel",
				option: "channel",
				label: copy.deroConfig.voiceChannels,
				description: voiceSub.voiceChannelGroup,
				current: cachedChannels(guild, voice?.allowedVoiceChannelIds ?? []),
			}),
			{
				id: "cap",
				kind: "number",
				label: copy.deroConfig.cap,
				description: voiceSub.capOption,
				current: voice?.monthlyCapUsd ?? BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD,
				min: capField?.minValue ?? 0,
				max: capField?.maxValue ?? BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD,
				callsFor: (value) => [call("cap", { dollars: { kind: "number", value } })],
			},
		];
		return { title: copy.deroConfig.title, controls };
	},
};

// ── /setup-level-system ──────────────────────────────────────────────────────

// One fixed choice of a leveling subcommand, as a radio group. Each change is its
// own run of that subcommand, so two choices on one subcommand (the curve's preset
// and its milestones) are two runs, each saving only its own option.
function levelingChoice(id: string, path: string, option: string, label: string, current: string): PanelControl {
	const field = fieldOf(levelSystemCommand, path, option);
	return {
		id,
		kind: "choice",
		label,
		description: field?.description ?? label,
		choices: field?.choices ?? [],
		current,
		callsFor: (value) => [call(path, { [option]: word(value) })],
	};
}

const levelSystemPanel: PanelDefinition = {
	covered: ["toggle"],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const context = await getLevelingConfig(guild.id);
		if (!context) return null;
		const settings = context.settings;
		const switches: PanelSwitch[] = [
			{ value: "leveling", label: copy.levelSystem.leveling, description: copy.levelSystem.levelingHint, on: settings.enabled, callsFor: (on) => [call("toggle", { enabled: flag(on) })] },
			{ value: "stack-rewards", label: copy.levelSystem.stackRewards, description: copy.levelSystem.stackRewardsHint, on: settings.stackRewards, callsFor: (on) => [call("rewards", { stack: flag(on) })] },
			{
				value: "stack-multipliers",
				label: copy.levelSystem.stackMultipliers,
				description: copy.levelSystem.stackMultipliersHint,
				on: settings.stackMultipliers,
				callsFor: (on) => [call("multipliers", { stack: flag(on) })],
			},
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			levelingChoice("curve", "curve", "preset", copy.levelSystem.curve, settings.curve),
			levelingChoice("milestones", "curve", "milestones", copy.levelSystem.milestones, settings.milestoneMode),
			levelingChoice("announce", "announce", "mode", copy.levelSystem.announce, settings.announceMode),
			levelingChoice("reaction-awards", "rates", "reaction-awards", copy.levelSystem.reactionAwards, settings.reaction.awards),
		];
		return { title: copy.levelSystem.title, controls };
	},
};

/** The commands whose guide button opens a settings panel, by command name. */
export const SETTINGS_PANELS: ReadonlyMap<string, PanelDefinition> = new Map([
	[configureCommand.data.name, configurePanel],
	[channelsCommand.data.name, channelsPanel],
	[deroConfigCommand.data.name, deroConfigPanel],
	[levelSystemCommand.data.name, levelSystemPanel],
]);
