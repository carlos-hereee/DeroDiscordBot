import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── selfDestruct, the three choices (2026-10 item 254) ──────────────────────
// One modal asks what to do. Just delete channels tears the channels down and resets
// the settings, keeping the records; Arcade only runs the /arcade off path; Delete my
// data deletes the records too (owner decision 4a), only after the owner types CONFIRM.
// Both teardowns then build Dero fresh (2026-11 item 285 debug pass). Every step is
// owner only, and each choice is one line in the admin log.

const mocks = vi.hoisted(() => ({
	registerButton: vi.fn(),
	registerModal: vi.fn(),
	wipeServerData: vi.fn(),
	resetConfigsToDefault: vi.fn(),
	turnArcadeOff: vi.fn(),
	emit: vi.fn(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
	revokeDeroVoiceRooms: vi.fn(),
	rebuildDestroyedHomebase: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerModal: mocks.registerModal }));
vi.mock("./serverReset.js", () => ({ wipeServerData: mocks.wipeServerData, resetConfigsToDefault: mocks.resetConfigsToDefault }));
vi.mock("./arcadeSwitch.js", () => ({ turnArcadeOff: mocks.turnArcadeOff }));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));
vi.mock("@features/voice/deroVoiceRooms.js", () => ({
	DERO_VOICE_ROOM_FIELDS: ["meetingVoiceChannelId", "arcadeVoiceChannelId"],
	revokeDeroVoiceRooms: mocks.revokeDeroVoiceRooms,
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("./GuildSetupManager.js", () => ({ GuildSetupManager: { rebuildDestroyedHomebase: mocks.rebuildDestroyedHomebase } }));

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
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const c = setupCopy.selfDestruct;
const OWNER = "owner-1";
const SANCTUM = "sanctum-1";
// The second sentence of a teardown's done line once the rebuild stood.
const REBUILT = c.rebuilt(`<#${SANCTUM}>`, rokCommanderCopy.channelContent.adminWelcome.setupButtonLabel);
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

// A modal submit carries no showModal, so every refusal on it answers privately. Each
// select the submit names is present in its fields, as Discord sends them.
function submit(customId: string, values: { word?: string; choice?: string; autoHeal?: string }, userId = OWNER) {
	const selects: Record<string, string | undefined> = { self_destruct_choice: values.choice, self_destruct_auto_heal: values.autoHeal };
	const present = Object.entries(selects).filter((entry): entry is [string, string] => entry[1] !== undefined);
	return {
		id: "submit-1",
		customId,
		user: { id: userId },
		guild: GUILD,
		client: {},
		deferred: false,
		replied: false,
		fields: {
			fields: new Map(present.map(([id, value]) => [id, { customId: id, values: [value] }])),
			getTextInputValue: () => values.word ?? "",
			getStringSelectValues: (id: string) => (selects[id] ? [selects[id]!] : []),
		},
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
}

const choose = (choice: string, userId = OWNER, autoHeal = "on") => submit("self_destruct:choose", { choice, autoHeal }, userId);
const confirmWord = (word: string, userId = OWNER, autoHeal = "on") => submit(`self_destruct:modal:${autoHeal}`, { word }, userId);
const autoHealWrites = () => mocks.update.mock.calls.filter((call) => "autoHealEnabled" in (call[1] as object));

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
const flagCleared = (): boolean => mocks.update.mock.calls.some((call) => (call[1] as { homebaseDestroyed?: boolean }).homebaseDestroyed === false);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.wipeServerData.mockResolvedValue({ failed: [] });
	mocks.resetConfigsToDefault.mockResolvedValue(undefined);
	mocks.turnArcadeOff.mockResolvedValue("off");
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adoptedChannelIds: [], adminChannelId: SANCTUM });
	mocks.update.mockResolvedValue(undefined);
	mocks.rebuildDestroyedHomebase.mockResolvedValue(true);
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
		// Every teardown resets the settings now (2026-11 item 285 debug pass), and only Delete my data takes the records.
		expect(text).toContain("puts every Dero setting back to its default");
		expect(text).toContain("Stored records");
		expect(text).toContain("adopted it is kept");

		const [select, autoHeal] = modal.components.filter((component) => component.component).map((component) => component.component!);
		expect(select!.required).toBe(true);
		expect([select!.min_values, select!.max_values]).toEqual([1, 1]);
		expect(select!.options.map((option) => option.label)).toEqual(["Just delete channels", "Delete my data", "Arcade only"]);
		expect(select!.options.some((option) => option.default)).toBe(false);
		// The auto heal select (2026-11 item 285 debug pass, owner ruling): required with no
		// default too, so the owner reads why a deleted channel would come back.
		expect(autoHeal!.custom_id).toBe("self_destruct_auto_heal");
		expect(autoHeal!.required).toBe(true);
		expect(autoHeal!.options.map((option) => option.value)).toEqual(["on", "off"]);
		expect(autoHeal!.options.some((option) => option.default)).toBe(false);
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
	// Owner rulings in the 2026-11 item 285 debug pass: Just delete channels resets the
	// settings and clears every stored id too, then builds Dero fresh at once, so the new
	// 🔒inner-sanctum offers Set up Dero. The records stay; only Delete my data wipes them.
	it("demolishes the channels, clears the stored ids, resets the settings, keeps the records, and writes one log line", async () => {
		const interaction = choose("channels");
		await submitModal(interaction);

		expect(mocks.update).toHaveBeenCalledTimes(3);
		expect(mocks.update.mock.calls[0]).toEqual(["g1", { homebaseDestroyed: true, setupComplete: false, adoptedChannelIds: [] }]);
		const cleared = mocks.update.mock.calls[1]![1] as Record<string, unknown>;
		for (const field of [...HOMEBASE_CHANNEL_FIELDS, ...MANAGED_CATEGORY_FIELDS]) expect(cleared[field], field).toBeNull();
		expect(cleared).toMatchObject({ adminRoleId: null, memberRoleId: null, onDemandChannels: [], tutorialCardMessageIds: {}, setupStepsSkipped: [] });
		expect(mocks.resetConfigsToDefault).toHaveBeenCalledWith("g1");
		expect(mocks.update.mock.invocationCallOrder[1]!).toBeLessThan(mocks.resetConfigsToDefault.mock.invocationCallOrder[0]!);
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(mocks.turnArcadeOff).not.toHaveBeenCalled();
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.channelsDone} ${REBUILT}` }));
		expect(auditDetails()).toEqual([c.auditChannelsConfirmed]);
	});

	it("builds Dero fresh after the settings reset, then clears the flag so the boot sweep repairs it like any server", async () => {
		await submitModal(choose("channels"));

		expect(mocks.rebuildDestroyedHomebase).toHaveBeenCalledWith(GUILD);
		expect(mocks.resetConfigsToDefault.mock.invocationCallOrder[0]!).toBeLessThan(mocks.rebuildDestroyedHomebase.mock.invocationCallOrder[0]!);
		expect(mocks.update.mock.calls[2]).toEqual(["g1", { homebaseDestroyed: false }]);
		expect(mocks.rebuildDestroyedHomebase.mock.invocationCallOrder[0]!).toBeLessThan(mocks.update.mock.invocationCallOrder[2]!);
	});
});

describe("the auto heal pick", () => {
	// The settings reset turns auto heal back on, so the pick is written after it and
	// before the rebuild, and the done line says so (2026-11 item 285 debug pass).
	for (const [label, makeSubmit, done] of [
		["Just delete channels", () => choose("channels", OWNER, "off"), c.channelsDone],
		["Delete my data", () => confirmWord("CONFIRM", OWNER, "off"), c.deleteDone],
	] as const) {
		it(`${label}: Turn auto heal off writes it after the reset and before the rebuild, and says so`, async () => {
			const interaction = makeSubmit();
			await submitModal(interaction);

			expect(autoHealWrites().map((call) => call[1])).toEqual([{ autoHealEnabled: false }]);
			const write = mocks.update.mock.invocationCallOrder[mocks.update.mock.calls.findIndex((call) => "autoHealEnabled" in (call[1] as object))]!;
			expect(mocks.resetConfigsToDefault.mock.invocationCallOrder[0]!).toBeLessThan(write);
			expect(write).toBeLessThan(mocks.rebuildDestroyedHomebase.mock.invocationCallOrder[0]!);
			expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${done} ${REBUILT} ${c.autoHealOffDone}` }));
		});
	}

	it("Keep auto heal on writes nothing about it", async () => {
		await submitModal(choose("channels", OWNER, "on"));
		expect(autoHealWrites()).toEqual([]);
	});

	it("a choice modal from an older build, with no auto heal select, leaves auto heal as it was", async () => {
		await submitModal(submit("self_destruct:choose", { choice: "channels" }));
		expect(autoHealWrites()).toEqual([]);
	});

	it("names the failure when auto heal could not be turned off", async () => {
		mocks.update.mockImplementation(async (_id: string, payload: Record<string, unknown>) => {
			if ("autoHealEnabled" in payload) throw new Error("write failed");
		});
		const interaction = choose("channels", OWNER, "off");
		await submitModal(interaction);

		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.channelsDone} ${REBUILT} ${c.autoHealOffFailed}` }));
	});

	it("Arcade only ignores the pick", async () => {
		await submitModal(choose("arcade", OWNER, "off"));
		expect(autoHealWrites()).toEqual([]);
	});
});

describe("the rebuild after a teardown, when it does not stand", () => {
	// Dero can lose Manage Channels or a write can fail between the teardown and the
	// rebuild. The flag then stays, so /setup's rebuild branch is the retry, and the
	// done line says so instead of naming a channel that was not built.
	for (const [label, makeSubmit, done] of [
		["Just delete channels", () => choose("channels"), c.channelsDone],
		["Delete my data", () => confirmWord("CONFIRM"), c.deleteDone],
	] as const) {
		it(`${label}: keeps the flag and names /setup when the rebuild does not stand`, async () => {
			mocks.rebuildDestroyedHomebase.mockResolvedValue(false);
			const interaction = makeSubmit();
			await submitModal(interaction);

			expect(flagCleared()).toBe(false);
			expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${done} ${c.rebuildFailed}` }));
		});

		it(`${label}: keeps the flag and names /setup when the rebuild throws`, async () => {
			mocks.rebuildDestroyedHomebase.mockRejectedValue(new Error("missing access"));
			const interaction = makeSubmit();
			await submitModal(interaction);

			expect(flagCleared()).toBe(false);
			expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${done} ${c.rebuildFailed}` }));
		});
	}
});

describe("Just delete channels, when a step fails", () => {
	it("names the settings when their reset fails, after the channels are already gone", async () => {
		mocks.resetConfigsToDefault.mockRejectedValueOnce(new Error("write failed"));
		const interaction = choose("channels");
		await submitModal(interaction);

		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.deletePartial([c.settingsLabel])} ${REBUILT}` }));
	});

	it("still finishes when clearing the stored ids fails, so the rebuild only rebuilds the old layout", async () => {
		mocks.update.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("write failed"));
		const interaction = choose("channels");
		await submitModal(interaction);

		expect(mocks.resetConfigsToDefault).toHaveBeenCalledWith("g1");
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.channelsDone} ${REBUILT}` }));
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
		// Dero's two voice rooms come off his voice allow list (2026-10 item 257 Phase 2b).
		expect(mocks.revokeDeroVoiceRooms).toHaveBeenCalledWith("g1", ["ch-meetingVoiceChannelId", "ch-arcadeVoiceChannelId"]);
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
		expect(buttonIds(reply)).toEqual(["self_destruct:delete:on"]);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([]);
	});

	it("Type CONFIRM opens the CONFIRM modal for the owner, carrying the auto heal pick", async () => {
		for (const pick of ["on", "off"]) {
			const interaction = press(`self_destruct:delete:${pick}`);
			await clickButton(interaction);
			const modal = (interaction.showModal.mock.calls[0] as unknown as [{ toJSON(): { custom_id: string } }])[0];
			expect(modal.toJSON().custom_id).toBe(`self_destruct:modal:${pick}`);
		}
	});

	it("carries Turn auto heal off from the choice to the Type CONFIRM button", async () => {
		const interaction = choose("data", OWNER, "off");
		await submitModal(interaction);

		expect(buttonIds((interaction.reply.mock.calls[0] as unknown as [Reply])[0])).toEqual(["self_destruct:delete:off"]);
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
		expect(mocks.resetConfigsToDefault.mock.invocationCallOrder[0]!).toBeLessThan(mocks.rebuildDestroyedHomebase.mock.invocationCallOrder[0]!);
		expect(flagCleared()).toBe(true);
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.deleteDone} ${REBUILT}` }));
		expect(auditDetails()).toEqual([c.auditDeleteConfirmed]);
	});

	it("names the records it could not delete", async () => {
		mocks.wipeServerData.mockResolvedValue({ failed: ["luck"] });
		const interaction = confirmWord("CONFIRM");
		await submitModal(interaction);

		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.deletePartial(["luck"])} ${REBUILT}` }));
	});

	it("names the settings when their reset fails, after the records are already gone", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.resetConfigsToDefault.mockRejectedValue(new Error("mongo down"));
		const interaction = confirmWord("CONFIRM");
		await submitModal(interaction);

		expect(mocks.wipeServerData).toHaveBeenCalledWith("g1");
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: `${c.deletePartial([c.settingsLabel])} ${REBUILT}` }));
	});
});
