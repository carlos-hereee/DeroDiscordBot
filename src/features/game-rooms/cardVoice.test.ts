import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, Guild } from "discord.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── cardVoice (2026-10 item 267, decisions 11 and 12) ──
// A card with Dero voice on asks for Dero as it posts: the host's call, else the Arcade
// Lounge. A busy Dero is never queued by itself: the card offers the host Queue Dero, whose
// Submit queues once and posts one admin log entry. Calling the card off takes the request
// out and ends only a call this card started.

const mocks = vi.hoisted(() => ({
	session: null as { channelId: string; startedByRoomId: string | null } | null,
	leave: vi.fn(),
	runner: vi.fn(),
	postNotice: vi.fn(async () => undefined),
	refreshCard: vi.fn(async () => undefined),
	showNotice: vi.fn(async () => undefined),
	showConfirm: vi.fn(async () => undefined),
	acknowledgeConfirm: vi.fn(async () => undefined),
	logWrite: vi.fn(async () => ({ persisted: true, posted: true, message: { channelId: "log-ch", messageId: "entry-1" } })),
	lounge: "vc-lounge" as string | null,
}));

vi.mock("@features/voice/voiceSessions.js", () => ({ voiceSessions: { get: () => mocks.session, leave: mocks.leave } }));
// The real queue, its session and order read from this test, with the runner as a spy.
vi.mock("@features/voice/voiceQueue.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@features/voice/voiceQueue.js")>();
	const { DEFAULT_VOICE_PRIORITY_ORDER } = await import("@features/voice/voicePriority.js");
	const voiceQueue = actual.createVoiceQueue({ now: () => Date.now(), sessionChannelId: () => mocks.session?.channelId ?? null, loadOrder: async () => [...DEFAULT_VOICE_PRIORITY_ORDER] });
	voiceQueue.useRunner(mocks.runner);
	return { ...actual, voiceQueue };
});
vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({ deroVoiceConfigStore: { findByGuildId: vi.fn(async () => null) } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn(async () => ({ arcadeVoiceChannelId: mocks.lounge, adminRoleId: null })) } }));
vi.mock("@db/stores/gameRoomStore.js", () => ({ gameRoomStore: { findByRoomId: vi.fn(async () => ({ ...ROOM, status: "draft" })) } }));
vi.mock("@features/voice/joinNotice.js", () => ({ postVoiceNotice: mocks.postNotice }));
vi.mock("./challengeCard.js", () => ({ cardStateFor: vi.fn(() => ({})), refreshCard: mocks.refreshCard }));
vi.mock("./roomReferee.js", () => ({ matchCategory: () => "casual-match" }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice, showConfirm: mocks.showConfirm, acknowledgeConfirm: mocks.acknowledgeConfirm }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: vi.fn() }));
vi.mock("@features/setup/adminLog.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@features/setup/adminLog.js")>();
	return { ...actual, adminLog: { write: mocks.logWrite } };
});

import { voiceQueue } from "@features/voice/voiceQueue.js";
import { createQueueChangeListener } from "@features/voice/voiceQueueLog.js";
import { bringDeroToCard, confirmQueue, offerQueue, releaseCard } from "./cardVoice.js";
import { cardVoiceState } from "./cardVoiceState.js";
import { openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";
import { HOST_STRICT_ACTIONS } from "./gameRoomActions.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { ConfirmInteraction } from "@utils/textModal.js";

const HOST = "host";
const ROOM = { roomId: "room-1", guildId: "g1", hostId: HOST, game: "coinflip", deroVoice: true, visibility: "public", spectatorIds: [] } as unknown as IGameRoom;

function guildWith(hostCall: string | null): Guild {
	const voiceStates = new Map(hostCall ? [[HOST, { channelId: hostCall }]] : []);
	return { id: "g1", client: {}, voiceStates: { cache: voiceStates } } as unknown as Guild;
}

function hostPress(guild: Guild) {
	const deferUpdate = vi.fn(async () => undefined);
	const interaction = { guild, guildId: "g1", channelId: "card-ch", user: { id: HOST }, isMessageComponent: () => true, isFromMessage: () => true, deferUpdate };
	return interaction as unknown as ButtonInteraction & ConfirmInteraction;
}

const waiting = () => voiceQueue.list("g1", ["meeting-hall", "rated-match", "casual-match", "arcade-lounge", "other"]);

beforeEach(() => {
	for (const request of waiting()) voiceQueue.remove("g1", request.id);
	cardVoiceState._reset();
	mocks.session = null;
	mocks.lounge = "vc-lounge";
	mocks.runner.mockReset().mockResolvedValue("joined");
	for (const mock of [mocks.leave, mocks.postNotice, mocks.refreshCard, mocks.showNotice, mocks.showConfirm, mocks.acknowledgeConfirm, mocks.logWrite]) mock.mockClear();
});

describe("a card with Dero voice on, as it posts", () => {
	it("asks for Dero in the host's call, as a game request a non speaker host may make", async () => {
		await bringDeroToCard(guildWith("vc-host"), ROOM, "card-ch");
		expect(mocks.runner).toHaveBeenCalledWith(
			expect.objectContaining({ requesterId: HOST, channelId: "vc-host", controlChannelId: "card-ch", gameVoice: expect.objectContaining({ roomId: "room-1", followsHost: true }) })
		);
	});

	it("asks for the Arcade Lounge when the host is in no call", async () => {
		await bringDeroToCard(guildWith(null), ROOM, "card-ch");
		expect(mocks.runner).toHaveBeenCalledWith(expect.objectContaining({ channelId: "vc-lounge", gameVoice: expect.objectContaining({ followsHost: false }) }));
	});

	it("says so on the card's channel when there is no call and no Lounge", async () => {
		mocks.lounge = null;
		await bringDeroToCard(guildWith(null), ROOM, "card-ch");
		expect(mocks.runner).not.toHaveBeenCalled();
		expect(mocks.postNotice).toHaveBeenCalledWith(expect.anything(), "card-ch", gameRoomsCopy.cardVoice.noLounge);
	});

	it("asks for nothing with Dero voice off", async () => {
		await bringDeroToCard(guildWith("vc-host"), { ...ROOM, deroVoice: false } as IGameRoom, "card-ch");
		expect(mocks.runner).not.toHaveBeenCalled();
		expect(cardVoiceState.wasRequested("room-1")).toBe(false);
	});

	it("never queues by itself while Dero is busy: the card offers Queue Dero instead", async () => {
		mocks.session = { channelId: "vc-busy", startedByRoomId: null };
		await bringDeroToCard(guildWith("vc-host"), ROOM, "card-ch");
		expect(waiting()).toEqual([]);
		expect(cardVoiceState.get("room-1")).toMatchObject({ kind: "busy", busyChannelId: "vc-busy" });
		expect(mocks.refreshCard).toHaveBeenCalled();
	});
});

describe("Queue Dero on the card", () => {
	const busyCard = (voice: OpenerCardState["voice"]): OpenerCardState => ({
		game: "coinflip",
		hostId: HOST,
		visibility: "public",
		pool: [],
		hostControls: { ratingBand: "any", requireApproval: false, pendingJoinCount: 0, spectatorMode: "public" },
		voice,
	});
	const customIds = (state: OpenerCardState) => openerCardRows("room-1", state).flatMap((row) => row.components.map((component) => (component.data as { custom_id?: string }).custom_id));

	it("shows only while Dero is busy and the card is not queued, keeps every row at five, and is the host's alone", () => {
		expect(customIds(busyCard({ kind: "busy", guildId: "g1", busyChannelId: "vc-busy" }))).toContain("gameroom:dqueue:room-1");
		expect(customIds(busyCard({ kind: "queued", guildId: "g1", requestId: "r", place: 1, total: 1 }))).not.toContain("gameroom:dqueue:room-1");
		expect(customIds(busyCard(null))).not.toContain("gameroom:dqueue:room-1");
		for (const row of openerCardRows("room-1", busyCard({ kind: "busy", guildId: "g1", busyChannelId: "vc-busy" }))) expect(row.components.length).toBeLessThanOrEqual(5);
		expect(HOST_STRICT_ACTIONS.has("dqueue")).toBe(true);
		expect(HOST_STRICT_ACTIONS.has("dqueueok")).toBe(true);
	});

	it("opens a modal saying where Dero is and the place the card would take", async () => {
		mocks.session = { channelId: "vc-busy", startedByRoomId: null };
		const guild = guildWith("vc-host");
		const interaction = hostPress(guild);
		await offerQueue(interaction, ROOM);
		expect(mocks.showConfirm).toHaveBeenCalledWith(
			interaction,
			expect.objectContaining({ sections: [gameRoomsCopy.cardVoice.confirmWhere("vc-busy"), gameRoomsCopy.cardVoice.confirmPlace(1, 1, "vc-host")], confirmId: "gameroom:dqueueok:room-1" })
		);
	});

	it("queues the card once on Submit, with one admin log entry, and its line says the place", async () => {
		mocks.session = { channelId: "vc-busy", startedByRoomId: null };
		voiceQueue.onChange(createQueueChangeListener(voiceQueue));
		const guild = guildWith("vc-host");
		await confirmQueue(hostPress(guild), ROOM);
		await confirmQueue(hostPress(guild), ROOM);
		expect(waiting()).toHaveLength(1);
		expect(cardVoiceState.get("room-1")).toMatchObject({ kind: "queued", place: 1, total: 1 });
		expect(mocks.showNotice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sections: [gameRoomsCopy.cardVoice.alreadyQueued(1, 1)] }));
		await vi.waitFor(() => expect(mocks.logWrite).toHaveBeenCalledTimes(1));
		expect(mocks.logWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: "voice.queue", actor: { userId: HOST } }));
	});
});

describe("calling the card off", () => {
	it("takes its request out of the queue and ends a call this card started", async () => {
		mocks.session = { channelId: "vc-busy", startedByRoomId: null };
		await confirmQueue(hostPress(guildWith("vc-host")), ROOM);
		mocks.session = { channelId: "vc-host", startedByRoomId: "room-1" };
		await releaseCard(guildWith("vc-host"), "room-1");
		expect(waiting()).toEqual([]);
		expect(mocks.leave).toHaveBeenCalledWith("g1");
		expect(cardVoiceState.get("room-1")).toBeNull();
	});

	it("never ends a call someone started with /dero join, or another card's", async () => {
		mocks.session = { channelId: "vc-host", startedByRoomId: null };
		await releaseCard(guildWith("vc-host"), "room-1");
		mocks.session = { channelId: "vc-host", startedByRoomId: "room-2" };
		await releaseCard(guildWith("vc-host"), "room-1");
		expect(mocks.leave).not.toHaveBeenCalled();
	});
});
