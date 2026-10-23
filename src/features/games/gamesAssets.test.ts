import { describe, it, expect } from "vitest";
import { DERO_IMAGE_REF } from "@base/copy/brand.js";
import { GAME_ASSET_FILES, gameAssetPath, resolveGameAsset, hangmanStageKey, missingGameAssets, type GameAssetKey } from "./gamesAssets.js";

// ── gamesAssets ────────────────────────────────────────────────────────────
// The manifest is the owner's art checklist as much as it is code, so these
// tests guard the two ways it can quietly rot: two slots pointing at one file,
// and a resolver that stops degrading gracefully when art is absent.

describe("the asset manifest", () => {
	it("maps every slot to a distinct file", () => {
		// Two keys sharing a path would mean one drop-in silently overwrites the
		// other's slot, and the collision would only show up as the wrong picture.
		const paths = Object.values(GAME_ASSET_FILES);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it("keeps every path relative and inside assets/games", () => {
		for (const path of Object.values(GAME_ASSET_FILES)) {
			expect(path.startsWith("/")).toBe(false);
			expect(path.includes("..")).toBe(false);
		}
	});

	it("declares a full seven frame gallows, one per allowed wrong guess plus the empty board", () => {
		for (let stage = 0; stage <= 6; stage++) {
			expect(GAME_ASSET_FILES[`hangmanStage${stage}` as GameAssetKey]).toBeDefined();
		}
	});

	it("declares the fourteen Monopoly slots, all PNGs in the monopoly folder", () => {
		// The board base, six tokens, house, hotel, two card backs, the jail stamp and
		// the winner and bankrupt banners: the owner's asset spec, one slot per file.
		const monopoly = (Object.keys(GAME_ASSET_FILES) as GameAssetKey[]).filter((key) => key.startsWith("monopoly"));
		expect(monopoly).toHaveLength(14);
		for (const key of monopoly) expect(GAME_ASSET_FILES[key]).toMatch(/^monopoly\/[a-z0-9-]+\.png$/);
	});
});

describe("hangmanStageKey", () => {
	it("maps a wrong guess count straight onto its frame", () => {
		expect(hangmanStageKey(0)).toBe("hangmanStage0");
		expect(hangmanStageKey(3)).toBe("hangmanStage3");
		expect(hangmanStageKey(6)).toBe("hangmanStage6");
	});

	it("clamps rather than throwing, so a miscount renders the end frame instead of crashing a live round", () => {
		expect(hangmanStageKey(-2)).toBe("hangmanStage0");
		expect(hangmanStageKey(99)).toBe("hangmanStage6");
		expect(hangmanStageKey(2.7)).toBe("hangmanStage2");
	});
});

describe("resolveGameAsset", () => {
	it("falls back to the bundled Dero avatar for art that does not exist yet", () => {
		// The whole point of the resolver: no custom art has been drawn, and every
		// game still renders a real picture instead of a dead image link.
		const resolved = resolveGameAsset("challenge");
		expect(resolved.ref).toBe(DERO_IMAGE_REF);
		expect(resolved.attachment).toBeDefined();
	});

	it("returns a usable attachment and ref for every declared slot", () => {
		for (const key of Object.keys(GAME_ASSET_FILES) as GameAssetKey[]) {
			const resolved = resolveGameAsset(key);
			expect(resolved.attachment).toBeDefined();
			expect(resolved.ref.startsWith("attachment://")).toBe(true);
		}
	});
});

describe("missingGameAssets", () => {
	it("reports only paths that are actually declared", () => {
		const declared = new Set<string>(Object.values(GAME_ASSET_FILES));
		for (const missing of missingGameAssets()) {
			expect(declared.has(missing)).toBe(true);
		}
	});

	it("checks only the slots it is handed, and agrees with gameAssetPath about each", () => {
		// challenge.gif has never been drawn, so it is the one slot every checkout lacks.
		expect(gameAssetPath("challenge")).toBeNull();
		expect(missingGameAssets(["challenge"])).toEqual(["challenge.gif"]);
		expect(missingGameAssets([])).toEqual([]);
	});
});
