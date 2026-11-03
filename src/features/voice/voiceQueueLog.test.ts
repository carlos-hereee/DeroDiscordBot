import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextChannel, type ButtonInteraction, type Guild } from "discord.js";

// ── voiceQueueLog (2026-10 item 267, decision 12) ──
// Every request that waits posts ONE 🗒️admin-log entry with Move up, Move down and Remove;
// the buttons re-check the owner or an admin on every press, reorder or remove, and redraw;
// a press on a request that stopped waiting is a state notice.

const mocks = vi.hoisted(() => ({
	write: vi.fn(),
	gate: vi.fn(),
	showNotice: vi.fn(async () => undefined),
}));

vi.mock("./voiceSessions.js", () => ({ voiceSessions: { get: vi.fn(() => null) } }));
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => ({ adminRoleId: "role-admin" })) } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn() }));
vi.mock("@features/setup/adminLog.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@features/setup/adminLog.js")>();
	return { ...actual, adminLog: { write: mocks.write }, resolveAdminLogAuthor: vi.fn(async () => null) };
});
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gate }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));

import { createVoiceQueue } from "./voiceQueue.js";
import { createQueueChangeListener, handleQueueLogButton, _resetQueueLog } from "./voiceQueueLog.js";
import { voiceCopy } from "./voiceCopy.js";
import { DEFAULT_VOICE_PRIORITY_ORDER } from "./voicePriority.js";

const ORDER = [...DEFAULT_VOICE_PRIORITY_ORDER];

function logChannel() {
	const channel = Object.create(TextChannel.prototype) as TextChannel;
	const edit = vi.fn(async () => undefined);
	Object.assign(channel, { id: "log-ch", messages: { edit } });
	return { channel, edit };
}

function setup() {
	const { channel, edit } = logChannel();
	const client = { channels: { fetch: vi.fn(async () => channel) } };
	const guild = { id: "g1", client } as unknown as Guild;
	const queue = createVoiceQueue({ now: () => 1_000, sessionChannelId: () => "vc-busy", loadOrder: async () => ORDER });
	queue.onChange(createQueueChangeListener(queue));
	let posted = 0;
	mocks.write.mockImplementation(async () => ({ persisted: true, posted: true, message: { channelId: "log-ch", messageId: `entry-${++posted}` } }));
	const add = (requesterId: string) => queue.enqueue({ guild, requesterId, channelId: `vc-${requesterId}`, controlChannelId: "card-ch", category: "other" }, ORDER);
	const idOf = (requesterId: string) => queue.list("g1", ORDER).find((request) => request.requesterId === requesterId)?.id ?? "";
	return { queue, add, idOf, edit };
}

function press(customId: string) {
	const deferUpdate = vi.fn(async () => undefined);
	const interaction = { customId, guildId: "g1", guild: { id: "g1" }, user: { id: "admin" }, isMessageComponent: () => true, deferUpdate } as unknown as ButtonInteraction;
	return { interaction, deferUpdate };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	_resetQueueLog();
	mocks.write.mockReset();
	mocks.gate.mockReset().mockResolvedValue(true);
	mocks.showNotice.mockClear();
});

describe("the voice queue's admin log entries", () => {
	it("posts one voice.queue entry per waiting request, naming it, with Move up, Move down and Remove", async () => {
		const { add } = setup();
		add("host");
		await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
		const entry = mocks.write.mock.calls[0][0];
		expect(entry).toMatchObject({ kind: "voice.queue", actor: { userId: "host" }, payload: { detail: voiceCopy.queueAdmin.waiting("host", "vc-host", 1, 1) } });
		const labels = entry.components[0].components.map((button: { data: { label?: string } }) => button.data.label);
		expect(labels).toEqual([voiceCopy.queueAdmin.moveUpLabel, voiceCopy.queueAdmin.moveDownLabel, voiceCopy.queueAdmin.removeLabel]);
	});

	it("moves a request up for an admin and redraws the entries at their new places", async () => {
		const { add, idOf, queue, edit } = setup();
		add("a");
		add("b");
		await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
		const { interaction, deferUpdate } = press(`voicequeue:up:${idOf("b")}`);
		await handleQueueLogButton(interaction, queue);
		expect(deferUpdate).toHaveBeenCalled();
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["b", "a"]);
		const details = edit.mock.calls.map((call) => (call as unknown as [string, { embeds: Array<{ data: { fields?: Array<{ value: string }> } }> }])[1].embeds[0].data.fields?.at(-1)?.value);
		expect(details).toContain(voiceCopy.queueAdmin.waiting("b", "vc-b", 1, 2));
	});

	it("moves a request down and removes one for an admin, closing its entry", async () => {
		const { add, idOf, queue, edit } = setup();
		add("a");
		add("b");
		await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
		await handleQueueLogButton(press(`voicequeue:down:${idOf("a")}`).interaction, queue);
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["b", "a"]);
		const removedId = idOf("a");
		await handleQueueLogButton(press(`voicequeue:remove:${removedId}`).interaction, queue);
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["b"]);
		const closing = edit.mock.calls.find((call) => (call as unknown as [string, { components: unknown[] }])[1].components.length === 0);
		expect(closing).toBeDefined();
	});

	it("refuses anyone but the owner or an admin, and changes nothing", async () => {
		const { add, idOf, queue } = setup();
		add("a");
		add("b");
		mocks.gate.mockResolvedValue(false);
		const { interaction, deferUpdate } = press(`voicequeue:up:${idOf("b")}`);
		await handleQueueLogButton(interaction, queue);
		expect(mocks.showNotice).toHaveBeenCalledWith(interaction, expect.objectContaining({ sections: [voiceCopy.queueAdmin.adminOnly] }));
		expect(deferUpdate).not.toHaveBeenCalled();
		expect(queue.list("g1", ORDER).map((request) => request.requesterId)).toEqual(["a", "b"]);
	});

	it("answers a press on a request that stopped waiting with a state notice", async () => {
		const { add, idOf, queue } = setup();
		add("a");
		const id = idOf("a");
		queue.remove("g1", id);
		await settle();
		const { interaction } = press(`voicequeue:remove:${id}`);
		await handleQueueLogButton(interaction, queue);
		expect(mocks.showNotice).toHaveBeenCalledWith(interaction, expect.objectContaining({ sections: [voiceCopy.queueAdmin.gone] }));
	});
});
