import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CategoryChannel, TextChannel, type Client, type Guild } from "discord.js";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	log: vi.fn(),
	refreshCards: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { update: mocks.update, findByGuildId: vi.fn() } }));
vi.mock("@db/stores/botLogStore.js", () => ({ botLogStore: { log: mocks.log } }));
vi.mock("./headquartersCards.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./headquartersCards.js")>()),
	refreshHeadquartersCards: mocks.refreshCards,
}));

import { switchTemplate, isTemplatePluginId, type TemplateRow } from "./switchTemplate.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { BOT_LOG_EVENTS } from "@base/constants/BOT_LOG_EVENTS.js";

// ── switchTemplate (2026-10 item 262 Phase 4) ──

type FakeChannel = (TextChannel | CategoryChannel) & { setName: ReturnType<typeof vi.fn> };

// A real prototype, so the instanceof checks in switchTemplate pass, with only the two
// members it reads.
function fakeChannel(kind: "text" | "category", name: string, setName: ReturnType<typeof vi.fn> = vi.fn(async () => undefined)): FakeChannel {
	const channel = Object.create(kind === "text" ? TextChannel.prototype : CategoryChannel.prototype) as FakeChannel;
	Object.defineProperty(channel, "name", { value: name, writable: true });
	Object.defineProperty(channel, "setName", { value: setName });
	return channel;
}

function guildWith(channels: Record<string, FakeChannel>): Guild {
	return {
		id: "g1",
		channels: { fetch: vi.fn(async (id: string) => channels[id] ?? null) },
	} as unknown as Guild;
}

const client = {} as Client;
let refreshIntros: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.update.mockResolvedValue(undefined);
	mocks.log.mockResolvedValue(undefined);
	refreshIntros = vi.spyOn(GuildSetupManager, "refreshIntroEmbeds").mockResolvedValue({ edited: 0, reposted: 0 });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("switchTemplate", () => {
	it("is a no op for the template the server already uses: no write, no rename, no refresh", async () => {
		const admin = fakeChannel("text", "🔒inner-sanctum");
		const result = await switchTemplate(client, guildWith({ admin }), { pluginId: "rok-commander", adminChannelId: "admin" }, "rok-commander");
		expect(result).toMatchObject({ changed: false, renamed: [], kept: [], failed: [] });
		expect(mocks.update).not.toHaveBeenCalled();
		expect(admin.setName).not.toHaveBeenCalled();
		expect(refreshIntros).not.toHaveBeenCalled();
		expect(mocks.refreshCards).not.toHaveBeenCalled();
	});

	it("reads a row with no pluginId as the kingdom template", async () => {
		const result = await switchTemplate(client, guildWith({}), {}, "rok-commander");
		expect(result.changed).toBe(false);
	});

	it("stores the new template, renames a channel still on the old default, and keeps the names both packs share", async () => {
		const admin = fakeChannel("text", "🔒inner-sanctum");
		const commands = fakeChannel("text", "📖command-center");
		const category = fakeChannel("category", GuildSetupManager.managedCategoryName("headquartersCategoryId", null));
		const config: TemplateRow = { pluginId: "rok-commander", adminChannelId: "admin", commandsChannelId: "cmd", headquartersCategoryId: "hq" };
		const result = await switchTemplate(client, guildWith({ admin, cmd: commands, hq: category }), config, "general-events");

		expect(mocks.update).toHaveBeenCalledWith("g1", { pluginId: "general-events" });
		expect(admin.setName).toHaveBeenCalledWith("🔒admin");
		// The names the two packs share cost no rename at all.
		expect(commands.setName).not.toHaveBeenCalled();
		expect(category.setName).not.toHaveBeenCalled();
		expect(result).toMatchObject({ changed: true, previousPluginId: "rok-commander", renamed: ["adminChannelId"], kept: [], failed: [] });
	});

	it("renames back to the kingdom default when a streamer server switches back", async () => {
		const admin = fakeChannel("text", "🔒admin");
		await switchTemplate(client, guildWith({ admin }), { pluginId: "general-events", adminChannelId: "admin" }, "rok-commander");
		expect(admin.setName).toHaveBeenCalledWith("🔒inner-sanctum");
	});

	it("keeps a name an admin set with /server channels rename, a channel the server adopted, and a live name that is not the old default", async () => {
		const renamed = fakeChannel("text", "🔒war-room");
		const adopted = fakeChannel("text", "🔒inner-sanctum");
		const handRenamed = fakeChannel("text", "🔒council");
		// The two packs name only the admin channel differently, so the rule is exercised on
		// three rows through that one slot.
		const runs: Array<[TemplateRow, FakeChannel]> = [
			[{ pluginId: "rok-commander", adminChannelId: "admin", channelNames: new Map([["adminChannelId", "🔒war-room"]]) }, renamed],
			[{ pluginId: "rok-commander", adminChannelId: "admin", adoptedChannelIds: ["admin"] }, adopted],
			[{ pluginId: "rok-commander", adminChannelId: "admin" }, handRenamed],
		];
		for (const [config, channel] of runs) {
			const result = await switchTemplate(client, guildWith({ admin: channel }), config, "general-events");
			expect(channel.setName).not.toHaveBeenCalled();
			expect(result.kept).toEqual(["adminChannelId"]);
			expect(result.renamed).toEqual([]);
		}
	});

	it("logs a refused rename and goes on with the rest", async () => {
		// Stub each slot's default so two slots differ between the packs; the real packs
		// differ on one slot only.
		vi.spyOn(GuildSetupManager, "channelNameFor").mockImplementation((spec, copyConfig) => `${copyConfig?.pluginId}-${spec.configField}`);
		const refused = vi.fn(async () => {
			throw new Error("rate limited");
		});
		const first = fakeChannel("text", "rok-commander-adminChannelId", refused);
		const second = fakeChannel("text", "rok-commander-commandsChannelId");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await switchTemplate(client, guildWith({ first, second }), { pluginId: "rok-commander", adminChannelId: "first", commandsChannelId: "second" }, "general-events");

		expect(refused).toHaveBeenCalledOnce();
		expect(second.setName).toHaveBeenCalledWith("general-events-commandsChannelId");
		expect(result).toMatchObject({ failed: ["adminChannelId"], renamed: ["commandsChannelId"] });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not rename adminChannelId"), expect.any(Error));
		// The switch still finishes its follow ups.
		expect(refreshIntros).toHaveBeenCalledOnce();
	});

	it("stores the template before it refreshes the intros, then redraws the card and writes the audit row", async () => {
		const order: string[] = [];
		mocks.update.mockImplementation(async () => void order.push("store"));
		refreshIntros.mockImplementation(async () => {
			order.push("intros");
			return { edited: 0, reposted: 0 };
		});
		const guild = guildWith({ admin: fakeChannel("text", "🔒inner-sanctum") });
		await switchTemplate(client, guild, { pluginId: "rok-commander", adminChannelId: "admin" }, "general-events");

		expect(order).toEqual(["store", "intros"]);
		expect(mocks.refreshCards).toHaveBeenCalledWith(guild, "serverConfig");
		expect(mocks.log).toHaveBeenCalledWith("g1", BOT_LOG_EVENTS.TEMPLATE_SWITCHED, expect.objectContaining({ from: "rok-commander", to: "general-events", renamed: ["adminChannelId"] }));
	});

	it("never throws when the intro refresh or the audit row fails", async () => {
		refreshIntros.mockRejectedValue(new Error("discord down"));
		mocks.log.mockRejectedValue(new Error("mongo down"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(switchTemplate(client, guildWith({}), { pluginId: "rok-commander" }, "general-events")).resolves.toMatchObject({ changed: true });
	});

	it("takes only the two template ids from a Submit", () => {
		expect(isTemplatePluginId("rok-commander")).toBe(true);
		expect(isTemplatePluginId("general-events")).toBe(true);
		expect(isTemplatePluginId("toString")).toBe(false);
		expect(isTemplatePluginId(undefined)).toBe(false);
	});
});
