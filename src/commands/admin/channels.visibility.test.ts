import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type RepliableInteraction } from "discord.js";

// ── /channels hide and show ──────────────────────────────────────────────────
// Post-launch plan items 9 and 11: a hide or show that landed is one config.change
// line in 🗒️admin-log naming the channel, and the owner only gate the settings
// panel shares refuses everyone else before anything is written.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	emitFor: vi.fn(),
	editOverwrite: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));

import { FormOptionReader } from "@features/command-buttons/formOptionReader.js";
import { canChangeVisibility, hideableChannelStates, run } from "./channels.js";

const OWNER_ID = "owner";

function interaction(userId: string): RepliableInteraction {
	// The established way to fake a TextChannel (see TestReminderJob): the handler
	// checks instanceof before it edits the overwrite.
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { permissionOverwrites: { edit: mocks.editOverwrite } });
	return {
		guildId: "g1",
		user: { id: userId },
		client: {},
		guild: { id: "g1", ownerId: OWNER_ID, roles: { everyone: { id: "g1" } }, channels: { fetch: vi.fn(async () => channel) } },
		reply: vi.fn(async () => undefined),
	} as unknown as RepliableInteraction;
}

const reader = (subcommand: string) => new FormOptionReader({ subcommand, group: null }, new Map([["channel", { kind: "string", value: "leaderboardChannelId" }]]));

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: "g1", categoryId: "cat", leaderboardChannelId: "c2", hiddenChannels: [] });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.emitFor.mockReset();
	mocks.editOverwrite.mockReset().mockResolvedValue(undefined);
});

describe("/channels hide and show", () => {
	it("logs a hide that landed, naming the channel", async () => {
		await run(interaction(OWNER_ID), reader("hide"));
		expect(mocks.update).toHaveBeenCalledWith("g1", { hiddenChannels: ["leaderboardChannelId"] });
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "config.change", { subject: "Leaderboard channel", detail: "hidden from members" });
	});

	it("logs a show that landed", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: "g1", categoryId: "cat", leaderboardChannelId: "c2", hiddenChannels: ["leaderboardChannelId"] });
		await run(interaction(OWNER_ID), reader("show"));
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "config.change", { subject: "Leaderboard channel", detail: "visible to members" });
	});

	it("refuses anyone but the owner and writes and logs nothing", async () => {
		expect(canChangeVisibility("admin", OWNER_ID)).toBe(false);
		await run(interaction("admin"), reader("hide"));
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.emitFor).not.toHaveBeenCalled();
	});

	it("lists only provisioned channels, each with its visibility", () => {
		const states = hideableChannelStates({ leaderboardChannelId: "c2", hiddenChannels: ["leaderboardChannelId"] } as unknown as Parameters<typeof hideableChannelStates>[0]);
		expect(states).toEqual([{ name: "Leaderboard", value: "leaderboardChannelId", hidden: true }]);
	});
});
