import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── selfDestruct, the three choices (2026-10 item 254) ──────────────────────
// One modal asks what to do. Just delete channels tears the channels down and keeps
// every setting; Arcade only runs the /arcade off path; Delete my data deletes the
// records and resets the settings (owner decision 4a), only after the owner types CONFIRM. Every step is owner only, and each choice is one
// line in the admin log.

const mocks = vi.hoisted(() => ({
	registerButton: vi.fn(),
	registerModal: vi.fn(),
	wipeServerData: vi.fn(),
	resetConfigsToDefault: vi.fn(),
	turnArcadeOff: vi.fn(),
	emit: vi.fn(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerModal: mocks.registerModal }));
vi.mock("./serverReset.js", () => ({ wipeServerData: mocks.wipeServerData, resetConfigsToDefault: mocks.resetConfigsToDefault }));
vi.mock("./arcadeSwitch.js", () => ({ turnArcadeOff: mocks.turnArcadeOff }));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));

import {
	buildChoiceModal,
	buildSelfDestructButton,
	HOMEBASE_CHANNEL_FIELDS,
	MANAGED_CATEGORY_FIELDS,
	registerSelfDestructHandlers,
	SELF_DESTRUCT_CHOICES,
	type SelfDestructChoice,
} from "./selfDestruct.js";
import { setupCopy } from "./setupCopy.js";

const c = setupCopy.selfDestruct;
const OWNER = "owner-1";
const GUILD = { id: "g1", ownerId: OWNER, channels: { fetch: vi.fn(async () => null) } };

type Reply = { embeds?: Array<{ data: { title?: string; description?: string } }>; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string; label?: string }> } }> };

function press(customId: string, userId = OWNER) {
	return {
		id: "press-1",
		customId,
		user: { id: userId },
		guild: GUILD,
		client: {},
		deferred: false,
		replied: false,
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
	};
}

// A modal submit carries no showModal, so every refusal on it answers privately.
function submit(customId: string, values: { word?: string; choice?: string }, userId = OWNER) {
	return {
		id: "submit-1",
		customId,
		user: { id: userId },
		guild: GUILD,
		client: {},
		deferred: false,
		replied: false,
		fields: { getTextInputValue: () => values.word ?? "", getStringSelectValues: () => (values.choice ? [values.choice] : []) },
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
}

const choose = (choice: string, userId = OWNER) => submit("self_destruct:choose", { choice }, userId);
const confirmWord = (word: string, userId = OWNER) => submit("self_destruct:modal", { word }, userId);

async function clickButton(interaction: ReturnType<typeof press>): Promise<void> {
	registerSelfDestructHandlers();
	const handler = mocks.registerButton.mock.calls.at(-1)![1] as (click: ButtonInteraction) => Promise<void>;
	await handler(interaction as unknown as ButtonInteraction);
}

async function submitModal(interaction: ReturnType<typeof submit>): Promise<void> {
	registerSelfDestructHandlers();
	const handler = mocks.registerModal.mock.calls.at(-1)![1] as (modal: ModalSubmitInteraction) => Promise<void>;
	await handler(interaction as unknown as ModalSubmitInteraction);
}

function auditDetails(): string[] {
	return mocks.emit.mock.calls.map((call) => (call[0] as { payload: { detail: string } }).payload.detail);
}

function buttonIds(reply: Reply): string[] {
	return (reply.components ?? []).flatMap((row) => row.toJSON().components.map((component) => component.custom_id ?? ""));
}

const demolished = (): boolean => mocks.update.mock.calls.some((call) => (call[1] as { homebaseDestroyed?: boolean }).homebaseDestroyed === true);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.wipeServerData.mockResolvedValue({ failed: [] });
	mocks.resetConfigsToDefault.mockResolvedValue(undefined);
	mocks.turnArcadeOff.mockResolvedValue("off");
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adoptedChannelIds: [] });
	mocks.update.mockResolvedValue(undefined);
});

describe("the self destruct button", () => {
	it("is labeled Self destruct", () => {
		expect(buildSelfDestructButton().toJSON()).toMatchObject({ label: "Self destruct", custom_id: "self_destruct:prompt" });
	});
});

describe("the choice modal", () => {
	it("says what goes and what stays, over one required select of the three choices", () => {
		const modal = buildChoiceModal().toJSON() as unknown as {
			components: Array<{ type: number; content?: string; component?: { custom_id: string; required: boolean; min_values: number; max_values: number; options: Array<{ value: string; label: string; default?: boolean }> } }>;
		};
		const text = modal.components.find((component) => component.content)!.content!;
		expect(text).toContain("deletes every Dero channel and its message history");
		expect(text).toContain("does **not** delete stored data");
		expect(text).toContain("adopted it is kept");

		const select = modal.components.find((component) => component.component)!.component!;
		expect(select.required).toBe(true);
		expect([select.min_values, select.max_values]).toEqual([1, 1]);
		expect(select.options.map((option) => option.label)).toEqual(["Just delete channels", "Delete my data", "Arcade only"]);
		expect(select.options.some((option) => option.default)).toBe(false);
		expect(modal.components.length).toBeLessThanOrEqual(5);
	});

	it("opens for the owner from the guide button, and nothing runs yet", async () => {
		const interaction = press("self_destruct:prompt");
		await clickButton(interaction);

		expect(interaction.showModal).toHaveBeenCalledOnce();
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([]);
	});

	it("refuses anyone but the server owner with a notice, and logs the attempt", async () => {
		const interaction = press("self_destruct:prompt", "admin-1");
		await clickButton(interaction);

		const notice = (interaction.showModal.mock.calls[0] as unknown as [{ toJSON(): { custom_id: string } }])[0];
		expect(notice.toJSON().custom_id).toBe("notice:press-1");
		expect(auditDetails()).toEqual([c.auditRefusedNotOwner]);
	});

	it.each(SELF_DESTRUCT_CHOICES)("refuses a %s choice submitted by anyone but the owner", async (choice: SelfDestructChoice) => {
		await submitModal(choose(choice, "admin-1"));

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([c.auditRefusedNotOwner]);
	});

	it("answers a button from an older prompt as a stale control, changing nothing", async () => {
		for (const stale of ["self_destruct:reset", "self_destruct:cancel", "self_destruct:confirm"]) {
			const interaction = press(stale);
			await clickButton(interaction);
			expect(interaction.showModal).toHaveBeenCalledOnce();
		}
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
	});
});

describe("Just delete channels", () => {
	it("demolishes the channels, keeps every setting and record, and writes one log line", async () => {
		const interaction = choose("channels");
		await submitModal(interaction);

		// The one write is demolishHomebase's flag: no setting is in it, and no record is wiped.
		expect(mocks.update).toHaveBeenCalledOnce();
		expect(mocks.update).toHaveBeenCalledWith("g1", { homebaseDestroyed: true, setupComplete: false, adoptedChannelIds: [] });
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.channelsDone }));
		expect(auditDetails()).toEqual([c.auditChannelsConfirmed]);
	});
});

describe("Just delete channels, everything Dero built", () => {
	// 🏰 DERO HEADQUARTERS (2026-10 item 257 Phase 2a): every channel goes, its six
	// included, then the three categories, Headquarters last, so no category is
	// deleted while a tracked channel still sits under it.
	it("deletes every tracked channel, then the categories, Headquarters last", async () => {
		const row: Record<string, unknown> = { guildId: "g1", adoptedChannelIds: [] };
		for (const field of HOMEBASE_CHANNEL_FIELDS) row[field] = `ch-${field}`;
		for (const field of MANAGED_CATEGORY_FIELDS) row[field] = `cat-${field}`;
		mocks.findByGuildId.mockResolvedValue(row);
		const deleted: string[] = [];
		GUILD.channels.fetch.mockImplementation((async (id: string) => ({ id, delete: vi.fn(async () => deleted.push(id)) })) as never);

		await submitModal(choose("channels"));

		const categories = MANAGED_CATEGORY_FIELDS.map((field) => `cat-${field}`);
		expect(deleted).toEqual([...HOMEBASE_CHANNEL_FIELDS.map((field) => `ch-${field}`), ...categories]);
		expect(deleted.at(-1)).toBe("cat-headquartersCategoryId");
		for (const field of ["deroConfigChannelId", "onboardingConfigChannelId", "arcadeControlChannelId", "commandOutputChannelId"]) {
			expect(deleted, field).toContain(`ch-${field}`);
		}
		GUILD.channels.fetch.mockImplementation((async () => null) as never);
	});
});

describe("Arcade only", () => {
	it("runs the /arcade off path alone and writes one log line", async () => {
		const interaction = choose("arcade");
		await submitModal(interaction);

		expect(mocks.turnArcadeOff).toHaveBeenCalledWith(GUILD);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
		const done = (interaction.editReply.mock.calls.at(-1) as unknown as [Reply])[0];
		expect(done.embeds![0]!.data.description).toBe(setupCopy.arcade.offBody);
		expect(auditDetails()).toEqual([c.auditArcadeOff]);
	});

	it("says so when the arcade was already off", async () => {
		mocks.turnArcadeOff.mockResolvedValue("already-off");
		const interaction = choose("arcade");
		await submitModal(interaction);

		const done = (interaction.editReply.mock.calls.at(-1) as unknown as [Reply])[0];
		expect(done.embeds![0]!.data.description).toBe(setupCopy.arcade.alreadyOff);
		expect(auditDetails()).toEqual([c.auditArcadeAlreadyOff]);
	});
});

describe("Delete my data", () => {
	it("answers with one Type CONFIRM button and deletes nothing yet", async () => {
		const interaction = choose("data");
		await submitModal(interaction);

		const reply = (interaction.reply.mock.calls[0] as unknown as [Reply])[0];
		expect(buttonIds(reply)).toEqual(["self_destruct:delete"]);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([]);
	});

	it("Type CONFIRM opens the CONFIRM modal for the owner", async () => {
		const interaction = press("self_destruct:delete");
		await clickButton(interaction);
		const modal = (interaction.showModal.mock.calls[0] as unknown as [{ toJSON(): { custom_id: string } }])[0];
		expect(modal.toJSON().custom_id).toBe("self_destruct:modal");
	});

	it.each(["confirm", "Confirm", "CONFIRMED", ""])("deletes nothing when the owner typed %j", async (word) => {
		const interaction = confirmWord(word);
		await submitModal(interaction);

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([c.auditDeleteRefused]);
	});

	it("refuses a CONFIRM submitted by anyone but the owner, even with the right word", async () => {
		await submitModal(confirmWord("CONFIRM", "admin-1"));

		expect(demolished()).toBe(false);
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
	});

	it("on the exact word flags the homebase destroyed, wipes the stored records, then resets the settings, with one log line", async () => {
		const interaction = confirmWord("CONFIRM");
		await submitModal(interaction);

		expect(mocks.update).toHaveBeenCalledWith("g1", expect.objectContaining({ homebaseDestroyed: true }));
		expect(mocks.wipeServerData).toHaveBeenCalledWith("g1");
		expect(mocks.resetConfigsToDefault).toHaveBeenCalledWith("g1");
		expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.wipeServerData.mock.invocationCallOrder[0]!);
		expect(mocks.wipeServerData.mock.invocationCallOrder[0]!).toBeLessThan(mocks.resetConfigsToDefault.mock.invocationCallOrder[0]!);
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.deleteDone }));
		expect(auditDetails()).toEqual([c.auditDeleteConfirmed]);
	});

	it("names the records it could not delete", async () => {
		mocks.wipeServerData.mockResolvedValue({ failed: ["luck"] });
		const interaction = confirmWord("CONFIRM");
		await submitModal(interaction);

		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.deletePartial(["luck"]) }));
	});

	it("names the settings when their reset fails, after the records are already gone", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.resetConfigsToDefault.mockRejectedValue(new Error("mongo down"));
		const interaction = confirmWord("CONFIRM");
		await submitModal(interaction);

		expect(mocks.wipeServerData).toHaveBeenCalledWith("g1");
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.deletePartial([c.settingsLabel]) }));
	});
});
