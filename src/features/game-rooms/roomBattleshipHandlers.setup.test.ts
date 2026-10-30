import { describe, it, expect, vi, beforeEach } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";

// ── Battleship setup: Randomize, and a Submit that means I am ready (2026-10 item 263 R3-1) ──
// Driven through the real Randomize handler, the real turn press and the real turn Submit over an
// in memory row, so the fingerprint a modal carries is checked exactly as a member meets it: a
// captain may Randomize as often as they like and Submit the one they keep, and a modal opened
// before a Randomize locks nothing (risk R14).

const row = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

// Writes a dotted path into the row the way Mongo's $set does.
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let cursor = target;
	for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
	cursor[keys[keys.length - 1]] = structuredClone(value);
}

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(async () => (row.current ? structuredClone(row.current) : null)),
		setSecretField: vi.fn(async (_guildId: string, _roomId: string, path: string, value: unknown) => {
			if (!row.current) return null;
			setPath(row.current, `secret.${path}`, value);
			return structuredClone(row.current);
		}),
		// The conditional sibling (2026-10 item 276): Randomize writes its fleet only while setup
		// runs and the captain is not ready, `$ne` or a plain value, as Mongo matches them. A plain
		// value is compared whole, as Mongo compares an embedded array (Ready matches the fleet
		// it showed, 2026-10 item 280).
		setSecretFieldsIf: vi.fn(async (_guildId: string, _roomId: string, expected: Record<string, unknown>, fields: Record<string, unknown>) => {
			if (!row.current || row.current.status !== "playing") return null;
			const holds = Object.entries(expected).every(([path, wanted]) => {
				const value = path.split(".").reduce<unknown>((at, key) => (at === null || at === undefined ? undefined : (at as Record<string, unknown>)[key]), row.current);
				const notEqual = (wanted as { $ne?: unknown } | null)?.$ne;
				return notEqual === undefined ? isDeepStrictEqual(value, wanted) : value !== notEqual;
			});
			if (!holds) return null;
			for (const [path, value] of Object.entries(fields)) setPath(row.current, `secret.${path}`, value);
			return structuredClone(row.current);
		}),
		updateSecretIf: vi.fn(async () => null),
		setTurnPromptPlayed: vi.fn(async () => null),
	},
}));
vi.mock("./roomTrail.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./roomTrail.js")>()), roomTrail: { postMove: vi.fn() } }));
// The prompt line has its own suite (turnPrompt.test.ts); setup has none to sync anyway.
vi.mock("./turnPrompt.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./turnPrompt.js")>()), syncTurnPrompt: vi.fn(async () => undefined) }));

import { battleshipTurnAdapter, handleFire, handleRandomize, handleReady } from "./roomBattleshipHandlers.js";
import { fleetFingerprint, startMatch, type StoredBattleship } from "./roomBattleship.js";
import { handleTurnSubmit } from "./turnPrompt.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { roomTrail } from "./roomTrail.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const A = "captain-a";
const B = "captain-b";
const client = { channels: { fetch: vi.fn(async () => null) } } as unknown as Client;

function seededRng(seed = 11): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

function seedSetup(): void {
	row.current = {
		roomId: "room-1",
		guildId: "guild-1",
		game: "battleship",
		status: "playing",
		hostId: A,
		playerIds: [A, B],
		channelId: "ch-1",
		moves: [],
		secret: { ...startMatch({ playerIds: [A, B] } as IGameRoom, { [A]: "Captain A", [B]: "Captain B" }, seededRng()), boardMessageId: null },
	};
}

const snapshot = (): IGameRoom => structuredClone(row.current) as unknown as IGameRoom;
const stored = (): StoredBattleship => row.current?.secret as StoredBattleship;

function press(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		user: { id: userId },
		client,
		isMessageComponent: () => true,
		showModal: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

// The custom id of the modal a press opened, which its Submit carries back.
const modalIdOf = (interaction: ButtonInteraction): string => {
	const [modal] = (interaction.showModal as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { toJSON(): { custom_id: string } }).toJSON());
	return modal.custom_id;
};

function submitOf(userId: string, customId: string): ModalSubmitInteraction {
	return {
		id: "submit-1",
		customId,
		guildId: "guild-1",
		user: { id: userId },
		client,
		fields: { getStringSelectValues: () => [], getTextInputValue: () => "" },
		isFromMessage: () => false,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferred: false,
		replied: false,
	} as unknown as ModalSubmitInteraction;
}

const repliedWith = (interaction: ModalSubmitInteraction): string =>
	JSON.stringify([(interaction.reply as unknown as ReturnType<typeof vi.fn>).mock.calls, (interaction.followUp as unknown as ReturnType<typeof vi.fn>).mock.calls]);
const adapterFor = () => battleshipTurnAdapter;

beforeEach(() => {
	vi.clearAllMocks();
	seedSetup();
});

describe("Randomize, then Submit", () => {
	it("locks in the third fleet after three Randomizes, the one the last modal showed", async () => {
		const shown: { modalId: string; ships: string }[] = [];
		for (let round = 0; round < 3; round++) {
			const interaction = press(A);
			await handleRandomize(interaction, snapshot());
			shown.push({ modalId: modalIdOf(interaction), ships: JSON.stringify(stored().players[0].ships) });
		}
		// Three different fleets were shown, each modal carrying its own.
		expect(new Set(shown.map((entry) => entry.modalId)).size).toBe(3);

		const submit = submitOf(A, shown[2].modalId);
		await handleTurnSubmit(submit, adapterFor);

		expect(stored().ready?.[0]).toBe(true);
		expect(JSON.stringify(stored().players[0].ships)).toBe(shown[2].ships);
		expect(shown[2].modalId).toBe(`gameroomModal:turn:room-1:${fleetFingerprint(stored().players[0])}`);
		expect(submit.deferUpdate).toHaveBeenCalledOnce();
	});

	it("locks nothing from a modal opened before a Randomize, answering the way a passed turn does", async () => {
		const setup = press(A);
		await handleFire(setup, snapshot());
		const staleModal = modalIdOf(setup);

		await handleRandomize(press(A), snapshot());
		const submit = submitOf(A, staleModal);
		await handleTurnSubmit(submit, adapterFor);

		expect(stored().ready?.[0]).toBe(false);
		expect(repliedWith(submit)).toContain(gameRoomsCopy.turnPrompt.turnPassed);
	});

	it("leaves the other captain's modal good when one captain randomizes", async () => {
		const theirs = press(B);
		await handleFire(theirs, snapshot());

		await handleRandomize(press(A), snapshot());
		await handleTurnSubmit(submitOf(B, modalIdOf(theirs)), adapterFor);

		expect(stored().ready?.[1]).toBe(true);
	});

	it("still locks in from a Ready on a board posted before the change", async () => {
		const interaction = press(A);
		await handleReady(interaction, snapshot());

		expect(stored().ready?.[0]).toBe(true);
		expect(interaction.deferUpdate).toHaveBeenCalledOnce();
	});
});

// ── Ready is tied to the fleet it showed (2026-10 item 280) ──
// The Submit checks its modal's fingerprint against a read, then locks in. A Randomize from another
// press landing between the two used to be locked in anyway, a fleet the captain never saw, and
// after the setup clock started the battle the Ready posted a stale line and an extra board.
describe("Ready racing a Randomize or the battle's start", () => {
	it("locks nothing when a Randomize re-laid the fleet after the Submit read it", async () => {
		const read = snapshot();
		await handleRandomize(press(A), snapshot());
		const acknowledge = vi.fn().mockResolvedValue(undefined);

		const result = await battleshipTurnAdapter.apply(client, read, A, {}, acknowledge);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed });
		expect(stored().ready?.[0]).toBe(false);
		expect(acknowledge).not.toHaveBeenCalled();
	});

	it("posts no ready line when the setup clock started the battle after the Submit read setup", async () => {
		const read = snapshot();
		(row.current!.secret as StoredBattleship).status = "playing";

		const result = await battleshipTurnAdapter.apply(client, read, A, {}, async () => undefined);

		expect(result).toEqual({ ok: false, reason: gameRoomsCopy.turnPrompt.turnPassed });
		expect(roomTrail.postMove).not.toHaveBeenCalled();
	});
});

// ── a fleet never changes once the battle starts (2026-10 item 276, audit P3) ──
// Randomize reads setup, opens its modal, then writes. The setup clock or the second Ready can
// start the battle in between, and the old unconditional write then re-laid a fleet the first
// shot could already be aimed at.
describe("Randomize racing the battle's start", () => {
	it("writes no fleet when the battle started after the press read setup", async () => {
		const read = snapshot();
		(row.current!.secret as StoredBattleship).status = "playing";
		const before = JSON.stringify(stored().players[0].ships);

		await handleRandomize(press(A), read);

		expect(JSON.stringify(stored().players[0].ships)).toBe(before);
	});

	it("writes no fleet when this captain readied after the press read setup", async () => {
		const read = snapshot();
		(row.current!.secret as StoredBattleship).ready = [true, false];
		const before = JSON.stringify(stored().players[0].ships);

		await handleRandomize(press(A), read);

		expect(JSON.stringify(stored().players[0].ships)).toBe(before);
	});

	it("still lays the fleet again while setup runs, so the guard refuses only a started battle", async () => {
		const before = JSON.stringify(stored().players[0].ships);

		await handleRandomize(press(A), snapshot());

		expect(JSON.stringify(stored().players[0].ships)).not.toBe(before);
	});
});
