import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild, type Snowflake } from "discord.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { infoEmbed } from "@utils/embedBuilder.js";

// ── the setup invitation DM (2026-11 item 285 Phase 1) ─────────────────────
// What:  the one place that DMs a guild owner the clickable /setup mention, so
//        they can start setup with one press instead of hunting for the command.
//        It does NOT run setup, touch any channel, or replace the pairing code DM,
//        which main.ts still sends first.
// Who:   main.ts calls sendSetupInvitation from the GuildCreate handler, and
//        backfillSetupInvitations once per boot after ClientReady, for guilds Dero
//        joined while it was offline or before this shipped.
// When:  at most once per guild for good: SETUP_INVITATION_SENT is read before the
//        send and written only after Discord accepted the DM, so an owner whose DMs
//        were closed is tried again on the next boot.
// How:   the mention is Discord's `</name:id>` command chip, which needs the id
//        Discord assigned the command at registration. Production registers it
//        globally and dev registers it per guild (deploy-commands.ts), so the global
//        list is asked first and the guild's own list second. Every failure is
//        logged and swallowed, because the invitation is a courtesy: /setup works
//        whether or not the DM ever lands.

// ── constants ──────────────────────────────────────────────────────────────

const SETUP_COMMAND_NAME = "setup";
const MENTION_TOKEN = "{{mention}}";
const SERVER_TOKEN = "{{server}}";
// What the body says in place of the chip when no command id resolves: the
// command typed out, which still tells the owner exactly what to run.
const PLAIN_SETUP_MENTION = "`/setup`";

type InvitationOutcome = "sent" | "dm-closed" | "owner-unavailable" | "failed";

// ── command id cache ───────────────────────────────────────────────────────
// Keyed by command name, as the plan asks. Only the GLOBAL id is cached: a guild
// registered id differs per guild, and a dev process asks it at most once per guild.
const globalCommandIds = new Map<string, Snowflake>();
// Whether the one global fetch has already run. Without it a dev process, whose
// global list is empty, would refetch it for every guild the backfill walks.
let globalCommandsFetched = false;
// Guild ids whose invitation is being sent right now (see sendSetupInvitation).
const invitationsInFlight = new Set<string>();

/** Test seam: forget the cached ids so each test starts cold. */
export function _resetSetupCommandIdCache(): void {
	globalCommandIds.clear();
	globalCommandsFetched = false;
}

/**
 * Resolve the id Discord assigned the /setup command: the global cache, then one
 * global fetch per process, then the guild's own commands (dev registration).
 * Returns null when /setup is registered nowhere this bot can see.
 */
export async function fetchSetupCommandId(client: Client, guild?: Guild): Promise<Snowflake | null> {
	const cached = globalCommandIds.get(SETUP_COMMAND_NAME);
	if (cached) return cached;

	const globalId = await findGlobalSetupCommandId(client);
	if (globalId) {
		globalCommandIds.set(SETUP_COMMAND_NAME, globalId);
		return globalId;
	}
	if (!guild) return null;
	return findGuildSetupCommandId(guild);
}

/** The clickable chip Discord renders for a slash command: `</setup:id>`. */
export function formatSetupMention(appCommandId: Snowflake): string {
	return `</${SETUP_COMMAND_NAME}:${appCommandId}>`;
}

/**
 * DM the guild owner the setup invitation once. Never throws: every failure is
 * logged, and a failure leaves the idempotency key unset so a later boot retries.
 */
export async function sendSetupInvitation(guild: Guild, client: Client): Promise<void> {
	// A guild joined while the boot backfill is still walking the cache reaches this
	// from both callers at once, and both would read the key as unset. One send per
	// guild at a time closes that window inside this process.
	if (invitationsInFlight.has(guild.id)) return;
	invitationsInFlight.add(guild.id);
	try {
		if (await botLogStore.has(guild.id, BOT_LOG_EVENTS.SETUP_INVITATION_SENT)) return;

		const commandId = await fetchSetupCommandId(client, guild).catch((error: unknown) => {
			console.warn(`[setup-invitation] could not read the /setup command id for guild ${guild.id}`, error);
			return null;
		});
		if (!commandId) {
			console.warn(`[setup-invitation] /setup is not registered where guild ${guild.id} can see it; sending the plain text invitation`);
		}
		const mentionResolved = commandId !== null;
		const outcome = await deliverInvitation(guild, commandId);

		if (outcome === "sent") {
			await botLogStore.log(guild.id, BOT_LOG_EVENTS.SETUP_INVITATION_SENT, { ownerId: guild.ownerId, outcome, mentionResolved });
			return;
		}
		await botLogStore.log(guild.id, BOT_LOG_EVENTS.SETUP_INVITATION_FAILED, { ownerId: guild.ownerId, outcome, mentionResolved });
	} catch (error) {
		// The audit write or the idempotency read itself failed. Nothing to record
		// it in, so the console is the record; the next boot tries again.
		console.warn(`[setup-invitation] the invitation for guild ${guild.id} failed before it could be recorded`, error);
	} finally {
		invitationsInFlight.delete(guild.id);
	}
}

/**
 * Invite the owner of every cached guild still missing SETUP_INVITATION_SENT, one
 * guild at a time with SETUP_INVITATION_DM_SPACING_MS between them. `sleep` is
 * injectable so the pacing can be tested without real timers.
 */
export async function backfillSetupInvitations(client: Client, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
	let isFirst = true;
	for (const guild of client.guilds.cache.values()) {
		if (!isFirst) await sleep(BOT_CONSTANTS.SETUP_INVITATION_DM_SPACING_MS);
		isFirst = false;
		// sendSetupInvitation never throws, so one guild cannot stop the sweep.
		await sendSetupInvitation(guild, client);
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

async function findGlobalSetupCommandId(client: Client): Promise<Snowflake | null> {
	const commands = client.application?.commands;
	if (!commands) return null;
	const fromCache = commands.cache.find((command) => command.name === SETUP_COMMAND_NAME);
	if (fromCache) return fromCache.id;
	if (globalCommandsFetched) return null;
	globalCommandsFetched = true;
	const fetched = await commands.fetch();
	return fetched.find((command) => command.name === SETUP_COMMAND_NAME)?.id ?? null;
}

async function findGuildSetupCommandId(guild: Guild): Promise<Snowflake | null> {
	const fromCache = guild.commands.cache.find((command) => command.name === SETUP_COMMAND_NAME);
	if (fromCache) return fromCache.id;
	const fetched = await guild.commands.fetch();
	return fetched.find((command) => command.name === SETUP_COMMAND_NAME)?.id ?? null;
}

/** Build the DM from the guild's pack and send it, reporting how it went. */
async function deliverInvitation(guild: Guild, commandId: Snowflake | null): Promise<InvitationOutcome> {
	// A first GuildCreate can arrive before autoSetup has written a row, and
	// getPluginCopy(null) is the kingdom pack, which is every new guild's default.
	const stored = await guildConfigStore.findByGuildId(guild.id);
	const copy = getPluginCopy(stored);
	const mention = commandId ? formatSetupMention(commandId) : PLAIN_SETUP_MENTION;
	const body = copy.setup.invitationDm.body.replaceAll(MENTION_TOKEN, mention).replaceAll(SERVER_TOKEN, guild.name);

	const owner = await guild.fetchOwner().catch(() => null);
	if (!owner) return "owner-unavailable";

	try {
		await owner.send({
			embeds: [infoEmbed(copy.setup.invitationDm.title, body, copy.COLORS.ARRIVAL, stored)],
			// The chip is a command mention, not a ping, but nothing in this DM may
			// ever notify anyone, so every mention kind is parsed out.
			allowedMentions: { parse: [] },
		});
		return "sent";
	} catch (error) {
		// 50007 is the owner's closed DMs, the expected refusal; anything else is
		// worth a console line beside its audit row.
		if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return "dm-closed";
		console.warn(`[setup-invitation] the DM to the owner of guild ${guild.id} failed`, error);
		return "failed";
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
