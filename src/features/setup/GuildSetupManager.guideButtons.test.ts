import { describe, it, expect } from "vitest";
import type { ButtonBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { GuildSetupManager } from "./GuildSetupManager.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";
import { buildAdminControlButtons, buildMemberControlButtons, buildProfileButtons } from "@features/power-ups/PowerUps.js";
import { ADMIN_GUIDE_COMMAND_ROWS } from "@features/command-buttons/adminGuideButtons.js";

// ── the guides' buttons, by audience (2026-10 item 245 Phase 4b) ─────────────
// What:  which buttons each guide carries, read off the builders themselves so a
//        relabel never breaks this, and that every channel's rows fit Discord's
//        five rows of five. A send past either limit is rejected whole, which on
//        boot would silently leave a guide without its buttons.
// Who:   resolveIntroComponents, the one source of every intro's rows, through the
//        same cast the other GuildSetupManager tests use for its private statics.

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;

const internals = GuildSetupManager as unknown as {
	resolveIntroComponents(field: string): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> | null;
	inviteCardComponents(): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
};

const idsOf = (buttons: ButtonBuilder[]): Array<string | undefined> => buttons.map((button) => (button.toJSON() as { custom_id?: string }).custom_id);
const rowIds = (field: string): Array<Array<string | undefined>> =>
	(internals.resolveIntroComponents(field) ?? []).map((row) => row.toJSON().components.map((component) => component.custom_id));

describe("the guides' buttons", () => {
	it("give #command-center the member buttons: Account, Levels, Achievements, Suggestion Box and Toggle pings, and no Fortune", () => {
		expect(rowIds("commandsChannelId").flat()).toEqual(idsOf([...buildProfileButtons(), buildSuggestionBoxButton(), ...buildMemberControlButtons()]));
	});

	// 2026-10 item 254: the Summon Dero card is posted in #command-center, so its Fortune
	// moved to the 🕹️games daily row with the guide's.
	it("give the Summon Dero card in #command-center its invite and Icebreaker, and no Fortune", () => {
		const ids = internals.inviteCardComponents().flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
		expect(ids).toContain("powerup:member:greet");
		expect(ids).not.toContain("powerup:member:fortune");
	});

	it("give the admin guide a button per admin job above its control row", () => {
		const rows = rowIds("adminCommandsChannelId");
		expect(rows.slice(0, ADMIN_GUIDE_COMMAND_ROWS.length)).toEqual(ADMIN_GUIDE_COMMAND_ROWS.map((buttons) => buttons.map((button) => `admincmd:${button.id}`)));
		expect(rows.at(-1)).toEqual(idsOf([buildSelfDestructButton(), ...buildAdminControlButtons()]));
	});

	it("give both voice rooms /dero's Join, Leave and Status", () => {
		for (const field of ["meetingVoiceChannelId", "arcadeVoiceChannelId"]) {
			expect(rowIds(field), field).toEqual([["dero_call:join", "dero_call:leave", "dero_call:status"]]);
		}
	});

	it("keep every channel's rows inside five rows of five", () => {
		for (const field of GuildSetupManager.CHANNEL_FIELDS) {
			const rows = rowIds(field);
			expect(rows.length, field).toBeLessThanOrEqual(LIMITS.MAX_MESSAGE_ROWS);
			for (const row of rows) expect(row.length, field).toBeLessThanOrEqual(LIMITS.MAX_ROW_BUTTONS);
		}
	});
});
