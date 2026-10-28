import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes, TextChannel, CategoryChannel, type Guild } from "discord.js";

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(), update: vi.fn() } }));
vi.mock("./adminLog.js", () => ({ adminLog: { write: vi.fn(async () => ({ persisted: true, posted: true })) } }));

import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { adminLog } from "./adminLog.js";
import { isRetiredAdminControls, otherManagedIds, retireAdminControls } from "./retireAdminControls.js";

// Risk R1 of 2026-10 item 263: the sweep deletes a channel, which cannot be undone, so
// every test here pins WHICH channel it may touch: the stored id, and nothing else.

const STORED_ID = "ch-admin-controls";
const NAMESAKE_ID = "ch-namesake";
const CLEARED = {
	adminCommandsChannelId: null,
	"introMessageIds.adminCommandsChannelId": null,
	"introMessageIds.adminCommandGuideId": null,
	"powerUpMessageIds.adminCommandsChannelId": null,
};

function textChannel(id: string, name = "🎛️admin-controls") {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const remove = vi.fn(async () => channel);
	Object.assign(channel, { id, name, delete: remove });
	return { channel, remove };
}

function unknownChannel(): DiscordAPIError {
	const error = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
	Object.assign(error, { code: RESTJSONErrorCodes.UnknownChannel });
	return error;
}

// A guild whose channels.fetch answers by id only, the way Discord does.
function makeGuild(channels: Map<string, unknown>, options: { manageChannels?: boolean; fetchError?: unknown } = {}) {
	const fetch = vi.fn(async (id: string) => {
		if (options.fetchError) throw options.fetchError;
		if (!channels.has(id)) throw unknownChannel();
		return channels.get(id);
	});
	const manage = options.manageChannels ?? true;
	const guild = {
		id: "guild-1",
		client: { user: { id: "bot-1" } },
		members: { me: { permissions: { has: (bit: bigint) => manage && bit === PermissionFlagsBits.ManageChannels } } },
		channels: { fetch },
	} as unknown as Guild;
	return { guild, fetch };
}

function storeRow(row: Record<string, unknown> | null): void {
	vi.mocked(guildConfigStore.findByGuildId).mockResolvedValue(row as never);
}

beforeEach(() => {
	vi.mocked(guildConfigStore.findByGuildId).mockReset();
	vi.mocked(guildConfigStore.update).mockReset();
	vi.mocked(adminLog.write).mockClear();
});

describe("retireAdminControls", () => {
	it("deletes exactly the channel with the stored id, once, clears its ids and writes one admin log line", async () => {
		const stored = textChannel(STORED_ID);
		const namesake = textChannel(NAMESAKE_ID);
		const { guild, fetch } = makeGuild(new Map([[STORED_ID, stored.channel], [NAMESAKE_ID, namesake.channel]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID, adminChannelId: "ch-sanctum" });

		expect(await retireAdminControls(guild)).toBe("deleted");

		expect(fetch).toHaveBeenCalledExactlyOnceWith(STORED_ID);
		expect(stored.remove).toHaveBeenCalledTimes(1);
		expect(namesake.remove).not.toHaveBeenCalled();
		expect(guildConfigStore.update).toHaveBeenCalledExactlyOnceWith("guild-1", CLEARED);
		expect(adminLog.write).toHaveBeenCalledTimes(1);
		expect(vi.mocked(adminLog.write).mock.calls[0]?.[0]).toMatchObject({ kind: "config.change", actor: { source: "dero" } });
	});

	it("never deletes a channel merely named like it: with no stored id nothing is read, deleted or written", async () => {
		const namesake = textChannel(NAMESAKE_ID);
		const { guild, fetch } = makeGuild(new Map([[NAMESAKE_ID, namesake.channel]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: null });

		expect(await retireAdminControls(guild)).toBe("none");

		expect(fetch).not.toHaveBeenCalled();
		expect(namesake.remove).not.toHaveBeenCalled();
		expect(guildConfigStore.update).not.toHaveBeenCalled();
		expect(adminLog.write).not.toHaveBeenCalled();
	});

	it("writes nothing on a second boot, once the id is cleared", async () => {
		const stored = textChannel(STORED_ID);
		const { guild } = makeGuild(new Map([[STORED_ID, stored.channel]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });
		await retireAdminControls(guild);
		storeRow({ guildId: "guild-1", adminCommandsChannelId: null });
		vi.mocked(guildConfigStore.update).mockClear();
		vi.mocked(adminLog.write).mockClear();

		expect(await retireAdminControls(guild)).toBe("none");

		expect(stored.remove).toHaveBeenCalledTimes(1);
		expect(guildConfigStore.update).not.toHaveBeenCalled();
		expect(adminLog.write).not.toHaveBeenCalled();
	});

	it("without Manage Channels deletes nothing, writes nothing and logs one line, so the next boot tries again", async () => {
		const stored = textChannel(STORED_ID);
		const { guild, fetch } = makeGuild(new Map([[STORED_ID, stored.channel]]), { manageChannels: false });
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		expect(await retireAdminControls(guild)).toBe("refused");

		expect(fetch).not.toHaveBeenCalled();
		expect(stored.remove).not.toHaveBeenCalled();
		expect(guildConfigStore.update).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});

	it("clears the ids without deleting when Discord says the stored channel is already gone", async () => {
		const { guild } = makeGuild(new Map());
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });

		expect(await retireAdminControls(guild)).toBe("cleared");

		expect(guildConfigStore.update).toHaveBeenCalledExactlyOnceWith("guild-1", CLEARED);
		expect(adminLog.write).not.toHaveBeenCalled();
	});

	it("keeps the id when the read fails for any other reason, and deletes nothing", async () => {
		const stored = textChannel(STORED_ID);
		const { guild } = makeGuild(new Map([[STORED_ID, stored.channel]]), { fetchError: new Error("gateway outage") });
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await retireAdminControls(guild)).toBe("kept");

		expect(stored.remove).not.toHaveBeenCalled();
		expect(guildConfigStore.update).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("never deletes through a stored id that is another managed channel's, and only clears the pointer", async () => {
		const sanctum = textChannel("ch-sanctum", "🔒inner-sanctum");
		const { guild, fetch } = makeGuild(new Map([["ch-sanctum", sanctum.channel]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: "ch-sanctum", adminChannelId: "ch-sanctum" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await retireAdminControls(guild)).toBe("cleared");

		expect(fetch).not.toHaveBeenCalled();
		expect(sanctum.remove).not.toHaveBeenCalled();
		expect(guildConfigStore.update).toHaveBeenCalledExactlyOnceWith("guild-1", CLEARED);
		warn.mockRestore();
	});

	it("never deletes a stored id that is not a text channel", async () => {
		const category = Object.create(CategoryChannel.prototype) as CategoryChannel;
		const remove = vi.fn();
		Object.assign(category, { id: STORED_ID, delete: remove });
		const { guild } = makeGuild(new Map([[STORED_ID, category]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await retireAdminControls(guild)).toBe("cleared");

		expect(remove).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("keeps the id when the delete itself fails, so the next boot tries again", async () => {
		const stored = textChannel(STORED_ID);
		stored.remove.mockRejectedValueOnce(new Error("Missing Access"));
		const { guild } = makeGuild(new Map([[STORED_ID, stored.channel]]));
		storeRow({ guildId: "guild-1", adminCommandsChannelId: STORED_ID });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await retireAdminControls(guild)).toBe("kept");

		expect(guildConfigStore.update).not.toHaveBeenCalled();
		expect(adminLog.write).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("otherManagedIds", () => {
	it("collects every channel and category id but the retired one, and no role ids", () => {
		const ids = otherManagedIds({
			categoryId: "cat-1",
			headquartersCategoryId: "cat-hq",
			adminChannelId: "ch-a",
			adminCommandsChannelId: "ch-retired",
			memberRoleId: "role-1",
			introMessageIds: { adminChannelId: "msg-1" },
		});
		expect([...ids].sort()).toEqual(["cat-1", "cat-hq", "ch-a"]);
	});
});

describe("isRetiredAdminControls", () => {
	it("matches only the stored id", () => {
		expect(isRetiredAdminControls({ adminCommandsChannelId: STORED_ID }, STORED_ID)).toBe(true);
		expect(isRetiredAdminControls({ adminCommandsChannelId: STORED_ID }, NAMESAKE_ID)).toBe(false);
		expect(isRetiredAdminControls({ adminCommandsChannelId: null }, STORED_ID)).toBe(false);
	});
});
