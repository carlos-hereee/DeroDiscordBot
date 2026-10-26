import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepliableInteraction } from "discord.js";

// ── the /leveling settings admin log lines ──────────────────────────────────
// Post-launch plan items 9 and 11: every setting a run writes is one config.change
// line in 🗒️admin-log, named by its leveling path, and a run that writes nothing
// logs nothing. The stores and the emitter are mocked.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	emitFor: vi.fn(),
	getLevelingConfig: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: mocks.emitFor } }));
vi.mock("@features/leveling/levelingConfig.js", async (original) => ({
	...(await original<typeof import("@features/leveling/levelingConfig.js")>()),
	getLevelingConfig: mocks.getLevelingConfig,
	invalidateLevelingConfig: vi.fn(),
}));

import { normalizeLevelingSettings } from "@features/leveling/levelingConfig.js";
import { FormOptionReader, type FormValue } from "@features/command-buttons/formOptionReader.js";
import { runLevelSettings as run } from "./levelSettingsSubcommands.js";

function interaction(): RepliableInteraction {
	return { guildId: "g1", guild: { id: "g1" }, user: { id: "u1" }, client: {}, reply: vi.fn(async () => undefined) } as unknown as RepliableInteraction;
}

const reader = (subcommand: string, values: Record<string, FormValue>) => new FormOptionReader({ subcommand, group: null }, new Map(Object.entries(values)));

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: "g1" });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.emitFor.mockReset();
	mocks.getLevelingConfig.mockReset().mockResolvedValue({ settings: normalizeLevelingSettings({}), weekStart: "sunday" });
});

describe("/leveling settings admin log", () => {
	it("logs one line per setting the run wrote", async () => {
		const ran = interaction();
		await run(ran, reader("curve", { preset: { kind: "string", value: "flat" }, milestones: { kind: "string", value: "everyN" } }));
		expect(mocks.emitFor.mock.calls.map((call) => [call[2], call[3]])).toEqual([
			["config.change", { subject: "leveling curve", detail: "set to flat" }],
			["config.change", { subject: "leveling milestoneMode", detail: "set to everyN" }],
		]);
	});

	it("logs a switch as on or off", async () => {
		await run(interaction(), reader("toggle", { enabled: { kind: "boolean", value: false } }));
		expect(mocks.emitFor).toHaveBeenCalledWith(expect.anything(), "g1", "config.change", { subject: "leveling enabled", detail: "off" });
	});

	it("logs nothing when the run wrote nothing", async () => {
		await run(interaction(), reader("curve", {}));
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.emitFor).not.toHaveBeenCalled();
	});
});
