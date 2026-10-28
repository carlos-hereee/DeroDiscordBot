import { describe, it, expect, vi, beforeEach } from "vitest";
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
