import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "discord.js";

const mocks = vi.hoisted(() => ({
	findConsent: vi.fn(),
	claimOnConsent: vi.fn(),
	claimOnStamp: vi.fn(),
	findConfig: vi.fn(),
}));

vi.mock("@db/stores/networkConsentStore.js", () => ({
	networkConsentStore: { findByUserId: mocks.findConsent, claimTagNotice: mocks.claimOnConsent },
}));
vi.mock("@db/stores/tagNoticeStore.js", () => ({ tagNoticeStore: { claim: mocks.claimOnStamp } }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findConfig } }));
vi.mock("@utils/config.js", () => ({ botInviteLink: "https://invite.example/dero" }));

import { claimTagNotice, sendTagNotice } from "./tagNotice.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { RatedWin } from "./recordMatchRatings.js";

// ── the tag notice (2026-10 item 244 Phase 5b) ─────────────────────────────
// After a rated win, one line in the channel the winner played in, when the tag they
// wear belongs to a server off the network; never for no tag or a hidden one; at most
// once per 30 days, throttled on the consent row or, for a player who never consented,
// on the small TagNotice row.

const WINNER = "winner-1";
const TAG_GUILD = "100000000000000001";
const NOW = new Date("2026-10-23T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - BOT_CONSTANTS.NETWORK.TAG_NOTICE_INTERVAL_MS);

type Identity = { identityGuildId: string | null; identityEnabled: boolean | null; tag: string | null } | null;

function setup(identity: Identity, botGuilds: string[] = []) {
	const send = vi.fn(async () => undefined);
	const channel = { isTextBased: () => true, send };
	const client = {
		users: { cache: new Map([[WINNER, { id: WINNER, primaryGuild: identity }]]), fetch: vi.fn() },
		guilds: { cache: new Map(botGuilds.map((id) => [id, { id, name: "Tag Server" }])) },
		channels: { fetch: vi.fn(async () => channel) },
	} as unknown as Client;
	return { client, send, fetchChannel: client.channels.fetch as unknown as ReturnType<typeof vi.fn> };
}

const win = (overrides: Partial<RatedWin["room"]> = {}): RatedWin => ({
	room: { roomId: "room-1", guildId: "host-guild", game: "holdem", channelId: "host-ch", satellites: [], ...overrides },
	winnerId: WINNER,
});

const wearing: Identity = { identityGuildId: TAG_GUILD, identityEnabled: true, tag: "ABC" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findConsent.mockResolvedValue(null);
	mocks.claimOnStamp.mockResolvedValue(true);
	mocks.claimOnConsent.mockResolvedValue(true);
	mocks.findConfig.mockResolvedValue(null);
});

describe("sendTagNotice", () => {
	it("invites the winner to bring Dero to a tag server Dero is not in, naming it by its tag", async () => {
		const { client, send } = setup(wearing);
		expect(await sendTagNotice(client, win(), NOW)).toBe(true);
		const content = (send.mock.calls[0] as unknown as [{ content: string }])[0].content;
		expect(content).toContain("**ABC**");
		expect(content).toContain("https://invite.example/dero");
	});

	it("names a tag server Dero is in but that is not on the network, and asks its admins to open it", async () => {
		mocks.findConfig.mockResolvedValue({ guildId: TAG_GUILD, challengeReach: "server" });
		const { client, send } = setup(wearing, [TAG_GUILD]);
		expect(await sendTagNotice(client, win(), NOW)).toBe(true);
		expect((send.mock.calls[0] as unknown as [{ content: string }])[0].content).toContain("**Tag Server**");
	});

	it("says nothing when the tag server is already on the network", async () => {
		mocks.findConfig.mockResolvedValue({ guildId: TAG_GUILD, challengeReach: "network" });
		const { client, send } = setup(wearing, [TAG_GUILD]);
		expect(await sendTagNotice(client, win(), NOW)).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("never says anything to a winner who wears no tag, or hides it, and spends no throttle", async () => {
		for (const identity of [null, { ...wearing, identityEnabled: false }] as Identity[]) {
			const { client, send } = setup(identity);
			expect(await sendTagNotice(client, win(), NOW)).toBe(false);
			expect(send).not.toHaveBeenCalled();
		}
		expect(mocks.claimOnStamp).not.toHaveBeenCalled();
		expect(mocks.claimOnConsent).not.toHaveBeenCalled();
	});

	it("posts in the satellite a network table seats the winner through, not the host room", async () => {
		const { client, fetchChannel } = setup(wearing);
		await sendTagNotice(client, win({ satellites: [{ guildId: "sat-guild", channelId: "sat-ch", userIds: [WINNER], tableMessageId: null }] }), NOW);
		expect(fetchChannel).toHaveBeenCalledWith("sat-ch");
	});

	it("says nothing when the throttle was claimed inside the last 30 days", async () => {
		mocks.claimOnStamp.mockResolvedValue(false);
		const { client, send } = setup(wearing);
		expect(await sendTagNotice(client, win(), NOW)).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("claimTagNotice", () => {
	it("claims on the consent row for a consenting player, with a cutoff 30 days back", async () => {
		mocks.findConsent.mockResolvedValue({ userId: WINNER, version: 1, lastTagNoticeAt: null });
		expect(await claimTagNotice(WINNER, NOW)).toBe(true);
		expect(mocks.claimOnConsent).toHaveBeenCalledWith(WINNER, CUTOFF, NOW);
		expect(mocks.claimOnStamp).not.toHaveBeenCalled();
	});

	it("claims on the small TagNotice row for a player who never consented, never writing a consent row", async () => {
		expect(await claimTagNotice(WINNER, NOW)).toBe(true);
		expect(mocks.claimOnStamp).toHaveBeenCalledWith(WINNER, CUTOFF, NOW);
		expect(mocks.claimOnConsent).not.toHaveBeenCalled();
	});

	it("answers no when the claim lost, so a second rated win inside the window sends nothing", async () => {
		mocks.claimOnStamp.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await claimTagNotice(WINNER, NOW)).toBe(true);
		expect(await claimTagNotice(WINNER, new Date(NOW.getTime() + 60_000))).toBe(false);
	});
});
