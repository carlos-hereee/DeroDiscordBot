import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";

vi.mock("@db/stores/gameRoomStore.js", () => ({
	gameRoomStore: {
		findByRoomId: vi.fn(),
		update: vi.fn(),
		addPoolMember: vi.fn(),
		addPendingJoin: vi.fn(),
	},
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: vi.fn() } }));
vi.mock("@db/stores/playerRatingStore.js", () => ({ playerRatingStore: { findForPlayers: vi.fn() } }));
vi.mock("./RoomProvisioner.js", () => ({ RoomProvisioner: { open: vi.fn() }, describeRoomOpenFailure: () => "nope" }));
vi.mock("./soloRooms.js", () => ({ readPrivateQuotaStatus: vi.fn().mockResolvedValue(null) }));
vi.mock("./challengeCardRenderer.js", () => ({ renderChallengeCard: vi.fn().mockResolvedValue(null), challengeCardView: vi.fn().mockResolvedValue({}) }));

import { chooseVisibility, handleInviteSelect, handleOpponentSelect, joinChallenge, openInvitePicker } from "./challengeBoard.js";
import { openerCardRows, type OpenerCardState } from "./challengeBoardEmbeds.js";
import { gameRoomStore } from "@db/stores/gameRoomStore.js";
import { guildConfigStore } from "@db/stores/guildConfigStore.js";
import { playerRatingStore } from "@db/stores/playerRatingStore.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";
import type { IGameRoom } from "@db/models/GameRoom.js";

// ── the challenge card under the host controls (2026-10 item 244 Phase 4) ──
// What:  the server's reach caps the visibility a host is offered AND may choose; the
//        card's Join reads the join gate (removed, band, approval); and a member the
//        host removed cannot come back through the invite picker or the opponent select.

const words = rokCommanderCopy.arcadeHostControls;
type Mock = ReturnType<typeof vi.fn>;
const storeMock = gameRoomStore as unknown as Record<"findByRoomId" | "update" | "addPoolMember" | "addPendingJoin", Mock>;
const configMock = guildConfigStore.findByGuildId as unknown as Mock;
const ratingsMock = playerRatingStore.findForPlayers as unknown as Mock;

const HOST = "host-1";
const JOINER = "joiner-1";
const SETTLED = BOT_CONSTANTS.RATINGS.PROVISIONAL_GAMES;

const makeRoom = (overrides: Partial<IGameRoom> = {}): IGameRoom =>
	({
		roomId: "room-1",
		guildId: "guild-1",
		game: "holdem",
		hostId: HOST,
		playerIds: [HOST],
		spectatorIds: [],
		pendingJoinIds: [],
		kickedIds: [],
		ratingBand: "any",
		requireApproval: false,
		visibility: "public",
		status: "draft",
		channelId: null,
		boardMessageId: null,
		...overrides,
	}) as unknown as IGameRoom;

const members = new Map(
	[HOST, JOINER, "kicked-1", "member-2"].map((id) => [id, { id, displayName: id, user: { bot: false, username: id } }])
);
const memberCache = {
	size: members.size,
	get: (id: string) => members.get(id),
	filter(predicate: (member: { id: string; user: { bot: boolean } }) => boolean) {
		const kept = [...members.values()].filter(predicate);
		return { map: <T>(fn: (member: (typeof kept)[number]) => T) => kept.map(fn) };
	},
};
const guild = { id: "guild-1", members: { cache: memberCache, fetch: vi.fn(async (id?: string) => (id ? members.get(id) ?? null : memberCache)) } };

function makeButton(userId: string): ButtonInteraction {
	return {
		guildId: "guild-1",
		guild,
		user: { id: userId },
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	} as unknown as ButtonInteraction;
}

function makeSelect(action: string, values: string[]): StringSelectMenuInteraction {
	return {
		customId: `gameroomSelect:${action}:room-1`,
		guildId: "guild-1",
		guild,
		user: { id: HOST },
		values,
		client: {},
		reply: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
	} as unknown as StringSelectMenuInteraction;
}

const replyText = (interaction: { reply: unknown }): string =>
	(((interaction.reply as Mock).mock.calls[0]?.[0] ?? {}) as { content?: string }).content ?? "";

const rated = (userId: string, displayRating: number, ratedGames = SETTLED) => ({ userId, game: "holdem", mu: 25, sigma: 1, displayRating, ratedGames, lastRatedAt: new Date() });

beforeEach(() => {
	vi.clearAllMocks();
	configMock.mockResolvedValue(null);
	ratingsMock.mockResolvedValue([]);
	storeMock.update.mockImplementation(async (_guildId: string, _roomId: string, patch: Partial<IGameRoom>) => makeRoom(patch));
	storeMock.addPoolMember.mockResolvedValue(makeRoom({ spectatorIds: [JOINER] }));
	storeMock.addPendingJoin.mockResolvedValue(makeRoom({ pendingJoinIds: [JOINER] }));
	storeMock.findByRoomId.mockResolvedValue(makeRoom());
});

describe("the server's challenge reach", () => {
	const firstStep = (allowPublic?: boolean): OpenerCardState => ({ game: "holdem", hostId: HOST, visibility: null, pool: [], ...(allowPublic === undefined ? {} : { allowPublic }) });
	const visibilityChoices = (state: OpenerCardState): string[] =>
		openerCardRows("room-1", state)
			.flatMap((row) => row.toJSON().components)
			.map((component) => ("custom_id" in component ? component.custom_id : ""))
			.filter((id) => id.includes(":vis:"));

	it("offers Invite only and Open to all at Server and Network reach", () => {
		expect(visibilityChoices(firstStep(true))).toEqual(["gameroom:vis:room-1:invite", "gameroom:vis:room-1:public"]);
		expect(visibilityChoices(firstStep())).toEqual(["gameroom:vis:room-1:invite", "gameroom:vis:room-1:public"]);
	});

	it("offers Invite only alone at Invite only reach", () => {
		expect(visibilityChoices(firstStep(false))).toEqual(["gameroom:vis:room-1:invite"]);
	});

	it("refuses Open to all server side at Invite only reach, writing nothing, even from a stale card", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		const interaction = makeButton(HOST);

		await chooseVisibility(interaction, makeRoom({ visibility: "invite" }), "public");

		expect(replyText(interaction)).toBe(words.reach.publicRefused);
		expect(storeMock.update).not.toHaveBeenCalled();
	});

	it("still lets an invite only server choose Invite only, and a Server reach choose Open to all", async () => {
		configMock.mockResolvedValue({ challengeReach: "invite-only" });
		await chooseVisibility(makeButton(HOST), makeRoom(), "invite");
		configMock.mockResolvedValue({ challengeReach: "server" });
		await chooseVisibility(makeButton(HOST), makeRoom(), "public");

		expect(storeMock.update.mock.calls.map((call) => call[2])).toEqual([{ visibility: "invite" }, { visibility: "public" }]);
	});
});

describe("Join on an open challenge", () => {
	it("refuses a member the host removed", async () => {
		const interaction = makeButton("kicked-1");
		await joinChallenge(interaction, makeRoom({ kickedIds: ["kicked-1"] }));

		expect(replyText(interaction)).toBe(words.kick.refusedRejoin);
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
		expect(storeMock.addPendingJoin).not.toHaveBeenCalled();
	});

	it("refuses a settled rating outside the host's band", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1300), rated(JOINER, 1000)]);
		const interaction = makeButton(JOINER);

		await joinChallenge(interaction, makeRoom({ ratingBand: "close" }));

		expect(replyText(interaction)).toBe(words.band.refused(gameRoomsCopy.gameLabel("holdem")));
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
	});

	it("lets a provisional joiner past the band", async () => {
		ratingsMock.mockResolvedValue([rated(HOST, 1300), rated(JOINER, 1000, SETTLED - 1)]);
		await joinChallenge(makeButton(JOINER), makeRoom({ ratingBand: "tight" }));

		expect(storeMock.addPoolMember).toHaveBeenCalledWith("guild-1", "room-1", JOINER);
	});

	it("turns the join into a request when the host approves each joiner", async () => {
		const interaction = makeButton(JOINER);
		await joinChallenge(interaction, makeRoom({ requireApproval: true }));

		expect(storeMock.addPendingJoin).toHaveBeenCalledWith("guild-1", "room-1", JOINER);
		expect(storeMock.addPoolMember).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(words.approval.asked);
	});

	it("refuses a removal that landed between the gate and the write", async () => {
		storeMock.addPoolMember.mockResolvedValue(null);
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ kickedIds: [JOINER] }));
		const interaction = makeButton(JOINER);

		await joinChallenge(interaction, makeRoom());

		expect(replyText(interaction)).toBe(words.kick.refusedRejoin);
	});
});

describe("a removed member cannot come back by a select", () => {
	it("is never offered by the invite picker", async () => {
		const interaction = makeButton(HOST);
		await openInvitePicker(interaction, makeRoom({ visibility: "invite", kickedIds: ["kicked-1"] }));

		const payload = (interaction.reply as Mock).mock.calls[0][0] as { components: { toJSON(): { components: { options?: { value: string }[] }[] } }[] };
		const offered = payload.components[0].toJSON().components[0].options?.map((option) => option.value) ?? [];
		expect(offered).toContain("member-2");
		expect(offered).not.toContain("kicked-1");
	});

	it("is filtered out of an invite submission that names them anyway", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ visibility: "invite", kickedIds: ["kicked-1"] }));

		await handleInviteSelect(makeSelect("invite", ["kicked-1", "member-2"]));

		expect(storeMock.update).toHaveBeenCalledWith("guild-1", "room-1", { spectatorIds: ["member-2"] });
	});

	it("is refused by the opponent select", async () => {
		storeMock.findByRoomId.mockResolvedValue(makeRoom({ game: "rps", spectatorIds: ["kicked-1"], kickedIds: ["kicked-1"] }));
		const interaction = makeSelect("opponent", ["kicked-1"]);

		await handleOpponentSelect(interaction);

		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(replyText(interaction)).toBe(gameRoomsCopy.board.poolEmpty);
	});
});
