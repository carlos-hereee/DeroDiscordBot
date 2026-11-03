import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

// ── the admin command launcher ───────────────────────────────────────────────
// What:  the admin guide's buttons, end to end through the registered handlers:
//        the guide offers exactly the commands the launcher can open and every
//        admin command among them; every leaf of every admin command builds a form
//        inside Discord's limits; a member who is neither the owner nor an admin is
//        refused at EVERY step, because a select or a modal is reachable without the
//        button that opened it; and an admin's submitted form runs the command's own
//        handler (2026-10 item 245 Phase 4b). Since the regroup by job (2026-10 item
//        254 Phase 1) a button names a launch id, a panel id or /events, and every
//        id an older guide carries still opens the job it opened. The stores are
//        mocked; the commands, the form and the gate are real. A refused or stale
//        press is answered with a notice modal (post-launch plan item 9); a refused
//        SUBMIT, which cannot open a modal, with the private reply.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	findEvents: vi.fn(),
	findVoice: vi.fn(),
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
	selects: new Map<string, (interaction: unknown) => Promise<void>>(),
	modals: new Map<string, (interaction: unknown) => Promise<void>>(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@db/stores/eventStore.js", () => ({ eventStore: { findByGuildId: mocks.findEvents } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: mocks.findVoice } }));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
	registerSelectMenu: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.selects.set(prefix, handler),
	registerModal: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.modals.set(prefix, handler),
}));

import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { LAUNCHABLE_COMMANDS, formCustomId, offerSwitchFix, registerAdminCommandLauncher, resolveLaunchTarget } from "./adminCommandLauncher.js";
import { buildForm, listLeaves } from "./commandForm.js";
import { GuildSetupManager } from "@features/setup/GuildSetupManager.js";
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
		deleteReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		// Read by answerInChannel's quiet acknowledgement, which /setup takes before setup
		// has built 🛠️server-config (2026-11 item 285 debug pass).
		isModalSubmit: () => false,
		isMessageComponent: () => false,
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

// A modal's fields, answered by name: a string is a text answer, an array a select's picks,
// and `roles` names the role a role select picked, by field.
function submit(customId: string, answers: Record<string, string | string[]>, userId: string, roles: Record<string, string> = {}) {
	const fields = {
		fields: new Map([...Object.keys(answers), ...Object.keys(roles)].map((name) => [name, {}])),
		getTextInputValue: (name: string) => String(answers[name] ?? ""),
		getStringSelectValues: (name: string) => (Array.isArray(answers[name]) ? (answers[name] as string[]) : []),
		getSelectedUsers: () => null,
		getSelectedRoles: (name: string) => (roles[name] ? { first: () => ({ id: roles[name] }) } : null),
		getSelectedChannels: () => null,
	};
	const fake = fakeInteraction(userId, { customId, fields });
	// A discord.js modal submit carries no showModal, which is how a notice knows it
	// cannot answer with a modal.
	Reflect.deleteProperty(fake.interaction, "showModal");
	return { ...fake, run: () => mocks.modals.get("admincmd_form")!(fake.interaction as unknown as ModalSubmitInteraction) };
}

const refusal = rokCommanderCopy.responses.noWizardPowers;
const firstReply = (reply: ReturnType<typeof vi.fn>): Replied => reply.mock.calls[0]?.[0] as Replied;
type ShownModal = { custom_id: string; components: Array<{ content?: string }> };
const shownModals = (showModal: ReturnType<typeof vi.fn>): ShownModal[] =>
	showModal.mock.calls.map((call) => (call[0] as { toJSON(): unknown }).toJSON() as ShownModal);
// The notice modal's text, the answer to a refused or stale press.
const noticeText = (showModal: ReturnType<typeof vi.fn>): string | undefined =>
	shownModals(showModal)
		.find((modal) => modal.custom_id.startsWith("notice:"))
		?.components.map((component) => component.content)
		.join("\n");
// The command's own forms, never a notice.
const formModals = (showModal: ReturnType<typeof vi.fn>): ShownModal[] => shownModals(showModal).filter((modal) => !modal.custom_id.startsWith("notice:"));

beforeAll(() => {
	registerAdminCommandLauncher();
});

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, weekStart: "sunday" });
	mocks.update.mockReset().mockResolvedValue(undefined);
	mocks.findEvents.mockReset().mockResolvedValue([]);
	mocks.findVoice.mockReset().mockResolvedValue(null);
});

// The launch ids the retired admin guide carried (2026-10 item 263 Phase 4a retired it
// with 🎛️admin-controls), each with the command path its label named. A guide still
// standing on a server the boot sweep has not reached keeps opening its job, and the
// Headquarters steps open the same ids, so every admin command must stay reachable.
const GUIDE_BUTTONS = [
	{ id: "events", path: "events" },
	{ id: "server", path: "server" },
	{ id: "server-channels", path: "server channels" },
	{ id: "leveling", path: "leveling" },
	{ id: "dero-config", path: "dero-config" },
	{ id: "arcade", path: "arcade" },
];
const GUIDE_IDS = GUIDE_BUTTONS.map((button) => button.id);
const LEGACY_IDS = ["schedule", "stream", "configure-kvk-season", "configure", "channels", "setup-level-system", "xp", "economy", "dero-config"];

describe("the admin guide's launch ids", () => {
	it("open exactly the commands the launcher can, each under the path its label named, and every admin command among them", () => {
		const opened = new Set<string>();
		for (const button of GUIDE_BUTTONS) {
			const target = resolveLaunchTarget(button.id);
			expect(target?.path, button.id).toBe(button.path);
			if (target) opened.add(target.command.data.name);
		}
		// /setup is the one launchable command no guide button opens: 🔒inner-sanctum's Set up
		// Dero does (2026-11 item 285 debug pass), pinned in its own block below.
		expect([...opened].sort()).toEqual([...LAUNCHABLE_COMMANDS.keys()].filter((name) => name !== "setup").sort());
		for (const commandName of BOT_CONSTANTS.ADMIN_COMMANDS) expect(LAUNCHABLE_COMMANDS.has(commandName), `${commandName} has no launch id`).toBe(true);
	});

	it("map every id an older guide carries to the job it opened", () => {
		expect(LEGACY_IDS.map((id) => [id, resolveLaunchTarget(id)?.path, resolveLaunchTarget(id)?.panelId ?? null])).toEqual([
			["schedule", "events", null],
			["stream", "events", null],
			["configure-kvk-season", "events", null],
			["configure", "server", "server"],
			["channels", "server channels", "server-channels"],
			["setup-level-system", "leveling", "leveling"],
			["xp", "leveling", "leveling"],
			["economy", "arcade", "arcade"],
			["dero-config", "dero-config", "dero-config"],
		]);
		expect(resolveLaunchTarget("pause-schedule")).toBeNull();
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
	it.each([...GUIDE_IDS, ...LEGACY_IDS])("the admincmd:%s button refuses and opens nothing", async (launchId) => {
		const button = press("admincmd", `admincmd:${launchId}`, MEMBER_ID);
		await button.run();
		expect(noticeText(button.showModal)).toBe(refusal);
		expect(formModals(button.showModal)).toEqual([]);
		expect(button.reply).not.toHaveBeenCalled();
	});

	it("refuses the pick of what to do, the optional field pick and the required only button", async () => {
		const steps = [
			pick("admincmd_leaf", "admincmd_leaf:events", ["pause"], MEMBER_ID),
			pick("admincmd_fields", "admincmd_fields:events:stream/weekly", ["description"], MEMBER_ID),
			press("admincmd_go", "admincmd_go:events:stream/weekly", MEMBER_ID),
		];
		for (const step of steps) {
			await step.run();
			expect(noticeText(step.showModal)).toBe(refusal);
			expect(formModals(step.showModal)).toEqual([]);
		}
	});

	it("refuses a submitted form and runs nothing", async () => {
		const form = submit("admincmd_form:server:leaderboard/week-start:0", { start: ["monday"] }, MEMBER_ID);
		// A refused Submit is a state: the notice's private fallback is its plain text since Phase 1c (owner rule 1).
		await form.run();
		expect(firstReply(form.reply).content).toBe(refusal);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("lets the server owner through even with no admin role configured", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminRoleId: null });
		const button = press("admincmd", "admincmd:events", OWNER_ID);
		await button.run();
		expect(firstReply(button.reply).content).toBe(commandButtonsCopy.launcher.pickLeafPrompt("events"));
	});
});

describe("an admin's flow", () => {
	it("picks what /events should do, from every leaf it has", async () => {
		const button = press("admincmd", "admincmd:events", ADMIN_ID);
		await button.run();
		const select = firstReply(button.reply).components?.[0]?.toJSON().components[0];
		expect(select?.custom_id).toBe("admincmd_leaf:events");
		expect(select?.options?.map((option) => option.value)).toEqual(["list", "delete", "pause", "resume", "stream/announce", "stream/soon", "stream/weekly", "kvk-season"]);
	});

	it.each(["schedule", "stream", "configure-kvk-season"])("opens the /events pick from an older guide's admincmd:%s", async (launchId) => {
		const button = press("admincmd", `admincmd:${launchId}`, ADMIN_ID);
		await button.run();
		expect(firstReply(button.reply).content).toBe(commandButtonsCopy.launcher.pickLeafPrompt("events"));
		expect(firstReply(button.reply).components?.[0]?.toJSON().components[0]?.custom_id).toBe("admincmd_leaf:events");
	});

	it("opens a leaf's form at once when it fits, titled with its full path", async () => {
		const leaf = pick("admincmd_leaf", "admincmd_leaf:events", ["kvk-season"], ADMIN_ID);
		await leaf.run();
		const modal = leaf.showModal.mock.calls[0]?.[0]?.toJSON();
		expect(modal?.title).toBe("/events kvk-season");
		expect(modal?.components).toHaveLength(4);
	});

	it("asks which optional settings to fill for a leaf bigger than one form", async () => {
		const leaf = pick("admincmd_leaf", "admincmd_leaf:events", ["stream/weekly"], ADMIN_ID);
		await leaf.run();
		const [fieldRow, buttonRow] = firstReply(leaf.reply).components ?? [];
		const select = fieldRow?.toJSON().components[0];
		// /events stream weekly has three required options, so two optional ones fit beside them.
		expect(select?.custom_id).toBe("admincmd_fields:events:stream/weekly");
		expect(select?.max_values).toBe(LIMITS.MAX_MODAL_FIELDS - 3);
		expect(buttonRow?.toJSON().components[0]?.custom_id).toBe("admincmd_go:events:stream/weekly");
		expect(leaf.showModal).not.toHaveBeenCalled();
	});

	it("stops a required option with nothing to pick rather than opening an empty form", async () => {
		const leaf = pick("admincmd_leaf", "admincmd_leaf:events", ["delete"], ADMIN_ID);
		await leaf.run();
		expect(noticeText(leaf.showModal)).toBe(commandButtonsCopy.problems.nothingToPick("event"));
		expect(formModals(leaf.showModal)).toEqual([]);
	});

	it("runs the command's own handler from the submitted form", async () => {
		const form = submit("admincmd_form:server:leaderboard/week-start:0", { start: ["monday"] }, ADMIN_ID);
		await form.run();
		// configureLeaderboardWeekStart, the handler /server leaderboard week-start runs, made the write.
		expect(mocks.update).toHaveBeenCalledWith(GUILD_ID, { weekStart: "monday" });
		expect(firstReply(form.reply).embeds?.[0]?.data.title).toBe("📅 Leaderboard week start updated");
	});

	it("names the field that failed instead of running the command", async () => {
		// /events pause's `days` field alone (its index 1), answered with words.
		const form = submit("admincmd_form:events:pause:1", { days: "two weeks" }, ADMIN_ID);
		await form.run();
		expect(firstReply(form.reply).content).toBe(commandButtonsCopy.problems.notWholeNumber("days"));
		expect(mocks.findEvents).not.toHaveBeenCalled();
	});

	it("holds a number to the command's own bounds", async () => {
		const form = submit("admincmd_form:events:pause:1", { days: "0" }, ADMIN_ID);
		await form.run();
		expect(firstReply(form.reply).content).toBe(commandButtonsCopy.problems.outOfRange("days", "1 to 90"));
	});

	it("answers a button from an older layout quietly", async () => {
		const button = press("admincmd", "admincmd:pause-schedule", ADMIN_ID);
		await button.run();
		expect(noticeText(button.showModal)).toBe(commandButtonsCopy.launcher.staleButton);
		expect(button.reply).not.toHaveBeenCalled();
	});

	it("answers a stale form submit privately, since a submit cannot open a modal", async () => {
		const form = submit("admincmd_form:server:no-such-leaf:0", {}, ADMIN_ID);
		await form.run();
		expect(firstReply(form.reply).content).toBe(commandButtonsCopy.launcher.staleButton);
	});
});

// ── the settings panels (post-launch plan item 9) ────────────────────────────

// A settings panel's fields: the selected switch values, the chosen week, a text answer.
function panelSubmit(customId: string, answers: { switches?: string[]; week?: string }, userId: string) {
	const present = Object.keys(answers);
	const fields = {
		fields: new Map(present.map((id) => [id, {}])),
		getStringSelectValues: (id: string) => (id === "week" ? (answers.week ? [answers.week] : []) : (answers.switches ?? [])),
		getSelectedRoles: () => null,
		getSelectedChannels: () => null,
		getTextInputValue: () => "",
	};
	const fake = fakeInteraction(userId, { customId, fields });
	Reflect.deleteProperty(fake.interaction, "showModal");
	const editReply = fake.interaction.editReply as ReturnType<typeof vi.fn>;
	return { ...fake, editReply, run: () => mocks.modals.get("admincmd_panel")!(fake.interaction as unknown as ModalSubmitInteraction) };
}

type EditedReply = { content?: string; embeds?: Array<{ data: { title?: string; description?: string } }>; components?: unknown[] };

describe("the settings panels", () => {
	it("open /server's panel at once, preset to how the server stands", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, weekStart: "monday", autoHealEnabled: false });
		const button = press("admincmd", "admincmd:server", ADMIN_ID);
		await button.run();
		const [modal] = formModals(button.showModal) as unknown as Array<{ custom_id: string; components: Array<{ component: { options: Array<{ value: string; default?: boolean }> } }> }>;
		expect(modal?.custom_id).toBe("admincmd_panel:server");
		const [switches, week] = modal?.components.map((label) => label.component.options) ?? [];
		expect(switches?.map((option) => [option.value, Boolean(option.default)])).toEqual([
			["auto-heal", false],
			["leaderboard-tracking", true],
		]);
		expect(week?.find((option) => option.default)?.value).toBe("monday");
		expect(button.reply).not.toHaveBeenCalled();
	});

	it("give an admin who is not the owner the /server channels pick, since hide and show are the owner's", async () => {
		const button = press("admincmd", "admincmd:server-channels", ADMIN_ID);
		await button.run();
		expect(firstReply(button.reply).content).toBe(commandButtonsCopy.launcher.pickLeafPrompt("server channels"));
		const select = firstReply(button.reply).components?.[0]?.toJSON().components[0];
		expect(select?.options?.map((option) => option.value)).toEqual(["channels/hide", "channels/show", "channels/list", "channels/rename"]);
		expect(formModals(button.showModal)).toEqual([]);
	});

	it.each([
		["configure", "server"],
		["channels", "server-channels"],
		["setup-level-system", "leveling"],
		["xp", "leveling"],
		["economy", "arcade"],
		["dero-config", "dero-config"],
	])("open the panel an older guide's admincmd:%s now names (%s)", async (launchId, panelId) => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, categoryId: "cat", commandsChannelId: "c1", hiddenChannels: [] });
		const button = press("admincmd", `admincmd:${launchId}`, OWNER_ID);
		await button.run();
		expect(formModals(button.showModal).map((modal) => modal.custom_id)).toEqual([`admincmd_panel:${panelId}`]);
		expect(button.reply).not.toHaveBeenCalled();
	});

	it("run each changed setting through the command's own handler and answer once", async () => {
		const panel = panelSubmit("admincmd_panel:server", { switches: ["leaderboard-tracking"], week: "monday" }, ADMIN_ID);
		await panel.run();
		// Auto heal was cleared and the week moved; tracking stayed on, so it never ran.
		expect(mocks.update.mock.calls).toEqual([
			[GUILD_ID, { autoHealEnabled: false }],
			[GUILD_ID, { weekStart: "monday" }],
		]);
		expect(panel.reply).not.toHaveBeenCalled();
		expect(panel.editReply).toHaveBeenCalledTimes(1);
		const answer = panel.editReply.mock.calls[0]?.[0] as EditedReply;
		expect(answer.embeds?.map((embed) => embed.data.title)).toEqual(["✋ Auto-heal OFF", "📅 Leaderboard week start updated"]);
		// The panel's other /server leaves, the channels group, are offered after it.
		const select = (answer.components?.[0] as { toJSON(): { components: Array<{ options: Array<{ value: string }> }> } }).toJSON().components[0];
		expect(select?.options.map((option) => option.value)).toEqual(["channels/hide", "channels/show", "channels/list", "channels/rename"]);
	});

	it("write nothing when every setting is as it was", async () => {
		const panel = panelSubmit("admincmd_panel:server", { switches: ["auto-heal", "leaderboard-tracking"], week: "sunday" }, ADMIN_ID);
		await panel.run();
		expect(mocks.update).not.toHaveBeenCalled();
		const answer = panel.editReply.mock.calls[0]?.[0] as EditedReply;
		expect(answer.embeds?.[0]?.data.description).toBe(commandButtonsCopy.panels.saved.nothingChanged);
	});

	it("offer the command's other subcommands after saving a panel that does not hold them all", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, categoryId: "cat", hiddenChannels: [] });
		const panel = panelSubmit("admincmd_panel:server-channels", {}, OWNER_ID);
		await panel.run();
		const answer = panel.editReply.mock.calls[0]?.[0] as EditedReply;
		const select = (answer.components?.[0] as { toJSON(): { components: Array<{ custom_id: string; options: Array<{ value: string }> }> } }).toJSON().components[0];
		expect(answer.content).toBe(commandButtonsCopy.panels.saved.morePrompt("server channels"));
		expect(select?.custom_id).toBe("admincmd_leaf:server");
		expect(select?.options.map((option) => option.value)).toEqual(["channels/rename"]);
	});

	it("refuse a submitted panel from a member and write nothing", async () => {
		const panel = panelSubmit("admincmd_panel:server", { switches: [] }, MEMBER_ID);
		await panel.run();
		expect(firstReply(panel.reply).content).toBe(refusal);
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

// ── a switch that is off, answered with its fix (2026-10 item 257, owner items 10 and 15) ──
// Claim with chips off and Dero's voice switched off route here: whoever may flip the
// switch gets its panel at once, everyone else the command to send an admin.
describe("offerSwitchFix", () => {
	const fix = { launchId: "arcade", title: "❌ Error", memberSections: ["Chips are off.", "`/arcade chips toggle enabled:True`"] };
	const asButton = { isButton: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false };
	const CONFIG = { guildId: GUILD_ID, adminRoleId: ADMIN_ROLE, chipEconomyEnabled: false };

	it("opens the arcade panel at once for an admin, and no notice", async () => {
		mocks.findByGuildId.mockResolvedValue(CONFIG);
		const fake = fakeInteraction(ADMIN_ID, asButton);
		await offerSwitchFix(fake.interaction as unknown as ButtonInteraction, fix, CONFIG);
		expect(formModals(fake.showModal).map((modal) => modal.custom_id)).toEqual(["admincmd_panel:arcade"]);
		expect(noticeText(fake.showModal)).toBeUndefined();
	});

	it("gives a member the command to send an admin, and no panel", async () => {
		mocks.findByGuildId.mockResolvedValue(CONFIG);
		const fake = fakeInteraction(MEMBER_ID, asButton);
		await offerSwitchFix(fake.interaction as unknown as ButtonInteraction, fix, CONFIG);
		expect(formModals(fake.showModal)).toEqual([]);
		expect(noticeText(fake.showModal)).toBe(fix.memberSections.join("\n"));
	});

	// A modal opens only as the first answer: after a defer the admin reads the member's
	// words, privately, rather than a panel Discord would refuse.
	it("answers an admin with the member's words once the press was already deferred", async () => {
		mocks.findByGuildId.mockResolvedValue(CONFIG);
		const fake = fakeInteraction(ADMIN_ID, { ...asButton, deferred: true });
		await offerSwitchFix(fake.interaction as unknown as ButtonInteraction, fix, CONFIG);
		expect(fake.showModal).not.toHaveBeenCalled();
		expect((fake.interaction.followUp as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ content: fix.memberSections.join("\n\n") });
	});
});

// ── Set up Dero on 🔒inner-sanctum (2026-11 item 285 debug pass) ──────────────
// The pending intro's button is `admincmd:setup`: the launcher builds /setup's own form
// from its two required role options and runs setup's own run, so the button and the
// slash command are one setup path. No admin role exists yet, so only the owner passes.
describe("Set up Dero", () => {
	const PENDING = { guildId: GUILD_ID, adminRoleId: null, categoryId: "category", setupComplete: false };

	it("opens /setup with its two required role options and nothing else", () => {
		const target = resolveLaunchTarget("setup");
		expect(target?.path).toBe("setup");
		const leaves = listLeaves(target!.command.data.toJSON());
		expect(leaves.map((leaf) => leaf.fields.map((field) => [field.name, field.type, field.required]))).toEqual([
			[
				["admin-role", "role", true],
				["member-role", "role", true],
			],
		]);
	});

	it("shows the owner the form of two role pickers", async () => {
		mocks.findByGuildId.mockResolvedValue(PENDING);
		const owner = press("admincmd", "admincmd:setup", OWNER_ID);
		await owner.run();
		const [form] = formModals(owner.showModal);
		expect(form?.custom_id).toBe("admincmd_form:setup::0.1");
		expect(noticeText(owner.showModal)).toBeUndefined();
	});

	it("refuses anyone but the owner and opens no form", async () => {
		mocks.findByGuildId.mockResolvedValue(PENDING);
		const member = press("admincmd", "admincmd:setup", MEMBER_ID);
		await member.run();
		expect(formModals(member.showModal)).toEqual([]);
		expect(noticeText(member.showModal)).toBe(refusal);
	});

	it("runs setup with exactly the roles the owner picked", async () => {
		mocks.findByGuildId.mockResolvedValue(PENDING);
		const applyAdminRole = vi.spyOn(GuildSetupManager, "applyAdminRole").mockResolvedValue(undefined);
		const form = submit("admincmd_form:setup::0.1", {}, OWNER_ID, { "admin-role": "role-picked-admin", "member-role": "role-picked-member" });
		await form.run();
		expect(applyAdminRole).toHaveBeenCalledTimes(1);
		expect(applyAdminRole.mock.calls[0]?.[1]).toEqual({ guildId: GUILD_ID, ownerId: OWNER_ID, adminRoleId: "role-picked-admin", memberRoleId: "role-picked-member" });
		applyAdminRole.mockRestore();
	});

	it("runs nothing for a member's submit", async () => {
		mocks.findByGuildId.mockResolvedValue(PENDING);
		const applyAdminRole = vi.spyOn(GuildSetupManager, "applyAdminRole").mockResolvedValue(undefined);
		const form = submit("admincmd_form:setup::0.1", {}, MEMBER_ID, { "admin-role": "role-picked-admin", "member-role": "role-picked-member" });
		await form.run();
		expect(applyAdminRole).not.toHaveBeenCalled();
		applyAdminRole.mockRestore();
	});
});
