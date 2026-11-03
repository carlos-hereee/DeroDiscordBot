import { describe, it, expect, vi, beforeEach } from "vitest";
import { ButtonStyle } from "discord.js";

// ── the Listen button ──────────────────────────────────────────────────────
// One helper decides whether a guild gets the button and whether a click is
// refused; these cases pin that it is the same decision in both places, and
// that attaching it can never throw into the post it rides on.

const mocks = vi.hoisted(() => ({ findByGuildId: vi.fn() }));

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: { findByGuildId: mocks.findByGuildId },
}));

import { attachListenRow, buildListenRow, listenRefusal, maybeListenRow, LISTEN_PREFIX } from "./listenButton.js";

const READY = { enabled: true, listenEnabled: true, voiceId: "abcDEF1234567890wxyz" };

beforeEach(() => {
	mocks.findByGuildId.mockReset();
});

describe("listenRefusal", () => {
	it("is null only when voice is on and Listen is on", () => {
		expect(listenRefusal(READY)).toBeNull();
	});

	// A stored null voice id reads as Dero's default voice, so it is no reason to refuse.
	it("is null for a row that stored no voice id", () => {
		expect(listenRefusal({ ...READY, voiceId: null })).toBeNull();
	});

	it("names each reason", () => {
		expect(listenRefusal(null)).toBe("notSetUp");
		expect(listenRefusal({ ...READY, enabled: false })).toBe("voiceOff");
		expect(listenRefusal({ ...READY, listenEnabled: false })).toBe("listenOff");
	});
});

describe("buildListenRow", () => {
	it("is one row with one secondary button labeled Listen", () => {
		const row = buildListenRow().toJSON();
		expect(row.components).toHaveLength(1);
		expect(row.components[0]).toMatchObject({ label: "Listen", style: ButtonStyle.Secondary, custom_id: LISTEN_PREFIX });
	});

	it("uses a colon free customId, because the registry routes on the text before the first colon", () => {
		expect(LISTEN_PREFIX).not.toContain(":");
	});
});

describe("maybeListenRow", () => {
	it("returns the row for a ready guild", async () => {
		mocks.findByGuildId.mockResolvedValue(READY);
		expect(await maybeListenRow("g1")).not.toBeNull();
	});

	it("returns null for a guild without voice, so no dead button is ever shown", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		expect(await maybeListenRow("g1")).toBeNull();
		mocks.findByGuildId.mockResolvedValue({ ...READY, enabled: false });
		expect(await maybeListenRow("g1")).toBeNull();
	});

	it("returns null outside a guild without reading anything", async () => {
		expect(await maybeListenRow(null)).toBeNull();
		expect(mocks.findByGuildId).not.toHaveBeenCalled();
	});
});

describe("attachListenRow", () => {
	it("edits the post with the row when the guild is ready", async () => {
		mocks.findByGuildId.mockResolvedValue(READY);
		const apply = vi.fn(async () => undefined);
		await attachListenRow("g1", apply);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("does not touch the post when the guild is not ready", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...READY, listenEnabled: false });
		const apply = vi.fn(async () => undefined);
		await attachListenRow("g1", apply);
		expect(apply).not.toHaveBeenCalled();
	});

	it("swallows a failure, so the post it follows is never affected", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.findByGuildId.mockRejectedValue(new Error("connection lost"));
		await expect(attachListenRow("g1", vi.fn())).resolves.toBeUndefined();

		mocks.findByGuildId.mockResolvedValue(READY);
		await expect(attachListenRow("g1", vi.fn(async () => Promise.reject(new Error("Unknown Message"))))).resolves.toBeUndefined();
		warn.mockRestore();
	});
});
