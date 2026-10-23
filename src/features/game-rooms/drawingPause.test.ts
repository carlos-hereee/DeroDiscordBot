import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AttachmentBuilder } from "discord.js";
import type { RenderPayload } from "@features/renderer/index.js";
import {
	_resetDrawingPauses,
	drawingSettled,
	heldMsSince,
	isClockExpired,
	isDrawing,
	pausedDeadline,
	roomDrawingKey,
	withDrawingPause,
} from "./drawingPause.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

// ── the drawing pause ──────────────────────────────────────────────────────
// What:  the hold every timed or per turn game's clock takes while its board draws
//        (Dero 1.7.0 test fixes, Phase 3a): the status line first, the card or its
//        text fallback after, and the held time added to every deadline.
// Where: risk R8 of the plan is a clock left held by a failed render, so the
//        throwing paths each get a case of their own.

const GAME = roomDrawingKey({ guildId: "g1", roomId: "room-1" });
const BUDGET_MS = 60_000;
const START = Date.UTC(2026, 9, 23, 12, 0, 0);

function card(): RenderPayload {
	return { attachment: new AttachmentBuilder(Buffer.from("png"), { name: "card.png" }), ref: "attachment://card.png" };
}

// A render the test finishes by hand, so it can look at the clock mid draw.
function deferredRender(): { render: () => Promise<RenderPayload | null>; finish: (value: RenderPayload | null) => void; fail: (error: Error) => void } {
	let finish: (value: RenderPayload | null) => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	const pending = new Promise<RenderPayload | null>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	return { render: () => pending, finish, fail };
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
	_resetDrawingPauses();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("withDrawingPause", () => {
	it("shows the status, holds the clock while the card draws, then swaps the card in", async () => {
		const writes: unknown[] = [];
		const draw = deferredRender();
		const drawing = withDrawingPause({
			gameKey: GAME,
			showStatus: async (status) => writes.push({ status }),
			render: draw.render,
			fallback: () => "text board",
			swapIn: async (drawn) => writes.push({ drawn }),
		});
		await settle();

		expect(writes).toEqual([{ status: gameRoomsCopy.drawing.status }]);
		expect(isDrawing(GAME)).toBe(true);

		const drawn = card();
		draw.finish(drawn);
		await drawing;
		expect(writes).toEqual([{ status: gameRoomsCopy.drawing.status }, { drawn }]);
		expect(isDrawing(GAME)).toBe(false);
	});

	it("swaps in the text board and releases the clock when the render throws", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const swapped: unknown[] = [];
		const draw = deferredRender();
		// The clock started at START; the draw starts 50 seconds into it.
		vi.setSystemTime(START + 50_000);
		const drawing = withDrawingPause({
			gameKey: GAME,
			showStatus: async () => undefined,
			render: draw.render,
			fallback: () => "text board",
			swapIn: async (drawn) => swapped.push(drawn),
		});
		await settle();
		vi.setSystemTime(START + BUDGET_MS + 1);
		// Past the budget, but the board is drawing, so the clock is held.
		expect(isClockExpired(GAME, START, BUDGET_MS)).toBe(false);

		draw.fail(new Error("canvas went away"));
		await drawing;

		expect(swapped).toEqual(["text board"]);
		expect(isDrawing(GAME)).toBe(false);
		// The clock resumes with the 10 001 held milliseconds added back, then runs out.
		vi.setSystemTime(START + BUDGET_MS + 10_000);
		expect(isClockExpired(GAME, START, BUDGET_MS)).toBe(false);
		vi.setSystemTime(START + BUDGET_MS + 10_001);
		expect(isClockExpired(GAME, START, BUDGET_MS)).toBe(true);
	});

	it("still releases the clock when the swap itself fails, and says so", async () => {
		await expect(
			withDrawingPause({
				gameKey: GAME,
				showStatus: async () => undefined,
				render: async () => card(),
				fallback: () => null,
				swapIn: async () => {
					throw new Error("Unknown Message");
				},
			})
		).rejects.toThrow("Unknown Message");
		expect(isDrawing(GAME)).toBe(false);
	});

	it("draws on when the status line cannot be posted", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const swapped: unknown[] = [];
		await withDrawingPause({
			gameKey: GAME,
			showStatus: async () => {
				throw new Error("429");
			},
			render: async () => null,
			fallback: () => "text board",
			swapIn: async (drawn) => swapped.push(drawn),
		});
		expect(swapped).toEqual(["text board"]);
	});

	it("lands two draws of one game in the order they were asked for, however their renders finish", async () => {
		const order: string[] = [];
		const first = deferredRender();
		const second = deferredRender();
		const one = withDrawingPause({ gameKey: GAME, showStatus: async () => undefined, render: first.render, fallback: () => null, swapIn: async () => order.push("first") });
		const two = withDrawingPause({ gameKey: GAME, showStatus: async () => undefined, render: second.render, fallback: () => null, swapIn: async () => order.push("second") });
		second.finish(null);
		await settle();
		expect(order).toEqual([]);

		first.finish(null);
		await Promise.all([one, two]);
		expect(order).toEqual(["first", "second"]);
		await expect(drawingSettled(GAME)).resolves.toBeUndefined();
	});
});

describe("the deadline", () => {
	it("is the start plus the budget while nothing has drawn", () => {
		expect(pausedDeadline(GAME, START, BUDGET_MS)).toBe(START + BUDGET_MS);
	});

	it("is extended by exactly the time the board spent drawing", async () => {
		const draw = deferredRender();
		vi.setSystemTime(START + 10_000);
		const drawing = withDrawingPause({ gameKey: GAME, showStatus: async () => undefined, render: draw.render, fallback: () => null, swapIn: async () => undefined });
		vi.setSystemTime(START + 13_500);
		draw.finish(null);
		await drawing;

		expect(heldMsSince(GAME, START)).toBe(3_500);
		expect(pausedDeadline(GAME, START, BUDGET_MS)).toBe(START + BUDGET_MS + 3_500);
		vi.setSystemTime(START + BUDGET_MS + 3_499);
		expect(isClockExpired(GAME, START, BUDGET_MS)).toBe(false);
		vi.setSystemTime(START + BUDGET_MS + 3_500);
		expect(isClockExpired(GAME, START, BUDGET_MS)).toBe(true);
	});

	it("counts only the part of a draw after the clock started", async () => {
		const draw = deferredRender();
		const drawing = withDrawingPause({ gameKey: GAME, showStatus: async () => undefined, render: draw.render, fallback: () => null, swapIn: async () => undefined });
		vi.setSystemTime(START + 2_000);
		draw.finish(null);
		await drawing;

		// A clock that started a second into the draw is held for the other second.
		expect(heldMsSince(GAME, START + 1_000)).toBe(1_000);
		// A clock that started after the draw finished is not held at all.
		expect(heldMsSince(GAME, START + 5_000)).toBe(0);
	});

	it("is never shared between two games", async () => {
		const other = roomDrawingKey({ guildId: "g2", roomId: "room-1" });
		const draw = deferredRender();
		const drawing = withDrawingPause({ gameKey: GAME, showStatus: async () => undefined, render: draw.render, fallback: () => null, swapIn: async () => undefined });
		vi.setSystemTime(START + BUDGET_MS);
		expect(isClockExpired(other, START, BUDGET_MS)).toBe(true);
		draw.finish(null);
		await drawing;
	});
});
