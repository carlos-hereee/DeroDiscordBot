import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, User } from "discord.js";

// ── rpsHandler ─────────────────────────────────────────────────────────────
// The pure modules already pin the race and the scoring exhaustively. What is
// left, and what only a handler test can reach, is the Discord shape: each
// player must get their OWN ephemeral message (the discord.js 14.25 bug this
// codebase already hit), exactly one public reveal must post however the clicks
// land, and the round state must not leak.

const challenge = vi.hoisted(() => ({ issueChallenge: vi.fn() }));
vi.mock("./challengeFlow.js", () => ({ issueChallenge: challenge.issueChallenge }));

import { runRps, RPS_PICK_TIMEOUT_MS, _clearRpsRounds, _activeRpsRoundCount } from "./rpsHandler.js";

const OPPONENT_ID = "222222222222222222";
const GUILD_ID = "910668785856413707";

// The cooldown lives at module scope and is keyed per user, so every test uses a
// fresh challenger rather than reaching into it.
let challengerSeq = 0;
const nextChallengerId = (): string => `1111111111111111${String(challengerSeq++).padStart(2, "0")}`;

interface FakeCollector {
	click: (customId: string) => ButtonInteraction;
	stopped: () => boolean;
}

// A message whose collector we can drive by hand. Records the customId prefix it
// was filtered on so a test can prove the two prompts are scoped to different
// sides.
function fakeMessage(id: string): { message: unknown; collector: () => FakeCollector; components: () => unknown } {
	let onCollect: ((interaction: unknown) => void) | undefined;
	let stopped = false;
	let filter: ((i: { user: { id: string }; customId: string }) => boolean) | undefined;

	const message = {
		id,
		createMessageComponentCollector: (config: { filter: typeof filter }) => {
			filter = config.filter;
			const collector = {
				on(event: string, callback: (arg?: unknown) => void) {
					if (event === "collect") onCollect = callback as (interaction: unknown) => void;
					return collector;
				},
				stop() {
					stopped = true;
				},
			};
			return collector;
		},
	};

	const click = (customId: string): ButtonInteraction => {
		const button = {
			customId,
			user: { id: "unused" },
			update: vi.fn(async () => undefined),
			reply: vi.fn(async () => undefined),
		} as unknown as ButtonInteraction;
		onCollect?.(button);
		return button;
	};

	return {
		message,
		collector: () => ({ click, stopped: () => stopped }),
		components: () => filter,
	};
}

function harness(): {
	interaction: ChatInputCommandInteraction;
	accept: ButtonInteraction;
	challengerId: string;
	opponentPrompt: ReturnType<typeof fakeMessage>;
	challengerPrompt: ReturnType<typeof fakeMessage>;
	acceptReply: ReturnType<typeof vi.fn>;
	followUp: ReturnType<typeof vi.fn>;
} {
	const challengerId = nextChallengerId();
	const opponentPrompt = fakeMessage("opponent-prompt");
	const challengerPrompt = fakeMessage("challenger-prompt");

	const acceptReply = vi.fn(async () => undefined);
	const accept = {
		reply: acceptReply,
		fetchReply: async () => opponentPrompt.message,
		editReply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction;

	const followUp = vi.fn(async () => challengerPrompt.message);
	const interaction = {
		user: { id: challengerId },
		guildId: GUILD_ID,
		options: { getUser: () => ({ id: OPPONENT_ID, bot: false }) as unknown as User },
		reply: vi.fn(async () => undefined),
		followUp,
		webhook: { editMessage: vi.fn(async () => undefined) },
	} as unknown as ChatInputCommandInteraction;

	return { interaction, accept, challengerId, opponentPrompt, challengerPrompt, acceptReply, followUp };
}

function acceptedChallenge(accept: ButtonInteraction, challengeId: string): void {
	challenge.issueChallenge.mockResolvedValue({ status: "accepted", challengeId, accept });
}

const pickId = (challengeId: string, side: string, choice: string): string => `minigame:rps:${challengeId}:${side}:${choice}`;

// The reveal and the timeout notice are followUps carrying embeds; the
// challenger's secret prompt is a followUp carrying components. Separating them
// is how these tests count public messages.
const publicPosts = (followUp: ReturnType<typeof vi.fn>): unknown[] =>
	followUp.mock.calls.map((call) => call[0]).filter((payload) => Boolean((payload as { embeds?: unknown[] }).embeds));

beforeEach(() => {
	_clearRpsRounds();
	challenge.issueChallenge.mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("runRps, the secret prompt delivery", () => {
	it("gives each player their OWN ephemeral message, never one shared", async () => {
		// The load bearing assertion of this phase. CHANGELOG.md records a
		// discord.js 14.25 bug where a select and a button silently dropped input
		// sharing one ephemeral, so the two players' controls must live on
		// different messages: the opponent's on their Accept click, the
		// challenger's on a separate followUp.
		const h = harness();
		acceptedChallenge(h.accept, "round-1");

		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		expect(h.acceptReply).toHaveBeenCalledTimes(1);
		const opponentPayload = h.acceptReply.mock.calls[0][0] as { components: unknown[]; flags: unknown };
		expect(opponentPayload.components).toHaveLength(1);
		expect(opponentPayload.flags).toBeDefined();

		const challengerPayload = h.followUp.mock.calls[0][0] as { components?: unknown[]; flags?: unknown };
		expect(challengerPayload.components).toHaveLength(1);
		expect(challengerPayload.flags).toBeDefined();

		// Two different messages, which is the whole point.
		expect(h.opponentPrompt.message).not.toBe(h.challengerPrompt.message);

		h.challengerPrompt.collector().click(pickId("round-1", "challenger", "rock"));
		h.opponentPrompt.collector().click(pickId("round-1", "opponent", "paper"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;
	});

	it("scopes each collector to its own side, so one player's buttons cannot resolve the other's", async () => {
		const h = harness();
		acceptedChallenge(h.accept, "round-2");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		const opponentFilter = h.opponentPrompt.components() as (i: { user: { id: string }; customId: string }) => boolean;
		expect(opponentFilter({ user: { id: OPPONENT_ID }, customId: pickId("round-2", "opponent", "rock") })).toBe(true);
		// Same round, wrong side.
		expect(opponentFilter({ user: { id: OPPONENT_ID }, customId: pickId("round-2", "challenger", "rock") })).toBe(false);
		// Right side, wrong round: a stale prompt from an earlier match between the
		// same two players must not resolve this one.
		expect(opponentFilter({ user: { id: OPPONENT_ID }, customId: pickId("other", "opponent", "rock") })).toBe(false);
		// Right buttons, wrong person.
		expect(opponentFilter({ user: { id: "999" }, customId: pickId("round-2", "opponent", "rock") })).toBe(false);

		h.challengerPrompt.collector().click(pickId("round-2", "challenger", "rock"));
		h.opponentPrompt.collector().click(pickId("round-2", "opponent", "paper"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;
	});
});

describe("runRps, the reveal", () => {
	it("posts exactly ONE public reveal and cleans up the round", async () => {
		const h = harness();
		acceptedChallenge(h.accept, "round-3");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		expect(_activeRpsRoundCount()).toBe(1);

		h.challengerPrompt.collector().click(pickId("round-3", "challenger", "rock"));
		h.opponentPrompt.collector().click(pickId("round-3", "opponent", "scissors"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		expect(publicPosts(h.followUp)).toHaveLength(1);
		expect(_activeRpsRoundCount()).toBe(0);
	});

	it("reveals once even when both players click in the SAME tick", async () => {
		// The race, driven through the real handler rather than the pure module.
		// Two clicks with no await between them is exactly what Node hands the
		// collectors when two players tap simultaneously.
		const h = harness();
		acceptedChallenge(h.accept, "round-4");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		h.challengerPrompt.collector().click(pickId("round-4", "challenger", "paper"));
		h.opponentPrompt.collector().click(pickId("round-4", "opponent", "paper"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		expect(publicPosts(h.followUp)).toHaveLength(1);
	});

	it("refuses a second throw from the same player without revealing", async () => {
		const h = harness();
		acceptedChallenge(h.accept, "round-5");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		const first = h.challengerPrompt.collector().click(pickId("round-5", "challenger", "rock"));
		await vi.advanceTimersByTimeAsync(0);
		const second = h.challengerPrompt.collector().click(pickId("round-5", "challenger", "scissors"));
		await vi.advanceTimersByTimeAsync(0);

		// The first throw was acknowledged in place; the second got a plain
		// ephemeral refusal and changed nothing.
		expect(first.update).toHaveBeenCalledTimes(1);
		expect(second.reply).toHaveBeenCalledTimes(1);
		expect(second.update).not.toHaveBeenCalled();
		expect(publicPosts(h.followUp)).toHaveLength(0);

		h.opponentPrompt.collector().click(pickId("round-5", "opponent", "paper"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		// Rock stood, so paper wins for the opponent. One reveal, built from the
		// FIRST throw rather than the attempted swap.
		const reveal = publicPosts(h.followUp)[0] as { embeds: { data: { description: string } }[] };
		expect(reveal.embeds[0].data.description).toContain("rock");
		expect(reveal.embeds[0].data.description).not.toContain("scissors");
	});
});

describe("runRps, the accepted but never thrown timeout", () => {
	it("closes the round, posts one notice, and does not leak state", async () => {
		const h = harness();
		acceptedChallenge(h.accept, "round-6");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		h.challengerPrompt.collector().click(pickId("round-6", "challenger", "rock"));
		await vi.advanceTimersByTimeAsync(0);
		expect(publicPosts(h.followUp)).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(RPS_PICK_TIMEOUT_MS + 1);
		await pending;

		const posts = publicPosts(h.followUp);
		expect(posts).toHaveLength(1);
		// The void round must NOT publish the throw of whoever did commit, or the
		// rematch starts with one player holding free information.
		const notice = posts[0] as { embeds: { data: { description: string } }[] };
		expect(notice.embeds[0].data.description).not.toContain("rock");
		expect(_activeRpsRoundCount()).toBe(0);
	});

	it("does not post a timeout notice after a reveal already landed", async () => {
		const h = harness();
		acceptedChallenge(h.accept, "round-7");
		const pending = runRps(h.interaction);
		await vi.advanceTimersByTimeAsync(0);

		h.challengerPrompt.collector().click(pickId("round-7", "challenger", "rock"));
		h.opponentPrompt.collector().click(pickId("round-7", "opponent", "paper"));
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		// Push well past the window. The timer was cleared on finish, so nothing
		// further may post; a reveal plus a "round expired" would contradict.
		await vi.advanceTimersByTimeAsync(RPS_PICK_TIMEOUT_MS * 2);
		expect(publicPosts(h.followUp)).toHaveLength(1);
	});
});

describe("runRps, bailing out", () => {
	it("sends no prompts and registers no round when the challenge is not accepted", async () => {
		for (const outcome of [{ status: "declined" }, { status: "timedOut" }, { status: "rejected", reason: "duplicate" }]) {
			const h = harness();
			challenge.issueChallenge.mockResolvedValue(outcome);

			await runRps(h.interaction);

			expect(h.acceptReply).not.toHaveBeenCalled();
			expect(h.followUp).not.toHaveBeenCalled();
			expect(_activeRpsRoundCount()).toBe(0);
		}
	});
});
