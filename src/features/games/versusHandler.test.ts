import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, User } from "discord.js";

// ── versusHandler ────────────────────────────────────────────────────────────
// versusResolve already pins the odds exhaustively. What only a handler test can
// reach is the wiring: that a non accepted challenge stays silent and costs the
// challenger nothing, that the result answers the ACCEPT click rather than the
// original command, and that the payoff does not ping two people a second time.
//
// This closes the plan's "at least one mocked test per game command" line, which
// rps and hangman met and duel did not.

const mocks = vi.hoisted(() => ({
	issueChallenge: vi.fn(),
	resolveVersus: vi.fn(),
}));
vi.mock("./challengeFlow.js", () => ({ issueChallenge: mocks.issueChallenge }));
vi.mock("./versusResolve.js", async (importOriginal) => {
	// Keep the real types and constants, swap only the resolver, so the handler
	// under test still sees a genuine VersusResult shape.
	const actual = await importOriginal<typeof import("./versusResolve.js")>();
	return { ...actual, resolveVersus: mocks.resolveVersus };
});

import { runCoinFlip, runDiceRoll } from "./versusHandler.js";

const OPPONENT_ID = "222222222222222222";

// The cooldown is module scope and keyed per user, so each test uses a fresh
// challenger rather than reaching into it.
let seq = 0;
const nextChallengerId = (): string => `1111111111111111${String(seq++).padStart(2, "0")}`;

function harness(flip: "dice" | "coin" = "dice"): {
	interaction: ChatInputCommandInteraction;
	accept: ButtonInteraction;
	challengerId: string;
	reply: ReturnType<typeof vi.fn>;
	acceptReply: ReturnType<typeof vi.fn>;
	// The flip is no longer an OPTION, it is which subcommand was invoked, so the
	// harness hands back the runner matching the mode it was built for.
	run: () => Promise<void>;
} {
	const challengerId = nextChallengerId();
	const reply = vi.fn(async () => undefined);
	const acceptReply = vi.fn(async () => undefined);

	const accept = { reply: acceptReply } as unknown as ButtonInteraction;
	const interaction = {
		user: { id: challengerId },
		guildId: "910668785856413707",
		options: {
			getUser: () => ({ id: OPPONENT_ID, bot: false }) as unknown as User,
			getString: () => flip,
		},
		reply,
	} as unknown as ChatInputCommandInteraction;

	const run = (): Promise<void> => (flip === "coin" ? runCoinFlip(interaction) : runDiceRoll(interaction));
	return { interaction, accept, challengerId, reply, acceptReply, run };
}

const accepted = (accept: ButtonInteraction): void => {
	mocks.issueChallenge.mockResolvedValue({ status: "accepted", challengeId: "duel-1", accept });
};

const embedDescription = (acceptReply: ReturnType<typeof vi.fn>): string =>
	(acceptReply.mock.calls[0][0] as { embeds: { data: { description: string } }[] }).embeds[0].data.description;

beforeEach(() => {
	mocks.issueChallenge.mockReset();
	mocks.resolveVersus.mockReset();
	mocks.resolveVersus.mockReturnValue({ flip: "dice", challengerRoll: 18, opponentRoll: 4, winner: "challenger" });
});

describe("coin flip and dice roll, handing off to the challenge engine", () => {
	it("issues the challenge as a duel against the named opponent", async () => {
		const h = harness();
		accepted(h.accept);
		await h.run();

		expect(mocks.issueChallenge).toHaveBeenCalledTimes(1);
		const request = mocks.issueChallenge.mock.calls[0][0] as { kind: string; opponent: { id: string } };
		// The kind is now per game rather than the single "duel" it was before the
		// 2026-08-12 split, which is what gives each half its own /account record.
		expect(request.kind).toBe("diceroll");
		expect(request.opponent.id).toBe(OPPONENT_ID);
	});

	it.each([{ status: "declined" }, { status: "timedOut" }, { status: "rejected", reason: "selfChallenge" }])(
		"stays completely silent on a $status outcome",
		async (outcome) => {
			// The engine already told the right person what happened. A second
			// message here would double up on every decline and every timeout.
			const h = harness();
			mocks.issueChallenge.mockResolvedValue(outcome);
			await h.run();

			expect(h.reply).not.toHaveBeenCalled();
			expect(h.acceptReply).not.toHaveBeenCalled();
			expect(mocks.resolveVersus).not.toHaveBeenCalled();
		}
	);

	it("does not burn the challenger's cooldown when the challenge was declined", async () => {
		// Recording on a decline would let anyone freeze a rival out of the game
		// for the window simply by refusing every challenge.
		const h = harness();
		mocks.issueChallenge.mockResolvedValue({ status: "declined" });
		await h.run();

		accepted(h.accept);
		await h.run();
		expect(h.acceptReply).toHaveBeenCalledTimes(1);
	});
});

describe("coin flip and dice roll, the payoff", () => {
	it("answers the ACCEPT click, not the original command", async () => {
		// challengeFlow hands the click back unacknowledged, and Discord gives
		// three seconds to answer it. Duel has no secret step, so duel is the one
		// that acknowledges it, by replying with the result.
		const h = harness();
		accepted(h.accept);
		await h.run();

		expect(h.acceptReply).toHaveBeenCalledTimes(1);
		const payload = h.acceptReply.mock.calls[0][0] as { embeds: unknown[]; files: unknown[]; allowedMentions: unknown };
		expect(payload.embeds).toHaveLength(1);
		expect(payload.files).toHaveLength(1);
		// Both players were already pinged by the challenge; pinging again on the
		// payoff would be noise.
		expect(payload.allowedMentions).toEqual({ parse: [] });
	});

	it("names the winner on a decisive dice duel, and shows both rolls", async () => {
		const h = harness();
		accepted(h.accept);
		mocks.resolveVersus.mockReturnValue({ flip: "dice", challengerRoll: 18, opponentRoll: 4, winner: "challenger" });
		await h.run();

		const text = embedDescription(h.acceptReply);
		expect(text).toContain("18");
		expect(text).toContain("4");
		expect(text).toContain(h.challengerId);
	});

	it("renders a tie without naming a winner", async () => {
		const h = harness();
		accepted(h.accept);
		mocks.resolveVersus.mockReturnValue({ flip: "dice", challengerRoll: 11, opponentRoll: 11, winner: "tie" });
		await h.run();

		const text = embedDescription(h.acceptReply);
		expect(text).toContain("Nobody takes it");
		expect(text).not.toContain("👑");
	});

	it("shows the coin face rather than rolls on a coin duel", async () => {
		const h = harness("coin");
		accepted(h.accept);
		mocks.resolveVersus.mockReturnValue({ flip: "coin", face: "tails", winner: "opponent" });
		await h.run();

		const text = embedDescription(h.acceptReply);
		expect(text).toContain("tails");
		expect(text).toContain(OPPONENT_ID);
	});

	it("passes the chosen flip through to the resolver", async () => {
		const h = harness("coin");
		accepted(h.accept);
		mocks.resolveVersus.mockReturnValue({ flip: "coin", face: "heads", winner: "challenger" });
		await h.run();

		expect(mocks.resolveVersus).toHaveBeenCalledWith("coin");
	});
});

describe("coin flip and dice roll, the spam gate", () => {
	it("blocks a second duel inside the window, before any public message", async () => {
		const h = harness();
		accepted(h.accept);
		await h.run();
		expect(h.acceptReply).toHaveBeenCalledTimes(1);

		mocks.issueChallenge.mockClear();
		await h.run();

		// Rejected ephemerally, and crucially the engine was never reached, so a
		// rate limited challenger cannot ping their target at all.
		expect(h.reply).toHaveBeenCalledTimes(1);
		expect(mocks.issueChallenge).not.toHaveBeenCalled();
	});

	it("gates per challenger, not globally", async () => {
		const first = harness();
		accepted(first.accept);
		await first.run();

		const second = harness();
		accepted(second.accept);
		await second.run();

		// A different member must not inherit the first one's cooldown.
		expect(second.acceptReply).toHaveBeenCalledTimes(1);
		expect(second.reply).not.toHaveBeenCalled();
	});
});
