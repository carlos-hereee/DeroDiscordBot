import { describe, it, expect, vi, beforeEach } from "vitest";
import { InteractionType, TextChannel, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

// ── the creation modal's Submit and Edit settings (2026-10 item 263 Phase 2a) ──────────────
// What is pinned: the press opens the modal from two reads made in parallel (risk R4); the
// Submit applies each choice through the card's own choice functions and posts the card already
// configured, at its gather step, in the channel its game and match decide, with no private line
// after it (R3-6); Casual without bots is allowed and posts in ⚔️challenges (R3-5); Who you play:
// Dero opens a solo room and posts no card; a refused choice is a note on the card; Edit settings
// shows what decision 7 allows and applies it the same way; a held slot at a solo start is offered
// to close at the press (R3-9).

const mocks = vi.hoisted(() => ({
	store: {
		findOpenByHost: vi.fn(),
		findByRoomId: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		markArchived: vi.fn(),
		setHoldemBuyIn: vi.fn(),
	},
	config: { findByGuildId: vi.fn() },
	openSoloRoom: vi.fn(),
}));

vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: mocks.store }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: mocks.config }));
vi.mock("@features/entitlements/gameRoomAccess.js", () => ({ checkGameRoomAccess: vi.fn(async () => ({ allowed: true })), gameRoomUpgradeEmbed: vi.fn() }));
vi.mock("@features/setup/adminLog.js", () => ({ adminLog: { emitFor: vi.fn(), emit: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope", checkRoomAdmission: vi.fn(), resolveRoomSeats: vi.fn(), seedRoom: vi.fn() }));
vi.mock("./soloRooms.js", () => ({
	openSoloRoom: mocks.openSoloRoom,
	soloLuckSlugFor: (game: string) => `solo-${game}`,
	describeSoloOpenFailure: () => "refused",
	readPrivateQuotaStatus: vi.fn(async () => null),
	startBlackjackRoomBoard: vi.fn(),
	startSoloBlackjackBoard: vi.fn(),
}));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn(async () => null), challengeCardView: vi.fn(async () => ({})) }));
// The card's band, spectator and approval functions, wrapped so a case can see the Submit call
// the very functions the card's controls call (owner decision 3: fold, never fork).
vi.mock("./hostControls.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./hostControls.js")>();
	return { ...actual, applyApproval: vi.fn(actual.applyApproval), applyRatingBand: vi.fn(actual.applyRatingBand), applySpectatorMode: vi.fn(actual.applySpectatorMode) };
});

import { confirmChallengeDraft, confirmSettingsEdit, offerChallengeDraft, offerToFreeSlot, openSettingsEditor } from "./challengeBoard.js";
import { applyApproval, applyRatingBand, applySpectatorMode } from "./hostControls.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

const HOST = "host-1";
const CHALLENGES = "chal-1";
const RATED = "rated-1";

// ── the fake draft row: every write lands on it, the way the store's returned document would ──
let row: IGameRoom;
function makeRoom(overrides: Partial<IGameRoom> = {}): IGameRoom {
	return {
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		buyInPaidBy: [],
		visibility: "invite",
		status: "draft",
		channelId: null,
		boardMessageId: null,
		network: false,
		casual: false,
		botSeats: 0,
		botsOffered: true,
		ratingBand: "any",
		requireApproval: false,
		spectatorMode: null,
		referee: null,
		monopolyAuctions: false,
		holdemBuyIn: null,
		settingsNotes: [],
		...overrides,
	} as unknown as IGameRoom;
}

// ── the guild: two challenge channels whose sends each case reads ──
function makeChannel(id: string) {
	const send = vi.fn(async () => ({ id: `card-in-${id}`, edit: vi.fn(async () => undefined) }));
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id, send, messages: { fetch: vi.fn(async () => ({ edit: vi.fn(async () => undefined) })) } });
	return { channel, send };
}
let challenges: ReturnType<typeof makeChannel>;
let rated: ReturnType<typeof makeChannel>;
function makeGuild() {
	return {
		id: "guild-1",
		members: { cache: new Map([[HOST, { displayName: "Host" }]]) },
		channels: {
			fetch: vi.fn(async (id: string) => {
				if (id === CHALLENGES) return challenges.channel;
				if (id === RATED) return rated.channel;
				return null;
			}),
		},
	};
}

const baseConfig = { arcadeChallengesChannelId: CHALLENGES, arcadeRatedChallengesChannelId: RATED, challengeReach: "server", botOpponentsEnabled: true, chipEconomyEnabled: true };

type FakeSubmit = ModalSubmitInteraction & { deferUpdate: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn>; followUp: ReturnType<typeof vi.fn> };
function submitOf(customId: string, answers: Record<string, string | string[]>): FakeSubmit {
	return {
		customId,
		type: InteractionType.ModalSubmit,
		guildId: "guild-1",
		guild: makeGuild(),
		user: { id: HOST, username: "host", globalName: "Host" },
		client: {},
		deferred: false,
		replied: false,
		isModalSubmit: () => true,
		isFromMessage: () => true,
		isMessageComponent: () => false,
		deferUpdate: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		fields: {
			getStringSelectValues: (id: string) => {
				const value = answers[id];
				if (value === undefined) throw new Error(`no field ${id}`);
				return Array.isArray(value) ? value : [value];
			},
			getTextInputValue: (id: string) => {
				const value = answers[id];
				if (typeof value !== "string") throw new Error(`no field ${id}`);
				return value;
			},
		},
	} as unknown as FakeSubmit;
}

function pressOf(): ButtonInteraction & { showModal: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> } {
	return {
		id: "press-1",
		guildId: "guild-1",
		guild: makeGuild(),
		user: { id: HOST },
		deferred: false,
		replied: false,
		showModal: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
	} as unknown as ButtonInteraction & { showModal: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
}

type CardSend = { embeds: Array<{ data: { description?: string } }>; components: Array<{ toJSON: () => { components: Array<{ custom_id?: string }> } }> };
const cardOf = (send: ReturnType<typeof vi.fn>): CardSend => (send.mock.calls[0] as unknown as [CardSend])[0];
const descriptionOf = (send: ReturnType<typeof vi.fn>): string => cardOf(send).embeds[0].data.description ?? "";
const actionsOf = (send: ReturnType<typeof vi.fn>): string[] => cardOf(send).components.flatMap((cardRow) => cardRow.toJSON().components.map((component) => component.custom_id?.split(":")[1] ?? ""));
const patches = (): Array<Partial<IGameRoom>> => mocks.store.update.mock.calls.map((call) => call[2] as Partial<IGameRoom>);

beforeEach(() => {
	vi.clearAllMocks();
	challenges = makeChannel(CHALLENGES);
	rated = makeChannel(RATED);
	row = makeRoom();
	mocks.config.findByGuildId.mockResolvedValue(baseConfig);
	mocks.store.findOpenByHost.mockResolvedValue(null);
	mocks.store.create.mockImplementation(async (input: Partial<IGameRoom>) => (row = makeRoom(input)));
	mocks.store.update.mockImplementation(async (_guildId: string, _roomId: string, patch: Partial<IGameRoom>) => (row = { ...row, ...patch } as IGameRoom));
	mocks.store.setHoldemBuyIn.mockImplementation(async (_guildId: string, _roomId: string, amount: number) => (row = { ...row, holdemBuyIn: amount } as IGameRoom));
	mocks.store.findByRoomId.mockImplementation(async () => row);
});

describe("the start press", () => {
	it("makes its two reads in parallel and renders nothing before the modal (risk R4)", async () => {
		// Each read is held open until the test lets it go, and records how many reads were in
		// flight when it started. Proved by order, not by a stopwatch: a timed version failed
		// under a busy machine's load although the reads ran together (2026-10 item 263).
		let inFlight = 0;
		let mostInFlight = 0;
		const releases: Array<() => void> = [];
		const held = <T>(value: T) =>
			new Promise<T>((resolve) => {
				inFlight += 1;
				mostInFlight = Math.max(mostInFlight, inFlight);
				releases.push(() => {
					inFlight -= 1;
					resolve(value);
				});
			});
		mocks.store.findOpenByHost.mockImplementation(() => held(null));
		mocks.config.findByGuildId.mockImplementation(() => held(baseConfig));
		const press = pressOf();

		const pressing = offerChallengeDraft(press, "holdem");
		// Let the press reach its reads; a sequential press would have started only the first.
		await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const release of releases.splice(0)) release();
		await vi.waitFor(() => expect(press.showModal).toHaveBeenCalled());
		for (const release of releases.splice(0)) release();
		await pressing;

		// Both reads were in flight together before either answered.
		expect(mostInFlight).toBe(2);
		expect(mocks.store.findOpenByHost).toHaveBeenCalledOnce();
		expect(mocks.config.findByGuildId).toHaveBeenCalledOnce();
		expect(press.showModal).toHaveBeenCalledOnce();
		expect(mocks.store.create).not.toHaveBeenCalled();
	});
});

describe("the creation Submit", () => {
	it("applies every Hold'em choice through the card's own functions, in a host's order, and posts the card configured", async () => {
		const submit = submitOf("gameroom:newok:holdem", { join: "approve", watch: "invite", match: "rated-close", buyIn: "5,000", voice: "off" });

		await confirmChallengeDraft(submit, "holdem", null);

		expect(applyApproval).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1" }), "on");
		expect(applyRatingBand).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1" }), "close");
		expect(applySpectatorMode).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room-1" }), "invite");
		expect(mocks.store.setHoldemBuyIn).toHaveBeenCalledWith("guild-1", "room-1", 5_000);
		// Who can join first (the visibility, then approval), then the band, then who may watch.
		const order = patches().map((patch) => Object.keys(patch)[0]);
		expect(order.indexOf("visibility")).toBeLessThan(order.indexOf("requireApproval"));
		expect(order.indexOf("requireApproval")).toBeLessThan(order.indexOf("ratingBand"));
		expect(order.indexOf("ratingBand")).toBeLessThan(order.indexOf("spectatorMode"));

		// A rated match posts in 🏆rated-challenges, at its gather step, with every setting named.
		expect(challenges.send).not.toHaveBeenCalled();
		expect(rated.send).toHaveBeenCalledOnce();
		expect(actionsOf(rated.send)).toEqual(["join", "start", "edit", "cancel", "requests", "kick"]);
		const description = descriptionOf(rated.send);
		expect(description).toContain(gameRoomsCopy.creation.summary.join.approve);
		expect(description).toContain(gameRoomsCopy.creation.summary.voice(false));
		expect(description).toContain(gameRoomsCopy.board.cardBuyIn(5_000));

		// Acknowledged quietly, and no private line follows the card (R3-6).
		expect(submit.deferUpdate).toHaveBeenCalledOnce();
		expect(submit.reply).not.toHaveBeenCalled();
		expect(submit.followUp).not.toHaveBeenCalled();
	});

	// A new Hold'em row already reads as voice on (refereeOn, 2026-10 item 263 R3-28), so the
	// default writes nothing and only the host's off is stored, as deroVoice (2026-10 item 267).
	it("leaves Dero voice on for Hold'em by default (owner decision 5), storing only an off", async () => {
		await confirmChallengeDraft(submitOf("gameroom:newok:holdem", { join: "public", watch: "open", match: "rated-any", buyIn: "", voice: "on" }), "holdem", null);
		expect(patches().some((patch) => "deroVoice" in patch)).toBe(false);

		mocks.store.update.mockClear();
		await confirmChallengeDraft(submitOf("gameroom:newok:holdem", { join: "public", watch: "open", match: "rated-any", buyIn: "", voice: "off" }), "holdem", null);
		expect(patches()).toContainEqual({ deroVoice: false });
	});

	it("stores Dero voice on for a game whose default is off, such as a coin flip", async () => {
		await confirmChallengeDraft(submitOf("gameroom:newok:coinflip", { join: "public", watch: "open", opponent: "anyone", voice: "on" }), "coinflip", null);
		expect(patches()).toContainEqual({ deroVoice: true });
	});

	it("accepts Casual without bots on a server with bots off, and posts the card in ⚔️challenges (R3-5)", async () => {
		mocks.config.findByGuildId.mockResolvedValue({ ...baseConfig, botOpponentsEnabled: false });

		await confirmChallengeDraft(submitOf("gameroom:newok:monopoly", { join: "public", watch: "open", match: "casual", auctions: "off" }), "monopoly", null);

		expect(patches()).toContainEqual({ casual: true, botSeats: 0 });
		expect(rated.send).not.toHaveBeenCalled();
		expect(challenges.send).toHaveBeenCalledOnce();
		expect(descriptionOf(challenges.send).split("\n")[0]).toBe(gameRoomsCopy.board.badgeLine("casual", "monopoly"));
	});

	it("seats exactly the Dero bot count the host picked in The match, not the casual table's fill", async () => {
		await confirmChallengeDraft(submitOf("gameroom:newok:monopoly", { join: "public", watch: "open", match: "casual-bots-2", auctions: "on" }), "monopoly", null);

		expect(patches()).toContainEqual({ casual: true, botSeats: 2 });
		expect(patches()).toContainEqual({ monopolyAuctions: true });
		expect(challenges.send).toHaveBeenCalledOnce();
	});

	it("saves each Hold'em bot count from 1 to 5 exactly as picked", async () => {
		for (const count of [1, 2, 3, 4, 5]) {
			mocks.store.update.mockClear();
			await confirmChallengeDraft(submitOf("gameroom:newok:holdem", { join: "public", watch: "open", match: `casual-bots-${count}`, buyIn: "" }), "holdem", null);
			expect(patches()).toContainEqual({ casual: true, botSeats: count });
		}
	});

	it("keeps a casual table with bots off a server that refuses them, rated, and says so on the card", async () => {
		mocks.config.findByGuildId.mockResolvedValue({ ...baseConfig, botOpponentsEnabled: false });

		await confirmChallengeDraft(submitOf("gameroom:newok:monopoly", { join: "public", watch: "open", match: "casual-bots-1", auctions: "off" }), "monopoly", null);

		expect(rated.send).toHaveBeenCalledOnce();
		expect(descriptionOf(rated.send)).toContain(gameRoomsCopy.creation.notApplied(gameRoomsCopy.creation.settingNames.casualBots, gameRoomsCopy.board.botsOff));
	});

	it("posts the card at the standard buy in when the typed one is out of range, and says so", async () => {
		await confirmChallengeDraft(submitOf("gameroom:newok:holdem", { join: "public", watch: "open", match: "rated-any", buyIn: "12", voice: "on" }), "holdem", null);

		expect(mocks.store.setHoldemBuyIn).not.toHaveBeenCalled();
		expect(rated.send).toHaveBeenCalledOnce();
		const description = descriptionOf(rated.send);
		expect(description).toContain(gameRoomsCopy.creation.settingNames.buyIn);
		expect(description).toContain(gameRoomsCopy.creation.buyInKept(1_000));
	});

	it("opens a solo room for Who you play: Dero, and posts no card", async () => {
		mocks.openSoloRoom.mockResolvedValue({ ok: true, room: { roomId: "solo-1" }, channel: { id: "solo-ch" } });

		await confirmChallengeDraft(submitOf("gameroom:newok:rps", { join: "public", watch: "open", opponent: "dero" }), "rps", null);

		expect(mocks.openSoloRoom).toHaveBeenCalledWith(expect.objectContaining({ id: "guild-1" }), "solo-rps", expect.objectContaining({ userId: HOST }));
		expect(mocks.store.create).not.toHaveBeenCalled();
		expect(challenges.send).not.toHaveBeenCalled();
		expect(rated.send).not.toHaveBeenCalled();
	});

	it("closes the held draft it named before posting the new card (R3-9: one Submit)", async () => {
		const held = makeRoom({ roomId: "old-room", game: "battleship" });
		mocks.store.findByRoomId.mockResolvedValueOnce(held);

		await confirmChallengeDraft(submitOf("gameroom:newok:holdem:old-room", { join: "public", watch: "open", match: "rated-any", buyIn: "" }), "holdem", "old-room");

		expect(mocks.store.markArchived).toHaveBeenCalledWith("guild-1", "old-room");
		expect(mocks.store.markArchived.mock.invocationCallOrder[0]).toBeLessThan(mocks.store.create.mock.invocationCallOrder[0]);
		expect(rated.send).toHaveBeenCalledOnce();
	});
});

describe("Edit settings", () => {
	type ShownModal = { toJSON: () => { components: Array<{ component?: { custom_id: string } }> } };
	const fieldsShown = (press: { showModal: ReturnType<typeof vi.fn> }): string[] =>
		(press.showModal.mock.calls[0][0] as ShownModal).toJSON().components.flatMap((entry) => (entry.component ? [entry.component.custom_id] : []));

	it("shows every field but the match until somebody joins, and only the three a joiner leaves after", async () => {
		const before = pressOf();
		await openSettingsEditor(before, makeRoom({ visibility: "public", boardMessageId: "card-1" }));
		expect(fieldsShown(before)).toEqual(["join", "watch", "buyIn", "voice"]);

		const after = pressOf();
		await openSettingsEditor(after, makeRoom({ visibility: "public", boardMessageId: "card-1", spectatorIds: ["joiner-2"] }));
		expect(fieldsShown(after)).toEqual(["watch", "voice"]);
	});

	it("applies after a joiner only what a joiner leaves editable, whatever the Submit carries", async () => {
		row = makeRoom({ game: "monopoly", visibility: "public", boardMessageId: "card-1", spectatorIds: ["joiner-2"] });

		await confirmSettingsEdit(submitOf("gameroom:editok:room-1", { join: "invite", watch: "none", voice: "on" }), row);

		expect(patches()).toContainEqual({ spectatorMode: "none" });
		expect(patches()).toContainEqual({ deroVoice: true });
		expect(patches().some((patch) => "visibility" in patch)).toBe(false);
	});

	it("changes who can join and the buy in before anybody joins, through the same functions", async () => {
		row = makeRoom({ visibility: "public", boardMessageId: "card-1", holdemBuyIn: 5_000 });

		await confirmSettingsEdit(submitOf("gameroom:editok:room-1", { join: "invite", watch: "invite", buyIn: "", voice: "on" }), row);

		expect(patches()).toContainEqual({ visibility: "invite" });
		// A cleared buy in goes back to the standard stack.
		expect(mocks.store.setHoldemBuyIn).toHaveBeenCalledWith("guild-1", "room-1", 1_000);
	});
});

describe("a held slot at a start that opens a room (R3-9)", () => {
	it("offers to close a held draft at the press, linking its card", async () => {
		mocks.store.findOpenByHost.mockResolvedValue(makeRoom({ roomId: "old-room", game: "monopoly", boardMessageId: "card-9" }));
		const press = pressOf();

		const held = await offerToFreeSlot(press, (roomId) => `arcade_host:replace:solo-hangman:${roomId}`);

		expect(held).toBe(true);
		const modal = (press.showModal.mock.calls[0][0] as { toJSON: () => { custom_id: string } }).toJSON();
		expect(modal.custom_id).toBe("arcade_host:replace:solo-hangman:old-room");
		expect(JSON.stringify(modal)).toContain(`https://discord.com/channels/guild-1/${RATED}/card-9`);
	});

	it("never touches a held running room, naming it where it plays", async () => {
		mocks.store.findOpenByHost.mockResolvedValue(makeRoom({ status: "playing", channelId: "room-ch" }));
		const press = pressOf();

		expect(await offerToFreeSlot(press, () => "unused")).toBe(true);
		expect(JSON.stringify((press.showModal.mock.calls[0][0] as { toJSON: () => unknown }).toJSON())).toContain(gameRoomsCopy.confirms.matchInPlay("room-ch"));
		expect(mocks.store.markArchived).not.toHaveBeenCalled();
	});

	it("answers false when the slot is free, so the start goes ahead", async () => {
		expect(await offerToFreeSlot(pressOf(), () => "unused")).toBe(false);
	});
});
