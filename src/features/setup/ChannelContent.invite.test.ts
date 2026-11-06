import { beforeEach, describe, expect, it, vi } from "vitest";

// ── the invite card's image ─────────────────────────────────────────────────
// The owner's live check found the card still drawing Dero's v1 gif. The ref on the embed and
// the file uploaded with it must name one image, or Discord shows an empty slot.

const art = vi.hoisted(() => ({ missing: false }));
vi.mock("@features/renderer/deroArt.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@features/renderer/deroArt.js")>();
	return { ...actual, deroArtAttachment: (...args: Parameters<typeof actual.deroArtAttachment>) => (art.missing ? null : actual.deroArtAttachment(...args)) };
});

import { DERO_GIF_FILE } from "@base/copy/brand.js";
import { ChannelContent } from "./ChannelContent.js";

beforeEach(() => {
	art.missing = false;
});

describe("the invite card's image", () => {
	it("is the v2 pose, with the embed and the upload naming the same file", () => {
		const { attachment } = ChannelContent.inviteCardImage();

		expect(attachment.name).toBe("mecha-dero.png");
		expect(ChannelContent.inviteCard().data.image?.url).toBe("attachment://mecha-dero.png");
	});

	it("falls back to the bundled gif while the pose is not on disk, so the slot is never empty", () => {
		art.missing = true;

		expect(ChannelContent.inviteCardImage().attachment.name).toBe(DERO_GIF_FILE);
		expect(ChannelContent.inviteCard().data.image?.url).toBe(`attachment://${DERO_GIF_FILE}`);
	});
});
