import { describe, expect, it } from "vitest";
import { ARCADE_SWITCH_DEFAULTS, arcadeSwitchesToWrite, isArcadeOff } from "./arcadeDefaults.js";
import { CONFIG_DEFAULTS } from "./serverReset.js";

// Owner item 11 of the 2026-10-27 live test: the arcade's switches start on when the
// arcade is built, and a server that turned one off keeps it off.

describe("arcadeSwitchesToWrite", () => {
	it("writes every switch on for a new arcade", () => {
		expect(arcadeSwitchesToWrite(null)).toEqual({ chipEconomyEnabled: true, arcadeMonthlyPost: true, botOpponentsEnabled: true });
	});

	it("writes a missing or null switch on, and leaves a stored false alone", () => {
		expect(arcadeSwitchesToWrite({ chipEconomyEnabled: false, arcadeMonthlyPost: null })).toEqual({ arcadeMonthlyPost: true, botOpponentsEnabled: true });
	});
});

describe("isArcadeOff", () => {
	const FIELDS = ["arcadeRulesChannelId", "partyGamesChannelId"];

	it("reads off only with no category and every arcade slot opted out", () => {
		expect(isArcadeOff({ gamesCategoryId: null, userRemovedChannels: [...FIELDS, "introChannelId"] }, FIELDS)).toBe(true);
	});

	it("reads on with a stored category, a slot still in, or no row", () => {
		expect(isArcadeOff({ gamesCategoryId: "cat", userRemovedChannels: FIELDS }, FIELDS)).toBe(false);
		expect(isArcadeOff({ gamesCategoryId: null, userRemovedChannels: ["arcadeRulesChannelId"] }, FIELDS)).toBe(false);
		expect(isArcadeOff(null, FIELDS)).toBe(false);
	});
});

describe("ARCADE_SWITCH_DEFAULTS", () => {
	it("is the table Delete my data resets to, so a reset arcade and a built one start the same", () => {
		expect(CONFIG_DEFAULTS).toMatchObject(ARCADE_SWITCH_DEFAULTS);
	});
});
