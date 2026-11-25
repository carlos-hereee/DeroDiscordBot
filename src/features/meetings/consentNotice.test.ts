import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, Client } from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { IMeetingConsent } from "@db/models/MeetingConsent.js";

// The three mcon buttons pressed through their registered handler, over an in memory consent
// row, one open meeting and the recorder's two sweeps faked (2026-11 item 420, L1 and L6):
// either button withdraws, every reply is true, and nothing a withdrawal depends on (the config
// read, the answer, the consent write) can stop it once the button was pressed.

type Row = Pick<IMeetingConsent, "version" | "revokedAt">;

const m = vi.hoisted(() => ({
	row: null as Row | null,
	words: new Map<string, number>(),
	steps: [] as string[],
	notices: [] as string[],
	configRead: async (): Promise<unknown> => null,
	showNotice: async (): Promise<void> => undefined,
	revokeFails: false,
	acceptFails: false,
	deleteFails: false,
	handler: null as ((interaction: unknown) => Promise<void>) | null,
	posts: [] as Array<{ content?: string; allowedMentions: { users: string[] }; description: string }>,
	refusePost: (_index: number) => false,
}));

vi.mock("@handlers/interactionRegistry.js", () => ({ registerButton: (_prefix: string, handler: typeof m.handler) => (m.handler = handler) }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: () => m.configRead() } }));
vi.mock("@utils/textModal.js", () => ({
	showNotice: async (_interaction: unknown, content: { sections: string[] }) => {
		await m.showNotice();
		m.notices.push(content.sections.join("\n"));
	},
}));
vi.mock("@utils/cardMessage.js", () => ({
	postInChannel: async (_client: unknown, _channelId: string, payload: { content?: string; allowedMentions: { users: string[] }; embeds: Array<{ data: { description?: string } }> }) => {
		const refused = m.refusePost(m.posts.length);
		m.posts.push({ content: payload.content, allowedMentions: payload.allowedMentions, description: payload.embeds[0]?.data.description ?? "" });
		return !refused;
	},
}));
vi.mock("@db/stores/meetingConsentStore.js", () => ({
	meetingConsentStore: {
		findByMember: async () => (m.row ? { ...m.row } : null),
		findActiveRows: async () => [],
		accept: async (_g: string, _u: string, version: number) => {
			if (m.acceptFails) throw new Error("mongo down");
			m.steps.push("accept");
			m.row = { version, revokedAt: null };
		},
		revoke: async (_g: string, _u: string, revokedAt: Date) => {
			if (m.revokeFails) throw new Error("mongo down");
			m.steps.push("revoke");
			if (!m.row || m.row.revokedAt) return false;
			m.row.revokedAt = revokedAt;
			return true;
		},
	},
}));
vi.mock("@db/stores/meetingStore.js", () => ({
	meetingStore: {
		findOpenIds: async () => ["open1"],
		hasSpeaker: async (_g: string, _id: string, userId: string) => m.words.has(userId),
		removeSpeaker: async () => undefined,
	},
}));
vi.mock("@db/stores/meetingTranscriptStore.js", () => ({
	meetingTranscriptStore: {
		hasSpeaker: async (_g: string, _id: string, userId: string) => m.words.has(userId),
		deleteForSpeaker: async (_g: string, _ids: readonly string[], userId: string) => {
			if (m.deleteFails) throw new Error("mongo down");
			m.steps.push("deleteWords");
			const had = m.words.get(userId) ?? 0;
			m.words.delete(userId);
			return had;
		},
	},
}));
vi.mock("@db/stores/meetingSummaryJobStore.js", () => ({ meetingSummaryJobStore: { resetLease: async () => undefined } }));
vi.mock("./meetingRecorder.js", () => ({
	dropSpeakerEverywhere: async () => void m.steps.push("drop"),
	allowSpeakerEverywhere: () => void m.steps.push("allow"),
}));

const consent = await import("./meetingConsent.js");
const { buildConsentNotice, postConsentNotice, registerConsentButtons } = await import("./consentNotice.js");
const { getPluginCopy } = await import("@base/copy/index.js");

const words = getPluginCopy(null).meetingRecording.consent;
const CURRENT = BOT_CONSTANTS.MEETINGS.CONSENT_VERSION;
const agreedRow = (): Row => ({ version: CURRENT, revokedAt: null });
const revokedRow = (): Row => ({ version: CURRENT, revokedAt: new Date("2026-11-20T00:00:00Z") });
const onChange = vi.fn(async () => undefined);

const press = (action: "agree" | "decline" | "revoke"): Promise<void> =>
	m.handler!({ customId: `mcon:${action}:mtg1`, guildId: "g1", user: { id: "alice" }, client: {} as Client } as unknown as ButtonInteraction);

beforeEach(() => {
	Object.assign(m, { posts: [], refusePost: () => false, row: null, steps: [], notices: [], configRead: async () => null, showNotice: async () => undefined, revokeFails: false, acceptFails: false, deleteFails: false });
	m.words.clear();
	onChange.mockClear();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	consent._resetMeetingConsentCache();
	registerConsentButtons(onChange);
});

describe("No thanks (L1)", () => {
	it("L1: No thanks after a yes is a full withdrawal: capture dropped, row revoked, words removed, and the reply says so", async () => {
		m.row = agreedRow();
		m.words.set("alice", 3);
		await press("decline");
		expect(m.steps).toEqual(["drop", "revoke", "deleteWords"]);
		expect(m.row?.revokedAt).toBeInstanceOf(Date);
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);
		expect(m.notices).toEqual([words.revoked]);
		expect(onChange).toHaveBeenCalledWith(expect.anything(), "g1", "alice");
	});

	it("L1: a member who never agreed is told so and gains no row, on either button", async () => {
		await press("decline");
		await press("revoke");
		expect(m.row).toBeNull();
		expect(m.steps).not.toContain("accept");
		expect(m.notices).toEqual([words.declined, words.notAgreed]);
	});

	it("L1: a member already withdrawn is told only that Dero does not record them, on either button", async () => {
		m.row = revokedRow();
		await press("decline");
		await press("revoke");
		expect(words.alreadyWithdrawn).toBeTruthy();
		expect(m.notices).toEqual([words.alreadyWithdrawn, words.alreadyWithdrawn]);
		expect(words.alreadyWithdrawn).not.toContain("stored");
	});

	it("L1: the notice says No thanks ends an earlier yes, and its last sentence names both buttons", () => {
		const payload = buildConsentNotice(getPluginCopy(null), { meetingId: "abc", title: "Sync", hostId: "host", memberIds: ["carol"] });
		const body = (payload.embeds?.[0] as { data: { description?: string } }).data.description ?? "";
		expect(body).toMatch(/No thanks:.*earlier yes/);
		const last = body.trim().split(/(?<=\.)\s+/).at(-1) ?? "";
		expect(last).toContain("No thanks");
		expect(last).toContain("Stop recording me");
	});
});

describe("nothing stops a withdrawal once the button was pressed (L1)", () => {
	it.each(["decline", "revoke"] as const)("L1: %s withdraws when the config read fails, and is still answered", async (action) => {
		m.row = agreedRow();
		m.words.set("alice", 1);
		m.configRead = async () => Promise.reject(new Error("mongo down"));
		await press(action);
		expect(m.row?.revokedAt).toBeInstanceOf(Date);
		expect(m.words.size).toBe(0);
		expect(m.notices).toEqual([words.revoked]);
	});

	it("L1: a config read that never ends holds up neither the drop, the row nor the removal", async () => {
		m.row = agreedRow();
		m.words.set("alice", 1);
		m.configRead = () => new Promise(() => undefined);
		void press("decline");
		await vi.waitFor(() => expect(m.steps).toEqual(["drop", "revoke", "deleteWords"]));
	});

	it.each(["decline", "revoke"] as const)("L1: %s still removes the words when the answer fails", async (action) => {
		m.row = agreedRow();
		m.words.set("alice", 1);
		m.showNotice = async () => Promise.reject(new Error("unknown interaction"));
		await press(action).catch(() => undefined);
		expect(m.row?.revokedAt).toBeInstanceOf(Date);
		expect(m.words.size).toBe(0);
	});

	it("L1: a withdrawal whose write failed answers an error, never revoked, and the member is unheard until it is retried", async () => {
		m.row = agreedRow();
		m.words.set("alice", 1);
		m.revokeFails = true;
		await press("decline").catch(() => undefined);
		expect(words.withdrawFailed).toBeTruthy();
		expect(m.notices).toEqual([words.withdrawFailed]);
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);
		m.revokeFails = false;
		await consent.retryOwedWithdrawals();
		expect(m.row?.revokedAt).toBeInstanceOf(Date);
		expect(m.words.size).toBe(0);
	});

	it("L5: a removal that failed is kept and finished by the repair pass", async () => {
		m.row = agreedRow();
		m.words.set("alice", 2);
		m.deleteFails = true;
		await press("revoke").catch(() => undefined);
		expect(m.notices).toEqual([words.revoked]);
		expect(m.words.get("alice")).toBe(2);
		m.deleteFails = false;
		await consent.retryOwedWithdrawals();
		expect(m.words.size).toBe(0);
	});
});

describe("postConsentNotice (L3)", () => {
	const { MAX_MESSAGE_LENGTH, MAX_MENTIONED_IDS, MAX_EMBED_DESCRIPTION_LENGTH } = BOT_CONSTANTS.DISCORD_LIMITS;
	const members = (count: number): string[] => Array.from({ length: count }, (_unused, index) => String(1_000_000_000_000_000_000n + BigInt(index)));
	const post = (memberIds: string[]) => postConsentNotice({} as Client, "notes", getPluginCopy(null), { meetingId: "abc", title: "x".repeat(BOT_CONSTANTS.MEETINGS.TITLE_MAX), hostId: "1".repeat(19), memberIds });

	it.each([1, 85, 250])("L3: %i members are each named in exactly one notice, inside every Discord limit", async (count) => {
		const ids = members(count);
		expect(await post(ids)).toEqual(ids);
		const named = m.posts.flatMap((sent) => [...(sent.content ?? "").matchAll(/<@(\d+)>/g)].map((match) => match[1]));
		expect(named).toEqual(ids);
		expect(m.posts.flatMap((sent) => sent.allowedMentions.users)).toEqual(ids);
		for (const sent of m.posts) {
			expect((sent.content ?? "").length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
			expect(sent.allowedMentions.users.length).toBeLessThanOrEqual(MAX_MENTIONED_IDS);
			expect(sent.description.length).toBeLessThanOrEqual(MAX_EMBED_DESCRIPTION_LENGTH);
		}
	});

	it("L3: a refused batch leaves exactly its own members unasked", async () => {
		const ids = members(250);
		m.refusePost = (index) => index === 1;
		const asked = await post(ids);
		const refused = m.posts[1].allowedMentions.users;
		expect(refused.length).toBeGreaterThan(0);
		expect(asked).toEqual(ids.filter((id) => !refused.includes(id)));
	});
});

describe("I agree (L6)", () => {
	it("records a member again only once the yes stood", async () => {
		await press("agree");
		expect(m.steps).toEqual(["accept", "allow"]);
		expect(m.notices).toEqual([words.agreed]);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("L6: an agree over a removal still owed runs the removal first, and fails with its own line when that fails", async () => {
		m.row = revokedRow();
		m.words.set("alice", 2);
		m.deleteFails = true;
		await press("agree");
		expect(m.steps).not.toContain("accept");
		expect(m.steps).not.toContain("allow");
		expect(m.notices).toEqual([words.agreeFailed]);
		expect(await consent.hasMeetingConsent("g1", "alice")).toBe(false);

		m.deleteFails = false;
		await press("agree");
		expect(m.steps).toEqual(["deleteWords", "accept", "allow"]);
		expect(m.notices.at(-1)).toBe(words.agreed);
	});

	it("L6: an agree whose write failed says so and records nobody", async () => {
		m.acceptFails = true;
		await press("agree").catch(() => undefined);
		expect(m.notices).toEqual([words.agreeFailed]);
		expect(m.steps).not.toContain("allow");
	});
});
