import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── the #command-center profile buttons ─────────────────────────────────────
// Account, Levels and Achievements (2026-10 item 245 Phase 4b) are the three
// /account views as buttons. Each must call the very handler /account calls, and
// answer privately, because a guide's buttons never post in the guide's channel.
// The three views are mocked, so this pins the routing and nothing below it.

const mocks = vi.hoisted(() => ({
	showAccountProfile: vi.fn(),
	showLevelsStandings: vi.fn(),
	showAchievements: vi.fn(),
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
}));

vi.mock("@features/leveling/accountProfile.js", () => ({ showAccountProfile: mocks.showAccountProfile }));
vi.mock("@features/leveling/levelsStandings.js", () => ({ showLevelsStandings: mocks.showLevelsStandings }));
vi.mock("@features/leveling/achievementsView.js", () => ({ showAchievements: mocks.showAchievements }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));

import { buildProfileButtons, registerPowerUpHandlers } from "./PowerUps.js";
import { levelingCopy } from "@features/leveling/levelingCopy.js";

const USER = { id: "u1" };

function press(action: string): ButtonInteraction {
	return { customId: `powerup:member:${action}`, guildId: "g1", guild: { id: "g1" }, user: USER, reply: vi.fn() } as unknown as ButtonInteraction;
}

beforeAll(() => {
	registerPowerUpHandlers();
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the profile buttons", () => {
	it("are Account, Levels and Achievements, each on its own powerup customId", () => {
		const buttons = buildProfileButtons().map((button) => button.toJSON() as { custom_id: string; label: string });
		expect(buttons.map((button) => button.custom_id)).toEqual(["powerup:member:account", "powerup:member:levels", "powerup:member:achievements"]);
		expect(buttons.map((button) => button.label)).toEqual([
			levelingCopy.guideButtons.account,
			levelingCopy.guideButtons.levels,
			levelingCopy.guideButtons.achievements,
		]);
	});

	it("open the presser's own profile, privately", async () => {
		const interaction = press("account");
		await mocks.buttons.get("powerup")!(interaction);
		expect(mocks.showAccountProfile).toHaveBeenCalledWith(interaction, { target: USER, isPrivate: true });
	});

	it("open the all time standings, the slash command's default window, privately", async () => {
		const interaction = press("levels");
		await mocks.buttons.get("powerup")!(interaction);
		expect(mocks.showLevelsStandings).toHaveBeenCalledWith(interaction, { window: "alltime", isPrivate: true });
	});

	it("open the presser's own achievements, privately", async () => {
		const interaction = press("achievements");
		await mocks.buttons.get("powerup")!(interaction);
		expect(mocks.showAchievements).toHaveBeenCalledWith(interaction, { target: USER, isPrivate: true });
	});
});
