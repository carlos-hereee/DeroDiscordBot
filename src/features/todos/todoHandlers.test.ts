import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { ITodo } from "@db/models/Todo.js";

// My todos at its limits (2026-11 item 420, L13): twenty full todos, each linking to its card,
// and the "more" line fit one description with every link whole.

const m = vi.hoisted(() => ({ todos: [] as ITodo[], total: 0 }));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: async () => null } }));
vi.mock("@db/stores/todoStore.js", () => ({ todoStore: { listOpenForAssignee: async () => m.todos, countOpenForAssignee: async () => m.total } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: () => undefined, registerModal: () => undefined }));
vi.mock("./todoActions.js", () => ({}));

const { replyMyTodos } = await import("./todoHandlers.js");

const CARD_ID = (index: number): string => `13000000000000000${String(index).padStart(2, "0")}`;
const todo = (index: number, text: string): ITodo => ({
	todoId: `todo${index}`,
	guildId: "1200000000000000001",
	text,
	createdBy: "u1",
	assigneeId: "u1",
	dueAt: new Date("2026-12-24T18:00:00.000Z"),
	status: "open",
	doneAt: null,
	doneBy: null,
	meetingId: null,
	actionItemIndex: null,
	channelId: "1250000000000000001",
	messageId: CARD_ID(index),
});

async function listed(): Promise<string> {
	const reply = vi.fn(async (_payload: { embeds: Array<{ data: { description?: string } }> }) => undefined);
	const interaction = { guildId: "1200000000000000001", user: { id: "u1" }, inCachedGuild: () => false, guild: null, reply };
	await replyMyTodos(interaction as unknown as ButtonInteraction);
	return reply.mock.calls[0][0].embeds[0].data.description ?? "";
}

beforeEach(() => {
	Object.assign(m, { todos: [], total: 0 });
});

describe("replyMyTodos", () => {
	it("L13: 20 todos of 300 characters and the more line build, with every link whole", async () => {
		m.todos = Array.from({ length: BOT_CONSTANTS.TODOS.MINE_LIST_MAX }, (_unused, index) => todo(index, "x".repeat(BOT_CONSTANTS.TODOS.TEXT_MAX)));
		m.total = 500;
		const description = await listed();
		expect(description.length).toBeLessThanOrEqual(4096);
		for (const each of m.todos) expect(description).toContain(`](https://discord.com/channels/1200000000000000001/1250000000000000001/${each.messageId})`);
		expect(description.match(/due <t:\d+:R>/g)).toHaveLength(20);
		expect(description).toContain("And 480 more in");
	});

	it("shows short todos whole, and the empty line for none", async () => {
		expect(await listed()).toBe("You hold no open todos in this server.");
		Object.assign(m, { todos: [todo(1, "Sharpen the swords")], total: 1 });
		expect(await listed()).toContain("[Sharpen the swords](");
	});
});
