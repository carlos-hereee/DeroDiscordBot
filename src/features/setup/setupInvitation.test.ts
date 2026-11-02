import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection, DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild } from "discord.js";

// ── the setup invitation DM (2026-11 item 285 Phase 1) ─────────────────────
// Pins the four promises the plan makes about this DM: one per guild for good,
// the key written only once Discord accepted it, a chip that pings nobody, and a
// backfill that spaces its DMs out. The stores are mocked like OnboardingCheck's.

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { has: vi.fn(), log: vi.fn() } }));

import {
	_resetSetupCommandIdCache,
	backfillSetupInvitations,
	fetchSetupCommandId,
	formatSetupMention,
	sendSetupInvitation,
} from "./setupInvitation.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { botLogStore } from "@db/stores/botLogStore.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

const configMock = guildConfigStore as unknown as { findByGuildId: ReturnType<typeof vi.fn> };
const logMock = botLogStore as unknown as { has: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };

const SETUP_ID = "111222333444555666";
const GUILD_SETUP_ID = "999888777666555444";

type FakeCommand = { id: string; name: string };

function commandManager(cached: FakeCommand[], fetched: FakeCommand[] = cached) {
	const toCollection = (list: FakeCommand[]) => new Collection(list.map((command) => [command.id, command]));
	return { cache: toCollection(cached), fetch: vi.fn(async () => toCollection(fetched)) };
}

function makeClient(global = commandManager([{ id: SETUP_ID, name: "setup" }]), guilds: Guild[] = []): Client {
	return {
		application: { commands: global },
		guilds: { cache: new Collection(guilds.map((guild) => [guild.id, guild])) },
	} as unknown as Client;
}

function makeGuild(id = "guild-1", send = vi.fn(async () => undefined), guildCommands = commandManager([])) {
	const guild = {
		id,
		name: "Test Realm",
		ownerId: "owner-1",
		commands: guildCommands,
		fetchOwner: vi.fn(async () => ({ send })),
	} as unknown as Guild;
	return { guild, send };
}

const sentEmbed = (send: ReturnType<typeof vi.fn>) => send.mock.calls[0][0].embeds[0].data;
const loggedEvents = () => logMock.log.mock.calls.map((call) => call[1]);

function dmClosedError(): DiscordAPIError {
	return new DiscordAPIError(
		{ code: RESTJSONErrorCodes.CannotSendMessagesToThisUser, message: "Cannot send messages to this user" },
		RESTJSONErrorCodes.CannotSendMessagesToThisUser,
		403,
		"POST",
		"/channels/1/messages",
		{}
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetSetupCommandIdCache();
	logMock.has.mockResolvedValue(false);
	logMock.log.mockResolvedValue(undefined);
	configMock.findByGuildId.mockResolvedValue(null);
});

describe("formatSetupMention", () => {
	it("builds Discord's command chip", () => {
		expect(formatSetupMention(SETUP_ID)).toBe(`</setup:${SETUP_ID}>`);
	});
});

describe("fetchSetupCommandId", () => {
	it("reads the global cache first and keeps the id for later calls", async () => {
		const global = commandManager([{ id: SETUP_ID, name: "setup" }]);
		const client = makeClient(global);
		expect(await fetchSetupCommandId(client)).toBe(SETUP_ID);
		expect(await fetchSetupCommandId(makeClient(commandManager([])))).toBe(SETUP_ID);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("fetches the global list once when the cache is cold", async () => {
		const global = commandManager([], [{ id: SETUP_ID, name: "setup" }]);
		expect(await fetchSetupCommandId(makeClient(global))).toBe(SETUP_ID);
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("falls back to the guild's own commands, as dev registers them, and fetches the global list only once", async () => {
		const global = commandManager([]);
		const client = makeClient(global);
		const { guild } = makeGuild("guild-1", undefined, commandManager([], [{ id: GUILD_SETUP_ID, name: "setup" }]));
		expect(await fetchSetupCommandId(client, guild)).toBe(GUILD_SETUP_ID);
		expect(await fetchSetupCommandId(client, guild)).toBe(GUILD_SETUP_ID);
		expect(global.fetch).toHaveBeenCalledOnce();
	});

	it("answers null when /setup is registered nowhere", async () => {
		const { guild } = makeGuild();
		expect(await fetchSetupCommandId(makeClient(commandManager([])), guild)).toBeNull();
	});
});

describe("sendSetupInvitation", () => {
	it("sends once with the chip, then the key makes the next call a no op", async () => {
		const { guild, send } = makeGuild();
		const client = makeClient();
		await sendSetupInvitation(guild, client);

		expect(send).toHaveBeenCalledOnce();
		expect(sentEmbed(send).description).toContain(`</setup:${SETUP_ID}>`);
		expect(logMock.log).toHaveBeenCalledWith("guild-1", BOT_LOG_EVENTS.SETUP_INVITATION_SENT, {
			ownerId: "owner-1",
			outcome: "sent",
			mentionResolved: true,
		});

		logMock.has.mockResolvedValue(true);
		await sendSetupInvitation(guild, client);
		expect(send).toHaveBeenCalledOnce();
		expect(logMock.has).toHaveBeenLastCalledWith("guild-1", BOT_LOG_EVENTS.SETUP_INVITATION_SENT);
	});

	it("pings nobody and logs no DM text or name", async () => {
		const { guild, send } = makeGuild();
		await sendSetupInvitation(guild, makeClient());
		expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
		const metadata = JSON.stringify(logMock.log.mock.calls[0][2]);
		expect(metadata).not.toContain("Test Realm");
		expect(metadata).not.toContain("setup:");
	});

	it("sends the typed /setup when no command id resolves, and records that the chip did not", async () => {
		const { guild, send } = makeGuild();
		await sendSetupInvitation(guild, makeClient(commandManager([])));
		const body = sentEmbed(send).description as string;
		expect(body).toContain("`/setup`");
		expect(body).not.toContain("</setup:");
		expect(logMock.log.mock.calls[0][2]).toMatchObject({ mentionResolved: false });
	});

	it("logs a closed DM as a failure without throwing and never writes the key", async () => {
		const send = vi.fn(async () => {
			throw dmClosedError();
		});
		const { guild } = makeGuild("guild-1", send);
		await expect(sendSetupInvitation(guild, makeClient())).resolves.toBeUndefined();
		expect(loggedEvents()).toEqual([BOT_LOG_EVENTS.SETUP_INVITATION_FAILED]);
		expect(logMock.log.mock.calls[0][2]).toMatchObject({ outcome: "dm-closed" });
	});

	it("logs an owner it cannot fetch as a failure without throwing", async () => {
		const { guild } = makeGuild();
		(guild.fetchOwner as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Unknown Member"));
		await sendSetupInvitation(guild, makeClient());
		expect(loggedEvents()).toEqual([BOT_LOG_EVENTS.SETUP_INVITATION_FAILED]);
		expect(logMock.log.mock.calls[0][2]).toMatchObject({ outcome: "owner-unavailable" });
	});

	it("swallows a failed store read rather than throwing into GuildCreate", async () => {
		logMock.has.mockRejectedValue(new Error("mongo down"));
		const { guild, send } = makeGuild();
		await expect(sendSetupInvitation(guild, makeClient())).resolves.toBeUndefined();
		expect(send).not.toHaveBeenCalled();
	});

	it("uses the kingdom pack when the guild has no row yet", async () => {
		const { guild, send } = makeGuild();
		await sendSetupInvitation(guild, makeClient());
		const embed = sentEmbed(send);
		expect(embed.title).toBe(rokCommanderCopy.setup.invitationDm.title);
		expect(embed.description).toContain("**Test Realm**");
		expect(embed.description).not.toContain("{{");
	});

	it("uses the guild's own pack when it has one", async () => {
		configMock.findByGuildId.mockResolvedValue({ pluginId: "general-events" });
		const { guild, send } = makeGuild();
		await sendSetupInvitation(guild, makeClient());
		expect(sentEmbed(send).title).toBe(generalEventsCopy.setup.invitationDm.title);
	});

	it("sends once when GuildCreate and the backfill reach one guild together", async () => {
		const { guild, send } = makeGuild();
		const client = makeClient();
		await Promise.all([sendSetupInvitation(guild, client), sendSetupInvitation(guild, client)]);
		expect(send).toHaveBeenCalledOnce();
	});
});

describe("backfillSetupInvitations", () => {
	it("invites every cached guild missing the key, spaced by the constant between sends", async () => {
		const first = makeGuild("guild-1");
		const second = makeGuild("guild-2");
		const third = makeGuild("guild-3");
		logMock.has.mockImplementation(async (guildId: string) => guildId === "guild-2");
		const sleep = vi.fn(async () => undefined);

		await backfillSetupInvitations(makeClient(undefined, [first.guild, second.guild, third.guild]), sleep);

		expect(first.send).toHaveBeenCalledOnce();
		expect(second.send).not.toHaveBeenCalled();
		expect(third.send).toHaveBeenCalledOnce();
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(BOT_CONSTANTS.SETUP_INVITATION_DM_SPACING_MS);
		expect(BOT_CONSTANTS.SETUP_INVITATION_DM_SPACING_MS).toBe(200);
	});

	it("keeps walking after one guild's DM fails", async () => {
		const blocked = makeGuild(
			"guild-1",
			vi.fn(async () => {
				throw dmClosedError();
			})
		);
		const open = makeGuild("guild-2");
		await backfillSetupInvitations(makeClient(undefined, [blocked.guild, open.guild]), async () => undefined);
		expect(open.send).toHaveBeenCalledOnce();
	});
});
