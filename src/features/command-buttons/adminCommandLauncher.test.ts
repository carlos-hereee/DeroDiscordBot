import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

// ── the admin command launcher ───────────────────────────────────────────────
// What:  the admin guide's buttons, end to end through the registered handlers:
//        the guide offers exactly the commands the launcher can open and every
//        admin command among them; every leaf of every admin command builds a form
//        inside Discord's limits; a member who is neither the owner nor an admin is
//        refused at EVERY step, because a select or a modal is reachable without the
//        button that opened it; and an admin's submitted form runs the command's own
//        handler (2026-10 item 245 Phase 4b). The stores are mocked; the commands,
//        the form and the gate are real.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	findEvents: vi.fn(),
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
	selects: new Map<string, (interaction: unknown) => Promise<void>>(),
	modals: new Map<string, (interaction: unknown) => Promise<void>>(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: mocks.findEvents } }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerSelectMenu: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.selects.set(prefix, handler),
	registerModal: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.modals.set(prefix, handler),
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { LAUNCHABLE_COMMANDS, formCustomId, registerAdminCommandLauncher } from "./adminCommandLauncher.js";
import { ADMIN_GUIDE_COMMAND_ROWS, buildAdminCommandRows } from "./adminGuideButtons.js";
import { buildForm, listLeaves } from "./commandForm.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;
const GUILD_ID = "g1";
const OWNER_ID = "owner";
const ADMIN_ID = "admin";
const MEMBER_ID = "member";
const ADMIN_ROLE = "role-admin";

interface Replied {
	embeds?: Array<{ data: { title?: string; description?: string } }>;
	content?: string;
	components?: Array<{ toJSON(): { components: Array<{ custom_id?: string; options?: Array<{ value: string }>; max_values?: number }> } }>;
}

function fakeInteraction(userId: string, extra: Record<string, unknown>) {
	const reply = vi.fn(async (_payload: Replied) => undefined);
	const showModal = vi.fn(async (_modal: { toJSON(): { title: string; custom_id: string; components: unknown[] } }) => undefined);
	const guild = {
		id: GUILD_ID,
		ownerId: OWNER_ID,
		members: {
			cache: new Map([
				[ADMIN_ID, { id: ADMIN_ID, roles: { cache: new Set([ADMIN_ROLE]) } }],
				[MEMBER_ID, { id: MEMBER_ID, roles: { cache: new Set<string>() } }],
			]),
			fetch: vi.fn(async () => null),
		},
	};
	const interaction = {
		user: { id: userId },
		guild,
		guildId: GUILD_ID,
		client: {},
		reply,
		showModal,
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		...extra,
	};
	return { interaction, reply, showModal };
}

const press = (prefix: string, customId: string, userId: string) => {
	const fake = fakeInteraction(userId, { customId });
	return { ...fake, run: () => mocks.buttons.get(prefix)!(fake.interaction as unknown as ButtonInteraction) };
};

const pick = (prefix: string, customId: string, values: string[], userId: string) => {
	const fake = fakeInteraction(userId, { customId, values });
	return { ...fake, run: () => mocks.selects.get(prefix)!(fake.interaction as unknown as StringSelectMenuInteraction) };
};

// A modal's fields, answered by name: a string is a text answer, an array a select's picks.
function submit(customId: string, answers: Record<string, string | string[]>, userId: string) {
	const fields = {
		fields: new Map(Object.keys(answers).map((name) => [name, {}])),
		getTextInputValue: (name: string) => String(answers[name] ?? ""),
		getStringSelectValues: (name: string) => (Array.isArray(answers[name]) ? (answers[name] as string[]) : []),
		getSelectedUsers: () => null,
		getSelectedRoles: () => null,
		getSelectedChannels: () => null,
	};
	const fake = fakeInteraction(userId, { customId, fields });
	return { ...fake, run: () => mocks.modals.get("admincmd_form")!(fake.interaction as unknown as ModalSubmitInteraction) };
}

const refusal = rokCommanderCopy.responses.noWizardPowers;
const firstReply = (reply: ReturnType<typeof vi.fn>): Replied => reply.mock.calls[0]?.[0] as Replied;

beforeAll(() => {
	registerAdminCommandLauncher();
});

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, weekStart: "sunday" });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.findEvents.mockReset().mockResolvedValue([]);
});

describe("the admin guide's command buttons", () => {
	it("offer exactly the commands the launcher opens, and every admin command among them", () => {
		expect(ADMIN_GUIDE_COMMAND_ROWS.flat().sort()).toEqual([...LAUNCHABLE_COMMANDS.keys()].sort());
		for (const entry of BOT_CONSTANTS.ADMIN_COMMANDS) {
			const [commandName] = entry.split(" ");
			expect(LAUNCHABLE_COMMANDS.has(commandName ?? ""), `${entry} has no button`).toBe(true);
		}
	});

	it("label each button with its command and fit Discord's row and message limits", () => {
		const rows = buildAdminCommandRows();
		// The guide adds its control row (Self destruct and the admin controls) below.
		expect(rows.length + 1).toBeLessThanOrEqual(LIMITS.MAX_MESSAGE_ROWS);
		for (const row of rows) {
			const buttons = row.toJSON().components as Array<{ label?: string; custom_id?: string }>;
			expect(buttons.length).toBeLessThanOrEqual(LIMITS.MAX_ROW_BUTTONS);
			for (const button of buttons) expect(button.custom_id).toBe(`admincmd:${button.label?.slice(1)}`);
		}
	});

	it("build a form inside Discord's limits for every leaf of every admin command", () => {
		for (const command of LAUNCHABLE_COMMANDS.values()) {
			const leaves = listLeaves(command.data.toJSON());
			expect(leaves.length, command.data.name).toBeLessThanOrEqual(LIMITS.MAX_SELECT_OPTIONS);
			for (const leaf of leaves) {
				if (leaf.fields.length === 0) continue;
				// A leaf too big for one form shows its required fields and the first optional ones.
				const required = leaf.fields.filter((field) => field.required);
				const shown = [...required, ...leaf.fields.filter((field) => !field.required)].slice(0, LIMITS.MAX_MODAL_FIELDS);
				expect(required.length, `${command.data.name} ${leaf.path} has more required fields than a form holds`).toBeLessThanOrEqual(LIMITS.MAX_MODAL_FIELDS);
				const customId = formCustomId(command.data.name, leaf, shown);
				const modal = buildForm({ customId, commandName: command.data.name, leaf, fields: shown, picks: new Map() }).toJSON();
				expect(customId.length, customId).toBeLessThanOrEqual(LIMITS.MAX_CUSTOM_ID_LENGTH);
				expect(modal.title.length).toBeLessThanOrEqual(LIMITS.MAX_MODAL_TITLE_LENGTH);
				expect(modal.components.length).toBeGreaterThan(0);
				expect(modal.components.length).toBeLessThanOrEqual(LIMITS.MAX_MODAL_FIELDS);
			}
		}
	});
});

describe("every admin button refuses a member who is neither the owner nor an admin", () => {
	it.each([...LAUNCHABLE_COMMANDS.keys()])("the /%s button refuses and opens nothing", async (commandName) => {
		const button = press("admincmd", `admincmd:${commandName}`, MEMBER_ID);
		await button.run();
		expect(firstReply(button.reply).embeds?.[0]?.data.description).toBe(refusal);
		expect(button.showModal).not.toHaveBeenCalled();
	});

	it("refuses the pick of what to do, the optional field pick and the required only button", async () => {
		const steps = [
			pick("admincmd_leaf", "admincmd_leaf:schedule", ["pause"], MEMBER_ID),
			pick("admincmd_fields", "admincmd_fields:stream:setup", ["description"], MEMBER_ID),
			press("admincmd_go", "admincmd_go:stream:setup", MEMBER_ID),
		];
		for (const step of steps) {
			await step.run();
			expect(firstReply(step.reply).embeds?.[0]?.data.description).toBe(refusal);
			expect(step.showModal).not.toHaveBeenCalled();
		}
	});

	it("refuses a submitted form and runs nothing", async () => {
		const form = submit("admincmd_form:configure:week-start:0", { start: ["monday"] }, MEMBER_ID);
		await form.run();
		expect(firstReply(form.reply).embeds?.[0]?.data.description).toBe(refusal);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("lets the server owner through even with no admin role configured", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminRoleId: null });
		const button = press("admincmd", "admincmd:schedule", OWNER_ID);
		await button.run();
		expect(firstReply(button.reply).content).toBe(commandButtonsCopy.launcher.pickLeafPrompt("schedule"));
	});
});

describe("an admin's flow", () => {
	it("picks what a command with several subcommands should do", async () => {
		const button = press("admincmd", "admincmd:schedule", ADMIN_ID);
		await button.run();
		const select = firstReply(button.reply).components?.[0]?.toJSON().components[0];
		expect(select?.custom_id).toBe("admincmd_leaf:schedule");
		expect(select?.options?.map((option) => option.value)).toEqual(["pause", "resume"]);
	});

	it("opens the form at once for a command with one leaf", async () => {
		const button = press("admincmd", "admincmd:configure-kvk-season", ADMIN_ID);
		await button.run();
		const modal = button.showModal.mock.calls[0]?.[0]?.toJSON();
		expect(modal?.title).toBe("/configure-kvk-season");
		expect(modal?.components).toHaveLength(4);
	});

	it("asks which optional settings to fill for a leaf bigger than one form", async () => {
		const leaf = pick("admincmd_leaf", "admincmd_leaf:stream", ["setup"], ADMIN_ID);
		await leaf.run();
		const [fieldRow, buttonRow] = firstReply(leaf.reply).components ?? [];
		const select = fieldRow?.toJSON().components[0];
		// /stream setup has three required options, so two optional ones fit beside them.
		expect(select?.custom_id).toBe("admincmd_fields:stream:setup");
		expect(select?.max_values).toBe(LIMITS.MAX_MODAL_FIELDS - 3);
		expect(buttonRow?.toJSON().components[0]?.custom_id).toBe("admincmd_go:stream:setup");
		expect(leaf.showModal).not.toHaveBeenCalled();
	});

	it("stops a required option with nothing to pick rather than opening an empty form", async () => {
		const leaf = pick("admincmd_leaf", "admincmd_leaf:events", ["delete"], ADMIN_ID);
		await leaf.run();
		expect(firstReply(leaf.reply).embeds?.[0]?.data.description).toBe(commandButtonsCopy.problems.nothingToPick("event"));
		expect(leaf.showModal).not.toHaveBeenCalled();
	});

	it("runs the command's own handler from the submitted form", async () => {
		const form = submit("admincmd_form:configure:week-start:0", { start: ["monday"] }, ADMIN_ID);
		await form.run();
		// configureLeaderboardWeekStart, the handler /configure week-start runs, made the write.
		expect(mocks.update).toHaveBeenCalledWith(GUILD_ID, { weekStart: "monday" });
		expect(firstReply(form.reply).embeds?.[0]?.data.title).toBe("📅 Leaderboard week start updated");
	});

	it("names the field that failed instead of running the command", async () => {
		// /schedule pause's `days` field alone (its index 1), answered with words.
		const form = submit("admincmd_form:schedule:pause:1", { days: "two weeks" }, ADMIN_ID);
		await form.run();
		expect(firstReply(form.reply).embeds?.[0]?.data.description).toBe(commandButtonsCopy.problems.notWholeNumber("days"));
		expect(mocks.findEvents).not.toHaveBeenCalled();
	});

	it("holds a number to the command's own bounds", async () => {
		const form = submit("admincmd_form:schedule:pause:1", { days: "0" }, ADMIN_ID);
		await form.run();
		expect(firstReply(form.reply).embeds?.[0]?.data.description).toBe(commandButtonsCopy.problems.outOfRange("days", "1 to 90"));
	});

	it("answers a button from an older layout quietly", async () => {
		const button = press("admincmd", "admincmd:pause-schedule", ADMIN_ID);
		await button.run();
		expect(firstReply(button.reply).content).toBe(commandButtonsCopy.launcher.staleButton);
	});
});
