import { describe, it, expect } from "vitest";
import { buildTipsDmEmbed, parseTipsDm } from "./tipsDm.js";

// ── Creator Lab weekly tips DM (2026-11 item 283 Phase 5) ──
// The guard over the server's tips body and the embed it draws.

describe("parseTipsDm", () => {
	it("keeps a niche with one to three tips", () => {
		expect(parseTipsDm({ niche: "music", items: ["One.", "Two.", "Three."] })).toEqual({ niche: "music", items: ["One.", "Two.", "Three."] });
	});

	it("refuses a missing niche, no tips, too many tips or a blank tip", () => {
		expect(parseTipsDm(null)).toBeNull();
		expect(parseTipsDm({ items: ["One."] })).toBeNull();
		expect(parseTipsDm({ niche: "music", items: [] })).toBeNull();
		expect(parseTipsDm({ niche: "music", items: ["1", "2", "3", "4"] })).toBeNull();
		expect(parseTipsDm({ niche: "music", items: ["One.", "  "] })).toBeNull();
		expect(parseTipsDm({ niche: "music", items: "One." })).toBeNull();
	});
});

describe("buildTipsDmEmbed", () => {
	it("says why tips came instead of a read, names the niche and numbers each tip", () => {
		const embed = buildTipsDmEmbed({ niche: "variety", items: ["Group videos into playlists."] }).data;
		expect(embed.description).toContain("not have many comments yet");
		expect(embed.description).toContain("variety content");
		expect(embed.fields).toEqual([{ name: "Tip 1", value: "Group videos into playlists.", inline: false }]);
		expect(embed.footer?.text).toContain("Creator Lab");
	});

	it("reads an unknown niche as plain words rather than a raw token", () => {
		expect(buildTipsDmEmbed({ niche: "cooking", items: ["Tip."] }).data.description).toContain("your niche");
	});
});
