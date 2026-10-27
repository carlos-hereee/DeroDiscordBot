import { describe, it, expect, vi } from "vitest";
import type { Client } from "discord.js";
import type { IDeroVoiceConfig } from "@db/models/DeroVoiceConfig.js";
import type { IGameRoom } from "@db/models/GameRoom.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { JAIL_INDEX, JAIL_SENTENCE_TURNS } from "@features/games/monopolyBoard.js";
import {
	applyBuy,
	applyEndTurn,
	applyForfeit,
	applyJailChoice,
	applyRoll,
	applySkip,
	closeAuction,
	createInitialState,
	placeBid,
	type MonopolyResult,
	type MonopolyState,
} from "@features/games/monopolyState.js";
import type { CallAnnouncerDeps } from "@features/voice/callAnnouncer.js";
import type { CallSpeechInput, CallSpeechResult } from "@features/voice/callSpeech.js";
import type { VoiceSessionView } from "@features/voice/voiceSessions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import { announceReferee, groupIntoClips, pickRefereeLines, withNames, _refereeSettled } from "./roomMonopolyReferee.js";

// ── roomMonopolyReferee ──────────────────────────────────────────────
// The allowlist against REAL engine moves, so a reworded trail line fails here
// instead of quietly dropping out of the referee's voice. Then the clips (a turn
// handoff alone, the rest joined, in order) and every gate that keeps Dero quiet,
// against a fake call and a fake guild.

const ALICE = "alice";
const BOB = "bob";
const NOW = 1_000;
const SEED = 241;

const newMatch = (auctionsEnabled = false): MonopolyState => createInitialState([ALICE, BOB], { auctionsEnabled }, NOW, SEED);

// A die face f comes from any rng value in [(f - 1) / 6, f / 6), so the midpoint is used.
function diceRng(...faces: number[]): () => number {
	let index = 0;
	return () => (faces[Math.min(index++, faces.length - 1)] - 0.5) / 6;
}

function expectOk(result: MonopolyResult): { state: MonopolyState; trailLines: string[] } {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

const rollFrom = (state: MonopolyState, position: number, ...faces: number[]) => {
	state.seats[state.activeSeatIndex].position = position;
	return expectOk(applyRoll(state, diceRng(...faces), NOW));
};

const giveTiles = (state: MonopolyState, ownerId: string, ...ids: string[]): void => {
	for (const id of ids) state.properties[id].ownerId = ownerId;
};

const spokenTexts = (lines: string[]): string[] => pickRefereeLines(lines).map((line) => line.text);

// ── ① the allowlist ──
describe("the spoken allowlist, from real engine moves", () => {
	it("speaks a purchase but not the roll, the landing or the lot being for sale", () => {
		const rolled = rollFrom(newMatch(), 0, 1, 2);
		expect(rolled.trailLines).toHaveLength(3);
		expect(spokenTexts(rolled.trailLines)).toEqual([]);

		const bought = expectOk(applyBuy(rolled.state, ALICE, "burnt-umber-row"));
		expect(spokenTexts(bought.trailLines)).toEqual(["<@alice> bought Burnt Umber Row for $60."]);
	});

	it("speaks a rent at the big rent bar and leaves a smaller one unspoken", () => {
		// All four rails charge $200, the bar itself; three charge $100.
		expect(BOT_CONSTANTS.MONOPOLY_REFEREE_BIG_RENT).toBe(200);
		const fourRails = newMatch();
		giveTiles(fourRails, BOB, "rail-one", "rail-two", "rail-three", "rail-four");
		expect(spokenTexts(rollFrom(fourRails, 0, 2, 3).trailLines)).toEqual(["<@alice> paid $200 rent to <@bob>."]);

		const threeRails = newMatch();
		giveTiles(threeRails, BOB, "rail-one", "rail-two", "rail-three");
		const small = rollFrom(threeRails, 0, 2, 3).trailLines;
		expect(small).toContain("<@alice> paid $100 rent to <@bob>.");
		expect(spokenTexts(small)).toEqual([]);
	});

	it("speaks a hotel's rent", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		state.properties["reader-dock"].hotel = true;
		expect(spokenTexts(rollFrom(state, 0, 2, 4).trailLines)).toEqual(["<@alice> paid $550 rent to <@bob>."]);
	});

	it("speaks a card by its title only, cutting the flavor and the card's small print", () => {
		const state = newMatch();
		state.chanceDeck = ["chance-dividend", ...state.chanceDeck.filter((id) => id !== "chance-dividend")];
		const { trailLines } = rollFrom(state, 0, 3, 4);
		expect(trailLines).toContain("<@alice> drew Guild Dividend. Your shares in the Dero Trading Guild paid out.");
		expect(spokenTexts(trailLines)).toEqual(["<@alice> drew Guild Dividend."]);
	});

	it("speaks going to jail, a doubles streak to jail, and every way out", () => {
		expect(spokenTexts(rollFrom(newMatch(), 24, 2, 4).trailLines)).toEqual(["<@alice> goes straight to Jail."]);

		const streak = newMatch();
		streak.doublesStreak = 2;
		expect(spokenTexts(rollFrom(streak, 0, 1, 1).trailLines)).toEqual(["<@alice> rolled doubles 3 times in a row and goes to Jail."]);

		const jailed = (): MonopolyState => {
			const state = newMatch();
			Object.assign(state.seats[0], { position: JAIL_INDEX, inJail: true, jailTurnsRemaining: JAIL_SENTENCE_TURNS });
			return state;
		};
		expect(spokenTexts(expectOk(applyJailChoice(jailed(), "bail")).trailLines)).toEqual(["<@alice> paid $50 bail and is free to roll."]);
		const walked = expectOk(applyJailChoice(jailed(), "roll", diceRng(2, 2))).trailLines;
		expect(spokenTexts(walked)).toContain("<@alice> rolled doubles and walks out of Jail.");
		const stayed = expectOk(applyJailChoice(jailed(), "roll", diceRng(1, 2))).trailLines;
		expect(spokenTexts(stayed)).toEqual([]);
		const lastTry = jailed();
		lastTry.seats[0].jailTurnsRemaining = 1;
		expect(spokenTexts(expectOk(applyJailChoice(lastTry, "roll", diceRng(1, 2))).trailLines)).toContain(
			"<@alice> used the last try, pays $50 bail and moves."
		);
	});

	it("speaks a doubles reroll and the turn handoff, and marks only the handoff", () => {
		const rolled = rollFrom(newMatch(), 0, 3, 3);
		const bought = expectOk(applyBuy(rolled.state, ALICE, "reader-dock"));
		const again = expectOk(applyEndTurn(bought.state, NOW));
		expect(pickRefereeLines(again.trailLines)).toEqual([{ text: "<@alice> rolled doubles and rolls again.", handoff: false }]);

		const plain = rollFrom(newMatch(), 0, 1, 2);
		const passed = expectOk(applyEndTurn(expectOk(applySkip(plain.state, ALICE)).state, NOW));
		expect(pickRefereeLines(passed.trailLines)).toEqual([{ text: "It is now <@bob>'s turn.", handoff: true }]);
	});

	it("speaks an auction opening and its close, won or with no bids, but never a sealed bid", () => {
		const opened = expectOk(applySkip(rollFrom(newMatch(true), 0, 1, 2).state, ALICE));
		expect(spokenTexts(opened.trailLines)).toEqual(["<@alice> passed on Burnt Umber Row, and it goes up for auction."]);

		const bid = expectOk(placeBid(opened.state, BOB, 80));
		expect(spokenTexts(bid.trailLines)).toEqual([]);
		expect(spokenTexts(expectOk(closeAuction(bid.state)).trailLines)).toEqual(["<@bob> won Burnt Umber Row at auction for $80."]);
		expect(spokenTexts(expectOk(closeAuction(opened.state)).trailLines)).toEqual(["Nobody bid on Burnt Umber Row, so it stays with the bank."]);

		// A pass with auctions off is a plain pass, and says nothing.
		expect(spokenTexts(expectOk(applySkip(rollFrom(newMatch(), 0, 1, 2).state, ALICE)).trailLines)).toEqual([]);
	});

	it("speaks a held debt", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		giveTiles(state, ALICE, "rail-one");
		state.seats[0].chips = 10;
		const { state: held, trailLines } = rollFrom(state, 0, 2, 4);
		expect(held.phase).toBe("awaiting-debt");
		expect(spokenTexts(trailLines)).toEqual([
			"<@alice> owes <@bob> $12 and has $10, so they need to mortgage lots or sell buildings to raise the rest, then pay.",
		]);
	});

	it("speaks a bankruptcy and the winner, not the hand over of holdings", () => {
		const state = newMatch();
		giveTiles(state, BOB, "reader-dock", "teal-vale", "teal-ridge");
		state.seats[0].chips = 4;
		const { state: finished, trailLines } = rollFrom(state, 0, 2, 4);
		expect(finished.phase).toBe("finished");
		expect(spokenTexts(trailLines)).toEqual([
			"<@alice> cannot cover $12, even by selling and mortgaging everything, and is bankrupt.",
			"<@bob> wins the match.",
		]);
	});

	it("speaks the idle sweep's own line without its hourglass, then the handoff", () => {
		const three = createInitialState([ALICE, BOB, "cara"], { auctionsEnabled: false }, NOW, SEED);
		const forfeited = expectOk(applyForfeit(three, ALICE, NOW));
		const lines = [gameRoomsCopy.monopoly.idleForfeit(ALICE), ...forfeited.trailLines];
		const spoken = pickRefereeLines(lines);
		expect(spoken[0].text).toMatch(/^<@alice> stayed on the clock for \d+ hours without a move/);
		expect(spoken.at(-1)).toEqual({ text: "It is now <@bob>'s turn.", handoff: true });
		expect(spokenTexts([gameRoomsCopy.monopoly.idleDebtDefault(ALICE)])[0]).toMatch(/^<@alice> left a debt unpaid for \d+ hours/);
	});
});

// ── ② clips ──
describe("the clips of one move", () => {
	it("puts each turn handoff in its own clip and joins the lines between, in order", () => {
		const clips = groupIntoClips([
			{ text: "A.", handoff: false },
			{ text: "B.", handoff: false },
			{ text: "It is now X's turn.", handoff: true },
			{ text: "C.", handoff: false },
		]);
		expect(clips).toEqual(["A. B.", "It is now X's turn.", "C."]);
	});

	it("swaps every mention for a display name, and a name it cannot find for the fallback", () => {
		const names = new Map([["alice", "Alice"]]);
		expect(withNames("<@alice> paid $200 rent to <@bob>.", names)).toBe(
			`Alice paid $200 rent to ${gameRoomsCopy.monopoly.refereeUnknownPlayer}.`
		);
	});
});

// ── ③ ④ delivery ──
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeGuildOptions {
	inCall?: Record<string, string>;
	cachedNames?: Record<string, string>;
	fetchedNames?: Record<string, string>;
}

function fakeClient({ inCall = { [ALICE]: "vc1" }, cachedNames = { [ALICE]: "Alice" }, fetchedNames = {} }: FakeGuildOptions = {}) {
	const members = new Map(Object.entries(cachedNames).map(([userId, displayName]) => [userId, { displayName }]));
	const fetch = vi.fn(async ({ user }: { user: string[] }) => {
		for (const userId of user) if (fetchedNames[userId]) members.set(userId, { displayName: fetchedNames[userId] });
	});
	const guild = {
		voiceStates: { cache: new Map(Object.entries(inCall).map(([userId, channelId]) => [userId, { channelId }])) },
		members: { cache: members, fetch },
	};
	const client = { guilds: { cache: new Map([["g1", guild]]) } } as unknown as Client;
	return { client, fetch };
}

function fakeDeps(options: { withCall?: boolean; config?: Partial<IDeroVoiceConfig>; render?: (input: CallSpeechInput) => Promise<CallSpeechResult> } = {}) {
	const speak = vi.fn(() => "queued" as const);
	const call = { guildId: "g1", channelId: "vc1", controlChannelId: "t1", status: "ready", speaker: { speak } } as unknown as VoiceSessionView;
	const config = { guildId: "g1", enabled: true, voiceId: "voice-1", ...options.config } as unknown as IDeroVoiceConfig;
	const deps: CallAnnouncerDeps = {
		sessionIn: vi.fn(() => (options.withCall === false ? null : call)),
		loadConfig: vi.fn(async () => config),
		render: vi.fn(options.render ?? (async ({ text }: CallSpeechInput) => ({ status: "ok" as const, pcm48kStereo: Buffer.from(text), cached: false }))),
	};
	const spoken = (): string[] => speak.mock.calls.map((args) => (args as unknown as [Buffer])[0].toString());
	return { deps, speak, spoken };
}

let roomCounter = 0;
const refereeRoom = (monopolyReferee = true): IGameRoom => ({ roomId: `room-${++roomCounter}`, guildId: "g1", monopolyReferee }) as unknown as IGameRoom;

// A move that ends a turn with a big rent, so it has two clips: the rent, then the handoff.
const RENT_THEN_HANDOFF = ["<@alice> rolled 2 and 3.", "<@alice> paid $200 rent to <@bob>.", "It is now <@bob>'s turn."];

describe("announceReferee", () => {
	it("speaks the rent and the handoff as two clips, at dealer priority, with names for mentions", async () => {
		const { client, fetch } = fakeClient({ fetchedNames: { [BOB]: "Bob" } });
		const { deps, speak, spoken } = fakeDeps();
		const room = refereeRoom();

		announceReferee({ client, room, state: newMatch(), lines: RENT_THEN_HANDOFF }, deps);
		await _refereeSettled(room.roomId);

		expect(spoken()).toEqual(["Alice paid $200 rent to Bob.", "It is now Bob's turn."]);
		expect(speak).toHaveBeenCalledWith(expect.any(Buffer), "dealer");
		// Alice was cached, so only Bob is fetched, once for the whole move.
		expect(fetch).toHaveBeenCalledExactlyOnceWith({ user: [BOB] });
	});

	it("delivers clips in the order the moves happened, even when an earlier render is slower", async () => {
		const { client } = fakeClient({ cachedNames: { [ALICE]: "Alice", [BOB]: "Bob" } });
		const { deps, spoken } = fakeDeps({
			render: async ({ text }) => {
				if (text.includes("bought")) await new Promise((resolve) => setTimeout(resolve, 20));
				return { status: "ok", pcm48kStereo: Buffer.from(text), cached: false };
			},
		});
		const room = refereeRoom();

		announceReferee({ client, room, state: newMatch(), lines: ["<@alice> bought Rail One for $200."] }, deps);
		announceReferee({ client, room, state: newMatch(), lines: ["It is now <@bob>'s turn."] }, deps);
		await _refereeSettled(room.roomId);

		expect(spoken()).toEqual(["Alice bought Rail One for $200.", "It is now Bob's turn."]);
	});

	it("costs nothing at all for a room without the referee, or a move with nothing to say", async () => {
		const { client } = fakeClient();
		for (const [room, lines] of [
			[refereeRoom(false), RENT_THEN_HANDOFF],
			[refereeRoom(), ["<@alice> rolled 1 and 2.", "<@alice> paid $6 rent to <@bob>."]],
		] as const) {
			const { deps } = fakeDeps();
			announceReferee({ client, room, state: newMatch(), lines: [...lines] }, deps);
			await _refereeSettled(room.roomId);
			await flush();
			expect(deps.sessionIn).not.toHaveBeenCalled();
		}
	});

	it("stays silent with no call, and with no seat still playing in the call", async () => {
		const noCall = fakeDeps({ withCall: false });
		const room = refereeRoom();
		announceReferee({ client: fakeClient().client, room, state: newMatch(), lines: RENT_THEN_HANDOFF }, noCall.deps);
		await _refereeSettled(room.roomId);
		// The config is read once, only to name why it is silent (Arcade 7); nothing renders.
		expect(noCall.deps.loadConfig).toHaveBeenCalledOnce();
		expect(noCall.deps.render).not.toHaveBeenCalled();

		// Alice is in another voice channel, and the one seat in Dero's call is out.
		const elsewhere = fakeDeps();
		const state = newMatch();
		state.seats[1].bankrupt = true;
		const otherRoom = refereeRoom();
		announceReferee({ client: fakeClient({ inCall: { [ALICE]: "vc2", [BOB]: "vc1" } }).client, room: otherRoom, state, lines: RENT_THEN_HANDOFF }, elsewhere.deps);
		await _refereeSettled(otherRoom.roomId);
		expect(elsewhere.deps.loadConfig).not.toHaveBeenCalled();
		expect(elsewhere.speak).not.toHaveBeenCalled();
	});

	it("stays silent when the guild's voice is switched off, and when the monthly cap is reached", async () => {
		const off = fakeDeps({ config: { enabled: false } });
		const room = refereeRoom();
		announceReferee({ client: fakeClient().client, room, state: newMatch(), lines: RENT_THEN_HANDOFF }, off.deps);
		await _refereeSettled(room.roomId);
		expect(off.deps.render).not.toHaveBeenCalled();

		const capped = fakeDeps({ render: async () => ({ status: "capReached" }) });
		const cappedRoom = refereeRoom();
		announceReferee({ client: fakeClient().client, room: cappedRoom, state: newMatch(), lines: RENT_THEN_HANDOFF }, capped.deps);
		await _refereeSettled(cappedRoom.roomId);
		expect(capped.deps.render).toHaveBeenCalled();
		expect(capped.speak).not.toHaveBeenCalled();
	});

	it("never throws into the move, even when delivery fails", async () => {
		const { deps } = fakeDeps({ render: async () => Promise.reject(new Error("provider down")) });
		const room = refereeRoom();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(() => announceReferee({ client: fakeClient().client, room, state: newMatch(), lines: RENT_THEN_HANDOFF }, deps)).not.toThrow();
		await _refereeSettled(room.roomId);
		expect(error).toHaveBeenCalledWith(expect.stringContaining("[monopoly-referee]"), expect.any(Error));
		error.mockRestore();
	});
});

// ── why it is silent (2026-10 item 254, Arcade 7) ──
// Every check that stops a move's clips names its reason, once per move, so the room
// layer can post the match's one notice. A move it speaks names none.
describe("announceReferee's silence", () => {
	async function silenceOf(deps: CallAnnouncerDeps, clientOptions: FakeGuildOptions = {}, state = newMatch()): Promise<string[]> {
		const reasons: string[] = [];
		const room = refereeRoom();
		announceReferee({ client: fakeClient(clientOptions).client, room, state, lines: RENT_THEN_HANDOFF, onSilent: (reason) => reasons.push(reason) }, deps);
		await _refereeSettled(room.roomId);
		return reasons;
	}

	it("says the voice is off when Dero is in no call and the guild switched its voice off", async () => {
		expect(await silenceOf(fakeDeps({ withCall: false, config: { enabled: false } }).deps)).toEqual(["voiceOff"]);
	});

	it("says Dero is in no call when the voice is on", async () => {
		expect(await silenceOf(fakeDeps({ withCall: false }).deps)).toEqual(["noCall"]);
	});

	it("says no player is in Dero's call when only someone else is", async () => {
		expect(await silenceOf(fakeDeps().deps, { inCall: { [ALICE]: "vc2" } })).toEqual(["noPlayerInCall"]);
	});

	it("says the budget is spent when the render hits the monthly cap, once for the move", async () => {
		const capped = fakeDeps({ render: async () => ({ status: "capReached" }) });
		expect(await silenceOf(capped.deps)).toEqual(["budgetSpent"]);
		expect(capped.deps.render).toHaveBeenCalledOnce();
	});

	it("names nothing when every clip is spoken, or when a render merely fails", async () => {
		expect(await silenceOf(fakeDeps().deps)).toEqual([]);
		expect(await silenceOf(fakeDeps({ render: async () => ({ status: "failed", kind: "unexpected" }) }).deps)).toEqual([]);
	});

	it("never joins a call itself: no session is opened, whatever the reason", async () => {
		const noCall = fakeDeps({ withCall: false });
		await silenceOf(noCall.deps);
		expect(noCall.speak).not.toHaveBeenCalled();
		expect(noCall.deps.sessionIn).toHaveBeenCalled();
	});
});
