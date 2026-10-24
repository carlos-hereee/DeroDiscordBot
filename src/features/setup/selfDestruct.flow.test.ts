import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── selfDestruct, the two tiers (post-launch plan item 10) ──────────────────
// Tier one resets every setting and keeps everything else; tier two deletes only
// after the owner types CONFIRM. Every step is owner only and lands in the admin log.

const mocks = vi.hoisted(() => ({
	registerButton: vi.fn(),
	registerModal: vi.fn(),
	resetConfigsToDefault: vi.fn(),
	wipeServerData: vi.fn(),
	emit: vi.fn(),
	findByGuildId: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerModal: mocks.registerModal }));
vi.mock("./serverReset.js", () => ({ resetConfigsToDefault: mocks.resetConfigsToDefault, wipeServerData: mocks.wipeServerData }));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: mocks.emit } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));

import { buildSelfDestructButton, registerSelfDestructHandlers } from "./selfDestruct.js";
import { setupCopy } from "./setupCopy.js";

const c = setupCopy.selfDestruct;
const OWNER = "owner-1";
const GUILD = { id: "g1", ownerId: OWNER, channels: { fetch: vi.fn(async () => null) } };

type Reply = { embeds?: Array<{ data: { title?: string; description?: string } }>; components?: Array<{ toJSON(): { components: Array<{ custom_id?: string; label?: string }> } }> };

function press(customId: string, userId = OWNER) {
	return {
		customId,
		user: { id: userId },
		guild: GUILD,
		client: {},
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
	};
}

function submit(word: string, userId = OWNER) {
	return {
		customId: "self_destruct:modal",
		user: { id: userId },
		guild: GUILD,
		client: {},
		fields: { getTextInputValue: () => word },
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
}

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

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.resetConfigsToDefault.mockResolvedValue(undefined);
	mocks.wipeServerData.mockResolvedValue({ failed: [] });
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", adoptedChannelIds: [] });
	mocks.update.mockResolvedValue(undefined);
});

describe("the self destruct button", () => {
	it("is labeled Self destruct", () => {
		expect(buildSelfDestructButton().toJSON()).toMatchObject({ label: "Self destruct", custom_id: "self_destruct:prompt" });
	});
});

describe("tier one, reset all configs", () => {
	it("opens a private prompt that says it resets all configs, with Confirm and Cancel", async () => {
		const interaction = press("self_destruct:prompt");
		await clickButton(interaction);

		const reply = (interaction.reply.mock.calls[0] as unknown as [Reply])[0];
		expect(reply.embeds![0]!.data.description).toContain("resets all configs to default");
		expect(buttonIds(reply)).toEqual(["self_destruct:reset", "self_destruct:cancel"]);
		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
	});

	it("refuses anyone but the server owner, and logs the attempt", async () => {
		const interaction = press("self_destruct:reset", "admin-1");
		await clickButton(interaction);

		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([c.auditRefusedNotOwner]);
	});

	it("resets on Confirm, keeps every channel, and then offers Delete server data", async () => {
		const interaction = press("self_destruct:reset");
		await clickButton(interaction);

		expect(mocks.resetConfigsToDefault).toHaveBeenCalledWith("g1");
		expect(GUILD.channels.fetch).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		const done = (interaction.editReply.mock.calls.at(-1) as unknown as [Reply])[0];
		expect(done.embeds![0]!.data.title).toBe(c.resetDoneTitle);
		expect(buttonIds(done)).toEqual(["self_destruct:delete"]);
		expect(auditDetails()).toEqual([c.auditReset]);
	});

	it("reports a failed reset and offers nothing further", async () => {
		mocks.resetConfigsToDefault.mockRejectedValue(new Error("mongo down"));
		const interaction = press("self_destruct:reset");
		await clickButton(interaction);

		const failed = (interaction.editReply.mock.calls.at(-1) as unknown as [Reply])[0];
		expect(buttonIds(failed)).toEqual([]);
		expect(auditDetails()).toEqual([c.auditResetFailed]);
	});

	it("answers the retired one click confirm as a stale control, deleting nothing", async () => {
		const interaction = press("self_destruct:confirm");
		await clickButton(interaction);

		expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: c.staleControl }));
		expect(mocks.resetConfigsToDefault).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

describe("tier two, delete server data", () => {
	it("opens the CONFIRM modal for the owner", async () => {
		const interaction = press("self_destruct:delete");
		await clickButton(interaction);
		expect(interaction.showModal).toHaveBeenCalledOnce();
	});

	it("deletes nothing unless the owner typed CONFIRM exactly", async () => {
		const interaction = submit("confirm");
		await submitModal(interaction);

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
		expect(auditDetails()).toEqual([c.auditDeleteRefused]);
	});

	it("refuses a modal submitted by anyone but the owner, even with the right word", async () => {
		await submitModal(submit("CONFIRM", "admin-1"));

		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.wipeServerData).not.toHaveBeenCalled();
	});

	it("on CONFIRM flags the homebase destroyed before wiping the stored records", async () => {
		const interaction = submit("CONFIRM");
		await submitModal(interaction);

		expect(mocks.update).toHaveBeenCalledWith("g1", expect.objectContaining({ homebaseDestroyed: true }));
		expect(mocks.wipeServerData).toHaveBeenCalledWith("g1");
		expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.wipeServerData.mock.invocationCallOrder[0]!);
		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.deleteDone }));
		expect(auditDetails()).toEqual([c.auditDeleteConfirmed]);
	});

	it("names the records it could not delete", async () => {
		mocks.wipeServerData.mockResolvedValue({ failed: ["luck"] });
		const interaction = submit("CONFIRM");
		await submitModal(interaction);

		expect(interaction.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: c.deletePartial(["luck"]) }));
	});
});
