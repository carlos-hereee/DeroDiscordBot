import { AttachmentBuilder, type ColorResolvable } from "discord.js";
import { join } from "node:path";

// ── shared brand identity ────────────────────────────────────────────────
// What:  the bot's visual + platform identity that does NOT vary by plugin
//        voice (kingdom vs neutral): the footer wordmark, the Dero embed
//        author, and the embed color palette. These were previously declared
//        verbatim inside every copy pack; lifting them here makes one source
//        of truth that each pack references, and gives non pack-aware call
//        sites (handlers with no guildConfig in scope, ops/observability
//        embeds) a place to import a color or footer WITHOUT pulling in a
//        whole voice pack.
// Who:   both copy packs spread these into their objects so getPluginCopy
//        (config).COLORS / .FOOTER / .AUTHOR keep working unchanged; color
//        and footer only consumers import the named exports directly.
// When:  read at module load (packs) and per render (consumers). Frozen for
//        the process lifetime, pure constants.
// Where: lives at @base/copy/brand, a sibling of the packs. Replaces the role
//        the legacy embed-content.ts shim played for these constants.

// Platform brand, not bot brand. Survives any pack-name changes and reinforces
// companyuno.com recognition across every embed the bot posts.
export const FOOTER = "Company Uno";

// Dero, the Company Uno mascot, is the bot's visual identity. Set as the embed
// author in embedBuilder.base() so every embed carries his name and icon. The
// icon is a 128px PNG: Discord renders author icons as a single static frame, so
// the icon-sized PNG is the right asset here; the introductions embed shows the
// bundled v2 welcome pose instead (ChannelContent.introductionImage). Same value
// across every pack, the bot presents as Dero regardless of voice.
//
// DEPLOY NOTE: these assets live in companyuno-client/nexious-client/public/dero and only render
// once the web app is deployed with them. Until then companyuno.com/dero/* 200s
// with the SPA's HTML (not the file), so Discord shows the name with no image.
export const AUTHOR = {
	name: "Dero",
	iconURL: "https://www.companyuno.com/dero/dero-icon-128.png",
};

// Animated Dero (default state), the introductions embed image only while the
// bundled v2 welcome pose is not on disk (ChannelContent.introductionImage).
// Same deploy requirement as AUTHOR.iconURL.
export const DERO_GIF_URL = "https://www.companyuno.com/dero/dero-default.gif";

// ── bundled Dero images ──────────────────────────────────────────────────
// Files shipped in the bot's assets/ dir (so they deploy WITH the bot on
// Railway), attached to messages via Discord's attachment:// reference. This
// avoids depending on companyuno.com serving /dero, the gif URL above 404s to
// the SPA's HTML until that web app ships. Two sizes for two jobs:
//   • the 85 KB still PNG, the per-announcement go-live thumbnail, where the
//     ~2.8 MB gif would be far too heavy to re-upload every time.
//   • the ~2.8 MB animated gif, the invite card, a post-once pinned message
//     where the upload happens rarely and the animation is worth it.
export const DERO_IMAGE_FILE = "dero-avatar-512.png";
export const DERO_IMAGE_REF = `attachment://${DERO_IMAGE_FILE}`;

export const DERO_GIF_FILE = "dero-default.gif";
export const DERO_GIF_REF = `attachment://${DERO_GIF_FILE}`;

/** The folder under assets/dero holding the original Dero art (both files above); the v2 lineup sits beside it in v2. */
export const DERO_V1_DIR = "v1";

// Build an upload for a bundled asset. process.cwd() is the bot's project root
// (Railway start + nodemon both run from there), so assets/dero/v1/<file> resolves
// whether running from src or the compiled dist.
function buildDeroAttachment(file: string): AttachmentBuilder {
	return new AttachmentBuilder(join(process.cwd(), "assets", "dero", DERO_V1_DIR, file), { name: file });
}
export function buildDeroImageAttachment(): AttachmentBuilder {
	return buildDeroAttachment(DERO_IMAGE_FILE);
}
export function buildDeroGifAttachment(): AttachmentBuilder {
	return buildDeroAttachment(DERO_GIF_FILE);
}

// Embed color palette. Color is neutral by design, the kingdom vs streamer
// split happens in words, not in chrome, so the palette is identical across
// packs and lives here once. Keys map to embed types (reminder, schedule, etc).
export const COLORS = {
	REMINDER: "Red",
	SEASON_END: "DarkGrey",
	LEADERBOARD: "Gold",
	CONFIRMATION: "Yellow",
	ERROR: "DarkRed",
	ARRIVAL: "DarkGold",
	INTRODUCTION: "DarkGold",
	COMMANDS: "DarkBlue",
	SCHEDULE: "DarkGreen",
	ANNOUNCEMENTS: "DarkRed",
	ADMIN: "DarkPurple",
	// NextUpBoard posts + 🛡️next-decree channel intro. Navy Blue reads as
	// "shield" without colliding with SCHEDULE (DarkGreen) or ANNOUNCEMENTS
	// (DarkRed) in the sidebar.
	NEXT_DECREE: "DarkNavy",
	// Dero's brand-indigo accent (matches the web --main-brand-color).
	// Decision 11: the bot identity pairs the "Dero" author + icon with a
	// brand indigo bar. Available for Dero-led or default embeds; the
	// per-type colors above keep their meaning and are unchanged.
	DERO: "#4f46e5",
	// /mini-game fortune (a plain bot command, not a platform plugin). The common
	// reading reuses the Dero brand indigo; the rare "ultra" reading uses the
	// Dero ultra-gold accent (the web --dero-ultra-halo) so the special tier
	// reads as the top rung of the brand's default→activation→ultra ladder.
	FORTUNE: "#4f46e5",
	FORTUNE_ULTRA: "#ffd23a",
	// /mini-game subcommands (plain bot commands, not platform plugins, same
	// non pack-aware path fortune uses above). One key per game so a player can
	// tell at a glance which game an embed belongs to when several rounds are
	// live in the same channel. GAME_CHALLENGE is deliberately the muted one:
	// a challenge is a PENDING state, so it should not out-shout the resolved
	// result embed that follows it. All four are distinct from every key above.
	GAME_CHALLENGE: "#64748b",
	GAME_COINFLIP: "#f97316",
	// A warmer amber than the coin's orange, so the two head to head games are
	// still tellable apart at a glance when both are live in one channel. They
	// were one game ("duel") until 2026-08-12 and so shared one color.
	GAME_DICEROLL: "#eab308",
	GAME_RPS: "#0ea5e9",
	GAME_HANGMAN: "#22c55e",
	// The ARCADE GAMES category's own surfaces (the rules card, the challenge board
	// intro, a room's opener). Deliberately NOT one of the per game colors above:
	// those identify a match, this identifies the arena the matches live in.
	ARCADE: "#7c3aed",
	// Felt green, deliberately DARKER than GAME_HANGMAN's brighter green so the two
	// are still distinguishable side by side in a channel that has both open.
	GAME_BLACKJACK: "#15803d",
	// ── leveling (2026-08-11) ──
	// Same non pack-aware path as the games and fortune above: leveling is a
	// plain bot feature, not a platform plugin, so its embeds pull colors from
	// here directly rather than through getPluginCopy.
	//
	// LEVEL_UP is the ordinary level, a calm teal that does not compete with the
	// reminder red or the announcement red it will sit beside in the same
	// channel. LEVEL_MILESTONE is a PRIME level and has to read as clearly rarer
	// at a glance, so it takes the violet that nothing else in this palette uses
	// and that the wider games convention already reads as "epic". The gap
	// between those two is the whole point: a member scrolling past should know
	// which kind of level up they are looking at before reading a word of it.
	// Gold is not available for the milestone, FORTUNE_ULTRA already owns the
	// brand's top rung and two golds would flatten that ladder.
	LEVEL_UP: "#14b8a6",
	LEVEL_MILESTONE: "#a855f7",
	// The member profile. A blue distinct from GAME_RPS's lighter sky, chosen to
	// read as identity rather than as an event; /account is a reference surface,
	// not a payoff, so it stays out of the celebratory end of the palette.
	ACCOUNT: "#2563eb",
	// Achievement unlocks. A bronze rather than a gold, deliberately: the tracks
	// run bronze through diamond, so no single embed color can stand for a tier,
	// and the darker metal keeps it clear of LEADERBOARD's Gold and of DarkGold.
	ACHIEVEMENT: "#b45309",
	// The levels standings board. Reads as family with LEVEL_UP on purpose, they
	// are one system, but it MUST stay far from LEADERBOARD's Gold: the two
	// boards live in the SAME channel and answer different questions (event
	// participation vs presence over time), so color is the first thing telling
	// a member which one they are scrolling past.
	LEVELS_BOARD: "#0d9488",
	// ── rendered cards (2026-10 item 243) ──
	// The canvas cards' own surfaces, which embeds never use. They are the
	// platform's dark mode tokens (page, panel, nested block, primary, secondary
	// and muted text) so a card reads as Company Uno rather than as a second look.
	// A card still takes its ACCENT from the surface's embed color above, which
	// keeps a card and its fallback embed on the same hue.
	CARD_BACKGROUND: "#0b1120",
	CARD_PANEL: "#111c2e",
	CARD_NESTED: "#18233a",
	CARD_TEXT: "#f8fafc",
	CARD_TEXT_SECONDARY: "#94a3b8",
	CARD_TEXT_MUTED: "#7c8ba1",
	// The four achievement tier metals on the unlock medallion. Separate keys
	// because ACHIEVEMENT above is one embed color for every tier. Gold borrows
	// FORTUNE_ULTRA's value on purpose: two golds would flatten the brand's top
	// rung, so the gold tier IS that rung rather than a third gold beside it.
	// Diamond is a pale indigo ice, not a cyan, because teal and cyan read as
	// "AI or live" on the platform.
	ACHIEVEMENT_BRONZE: "#cd7f32",
	ACHIEVEMENT_SILVER: "#cbd5e1",
	ACHIEVEMENT_GOLD: "#ffd23a",
	ACHIEVEMENT_DIAMOND: "#c7d2fe",
	// ── arcade cards (2026-10 item 243 Phase 3) ──
	// A playing card's stock and its two inks, shared by blackjack and the hold em
	// dealer. The black ink is a near black slate rather than pure black so it
	// matches the card sheet behind it.
	PLAYING_CARD_FACE: "#f8fafc",
	PLAYING_CARD_RED: "#dc2626",
	PLAYING_CARD_BLACK: "#0f172a",
	// How a hand or a round came out, on any game card. Lighter than the embed
	// greens and reds above because they sit on the dark card sheet, not in an
	// embed's side stripe.
	CARD_OUTCOME_WIN: "#4ade80",
	CARD_OUTCOME_LOSE: "#f87171",
	// The battleship grid. The water is a navy, not a cyan, because teal and cyan
	// read as "AI or live" on the platform; a hit is the coin flip's orange and a
	// sunk hull the reminder red, so a sinking reads hotter than a hit.
	BATTLESHIP_WATER: "#1e3a8a",
	BATTLESHIP_MISS: "#64748b",
	BATTLESHIP_HIT: "#f97316",
	BATTLESHIP_SUNK: "#dc2626",
	// The eight Monopoly color groups, on the trade, auction and winner cards. The
	// classic board's hues, except light blue, which is a plain sky blue rather
	// than the board's cyan for the same teal and cyan rule as the water above.
	MONOPOLY_BROWN: "#92400e",
	MONOPOLY_LIGHT_BLUE: "#93c5fd",
	MONOPOLY_PINK: "#db2777",
	MONOPOLY_ORANGE: "#ea580c",
	MONOPOLY_RED: "#dc2626",
	MONOPOLY_YELLOW: "#facc15",
	MONOPOLY_GREEN: "#16a34a",
	MONOPOLY_DARK_BLUE: "#1d4ed8",
	// ── platform cards (2026-10 item 243 Phase 4) ──
	// Dero's voice presence card. Live in a call is exactly the "AI or live" case
	// the platform reserves teal for, so the listening and speaking states take
	// the platform teal and a brighter teal beside it; the plain "joined" state
	// keeps the Dero indigo above. Neither is a leveling color, so the leveling
	// teal conflict in TECH_DEBT does not reach these.
	VOICE_LISTENING: "#14b8a6",
	VOICE_SPEAKING: "#2dd4bf",
	// The one Dero variant no Monopoly group already names: the purple mecha, token six.
	DERO_PURPLE: "#7c3aed",
} satisfies Record<string, ColorResolvable>;

// ── the six Dero color variants (2026-10 item 250 Phase 5) ──
// The mecha Dero in six armors, in the order of the Monopoly tokens that draw them
// (assets/games/monopoly/token-1.png is the red, token-6.png the purple). ONE list for
// every place a variant shows, so a bot seat named Red, the red token and the red die
// face can never disagree: the Monopoly bot seats, the Hold'em and Battleship bots,
// and the dice card's faces all read it.
export const DERO_VARIANTS = [
	{ name: "Red", color: COLORS.MONOPOLY_RED },
	{ name: "Orange", color: COLORS.MONOPOLY_ORANGE },
	{ name: "Gold", color: COLORS.MONOPOLY_YELLOW },
	{ name: "Green", color: COLORS.MONOPOLY_GREEN },
	{ name: "Blue", color: COLORS.MONOPOLY_DARK_BLUE },
	{ name: "Purple", color: COLORS.DERO_PURPLE },
] as const;

export type DeroVariant = (typeof DERO_VARIANTS)[number];
