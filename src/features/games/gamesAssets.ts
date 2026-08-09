import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { AttachmentBuilder } from "discord.js";
import { buildDeroImageAttachment, DERO_IMAGE_REF } from "@base/copy/brand.js";

// ── /mini-game art manifest and resolver ───────────────────────────────────
// What:  the single declaration of every image the games can show, plus a
//        resolver that falls back to the bundled Dero avatar whenever the real
//        file is not on disk yet.
// Who:   gamesEmbeds.ts and each game's handler. Nothing else should build a
//        path into assets/games/ by hand.
// When:  once per embed render. existsSync is a stat, cheap enough per
//        interaction and far cheaper than shipping a broken image reference.
// Where: files live under assets/games/, which deploys WITH the bot on Railway
//        the same way assets/dero and assets/fortune already do. process.cwd()
//        is the project root under both nodemon and the Railway start command,
//        so the same path resolves from src and from dist.
// How:   custom art present, attach it and point the embed at it. Custom art
//        absent, attach the 85 KB Dero avatar instead and point the embed at
//        THAT. Either way the caller gets a usable { attachment, ref } pair and
//        no embed ever renders a dead image link.
//
// This mirrors respondWithFortune's existing discipline exactly: it existsSync
// checks each orb gif and degrades gracefully rather than breaking on an
// unrendered verdict. Same idea, one level up.
//
// TO ADD REAL ART: drop the file at the path below. No code change is needed.
// missingGameAssets() reports what is still outstanding.

const GAMES_ASSET_DIR = "games";

// Relative to assets/games/. The comment on each block names the phase that
// consumes it, so a slot that is declared but not yet rendered is obvious.
export const GAME_ASSET_FILES = {
	// ── shared challenge surface (Phase 1, LIVE) ──
	// Thumbnail on the "X challenges Y" prompt, shared by duel and rps.
	challenge: "challenge.gif",

	// ── duel (Phase 2, LIVE) ──
	duelDice: "duel/dice-roll.gif",
	duelCoin: "duel/coin-flip.gif",
	duelTie: "duel/tie.png",

	// ── rock paper scissors (Phase 3, LIVE) ──
	// The reveal embed carries the WINNING throw, so the image says something the
	// text does not already say twice. A generic "both hands come down" reveal gif
	// was considered and dropped: it cannot show who won, and declaring art that
	// nothing renders would make this manifest lie about what needs drawing.
	rpsRock: "rps/rock.png",
	rpsPaper: "rps/paper.png",
	rpsScissors: "rps/scissors.png",
	rpsTie: "rps/tie.png",

	// ── hangman (Phase 4, declared, not yet rendered) ──
	// Seven gallows frames: stage 0 is the empty gallows, stage 6 is a full
	// figure and a lost round. Classic hangman allows six wrong guesses, so the
	// frame index IS the wrong guess count and hangmanStageKey below maps one to
	// the other without arithmetic at the call site.
	hangmanStage0: "hangman/stage-0.png",
	hangmanStage1: "hangman/stage-1.png",
	hangmanStage2: "hangman/stage-2.png",
	hangmanStage3: "hangman/stage-3.png",
	hangmanStage4: "hangman/stage-4.png",
	hangmanStage5: "hangman/stage-5.png",
	hangmanStage6: "hangman/stage-6.png",
	hangmanWin: "hangman/win.png",
	hangmanLose: "hangman/lose.png",
} as const satisfies Record<string, string>;

export type GameAssetKey = keyof typeof GAME_ASSET_FILES;

export interface ResolvedGameAsset {
	// Attach this to the SAME message that carries the embed, or the reference
	// below will not resolve and Discord renders an empty image slot.
	attachment: AttachmentBuilder;
	// Pass to setImage() or setThumbnail().
	ref: string;
}

// Map a wrong guess count onto its gallows frame. Clamped at both ends so a
// caller that miscounts renders the last frame rather than throwing mid round.
export function hangmanStageKey(wrongGuesses: number): GameAssetKey {
	const clamped = Math.min(6, Math.max(0, Math.floor(wrongGuesses)));
	return `hangmanStage${clamped}` as GameAssetKey;
}

export function resolveGameAsset(key: GameAssetKey): ResolvedGameAsset {
	const relative = GAME_ASSET_FILES[key];
	const absolute = join(process.cwd(), "assets", GAMES_ASSET_DIR, relative);

	if (!existsSync(absolute)) {
		// Placeholder path. The Dero avatar is the 85 KB still PNG, already the
		// house choice for a per message thumbnail (the 2.8 MB gif is reserved for
		// post once surfaces), so this is cheap to re-upload per game.
		return { attachment: buildDeroImageAttachment(), ref: DERO_IMAGE_REF };
	}

	// Attach under the file's own basename so two different assets can never
	// collide on one message, and so the ref reads obviously in a log.
	const name = basename(relative);
	return { attachment: new AttachmentBuilder(absolute, { name }), ref: `attachment://${name}` };
}

// Which slots still have no real art. Not called on any hot path: this exists so
// the owner can confirm a drop-in landed, and so a test can assert the manifest
// stays honest.
export function missingGameAssets(): string[] {
	return Object.values(GAME_ASSET_FILES).filter(
		(relative) => !existsSync(join(process.cwd(), "assets", GAMES_ASSET_DIR, relative))
	);
}
