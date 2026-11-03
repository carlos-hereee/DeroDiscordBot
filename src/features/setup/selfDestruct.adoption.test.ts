import { describe, it, expect, vi, beforeEach } from "vitest";
import { CategoryChannel, type ModalSubmitInteraction } from "discord.js";

// ── selfDestruct, adopted channels (2026-10 item 247 Phase 2) ──────────────
// /self-destruct removes what Dero BUILT. A welcome or rules channel the server
// already had, and Dero only adopted, is the owner's: it must survive the
// demolition parent-less, with its permissions untouched, and the stored row must
// let go of it in the same write that sets homebaseDestroyed. selfDestruct.test.ts
// keeps the completeness guard; this file drives the teardown itself, through the
// CONFIRM modal behind Delete my data (2026-10 item 254).

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	update: vi.fn(),
	registerButton: vi.fn(),
	registerModal: vi.fn(),
	wipeServerData: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: mocks.update } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: mocks.registerButton, registerModal: mocks.registerModal }));
vi.mock("./serverReset.js", () => ({ resetConfigsToDefault: vi.fn(), wipeServerData: mocks.wipeServerData }));
// The rebuild that follows the teardown has its own tests; here it only has to stand.
vi.mock("./GuildSetupManager.js", () => ({ GuildSetupManager: { rebuildDestroyedHomebase: vi.fn(async () => true) } }));
vi.mock("./adminLog.js", () => ({ adminLog: { emit: vi.fn() } }));

import { HOMEBASE_CHANNEL_FIELDS, registerSelfDestructHandlers } from "./selfDestruct.js";

const OWNER = "owner-1";
const ADOPTED = "ch-own-welcome";

type Deletable = { id: string; delete: ReturnType<typeof vi.fn> };

function rig() {
	const stored: Record<string, unknown> = Object.fromEntries(HOMEBASE_CHANNEL_FIELDS.map((field) => [field, `ch-${field}`]));
	stored.welcomeChannelId = ADOPTED;
	stored.categoryId = "cat-home";
	stored.gamesCategoryId = "cat-games";
	stored.adoptedChannelIds = [ADOPTED];

	const channel = (id: string): Deletable => ({ id, delete: vi.fn(async () => undefined) });
	const channels = new Map<string, unknown>(HOMEBASE_CHANNEL_FIELDS.map((field) => [`ch-${field}`, channel(`ch-${field}`)]));
	const overwrites = { set: vi.fn(), edit: vi.fn(), create: vi.fn(), delete: vi.fn() };
	const adopted = { ...channel(ADOPTED), permissionOverwrites: overwrites };
	channels.set(ADOPTED, adopted);

	// A live match room under the arcade: untracked on the row, still demolished.
	const room = channel("ch-room");
	const category = (id: string, children: Deletable[]): CategoryChannel & { delete: ReturnType<typeof vi.fn> } => {
		const made = Object.create(CategoryChannel.prototype) as CategoryChannel & { delete: ReturnType<typeof vi.fn> };
		Object.defineProperty(made, "id", { value: id });
		Object.defineProperty(made, "children", { value: { cache: new Map(children.map((child) => [child.id, child])) } });
		Object.defineProperty(made, "delete", { value: vi.fn(async () => undefined) });
		return made;
	};
	const home = category("cat-home", [adopted]);
	const games = category("cat-games", [room]);
	channels.set("cat-home", home);
	channels.set("cat-games", games);

	const guild = { id: "g1", ownerId: OWNER, channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } };
	const interaction = {
		customId: "self_destruct:modal",
		user: { id: OWNER },
		guild,
		client: {},
		fields: { getTextInputValue: () => "CONFIRM" },
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	} as unknown as ModalSubmitInteraction;

	return { stored, channels, adopted, overwrites, room, home, games, interaction };
}

async function confirm(interaction: ModalSubmitInteraction): Promise<void> {
	registerSelfDestructHandlers();
	const handler = mocks.registerModal.mock.calls.at(-1)![1] as (submit: ModalSubmitInteraction) => Promise<void>;
	await handler(interaction);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	mocks.update.mockResolvedValue(undefined);
	mocks.wipeServerData.mockResolvedValue({ failed: [] });
});

describe("self-destruct with an adopted channel", () => {
	it("keeps the adopted channel, with its permissions untouched, and deletes every channel Dero built", async () => {
		const { stored, channels, adopted, overwrites, interaction } = rig();
		mocks.findByGuildId.mockResolvedValue(stored);

		await confirm(interaction);

		expect(adopted.delete).not.toHaveBeenCalled();
		for (const fn of Object.values(overwrites)) expect(fn).not.toHaveBeenCalled();
		for (const field of HOMEBASE_CHANNEL_FIELDS) {
			if (field === "welcomeChannelId") continue;
			expect((channels.get(`ch-${field}`) as Deletable).delete, `${field} was not demolished`).toHaveBeenCalledOnce();
		}
	});

	it("skips the adopted channel in the category sweep, so it outlives the category parent-less", async () => {
		const { stored, adopted, room, home, games, interaction } = rig();
		mocks.findByGuildId.mockResolvedValue(stored);

		await confirm(interaction);

		expect(home.delete).toHaveBeenCalledOnce();
		expect(games.delete).toHaveBeenCalledOnce();
		expect(room.delete).toHaveBeenCalledOnce();
		expect(adopted.delete).not.toHaveBeenCalled();
	});

	it("releases the adopted slot and empties the list in the same write as the flag, before any delete", async () => {
		// The flag write comes first; the second write, after the deletes, clears every stored id,
		// and the third clears the flag once the rebuild stood.
		// The adopted slot is released in the first so nothing points at the kept channel mid teardown.
		const { stored, channels, interaction } = rig();
		mocks.findByGuildId.mockResolvedValue(stored);

		await confirm(interaction);

		expect(mocks.update).toHaveBeenCalledTimes(3);
		expect(mocks.update.mock.calls[0]).toEqual(["g1", { homebaseDestroyed: true, setupComplete: false, welcomeChannelId: null, adoptedChannelIds: [] }]);
		const writeOrder = mocks.update.mock.invocationCallOrder[0]!;
		const firstDelete = (channels.get("ch-introChannelId") as Deletable).delete.mock.invocationCallOrder[0]!;
		expect(writeOrder).toBeLessThan(firstDelete);
	});

	it("leaves a guild that adopted nothing exactly as before: every slot demolished, no slot released", async () => {
		const { stored, adopted, interaction } = rig();
		mocks.findByGuildId.mockResolvedValue({ ...stored, adoptedChannelIds: [] });

		await confirm(interaction);

		expect(mocks.update).toHaveBeenCalledWith("g1", { homebaseDestroyed: true, setupComplete: false, adoptedChannelIds: [] });
		expect(adopted.delete).toHaveBeenCalled();
	});
});
