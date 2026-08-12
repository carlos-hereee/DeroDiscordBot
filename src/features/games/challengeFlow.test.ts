import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, User } from "discord.js";
import { issueChallenge, CHALLENGE_TIMEOUT_MS, _clearActiveChallenges, _activeChallengeCount } from "./challengeFlow.js";

// ── challengeFlow ──────────────────────────────────────────────────────────
// The engine both challenge based games depend on, so its guards and its
// cleanup are the two things worth pinning hard. A leaked map entry would block
// the same two players from ever challenging each other again for the life of
// the process, and it would do it silently.

const CHALLENGER_ID = "111111111111111111";
const OPPONENT_ID = "222222222222222222";
const GUILD_ID = "910668785856413707";

interface Harness {
	interaction: ChatInputCommandInteraction;
	reply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
	// Drives the fake collector the way Discord would: a click, or nothing until
	// the window closes.
	click: (customId: string) => ButtonInteraction;
	customIds: () => { acceptId: string; declineId: string };
}

function fakeUser(id: string, bot = false): User {
	return { id, bot } as unknown as User;
}

// A stand-in for the slash interaction plus the message its reply produces. The
// collector is fake but its clock is REAL setTimeout, so vitest's fake timers
// drive the timeout branch exactly as Discord's own window would.
function makeHarness(guildId: string | null = GUILD_ID): Harness {
	const reply = vi.fn(async () => undefined);
	const editReply = vi.fn(async () => undefined);

	let onCollect: ((interaction: unknown) => void) | undefined;
	let onEnd: (() => void) | undefined;

	const message = {
		createMessageComponentCollector: (config: { time: number }) => {
			const handle = setTimeout(() => onEnd?.(), config.time);
			const collector = {
				on(event: string, callback: (arg?: unknown) => void) {
					if (event === "collect") onCollect = callback as (interaction: unknown) => void;
					else onEnd = () => {
						clearTimeout(handle);
						callback();
					};
					return collector;
				},
			};
			return collector;
		},
	};

	const interaction = {
		user: { id: CHALLENGER_ID },
		guildId,
		reply,
		editReply,
		fetchReply: async () => message,
	} as unknown as ChatInputCommandInteraction;

	// Read the real customIds off the posted button row rather than rebuilding
	// them, so the test cannot drift from the id format the engine actually emits.
	const customIds = (): { acceptId: string; declineId: string } => {
		const payload = reply.mock.calls[0][0] as { components: { toJSON: () => { components: { custom_id: string }[] } }[] };
		const ids = payload.components[0].toJSON().components.map((component) => component.custom_id);
		return { acceptId: ids[0], declineId: ids[1] };
	};

	const click = (customId: string): ButtonInteraction => {
		const button = { customId, user: { id: OPPONENT_ID }, update: vi.fn(async () => undefined) } as unknown as ButtonInteraction;
		onCollect?.(button);
		onEnd?.();
		return button;
	};

	return { interaction, reply, editReply, click, customIds };
}

beforeEach(() => {
	_clearActiveChallenges();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("issueChallenge guards", () => {
	it("rejects a self challenge without posting publicly", async () => {
		const h = makeHarness();
		const outcome = await issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(CHALLENGER_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});

		expect(outcome).toEqual({ status: "rejected", reason: "selfChallenge" });
		// One ephemeral reply, and critically no components, so nothing clickable
		// ever reached the channel.
		expect(h.reply).toHaveBeenCalledTimes(1);
		expect((h.reply.mock.calls[0][0] as { components?: unknown }).components).toBeUndefined();
		expect(_activeChallengeCount()).toBe(0);
	});

	it("rejects a bot opponent", async () => {
		const h = makeHarness();
		const outcome = await issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(OPPONENT_ID, true),
			kind: "rps",
			gameLabel: "rock paper scissors",
		});

		expect(outcome).toEqual({ status: "rejected", reason: "botOpponent" });
		expect(_activeChallengeCount()).toBe(0);
	});

	it("rejects a challenge issued outside a guild", async () => {
		const h = makeHarness(null);
		const outcome = await issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});

		expect(outcome).toEqual({ status: "rejected", reason: "outsideGuild" });
		expect(_activeChallengeCount()).toBe(0);
	});

	it("rejects a second concurrent challenge between the same two players", async () => {
		const first = makeHarness();
		// Deliberately NOT awaited: the first challenge is still parked on its
		// collector, which is the only state in which a duplicate is possible.
		const pending = issueChallenge({
			interaction: first.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});
		// The slot is claimed synchronously, before the first await in the engine,
		// so a second caller in the SAME tick already sees it. That is the whole
		// point of keeping the check and the write adjacent with no await between.
		expect(_activeChallengeCount()).toBe(1);

		const second = makeHarness();
		const outcome = await issueChallenge({
			interaction: second.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});
		expect(outcome).toEqual({ status: "rejected", reason: "duplicate" });
		// The duplicate must not have posted a challenge message of its own.
		expect((second.reply.mock.calls[0][0] as { components?: unknown }).components).toBeUndefined();

		// Let the first one time out so the suite leaves no dangling timer.
		await vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS + 1);
		await pending;
		expect(_activeChallengeCount()).toBe(0);
	});

	it("blocks the reverse pairing too, not just the same direction", async () => {
		const first = makeHarness();
		const pending = issueChallenge({
			interaction: first.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});

		// B challenging A while A's challenge to B is open is the same open
		// challenge from the other side, so the pair key is unordered.
		const reverse = makeHarness();
		Object.assign(reverse.interaction, { user: { id: OPPONENT_ID } });
		const outcome = await issueChallenge({
			interaction: reverse.interaction,
			opponent: fakeUser(CHALLENGER_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});
		expect(outcome).toEqual({ status: "rejected", reason: "duplicate" });

		await vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS + 1);
		await pending;
	});
});

describe("issueChallenge outcomes", () => {
	it("times out when nobody answers, and cleans up its state", async () => {
		const h = makeHarness();
		const pending = issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});

		// Still open right up to the edge of the window.
		await vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS - 1);
		expect(_activeChallengeCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(2);
		const outcome = await pending;

		expect(outcome).toEqual({ status: "timedOut" });
		// The cleanup that matters: the pair slot is released, so these two can
		// challenge each other again immediately.
		expect(_activeChallengeCount()).toBe(0);
		// And the dead buttons are stripped from the public message.
		expect(h.editReply).toHaveBeenCalledTimes(1);
		expect((h.editReply.mock.calls[0][0] as { components: unknown[] }).components).toEqual([]);
	});

	it("reports a decline, acknowledges it through the button, and cleans up", async () => {
		const h = makeHarness();
		const pending = issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "diceroll",
			gameLabel: "a duel",
		});
		await vi.advanceTimersByTimeAsync(0);

		const button = h.click(h.customIds().declineId);
		const outcome = await pending;

		expect(outcome).toEqual({ status: "declined" });
		// A decline is terminal inside the engine, so the engine owns the ack.
		expect(button.update).toHaveBeenCalledTimes(1);
		expect(_activeChallengeCount()).toBe(0);
	});

	it("hands the accept click back UNACKNOWLEDGED so the caller can reply to it", async () => {
		const h = makeHarness();
		const pending = issueChallenge({
			interaction: h.interaction,
			opponent: fakeUser(OPPONENT_ID),
			kind: "rps",
			gameLabel: "rock paper scissors",
		});
		await vi.advanceTimersByTimeAsync(0);

		const button = h.click(h.customIds().acceptId);
		const outcome = await pending;

		expect(outcome.status).toBe("accepted");
		if (outcome.status !== "accepted") throw new Error("expected an accepted outcome");
		expect(outcome.accept).toBe(button);
		expect(outcome.challengeId).toBeTruthy();

		// The load bearing assertion for Phase 3: rps replies to this exact
		// interaction with the opponent's secret pick prompt, which is only
		// possible if the engine never touched it. The public message is tidied
		// through the original slash interaction instead.
		expect(button.update).not.toHaveBeenCalled();
		expect(h.editReply).toHaveBeenCalledTimes(1);
		expect((h.editReply.mock.calls[0][0] as { components: unknown[] }).components).toEqual([]);
		expect(_activeChallengeCount()).toBe(0);
	});
});
