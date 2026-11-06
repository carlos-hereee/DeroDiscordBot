import { describe, it, expect } from "vitest";
import type { ButtonBuilder } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { GuildSetupManager, isAdminRolePending } from "./GuildSetupManager.js";
import { buildSuggestionBoxButton } from "@features/suggestion-box/SuggestionBox.js";
import { buildEnterCodeButton } from "@features/secret-codes/secretCodeEntry.js";
import { buildSelfDestructButton } from "@features/setup/selfDestruct.js";
import { buildAdminControlButtons, buildMemberControlButtons, buildProfileButtons } from "@features/power-ups/PowerUps.js";

// ── the guides' buttons, by audience (2026-10 item 245 Phase 4b) ─────────────
// What:  which buttons each guide carries, read off the builders themselves so a
//        relabel never breaks this, and that every channel's rows fit Discord's
//        five rows of five. A send past either limit is rejected whole, which on
//        boot would silently leave a guide without its buttons.
// Who:   resolveIntroComponents, the one source of every intro's rows, through the
//        same cast the other GuildSetupManager tests use for its private statics.

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;

const internals = GuildSetupManager as unknown as {
	resolveIntroComponents(field: string, guildConfig?: null, adminRoleId?: string | null): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }> | null;
	inviteCardComponents(): Array<{ toJSON(): { components: Array<{ custom_id?: string }> } }>;
};

const idsOf = (buttons: ButtonBuilder[]): Array<string | undefined> => buttons.map((button) => (button.toJSON() as { custom_id?: string }).custom_id);
// A set admin role unless a test asks otherwise, so every channel is read as it stands after setup.
const SET_ADMIN_ROLE = "role-admin";
const rowIds = (field: string, adminRoleId: string | null = SET_ADMIN_ROLE): Array<Array<string | undefined>> =>
	(internals.resolveIntroComponents(field, null, adminRoleId) ?? []).map((row) => row.toJSON().components.map((component) => component.custom_id));

describe("the guides' buttons", () => {
	it("give #command-center the member buttons: Account, Levels, Achievements, Suggestion Box, Enter a code and Toggle pings, and no Fortune", () => {
		expect(rowIds("commandsChannelId").flat()).toEqual(idsOf([...buildProfileButtons(), buildSuggestionBoxButton(), buildEnterCodeButton(), ...buildMemberControlButtons()]));
	});

	// 2026-10 item 254: the Summon Dero card is posted in #command-center, so its Fortune
	// moved to the 🕹️games daily row with the guide's.
	it("give the Summon Dero card in #command-center its invite and Icebreaker, and no Fortune", () => {
		const ids = internals.inviteCardComponents().flatMap((row) => row.toJSON().components.map((component) => component.custom_id));
		expect(ids).toContain("powerup:member:greet");
		expect(ids).not.toContain("powerup:member:fortune");
	});

	// 🎛️admin-controls and its guide retired (2026-10 item 263 Phase 4a): Self destruct is
	// the one control on 🔒inner-sanctum's intro once setup has run, and no intro carries an
	// admin command button or Refresh standings, which rides 🛠️server-config's switches message.
	it("give a set 🔒inner-sanctum the owner only Self destruct and nothing else", () => {
		expect(rowIds("adminChannelId")).toEqual([idsOf([buildSelfDestructButton()])]);
	});

	// 2026-11 item 285 debug pass: while no admin role is set the intro is step one of
	// setup, and Set up Dero opens /setup through the admin command launcher.
	it("give a pending 🔒inner-sanctum Set up Dero first, then Self destruct", () => {
		expect(rowIds("adminChannelId", null)).toEqual([["admincmd:setup", ...idsOf([buildSelfDestructButton()])]]);
	});

	it("decide the pending buttons by the same test as the pending embed", () => {
		expect(isAdminRolePending(null)).toBe(true);
		expect(isAdminRolePending(undefined)).toBe(true);
		expect(isAdminRolePending("")).toBe(true);
		expect(isAdminRolePending(SET_ADMIN_ROLE)).toBe(false);
	});

	it("put no admin command button and no Refresh standings on any intro, Set up Dero on a pending inner sanctum aside", () => {
		const refresh = idsOf(buildAdminControlButtons());
		for (const field of GuildSetupManager.CHANNEL_FIELDS) {
			for (const adminRoleId of [SET_ADMIN_ROLE, null]) {
				const ids = rowIds(field, adminRoleId).flat();
				const allowed = field === "adminChannelId" && adminRoleId === null ? ["admincmd:setup"] : [];
				expect(ids.filter((id) => id?.startsWith("admincmd:")), field).toEqual(allowed);
				for (const id of refresh) expect(ids, field).not.toContain(id);
			}
		}
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
