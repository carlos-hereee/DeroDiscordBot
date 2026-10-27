import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

// ── the single choice pickers' routing (2026-10 item 254 Phase 5b) ────────────
// A picker opens as a modal and falls back to its select message, and both must reach
// the one handler that re-gates the pick. A modal submit routed nowhere would answer
// "no longer available" to every opponent, bot count, removal and rock paper scissors.

const mocks = vi.hoisted(() => ({
	modals: new Map<string, (interaction: ModalSubmitInteraction) => Promise<unknown>>(),
	selects: new Map<string, (interaction: StringSelectMenuInteraction) => Promise<unknown>>(),
	handleOpponentSelect: vi.fn(),
	handleBotSelect: vi.fn(),
	handleRemoveSelect: vi.fn(),
	handleRpsSelect: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: vi.fn(),
	registerSelectMenu: vi.fn((prefix: string, handler: (interaction: StringSelectMenuInteraction) => Promise<unknown>) => mocks.selects.set(prefix, handler)),
	registerModal: vi.fn((prefix: string, handler: (interaction: ModalSubmitInteraction) => Promise<unknown>) => mocks.modals.set(prefix, handler)),
}));
vi.mock("./challengeBoard.js", () => ({
	challengeBoard: { handleOpponentSelect: mocks.handleOpponentSelect, handleBotSelect: mocks.handleBotSelect },
}));
vi.mock("./hostControls.js", () => ({ hostControls: { handleRemoveSelect: mocks.handleRemoveSelect } }));
vi.mock("./roomGames.js", () => ({ runRoomMove: vi.fn(), handleRpsSelect: mocks.handleRpsSelect }));
vi.mock("./networkJoin.js", () => ({ registerNetworkHandlers: vi.fn() }));

import { registerGameRoomHandlers } from "./gameRoomHandlers.js";
import { GAME_ROOM_MODAL_PREFIX, GAME_ROOM_SELECT_PREFIX } from "./gameRoomActions.js";

const PICKERS = [
	["opponent", mocks.handleOpponentSelect],
	["bots", mocks.handleBotSelect],
	["kick", mocks.handleRemoveSelect],
	["rps", mocks.handleRpsSelect],
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.modals.clear();
	mocks.selects.clear();
	registerGameRoomHandlers();
});

describe("a picker's modal and its select message reach the same handler", () => {
	it.each(PICKERS)("%s", async (action, handler) => {
		const submit = { customId: `${GAME_ROOM_MODAL_PREFIX}:${action}:room-1` } as ModalSubmitInteraction;
		await mocks.modals.get(GAME_ROOM_MODAL_PREFIX)!(submit);
		expect(handler).toHaveBeenCalledWith(submit);

		const select = { customId: `${GAME_ROOM_SELECT_PREFIX}:${action}:room-1` } as StringSelectMenuInteraction;
		await mocks.selects.get(GAME_ROOM_SELECT_PREFIX)!(select);
		expect(handler).toHaveBeenLastCalledWith(select);
		expect(handler).toHaveBeenCalledTimes(2);
	});
});
