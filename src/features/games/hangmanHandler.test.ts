import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TextChannel as TextChannelClass, type ButtonInteraction, type ChatInputCommandInteraction, type TextChannel } from "discord.js";

// ── hangmanHandler ─────────────────────────────────────────────────────────
// hangmanState already pins every rule exhaustively. What only a handler test
// can reach is the Discord shape: one round per channel claimed synchronously,
// the modal opened as the FIRST response to its click (a modal cannot be
// deferred), a board that redraws only on a real turn, and a round that never
// leaks its map entry.

// Fixed word so the board and the win path are deterministic.
vi.mock("./hangmanWords.js", () => ({
	HANGMAN_WORDS: ["castle"],
	pickWord: () => ({ word: "castle", hint: "Stone fortress where the king lives", category: "realm" }),
}));

// Every board edit waits on a REAL hangman card render (2026-10 item 243 Phase 3),
// and the PNG encode finishes on the native thread pool, not in a microtask. The
// renderer stays real; this only records each render in flight so flush() below
// can wait for it instead of guessing a number of ticks.
const renders = vi.hoisted(() => ({ inFlight: new Set<Promise<unknown>>(), fail: false }));
vi.mock("./hangmanRenderer.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./hangmanRenderer.js")>();
	return {
		...real,
		renderHangmanCard: (view: Parameters<typeof real.renderHangmanCard>[0]) => {
			// `fail` stands in for a host where the card does not draw.
			const render = renders.fail ? Promise.resolve(null) : real.renderHangmanCard(view);
			renders.inFlight.add(render);
			void render.finally(() => renders.inFlight.delete(render));
			return render;
		},
	};
});

import { startHangmanRound, runHangman, _clearHangmanRounds, _activeHangmanRoundCount } from "./hangmanHandler.js";
import { gamesCopy } from "./gamesCopy.js";

interface Board {
	edit: ReturnType<typeof vi.fn>;
	collect: (click: unknown) => void;
	end: () => void;
	stopped: () => boolean;
	collectorOptions: () => Record<string, unknown> | undefined;
}

function fakeChannel(id: string, opts: { failSend?: boolean } = {}): { channel: TextChannel; send: ReturnType<typeof vi.fn>; board: () => Board } {
	let collectHandler: ((click: unknown) => void) | undefined;
	let endHandler: (() => void) | undefined;
	let stopped = false;
	let collectorOptions: Record<string, unknown> | undefined;
	const edit = vi.fn(async () => undefined);

	const message = {
		id: `${id}-board`,
		edit,
		createMessageComponentCollector: (options: Record<string, unknown>) => {
			collectorOptions = options;
			const collector = {
				on(event: string, callback: (arg?: unknown) => void) {
					if (event === "collect") collectHandler = callback as (click: unknown) => void;
					else endHandler = callback as () => void;
					return collector;
				},
				stop() {
					stopped = true;
					endHandler?.();
				},
			};
			return collector;
		},
	};

	const send = vi.fn(async () => {
		if (opts.failSend) throw new Error("missing permissions");
		return message;
	});

	return {
		channel: { id, send } as unknown as TextChannel,
		send,
		board: () => ({
			edit,
			collect: (click: unknown) => collectHandler?.(click),
			end: () => endHandler?.(),
			stopped: () => stopped,
			collectorOptions: () => collectorOptions,
		}),
	};
}

// A click that opens the modal and then resolves with the given letter. `letter`
// of null models a member closing the modal without submitting.
function fakeClick(letter: string | null, userId = "guesser-1"): ButtonInteraction & { showModal: ReturnType<typeof vi.fn> } {
	const showModal = vi.fn(async () => undefined);
	const click = {
		id: `click-${Math.floor(performance.now() * 1000)}`,
		user: { id: userId },
		showModal,
		deferReply: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		awaitModalSubmit: vi.fn(async () =>
			letter === null
				? Promise.reject(new Error("timed out"))
				: {
						user: { id: userId },
						fields: { getTextInputValue: () => letter },
						reply: vi.fn(async () => undefined),
					}
		),
	};
	return click as unknown as ButtonInteraction & { showModal: ReturnType<typeof vi.fn> };
}

// Drains the microtasks, then waits out any card render they started, and repeats
// until a pass starts none: a guess reaches its render only after the modal
// submit's own microtasks, and the board edit only after the render.
const MAX_FLUSH_PASSES = 10;
const flush = async (): Promise<void> => {
	for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
		for (let i = 0; i < 8; i++) await Promise.resolve();
		if (renders.inFlight.size === 0) return;
		await Promise.allSettled([...renders.inFlight]);
	}
};

beforeEach(() => {
	_clearHangmanRounds();
	renders.fail = false;
});

afterEach(() => {
	_clearHangmanRounds();
});

describe("the board's picture (2026-10 item 243)", () => {
	type Posted = { embeds: { data: { image?: { url: string } } }[]; files: { name: string }[] };

	it("carries the hangman card, and points the embed's image at it", async () => {
		const c = fakeChannel("chan-card");
		await startHangmanRound(c.channel, "starter-1");
		const payload = c.send.mock.calls[0][0] as Posted;
		expect(payload.files[0].name).toMatch(/^hangman-[0-9a-f]{12}\.png$/);
		expect(payload.embeds[0].data.image?.url).toBe(`attachment://${payload.files[0].name}`);
	});

	it("falls back to the gallows art, under the same embed, when the card does not draw", async () => {
		renders.fail = true;
		const c = fakeChannel("chan-art");
		await startHangmanRound(c.channel, "starter-1");
		const payload = c.send.mock.calls[0][0] as Posted;
		expect(payload.files).toHaveLength(1);
		expect(payload.files[0].name).not.toMatch(/^hangman-/);
		expect(payload.embeds[0].data.image?.url).toBe(`attachment://${payload.files[0].name}`);
	});
});

describe("startHangmanRound", () => {
	it("posts a public board with a guess button and its gallows art", async () => {
		const c = fakeChannel("chan-1");
		expect(await startHangmanRound(c.channel, "starter-1")).toBe("started");

		const payload = c.send.mock.calls[0][0] as { embeds: unknown[]; components: unknown[]; files: unknown[] };
		expect(payload.embeds).toHaveLength(1);
		expect(payload.components).toHaveLength(1);
		expect(payload.files).toHaveLength(1);
		expect(_activeHangmanRoundCount()).toBe(1);
	});

	it("allows only ONE round per channel", async () => {
		const c = fakeChannel("chan-2");
		expect(await startHangmanRound(c.channel, "starter-1")).toBe("started");
		expect(await startHangmanRound(c.channel, "starter-2")).toBe("alreadyRunning");
		// The rejected start must not have posted a second board.
		expect(c.send).toHaveBeenCalledTimes(1);
	});

	it("claims the channel slot synchronously, so two racing starts cannot both open a board", async () => {
		// The check and the write sit adjacent with no await between them, so a
		// second caller in the same tick already sees the claim.
		const c = fakeChannel("chan-3");
		const [first, second] = await Promise.all([
			startHangmanRound(c.channel, "starter-1"),
			startHangmanRound(c.channel, "starter-2"),
		]);
		expect([first, second].sort()).toEqual(["alreadyRunning", "started"]);
		expect(c.send).toHaveBeenCalledTimes(1);
	});

	it("runs rounds in different channels side by side", async () => {
		expect(await startHangmanRound(fakeChannel("chan-4").channel, "s")).toBe("started");
		expect(await startHangmanRound(fakeChannel("chan-5").channel, "s")).toBe("started");
		expect(_activeHangmanRoundCount()).toBe(2);
	});

	it("releases the slot when the board cannot be posted", async () => {
		// A missing permission must not lock the channel out of hangman for the
		// life of the process.
		const c = fakeChannel("chan-6", { failSend: true });
		expect(await startHangmanRound(c.channel, "starter-1")).toBe("failed");
		expect(_activeHangmanRoundCount()).toBe(0);
		// And a retry is possible immediately.
		const ok = fakeChannel("chan-6");
		expect(await startHangmanRound(ok.channel, "starter-1")).toBe("started");
	});
});

describe("the guess click", () => {
	it("opens the modal as the FIRST response, never after a defer", async () => {
		// A modal cannot be deferred. Any deferReply or deferUpdate before
		// showModal makes Discord reject it, and the guess silently does nothing.
		const c = fakeChannel("chan-7");
		await startHangmanRound(c.channel, "starter-1");
		const click = fakeClick("a");
		c.board().collect(click);
		await flush();

		expect(click.showModal).toHaveBeenCalledTimes(1);
		expect(click.deferReply).not.toHaveBeenCalled();
		expect(click.deferUpdate).not.toHaveBeenCalled();
	});

	it("redraws the board on a real turn", async () => {
		const c = fakeChannel("chan-8");
		await startHangmanRound(c.channel, "starter-1");
		c.board().collect(fakeClick("a"));
		await flush();
		expect(c.board().edit).toHaveBeenCalledTimes(1);
	});

	it("leaves the board untouched for a repeat or an invalid character", async () => {
		// The visible half of "those do not cost an attempt": nothing about the
		// board changes, so the channel sees no phantom turn.
		const c = fakeChannel("chan-9");
		await startHangmanRound(c.channel, "starter-1");

		c.board().collect(fakeClick("a"));
		await flush();
		expect(c.board().edit).toHaveBeenCalledTimes(1);

		c.board().collect(fakeClick("a", "guesser-2"));
		await flush();
		c.board().collect(fakeClick("7", "guesser-3"));
		await flush();
		expect(c.board().edit).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the member closes the modal without submitting", async () => {
		const c = fakeChannel("chan-10");
		await startHangmanRound(c.channel, "starter-1");
		c.board().collect(fakeClick(null));
		await flush();
		expect(c.board().edit).not.toHaveBeenCalled();
		expect(_activeHangmanRoundCount()).toBe(1);
	});
});

describe("ending a round", () => {
	it("ends and cleans up on a win, stripping the guess button", async () => {
		const c = fakeChannel("chan-11");
		await startHangmanRound(c.channel, "starter-1");

		// "castle" solved by its five distinct letters.
		for (const letter of ["c", "a", "s", "t", "l"]) {
			c.board().collect(fakeClick(letter));
			await flush();
		}
		c.board().collect(fakeClick("e"));
		await flush();

		const last = c.board().edit.mock.calls.at(-1)?.[0] as { components: unknown[] };
		expect(last.components).toEqual([]);
		expect(_activeHangmanRoundCount()).toBe(0);
	});

	it("ends and cleans up after six misses", async () => {
		const c = fakeChannel("chan-12");
		await startHangmanRound(c.channel, "starter-1");

		for (const letter of ["z", "q", "x", "j", "v", "w"]) {
			c.board().collect(fakeClick(letter));
			await flush();
		}

		const last = c.board().edit.mock.calls.at(-1)?.[0] as { components: unknown[] };
		expect(last.components).toEqual([]);
		expect(_activeHangmanRoundCount()).toBe(0);
	});

	it("cleans up when Discord ends the collector with nobody finishing", async () => {
		// The collector's end handler is the ONE cleanup path, reached by stop()
		// and by Discord closing the collector (the board deleted) alike.
		const c = fakeChannel("chan-13");
		await startHangmanRound(c.channel, "starter-1");
		expect(_activeHangmanRoundCount()).toBe(1);

		c.board().end();
		await flush();

		expect(_activeHangmanRoundCount()).toBe(0);
		// And it says so on the board rather than leaving a live looking button.
		const last = c.board().edit.mock.calls.at(-1)?.[0] as { components: unknown[] };
		expect(last.components).toEqual([]);
	});

	it("frees the channel for a fresh round once the last one ended", async () => {
		const c = fakeChannel("chan-14");
		await startHangmanRound(c.channel, "starter-1");
		c.board().end();
		await flush();

		const again = fakeChannel("chan-14");
		expect(await startHangmanRound(again.channel, "starter-2")).toBe("started");
	});

	// The owner's decision of 2026-10-23: hangman is not a race, so a round has no
	// clock at all. A `time` or `idle` on the collector would end an unfinished round.
	it("runs the round with no clock, so only a win or a loss ends it", async () => {
		const c = fakeChannel("chan-15");
		await startHangmanRound(c.channel, "starter-1");

		const options = c.board().collectorOptions();
		expect(options).toBeDefined();
		expect(options).not.toHaveProperty("time");
		expect(options).not.toHaveProperty("idle");
	});
});

// A /mini-game slash command typed in the channel the fake stands for. The prototype is
// TextChannel's so the handler's instanceof check passes; the fake's own send is what runs.
function slashCommand(channel: TextChannel, guildId: string | null) {
	Object.setPrototypeOf(channel, TextChannelClass.prototype);
	const command: Record<string, unknown> = {
		id: "cmd-1",
		guildId,
		user: { id: "cool-starter", username: "cool", globalName: "Cool" },
		channel,
		deferred: false,
		replied: false,
		isModalSubmit: () => false,
		isMessageComponent: () => false,
		reply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		showModal: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => {
			command.deferred = true;
		}),
	};
	return command as unknown as ChatInputCommandInteraction & Record<"deferReply" | "showModal", ReturnType<typeof vi.fn>>;
}

type NoticeJson = { title: string; components: Array<{ content?: string }> };
const noticeOf = (command: { showModal: ReturnType<typeof vi.fn> }): NoticeJson => (command.showModal.mock.calls[0]![0] as { toJSON(): NoticeJson }).toJSON();

describe("the slash command's cooldown (2026-10 item 263 R3-12)", () => {
	it("opens the cooldown notice at the command itself, titled for hangman, before any acknowledgement", async () => {
		// Outside a server the answer has no channel to read, so the first start needs no config.
		const started = slashCommand(fakeChannel("chan-cool").channel, null);
		await runHangman(started);
		expect(started.deferReply).toHaveBeenCalledOnce();

		const again = slashCommand(fakeChannel("chan-cool-2").channel, null);
		await runHangman(again);

		const notice = noticeOf(again);
		expect(notice.title).toBe(gamesCopy.notices.hangman);
		expect(notice.components[0]!.content).toBe(gamesCopy.hangman.cooldownMessage(15));
		expect(again.deferReply).not.toHaveBeenCalled();
		expect(_activeHangmanRoundCount()).toBe(1);
	});
});
