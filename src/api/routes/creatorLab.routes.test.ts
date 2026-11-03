import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Client } from "discord.js";

// ── /api/creator-lab route tests (Dero: Creator Lab, 2026-11 item 283 Phases 4 and 5) ──
// The mock first style of pairing.routes.test.ts: the store, the DM dispatcher and the config flag
// are mocked before the router loads, and the router is mounted without verifySignature (covered
// in verifySignature.test.ts). The flag is a getter over hoisted state so one file can test the
// router dark and lit.

const state = vi.hoisted(() => ({ dmEnabled: true, liveEnabled: true }));

vi.mock("@utils/config.js", () => ({
	get creatorLabDmEnabled() {
		return state.dmEnabled;
	},
	get creatorLabLiveEnabled() {
		return state.liveEnabled;
	},
}));
vi.mock("@db/stores/creatorLabLinkStore.js", () => ({
	creatorLabLinkStore: { redeem: vi.fn(), issue: vi.fn() },
	CREATOR_LAB_LINK_CODE_TTL_MS: 900_000,
}));
vi.mock("@db/stores/creatorLabChannelCodeStore.js", () => ({
	creatorLabChannelCodeStore: { redeem: vi.fn(), issue: vi.fn() },
	CREATOR_LAB_CHANNEL_CODE_TTL_MS: 900_000,
}));
vi.mock("@utils/directMessage.js", () => ({ sendDirectMessage: vi.fn() }));

import { createCreatorLabRouter } from "./creatorLab.routes.js";
import { creatorLabLinkStore } from "@db/stores/creatorLabLinkStore.js";
import { creatorLabChannelCodeStore } from "@db/stores/creatorLabChannelCodeStore.js";
import { sendDirectMessage } from "@utils/directMessage.js";

const redeemMock = creatorLabLinkStore.redeem as unknown as ReturnType<typeof vi.fn>;
const channelRedeemMock = creatorLabChannelCodeStore.redeem as unknown as ReturnType<typeof vi.fn>;
const dmMock = sendDirectMessage as unknown as ReturnType<typeof vi.fn>;
const DISCORD_ID = "123456789012345678";

const summary = {
	platform: "youtube",
	videoTitle: "My video",
	commentCount: 120,
	commentSource: "comments",
	themes: [
		{ label: "Audio too quiet", summary: "Many ask for a louder mic.", sentiment: "critical" },
		{ label: "Loves the edits", summary: "Fast cuts land well.", sentiment: "positive" },
	],
};

// The server's buildTipsDmBody shape (weeklyTipsNotice.ts): the niche and one to three English lines.
const tips = {
	niche: "gaming",
	items: ["Say what you are trying to do in the first minute.", "Keep your game audio below your voice."],
};

function buildApp() {
	const app = express();
	app.use(express.json());
	app.use("/api/creator-lab", createCreatorLabRouter({} as Client));
	return app;
}

describe("/api/creator-lab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.dmEnabled = true;
		state.liveEnabled = true;
	});

	it("answers 503 on every route while CREATOR_LAB_DM_ENABLED is off", async () => {
		state.dmEnabled = false;
		const redeem = await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "ABC234" });
		const dm = await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: DISCORD_ID, summary });
		const tipsDm = await request(buildApp()).post("/api/creator-lab/tips-dm").send({ discordUserId: DISCORD_ID, tips });
		expect(redeem.status).toBe(503);
		expect(dm.status).toBe(503);
		expect(tipsDm.status).toBe(503);
		expect(redeemMock).not.toHaveBeenCalled();
		expect(dmMock).not.toHaveBeenCalled();
	});

	it("redeems a live code into who ran the command", async () => {
		redeemMock.mockResolvedValue({ code: "ABC234", discordUserId: DISCORD_ID, discordUsername: "streamer", consumedAt: new Date() });
		const res = await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "abc234" });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ data: { discordUserId: DISCORD_ID, discordUsername: "streamer" } });
		expect(redeemMock).toHaveBeenCalledWith("abc234");
	});

	it("answers one 410 for every miss and 400 for no code at all", async () => {
		redeemMock.mockResolvedValue(null);
		expect((await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "ABC234" })).status).toBe(410);
		expect((await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "  " })).status).toBe(400);
		redeemMock.mockRejectedValue(new Error("mongo blip"));
		expect((await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "ABC234" })).status).toBe(500);
	});

	it("DMs the summary as one embed and reports delivery", async () => {
		dmMock.mockResolvedValue("sent");
		const res = await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: DISCORD_ID, summary });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ data: { delivered: true } });
		const [, userId, message] = dmMock.mock.calls[0] as [unknown, string, { embeds: Array<{ data: { title?: string; fields?: unknown[] } }> }];
		expect(userId).toBe(DISCORD_ID);
		expect(message.embeds[0]?.data.title).toBe("📊 Creator Lab read: My video");
		expect(message.embeds[0]?.data.fields).toHaveLength(2);
	});

	it("tells a closed DM (422) apart from a failed one (502)", async () => {
		dmMock.mockResolvedValueOnce("closed");
		expect((await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: DISCORD_ID, summary })).status).toBe(422);
		dmMock.mockResolvedValueOnce("failed");
		expect((await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: DISCORD_ID, summary })).status).toBe(502);
	});

	it("refuses a drifted body without trying Discord", async () => {
		const noThemes = await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: DISCORD_ID, summary: { ...summary, themes: [] } });
		const badId = await request(buildApp()).post("/api/creator-lab/dm").send({ discordUserId: "everyone", summary });
		expect(noThemes.status).toBe(400);
		expect(badId.status).toBe(400);
		expect(dmMock).not.toHaveBeenCalled();
	});

	it("DMs the weekly tips as one embed, one numbered field per tip", async () => {
		dmMock.mockResolvedValue("sent");
		const res = await request(buildApp()).post("/api/creator-lab/tips-dm").send({ discordUserId: DISCORD_ID, tips });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ data: { delivered: true } });
		const [, userId, message] = dmMock.mock.calls[0] as [unknown, string, { embeds: Array<{ data: { title?: string; fields?: Array<{ name: string; value: string }> } }> }];
		expect(userId).toBe(DISCORD_ID);
		expect(message.embeds[0]?.data.title).toBe("💡 Your Creator Lab tips this week");
		expect(message.embeds[0]?.data.fields).toEqual([
			{ name: "Tip 1", value: tips.items[0], inline: false },
			{ name: "Tip 2", value: tips.items[1], inline: false },
		]);
	});

	it("answers the tips DM's delivery like the analysis DM's (422 closed, 502 failed)", async () => {
		dmMock.mockResolvedValueOnce("closed");
		expect((await request(buildApp()).post("/api/creator-lab/tips-dm").send({ discordUserId: DISCORD_ID, tips })).status).toBe(422);
		dmMock.mockResolvedValueOnce("failed");
		expect((await request(buildApp()).post("/api/creator-lab/tips-dm").send({ discordUserId: DISCORD_ID, tips })).status).toBe(502);
	});

	it("refuses a drifted tips body without trying Discord", async () => {
		const send = (body: unknown) => request(buildApp()).post("/api/creator-lab/tips-dm").send(body as object);
		expect((await send({ discordUserId: DISCORD_ID, tips: { ...tips, items: [] } })).status).toBe(400);
		expect((await send({ discordUserId: DISCORD_ID, tips: { ...tips, items: ["a", "b", "c", "d"] } })).status).toBe(400);
		expect((await send({ discordUserId: DISCORD_ID, tips: { ...tips, niche: "" } })).status).toBe(400);
		expect((await send({ discordUserId: "everyone", tips })).status).toBe(400);
		expect(dmMock).not.toHaveBeenCalled();
	});

	// ── Live capture's channel code (2026-11 item 284 Phase 3) ──
	describe("POST /live-link/redeem", () => {
		const redeemLive = (body: Record<string, unknown>) => request(buildApp()).post("/api/creator-lab/live-link/redeem").send(body);

		it("answers where the code was issued, for the server to bind the app's live capture", async () => {
			channelRedeemMock.mockResolvedValue({
				code: "ABC234",
				guildId: "700000000000000001",
				channelId: "700000000000000002",
				guildName: "Harbor Discord",
				channelName: "stream-chat",
				discordUserId: DISCORD_ID,
				consumedAt: new Date(),
			});
			const res = await redeemLive({ code: "abc234" });
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				data: { guildId: "700000000000000001", channelId: "700000000000000002", discordUserId: DISCORD_ID, guildName: "Harbor Discord", channelName: "stream-chat" },
			});
			expect(channelRedeemMock).toHaveBeenCalledWith("abc234");
		});

		it("answers one 410 for any dead code and 400 for no code", async () => {
			channelRedeemMock.mockResolvedValue(null);
			expect((await redeemLive({ code: "ZZZ999" })).status).toBe(410);
			expect((await redeemLive({})).status).toBe(400);
		});

		it("follows its own switch, not the DM one, in both directions", async () => {
			state.liveEnabled = false;
			expect((await redeemLive({ code: "ABC234" })).status).toBe(503);
			expect(channelRedeemMock).not.toHaveBeenCalled();

			state.liveEnabled = true;
			state.dmEnabled = false;
			channelRedeemMock.mockResolvedValue(null);
			expect((await redeemLive({ code: "ABC234" })).status).toBe(410);
			expect((await request(buildApp()).post("/api/creator-lab/link/redeem").send({ code: "ABC234" })).status).toBe(503);
		});
	});
});
