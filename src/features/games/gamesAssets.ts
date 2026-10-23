import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { AttachmentBuilder } from "discord.js";
import { buildDeroImageAttachment, DERO_IMAGE_REF } from "@base/copy/brand.js";

// ── /mini-game art manifest and resolver ───────────────────────────────────
// What:  the single declaration of every image the games can show, plus a
//        resolver that falls back to the bundled Dero avatar whenever the real
//        file is not on disk yet.
// Who:   gamesEmbeds.ts, each game's handler, and monopolyRenderer (which reads
//        pixels through gameAssetPath). Nothing else should build a path into
//        assets/games/ by hand.
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

	// ── coin flip and dice roll (Phase 2, LIVE) ──
	// ⚠️ THE ART PATHS MOVED on 2026-08-12 when "duel" split into two games. The
	// files do not exist on disk yet (assets/ holds only dero and fortune), which
	// is why renaming the folders was free; drop the art at these paths, not the
	// old duel/ ones.
	diceRoll: "dice-roll/roll.gif",
	coinFlip: "coin-flip/flip.gif",
	// Reachable only from a dice roll. A single coin cannot tie.
	diceTie: "dice-roll/tie.png",

	// ── rock paper scissors (Phase 3, LIVE) ──
	// The reveal embed carries the WINNING throw, so the image says something the
	// text does not already say twice. A generic "both hands come down" reveal gif
	// was considered and dropped: it cannot show who won, and declaring art that
	// nothing renders would make this manifest lie about what needs drawing.
	rpsRock: "rps/rock.png",
	rpsPaper: "rps/paper.png",
	rpsScissors: "rps/scissors.png",
	rpsTie: "rps/tie.png",

	// ── hangman (the owner's art, 2026-10 item 243 Phase 3b) ──
	// Seven gallows frames: stage 0 is the empty gallows, stage 6 is a full
	// figure and a lost round. Classic hangman allows six wrong guesses, so the
	// frame index IS the wrong guess count and hangmanStageKey below maps one to
	// the other without arithmetic at the call site. Stages 1 to 5 are the figure
	// alone under its rope, drawn at another scale than the gallows, so each frame
	// is shown on its own rather than layered on stage 0.
	//
	// Prepared by companyuno-growth/workspace-tools/prepare-arcade-art.mjs, which
	// clears the light outline each file was cut out with. Also on disk and NOT
	// declared, because nothing draws them: panel.png and keyboard-*.png (fixed
	// pictures whose alphabets miss letters, so the card builds its keyboard from
	// the tiles instead) and icon.png.
	hangmanStage0: "hangman/stage-0.png",
	hangmanStage1: "hangman/stage-1.png",
	hangmanStage2: "hangman/stage-2.png",
	hangmanStage3: "hangman/stage-3.png",
	hangmanStage4: "hangman/stage-4.png",
	hangmanStage5: "hangman/stage-5.png",
	hangmanStage6: "hangman/stage-6.png",
	// The ending banners: "YOU WIN" for a solved word, "GAME OVER" for the rest.
	hangmanWin: "hangman/win.png",
	hangmanLose: "hangman/lose.png",
	hangmanBackground: "hangman/background.png",
	hangmanLogo: "hangman/logo-horizontal.png",
	// The room opener's art, the one other room message allowed a file (R8).
	hangmanLogoStacked: "hangman/logo-stacked.png",
	hangmanDeroIdle: "hangman/dero-idle.png",
	hangmanDeroThinking: "hangman/dero-thinking.png",
	hangmanDeroWin: "hangman/dero-win.png",
	hangmanDeroLose: "hangman/dero-lose.png",
	// Letter tiles. Only the blank tile is truly empty; the other three carry a
	// sample "A", which the card paints over before printing the real letter.
	hangmanTileBlank: "hangman/tile-blank.png",
	hangmanTileDefault: "hangman/tile-default.png",
	hangmanTileCorrect: "hangman/tile-correct.png",
	hangmanTileWrong: "hangman/tile-wrong.png",

	// ── battleship (the owner's art, 2026-10 item 243 Phase 3b) ──
	// Trimmed to the art and scaled down by prepare-arcade-art.mjs. The board's
	// grid is baked in; battleshipRenderer holds where its cells were measured.
	// Every ship is drawn bow up and is turned for a ship laid across a row.
	battleshipBoard: "battleship/board.png",
	battleshipLogo: "battleship/logo.png",
	battleshipAdmiral: "battleship/admiral.png",
	battleshipCarrier: "battleship/carrier.png",
	battleshipBattleship: "battleship/battleship.png",
	battleshipCruiser: "battleship/cruiser.png",
	battleshipSubmarine: "battleship/submarine.png",
	battleshipDestroyer: "battleship/destroyer.png",
	battleshipHit: "battleship/hit.png",
	battleshipMiss: "battleship/miss.png",

	// ── the Dero deck's back (2026-10 item 243 Phase 3b) ──
	// The 52 faces are resolved by playingCardAssetPath below rather than listed
	// one by one. Also on disk and NOT declared: the two jokers and poster-back.png,
	// since no game here deals a joker.
	cardBack: "cards/back.png",

	// ── monopoly (2026-10 item 241 Phase 5a, and the winner card of item 243) ──
	// The board base, the six seat tokens, the house and the hotel are what
	// monopolyRenderer composites; until every one of those is on disk the board
	// stays the text map. The jail stamp is drawn when present and skipped when not.
	// The winner banner heads the winner card and the bankrupt Dero badges each
	// bankrupt seat on it. The Chance and Community Chest card backs are on disk but
	// nothing renders them yet.
	monopolyBoardBase: "monopoly/board-base.png",
	monopolyToken1: "monopoly/token-1.png",
	monopolyToken2: "monopoly/token-2.png",
	monopolyToken3: "monopoly/token-3.png",
	monopolyToken4: "monopoly/token-4.png",
	monopolyToken5: "monopoly/token-5.png",
	monopolyToken6: "monopoly/token-6.png",
	monopolyHouse: "monopoly/house.png",
	monopolyHotel: "monopoly/hotel.png",
	monopolyChanceBack: "monopoly/chance-back.png",
	monopolyChestBack: "monopoly/chest-back.png",
	monopolyJailStamp: "monopoly/jail-stamp.png",
	monopolyWinner: "monopoly/winner.png",
	monopolyBankrupt: "monopoly/bankrupt.png",
} as const satisfies Record<string, string>;

export type GameAssetKey = keyof typeof GAME_ASSET_FILES;

const ALL_GAME_ASSET_KEYS = Object.keys(GAME_ASSET_FILES) as GameAssetKey[];

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

/**
 * The absolute path of a slot's art, or null while the file is not on disk. For a
 * caller that reads the pixels itself (monopolyRenderer) rather than attaching the
 * file whole, so it still never builds a path into assets/games/ by hand.
 */
export function gameAssetPath(key: GameAssetKey): string | null {
	const absolute = join(process.cwd(), "assets", GAMES_ASSET_DIR, GAME_ASSET_FILES[key]);
	return existsSync(absolute) ? absolute : null;
}

// ── the Dero deck's faces ─────────────────────────────────────────────
// 52 files named `<suit>-<rank>.png` (`spades-a.png`, `hearts-10.png`) under
// assets/games/cards/, written by prepare-arcade-art.mjs from the deck's labels.
// A rule rather than 52 manifest lines, because the names ARE the rule.
const PLAYING_CARD_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const PLAYING_CARD_SUITS = ["spade", "heart", "diamond", "club"] as const;

/** The deck's file for one face, relative to assets/games/. A suit is named the way the renderer's CardSuit names it. */
export function playingCardFile(rank: string, suit: (typeof PLAYING_CARD_SUITS)[number]): string {
	return `cards/${suit}s-${rank.toLowerCase()}.png`;
}

/** The absolute path of one face of the deck, or null while it is not on disk. */
export function playingCardAssetPath(rank: string, suit: (typeof PLAYING_CARD_SUITS)[number]): string | null {
	const absolute = join(process.cwd(), "assets", GAMES_ASSET_DIR, playingCardFile(rank, suit));
	return existsSync(absolute) ? absolute : null;
}

/** Which of the 52 faces are not on disk, as paths relative to assets/games/. */
export function missingPlayingCards(): string[] {
	return PLAYING_CARD_SUITS.flatMap((suit) => PLAYING_CARD_RANKS.map((rank) => ({ rank, suit })))
		.filter(({ rank, suit }) => playingCardAssetPath(rank, suit) === null)
		.map(({ rank, suit }) => playingCardFile(rank, suit));
}

export function resolveGameAsset(key: GameAssetKey): ResolvedGameAsset {
	const relative = GAME_ASSET_FILES[key];
	const absolute = gameAssetPath(key);

	if (!absolute) {
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

// Which slots still have no real art, as paths relative to assets/games/. With no
// argument it checks the whole manifest; a caller that owns a subset (the Monopoly
// renderer's boot line, its availability check) passes just those keys. Not called
// on any hot path: this exists so the owner can confirm a drop-in landed, and so a
// test can assert the manifest stays honest.
export function missingGameAssets(keys: readonly GameAssetKey[] = ALL_GAME_ASSET_KEYS): string[] {
	return keys.filter((key) => gameAssetPath(key) === null).map((key) => GAME_ASSET_FILES[key]);
}
