import { CategoryChannel, TextChannel, VoiceChannel, type Client, type Guild } from "discord.js";
import { DEFAULT_PLUGIN_ID, type ICopyConfig, type PluginId } from "@base/copy/index.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { refreshHeadquartersCards } from "./headquartersCards.js";
import { readAdoptedChannelIds } from "./adoption.js";

// ── switchTemplate ──────────────────────────────────────────────────────────
// What:  moves a server between Dero's two templates, kingdom (`rok-commander`) and
//        streamer (`general-events`), for free (2026-10 item 262 Phase 4). It stores the
//        new GuildConfig.pluginId, renames the managed categories and channels still on
//        the old template's default names, then rewrites every pinned intro and the
//        🛠️server-config card in the new voice.
// Who:   the 🛠️server-config template step (headquartersSteps.ts), after its owner or
//        admin gate. Nothing else writes pluginId.
// Does NOT: gate who may switch, answer the admin, or touch a channel Dero does not
//        manage. Every word a member reads comes from the pack the new id names.
// How:   ① the same id is a no op, so a repeated Submit costs no write and no rename;
//        ② pluginId is stored FIRST, because refreshIntroEmbeds re-reads the row to pick
//           the pack, and a crash after it leaves only names the boot drift sweep fixes;
//        ③ each managed category and channel is renamed once, and only when its live name
//           is the OLD pack's default: a name an admin set with /server channels rename is
//           a choice to keep, a channel the server adopted (its own #rules) keeps the name
//           the server gave it, and any other live name is one Dero did not give it;
//        ④ a refused rename is logged and the walk goes on, because Discord allows two
//           renames per channel per ten minutes and one refusal must not leave the rest
//           on the old names; the next boot's drift sweep (renameDriftedChannels) retries it
//           while auto heal is on;
//        ⑤ the intros, the cards and the audit row follow the primary write, and none of
//           them throws back into the caller (rulebook convention 7).

/** The two templates an admin picks between, by the plugin id each one stores. */
export const TEMPLATE_PLUGIN_IDS = ["rok-commander", "general-events"] as const satisfies readonly PluginId[];
export type TemplatePluginId = (typeof TEMPLATE_PLUGIN_IDS)[number];

/** Whether a submitted value is one of the two templates. A crafted Submit can carry any string. */
export function isTemplatePluginId(value: unknown): value is TemplatePluginId {
	return TEMPLATE_PLUGIN_IDS.some((id) => id === value);
}

/** The GuildConfig fields a switch reads: the template, the managed ids, the admin names and the adopted channels. */
export type TemplateRow = ICopyConfig & Record<string, unknown>;

/** What a switch did, each list naming GuildConfig fields. `changed` is false for the no op. */
export interface ISwitchTemplateResult {
	changed: boolean;
	previousPluginId: PluginId;
	renamed: string[];
	// Kept by rule: an admin set name, an adopted channel, or a live name that was not the old default.
	kept: string[];
	// Discord refused the rename (a rate limit, a missing permission).
	failed: string[];
}

/** One managed category or channel, with its old and new default names. */
interface IRenameTarget {
	field: string;
	channelId: string;
	oldName: string;
	newName: string;
	// A category has no /server channels rename slot and is never adopted.
	isCategory: boolean;
}

const MANAGED_CATEGORY_FIELDS = ["categoryId", "gamesCategoryId", "headquartersCategoryId"] as const;

/**
 * Switch the server to `nextPluginId`, renaming what still carries the old template's
 * default names. Never throws for a rename, an intro or a card; the store write is
 * the one step whose failure reaches the caller, since nothing changed without it.
 */
export async function switchTemplate(client: Client, guild: Guild, config: TemplateRow, nextPluginId: TemplatePluginId): Promise<ISwitchTemplateResult> {
	const previousPluginId = (config.pluginId ?? DEFAULT_PLUGIN_ID) as PluginId;
	const result: ISwitchTemplateResult = { changed: false, previousPluginId, renamed: [], kept: [], failed: [] };
	// ①
	if (previousPluginId === nextPluginId) return result;

	// ②
	await guildConfigStore.update(guild.id, { pluginId: nextPluginId });
	result.changed = true;

	// ③ and ④
	const adoptedIds = new Set(readAdoptedChannelIds(config));
	for (const target of renameTargets(config, previousPluginId, nextPluginId)) {
		if (target.oldName === target.newName) continue;
		const keptByRule = !target.isCategory && (GuildSetupManager.persistedChannelName(config, target.field) !== undefined || adoptedIds.has(target.channelId));
		if (keptByRule) {
			result.kept.push(target.field);
			continue;
		}
		const outcome = await renameIfDefault(guild, target);
		if (outcome === "renamed") result.renamed.push(target.field);
		else if (outcome === "kept") result.kept.push(target.field);
		else if (outcome === "failed") result.failed.push(target.field);
	}

	// ⑤
	await refreshIntrosQuietly(client, guild);
	refreshHeadquartersCards(guild, "serverConfig");
	botLogStore
		.log(guild.id, BOT_LOG_EVENTS.TEMPLATE_SWITCHED, { from: previousPluginId, to: nextPluginId, renamed: result.renamed, kept: result.kept, failed: result.failed })
		.catch((error: unknown) => console.warn(`[template] could not write the switch audit row for guild ${guild.id}`, error));
	return result;
}

// Every managed category and channel the row stores an id for, with the name each one
// carries by default in the old and the new pack.
function renameTargets(config: TemplateRow, previousPluginId: PluginId, nextPluginId: PluginId): IRenameTarget[] {
	const before: ICopyConfig = { pluginId: previousPluginId };
	const after: ICopyConfig = { pluginId: nextPluginId };
	const idOf = (field: string): string | null => {
		const value = config[field];
		return typeof value === "string" && value.length > 0 ? value : null;
	};
	const targets: IRenameTarget[] = [];
	for (const field of MANAGED_CATEGORY_FIELDS) {
		const channelId = idOf(field);
		if (!channelId) continue;
		targets.push({ field, channelId, isCategory: true, oldName: GuildSetupManager.managedCategoryName(field, before), newName: GuildSetupManager.managedCategoryName(field, after) });
	}
	for (const spec of GuildSetupManager.CHANNEL_SPECS) {
		const channelId = idOf(spec.configField);
		if (!channelId) continue;
		targets.push({
			field: spec.configField,
			channelId,
			isCategory: false,
			oldName: GuildSetupManager.channelNameFor(spec, before),
			newName: GuildSetupManager.channelNameFor(spec, after),
		});
	}
	return targets;
}

// One rename, only while the live name is still the old default. A channel that is gone
// or is not a kind Dero names is skipped: the repair sweep owns a missing channel.
async function renameIfDefault(guild: Guild, target: IRenameTarget): Promise<"renamed" | "kept" | "failed" | "skipped"> {
	const channel = await guild.channels.fetch(target.channelId).catch(() => null);
	if (!(channel instanceof TextChannel || channel instanceof VoiceChannel || channel instanceof CategoryChannel)) return "skipped";
	if (channel.name !== target.oldName) return "kept";
	try {
		await channel.setName(target.newName);
		return "renamed";
	} catch (error) {
		console.warn(`[template] could not rename ${target.field} in guild ${guild.id} to "${target.newName}"`, error);
		return "failed";
	}
}

async function refreshIntrosQuietly(client: Client, guild: Guild): Promise<void> {
	try {
		await GuildSetupManager.refreshIntroEmbeds(client, guild);
	} catch (error) {
		console.warn(`[template] could not refresh the intros of guild ${guild.id} after a template switch`, error);
	}
}
