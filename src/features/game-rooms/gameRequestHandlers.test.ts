import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import type { IGameRequest } from "@db/models/GameRequest.js";

// The guild's row carries the admin role the gate reads; the ballot rules are mocked so
// this file pins only what the handlers own: who sees Remove, who may use it, and what
// each action redraws. gameRequests.test.ts pins the rules themselves.
vi.mock("@db/stores/guildConfigStore.js", () => ({
	guildConfigStore: { findByGuildId: vi.fn(async () => ({ guildId: "guild-1", adminRoleId: "role-admin" })) },
}));
vi.mock("./gameRequests.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./gameRequests.js")>()),
	listGameRequests: vi.fn(),
	addGameRequest: vi.fn(),
	toggleGameRequestVote: vi.fn(),
	removeGameRequest: vi.fn(),
}));

import { buildBallotView, registerGameRequestHandlers } from "./gameRequestHandlers.js";
import { dispatchButton, dispatchSelectMenu } from "@handlers/interactionRegistry.js";
import { listGameRequests, removeGameRequest, toggleGameRequestVote, GAME_REQUEST_POOL_CAP } from "./gameRequests.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const listMock = listGameRequests as unknown as ReturnType<typeof vi.fn>;
const removeMock = removeGameRequest as unknown as ReturnType<typeof vi.fn>;
const toggleMock = toggleGameRequestVote as unknown as ReturnType<typeof vi.fn>;
const copy = rokCommanderCopy.gameRequests;

const GUILD = "guild-1";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const MEMBER = "member-1";

function request(name: string, voterIds: string[], second: number): IGameRequest {
	return { guildId: GUILD, nameKey: name.toLowerCase(), name, addedBy: "someone", voterIds, createdAt: new Date(Date.UTC(2026, 9, 23, 0, 0, second)) };
}
const POOL = [request("Chess", ["a", "b", MEMBER], 1), request("Darts", ["a"], 2)];

// The guild a gate check resolves the clicker against: the owner, one member holding
// the admin role, and one member without it.
function makeGuild() {
	const roles = (ids: string[]) => ({ roles: { cache: new Set(ids) } });
	const members = new Map([
		[ADMIN, roles(["role-admin"])],
		[MEMBER, roles([])],
	]);
	return { id: GUILD, ownerId: OWNER, members: { cache: members, fetch: vi.fn(async (id: string) => members.get(id) ?? null) } };
}

function makeInteraction(customId: string, userId: string, values: string[] = []) {
	return {
		customId,
		values,
		guildId: GUILD,
		guild: makeGuild(),
		user: { id: userId },
		reply: vi.fn(async () => undefined),
		update: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
	};
}

type DrawnView = { content?: string; components: Array<{ toJSON(): { components: Array<{ custom_id?: string; disabled?: boolean }> } }> };
const customIdsOf = (view: DrawnView) => view.components.flatMap((row) => row.toJSON().components.map((component) => component.custom_id));

beforeAll(() => {
	// The real registry, so every press below goes through the same prefix dispatch
	// main.ts uses. Registered once: the registry refuses a second registration.
	registerGameRequestHandlers();
});

// The modals a press opened, and the text of its notice: a refusal or a short answer now
// opens a notice modal instead of a private reply (2026-10 item 254 Phase 5b).
const shownModals = (interaction: { showModal: unknown }) =>
	(interaction.showModal as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string; components: { content?: string }[] } }).toJSON());
const noticeText = (interaction: { showModal: unknown }): string =>
	shownModals(interaction)
		.filter((modal) => modal.custom_id.startsWith("notice:"))
		.flatMap((modal) => modal.components.map((component) => component.content ?? ""))
		.join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	listMock.mockResolvedValue(POOL);
});

describe("buildBallotView", () => {
	it("lists the pool in the order given with each vote count, marking the viewer's own votes", () => {
		const view = buildBallotView(POOL, MEMBER, false, copy);
		const description = (view.embeds[0].data.description ?? "").split("\n");
		expect(description).toContain(copy.row(1, "Chess", 3, true));
		expect(description).toContain(copy.row(2, "Darts", 1, false));
		expect(description.indexOf(copy.row(1, "Chess", 3, true))).toBeLessThan(description.indexOf(copy.row(2, "Darts", 1, false)));
	});

	it("shows Remove only to a viewer who passed the gate", () => {
		expect(customIdsOf(buildBallotView(POOL, MEMBER, false, copy))).toEqual(["game_request:vote", "game_request:add"]);
		expect(customIdsOf(buildBallotView(POOL, ADMIN, true, copy))).toEqual(["game_request:vote", "game_request:remove", "game_request:add"]);
	});

	it("offers only Add a game on an empty ballot", () => {
		const view = buildBallotView([], MEMBER, true, copy);
		expect(customIdsOf(view)).toEqual(["game_request:add"]);
		expect(view.embeds[0].data.description).toContain(copy.empty);
	});

	it("disables Add a game at the cap and says why", () => {
		const full = Array.from({ length: GAME_REQUEST_POOL_CAP }, (_, index) => request(`Game ${index}`, [], index));
		const view = buildBallotView(full, MEMBER, false, copy);
		const add = view.components.at(-1)?.toJSON().components[0];
		expect(add?.disabled).toBe(true);
		expect(view.embeds[0].data.description).toContain(copy.full(GAME_REQUEST_POOL_CAP));
	});
});

describe("the ballot button", () => {
	it("opens the ballot privately, without Remove, for a member", async () => {
		const interaction = makeInteraction("game_request:open", MEMBER);
		await dispatchButton(interaction as unknown as ButtonInteraction);

		const sent = interaction.reply.mock.calls[0][0] as DrawnView & { flags?: number };
		expect(sent.flags).toBeDefined();
		expect(customIdsOf(sent)).not.toContain("game_request:remove");
	});

	it("opens the ballot with Remove for an admin and for the owner", async () => {
		for (const userId of [ADMIN, OWNER]) {
			const interaction = makeInteraction("game_request:open", userId);
			await dispatchButton(interaction as unknown as ButtonInteraction);
			expect(customIdsOf(interaction.reply.mock.calls[0][0] as DrawnView), userId).toContain("game_request:remove");
		}
	});

	it("opens the Add a game modal with the name limits on its one field", async () => {
		const interaction = makeInteraction("game_request:add", MEMBER);
		await dispatchButton(interaction as unknown as ButtonInteraction);

		const modal = (interaction.showModal.mock.calls[0][0] as { toJSON(): { custom_id: string; components: Array<{ components: Array<{ min_length?: number; max_length?: number }> }> } }).toJSON();
		expect(modal.custom_id).toBe("game_request:add");
		expect(modal.components[0].components[0]).toMatchObject({ min_length: 2, max_length: 40 });
	});
});

describe("the Remove select", () => {
	it("lets an admin strike a game and redraws the ballot", async () => {
		removeMock.mockResolvedValue(POOL[1]);
		const interaction = makeInteraction("game_request:remove", ADMIN, ["darts"]);

		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(removeMock).toHaveBeenCalledWith(GUILD, "darts");
		expect((interaction.update.mock.calls[0][0] as DrawnView).content).toBe(copy.removed("Darts"));
	});

	it("lets the server owner strike a game without holding the admin role", async () => {
		removeMock.mockResolvedValue(POOL[1]);
		const interaction = makeInteraction("game_request:remove", OWNER, ["darts"]);

		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(removeMock).toHaveBeenCalledWith(GUILD, "darts");
	});

	it("refuses a member who replays the Remove select, and removes nothing", async () => {
		// The select is never drawn for a member, but a customId and its values can be
		// replayed by anyone, so the handler gate is the one that counts.
		const interaction = makeInteraction("game_request:remove", MEMBER, ["darts"]);

		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(removeMock).not.toHaveBeenCalled();
		expect(interaction.update).not.toHaveBeenCalled();
		expect(noticeText(interaction)).toBe(copy.adminOnly);
	});
});

describe("the vote select", () => {
	it("toggles the clicker's vote and redraws the ballot with what happened", async () => {
		toggleMock.mockResolvedValue({ ok: true, voted: false, request: POOL[0] });
		const interaction = makeInteraction("game_request:vote", MEMBER, ["chess"]);

		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect(toggleMock).toHaveBeenCalledWith(GUILD, "chess", MEMBER);
		expect((interaction.update.mock.calls[0][0] as DrawnView).content).toBe(copy.unvoted("Chess"));
	});

	it("says so when the game was struck before the pick landed", async () => {
		toggleMock.mockResolvedValue({ ok: false, reason: "notFound" });
		const interaction = makeInteraction("game_request:vote", MEMBER, ["chess"]);

		await dispatchSelectMenu(interaction as unknown as StringSelectMenuInteraction);

		expect((interaction.update.mock.calls[0][0] as DrawnView).content).toBe(copy.notFound);
	});
});
