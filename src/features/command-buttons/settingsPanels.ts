import type { Guild, RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
// import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { getLevelingConfig } from "@features/leveling/levelingConfig.js";
import { voiceCopy } from "@features/voice/voiceCopy.js";
import { ratingsCopy } from "@features/ratings/ratingsCopy.js";
import { economyCopy } from "@features/economy/economyCopy.js";
import { isChipEconomyOn } from "@features/economy/chipWallet.js";
import type { OptionChoice } from "@handlers/commandOptions.js";
import { canChangeVisibility, hideableChannelStates } from "@features/setup/channelVisibilitySubcommands.js";
import * as deroConfigCommand from "@commands/admin/dero-config.js";
import * as levelingCommand from "@commands/admin/leveling.js";
import * as serverCommand from "@commands/admin/server.js";
import { findLeaf, listLeaves, type FormField } from "./commandForm.js";
import type { FormValue } from "./formOptionReader.js";
import type { LeafCall, PanelControl, PanelSwitch, PickControl, SettingsPanel } from "./settingsPanel.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the admin settings panels ────────────────────────────────────────────────
// What:  what each admin settings modal holds (post-launch plan item 9), keyed by a
//        panel id rather than a command name, since /server carries two: server
//        (auto heal and the leaderboard group), server-channels (the channels group),
//        leveling (the settings group), dero-config (Dero's voice) and arcade (the
//        chip switch, the monthly post and bot opponents). Each is read from the
//        server as it stands now.
// Who:   adminCommandLauncher, when an admin guide button names one of these panel
//        ids: the panel opens first, and its saved reply offers the panel's other
//        leaves of its command.
// Why these settings and not the plan's lists: the owner's decision (2026-10-25) was
//        that each modal holds only its command's real switches and choices, while
//        numbers and lists that need several fields (rates, rewards, renames, the
//        arcade's reach and block list, arcade on and off) stay on their subcommand
//        forms. A chip grant names a member and an amount, so it stays on its form too.
// How:   every control's change is a call to one of the command's own leaves, by its
//        full path ("leaderboard tracking"), with the options its slash command would
//        send, so a panel never writes anything the command could not. Choices and
//        channel types are read off the command's own builder, so a panel cannot offer
//        a value the command would refuse.

/** Who opened the panel, and where. */
export interface PanelContext {
	guild: Guild;
	userId: string;
}

/** One settings panel: the command and leaves it holds, and how to read it for a server. */
export interface PanelDefinition {
	/** The command whose leaves the panel runs. */
	command: string;
	/** The subcommand group the panel belongs to, or null for the whole command. Scopes the pick of its other leaves. */
	group: string | null;
	/** Leaf paths the panel holds; the saved reply offers the panel's other leaves. */
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
	group: "role" | "voicechannel";
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

// ── /server ──────────────────────────────────────────────────────────────────

const serverPanel: PanelDefinition = {
	command: "server",
	group: null,
	covered: ["auto-heal", "leaderboard tracking", "leaderboard week-start"],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const switches: PanelSwitch[] = [
			{ value: "auto-heal", label: copy.server.autoHeal, description: copy.server.autoHealHint, on: config.autoHealEnabled ?? true, callsFor: (on) => [call("auto-heal", { enabled: flag(on) })] },
			{
				value: "leaderboard-tracking",
				label: copy.server.tracking,
				description: copy.server.trackingHint,
				on: config.leaderboardTrackingEnabled ?? true,
				callsFor: (on) => [call("leaderboard tracking", { enabled: flag(on) })],
			},
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			{
				id: "week",
				kind: "choice",
				label: copy.server.weekLabel,
				description: copy.server.weekHint,
				choices: choicesOf(serverCommand, "leaderboard week-start", "start"),
				current: config.weekStart === "monday" ? "monday" : "sunday",
				callsFor: (value) => [call("leaderboard week-start", { start: word(value) })],
			},
		];
		return { title: copy.server.title, controls };
	},
};

// ── /server channels ─────────────────────────────────────────────────────────

// Hide and show are the server owner's alone (channelVisibilitySubcommands.ts, TWO
// GATES), so an admin who is not the owner gets the pick list, where rename is theirs
// and hide and show still answer with the owner only refusal.
const serverChannelsPanel: PanelDefinition = {
	command: "server",
	group: "channels",
	covered: ["channels hide", "channels show", "channels list"],
	async load({ guild, userId }) {
		if (!canChangeVisibility(userId, guild.ownerId)) return null;
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config?.categoryId) return null;
		const switches: PanelSwitch[] = hideableChannelStates(config).map((channel) => ({
			value: channel.value,
			label: channel.name,
			on: !channel.hidden,
			callsFor: (visible) => [call(visible ? "channels show" : "channels hide", { channel: word(channel.value) })],
		}));
		return { title: copy.serverChannels.title, controls: [{ id: "visible", kind: "switches", label: copy.serverChannels.label, description: copy.serverChannels.hint, switches }] };
	},
};

// ── /dero-config ─────────────────────────────────────────────────────────────

const voiceSub = voiceCopy.config.sub;

// Dero's voice and task list only; the arcade switches that sat here are the arcade panel's.
// ⚙️dero-config's step 1 (2026-10 item 263 Phase 4b, owner decision 15): the voice and
// Listen switches, the task roles and the voice channels Dero may join. The text channel
// list is retired (a task posts in 💬dero-commands) and the budget is hidden, so neither
// is a control nor a covered leaf the saved reply could offer.
const deroConfigPanel: PanelDefinition = {
	command: "dero-config",
	group: null,
	covered: [
		"enable",
		"disable",
		"listen",
		// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
		// "cap",
		"role add",
		"role remove",
		"voicechannel add",
		"voicechannel remove",
	],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const voice = await deroVoiceConfigStore.findByGuildId(guild.id);
		// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
		// const capField = fieldOf(deroConfigCommand, "cap", "dollars");
		const switches: PanelSwitch[] = [
			{ value: "voice", label: copy.deroConfig.voice, description: voiceSub.enable, on: voice?.enabled ?? false, callsFor: (on) => [call(on ? "enable" : "disable")] },
			{ value: "listen", label: copy.deroConfig.listen, description: voiceSub.listen, on: voice?.listenEnabled ?? true, callsFor: (on) => [call("listen", { enabled: flag(on) })] },
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			listControl({ id: "roles", kind: "roles", group: "role", option: "role", label: copy.deroConfig.roles, description: copy.deroConfig.rolesHint, current: cachedRoles(guild, voice?.allowedRoleIds ?? []) }),
			listControl({
				id: "voice-channels",
				kind: "channels",
				group: "voicechannel",
				option: "channel",
				label: copy.deroConfig.voiceChannels,
				description: voiceSub.voiceChannelGroup,
				current: cachedChannels(guild, voice?.allowedVoiceChannelIds ?? []),
			}),
			// Hidden by the owner's decision of 2026-10-27 (2026-10 item 263 Phase 4b); returns later.
			// {
			// 	id: "cap",
			// 	kind: "number",
			// 	label: copy.deroConfig.cap,
			// 	description: voiceSub.capOption,
			// 	current: voice?.monthlyCapUsd ?? BOT_CONSTANTS.DERO_VOICE_DEFAULT_CAP_USD,
			// 	min: capField?.minValue ?? 0,
			// 	max: capField?.maxValue ?? BOT_CONSTANTS.DERO_VOICE_MAX_CAP_USD,
			// 	callsFor: (value) => [call("cap", { dollars: { kind: "number", value } })],
			// },
		];
		return { title: copy.deroConfig.title, controls };
	},
};

// ── /leveling settings ───────────────────────────────────────────────────────

// One fixed choice of a leveling settings subcommand, as a single select. Each change is its
// own run of that subcommand, so two choices on one subcommand (the curve's preset
// and its milestones) are two runs, each saving only its own option.
function levelingChoice(id: string, path: string, option: string, label: string, current: string): PanelControl {
	const field = fieldOf(levelingCommand, path, option);
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

const LEVELING_SETTINGS = "settings";
const settingsPath = (subcommand: string): string => `${LEVELING_SETTINGS} ${subcommand}`;

const levelingPanel: PanelDefinition = {
	command: "leveling",
	group: null,
	covered: [settingsPath("toggle")],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const context = await getLevelingConfig(guild.id);
		if (!context) return null;
		const settings = context.settings;
		const switches: PanelSwitch[] = [
			{ value: "leveling", label: copy.leveling.leveling, description: copy.leveling.levelingHint, on: settings.enabled, callsFor: (on) => [call(settingsPath("toggle"), { enabled: flag(on) })] },
			{ value: "stack-rewards", label: copy.leveling.stackRewards, description: copy.leveling.stackRewardsHint, on: settings.stackRewards, callsFor: (on) => [call(settingsPath("rewards"), { stack: flag(on) })] },
			{
				value: "stack-multipliers",
				label: copy.leveling.stackMultipliers,
				description: copy.leveling.stackMultipliersHint,
				on: settings.stackMultipliers,
				callsFor: (on) => [call(settingsPath("multipliers"), { stack: flag(on) })],
			},
		];
		const controls: PanelControl[] = [
			{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches },
			levelingChoice("curve", settingsPath("curve"), "preset", copy.leveling.curve, settings.curve),
			levelingChoice("milestones", settingsPath("curve"), "milestones", copy.leveling.milestones, settings.milestoneMode),
			levelingChoice("announce", settingsPath("announce"), "mode", copy.leveling.announce, settings.announceMode),
			levelingChoice("reaction-awards", settingsPath("rates"), "reaction-awards", copy.leveling.reactionAwards, settings.reaction.awards),
		];
		return { title: copy.leveling.title, controls };
	},
};

// ── /arcade ──────────────────────────────────────────────────────────────────

// The arcade's three switches: chips (2026-10 item 250 Phase 5), the monthly post and
// bot opponents. A row that never stored the post or the bots switch reads as on, the
// schema default. Status, grants, the reach, the block list and on and off are offered
// on the saved reply, since each needs more than a switch.
const arcadePanel: PanelDefinition = {
	command: "arcade",
	group: null,
	covered: ["chips toggle", "monthly-post", "bots"],
	async load({ guild }) {
		const config = await guildConfigStore.findByGuildId(guild.id);
		if (!config) return null;
		const switches: PanelSwitch[] = [
			{
				value: "economy",
				label: economyCopy.panel.economy,
				description: economyCopy.panel.economyHint,
				on: isChipEconomyOn(config),
				callsFor: (on) => [call("chips toggle", { enabled: flag(on) })],
			},
			{
				value: "monthly-post",
				label: copy.arcade.monthlyPost,
				description: ratingsCopy.config.monthlyPost,
				on: config.arcadeMonthlyPost ?? true,
				callsFor: (on) => [call("monthly-post", { enabled: flag(on) })],
			},
			{
				value: "bots",
				label: copy.arcade.bots,
				description: ratingsCopy.config.bots,
				on: config.botOpponentsEnabled ?? true,
				callsFor: (on) => [call("bots", { enabled: flag(on) })],
			},
		];
		return { title: copy.arcade.title, controls: [{ id: "switches", kind: "switches", label: copy.switchesLabel, description: copy.switchesHint, switches }] };
	},
};

/** Every settings panel, by panel id. A guide button's launch id names one of these, or /events. */
export const SETTINGS_PANELS: ReadonlyMap<string, PanelDefinition> = new Map([
	["server", serverPanel],
	["server-channels", serverChannelsPanel],
	["leveling", levelingPanel],
	["dero-config", deroConfigPanel],
	["arcade", arcadePanel],
]);
