import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	findConfig: vi.fn(),
	showNotice: vi.fn(),
	askInChannel: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { create: mocks.create } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@features/schedule/ScheduleBoard.js", () => ({ refreshSchedule: vi.fn(async () => undefined) }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: vi.fn() } }));
vi.mock("@utils/answerInChannel.js", () => ({ askInChannel: mocks.askInChannel }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));

import { addAnnounceStreamOptions, announceStream } from "./announceStream.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import type { CommandOptionReader } from "@handlers/commandOptions.js";
import { SlashCommandSubcommandBuilder } from "discord.js";

// ── /events stream announce in the server's timezone (2026-10 item 263 Phase 4c) ──

const c = rokCommanderCopy.announceStream;
const interaction = { guildId: "g1", client: {} } as unknown as RepliableInteraction;

function optionsFor(when: string): CommandOptionReader {
	const strings: Record<string, string> = { title: "Patch Day", when };
	return {
		getString: (name: string) => strings[name] ?? null,
		getRole: () => null,
	} as unknown as CommandOptionReader;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
	mocks.findConfig.mockResolvedValue({ announcementsChannelId: "ch-announce", memberRoleId: null, timezone: "America/New_York" });
	mocks.askInChannel.mockResolvedValue({
		awaitPress: vi.fn(async () => ({ customId: "announce_confirm", update: mocks.update })),
		edit: vi.fn(),
	});
});

afterEach(() => vi.useRealTimers());

describe("announceStream", () => {
	it("reads the typed time in the server's zone, names it in the confirmation and stores the instant", async () => {
		await announceStream(interaction, optionsFor("11/07 @19:00"));

		const preview = mocks.askInChannel.mock.calls[0][2].embeds[0].toJSON().description as string;
		expect(preview).toContain(c.zoneLine("America/New_York"));
		// 7 PM New York after the 2026-11-01 change is midnight UTC.
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ firstOccurrence: new Date("2026-11-08T00:00:00.000Z") }));
		// One time means an interval of 0 to every reader (2026-10 item 280).
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ type: "one-time", intervalHours: 0 }));
	});

	it("names the zone when it cannot read the time", async () => {
		await announceStream(interaction, optionsFor("someday"));

		expect(mocks.showNotice).toHaveBeenCalledWith(interaction, expect.objectContaining({ sections: [c.invalidDateTime, c.zoneLine("America/New_York")] }));
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("reads UTC on a server that never picked a zone", async () => {
		mocks.findConfig.mockResolvedValue({ announcementsChannelId: "ch-announce", memberRoleId: null });

		await announceStream(interaction, optionsFor("11/07 @19:00"));

		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ firstOccurrence: new Date("2026-11-07T19:00:00.000Z") }));
	});

	it("takes the time as `when`, an option no longer named for UTC", () => {
		const names = (addAnnounceStreamOptions(new SlashCommandSubcommandBuilder().setName("announce").setDescription("x")).toJSON().options ?? []).map((option) => option.name);
		expect(names).toContain("when");
		expect(names).not.toContain("when-utc");
	});

	it("carries the zone line in both copy packs", () => {
		expect(generalEventsCopy.announceStream.zoneLine("Europe/Berlin")).toBe(c.zoneLine("Europe/Berlin"));
	});
});
