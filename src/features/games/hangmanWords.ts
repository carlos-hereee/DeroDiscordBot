// ── hangman word bank ──────────────────────────────────────────────────────
// ONE general purpose list, by the owner's decision on 2026-08-08. Deliberately
// NOT split into a kingdom themed and a streamer themed pair: this feature does
// not route through the two voice copy packs at all (see the comment at the top
// of gamesCopy.ts), so doubling the content for a voice split nobody asked for
// would be wasted authoring effort.
//
// Selection rules, so a future addition matches:
//   • 4 to 9 letters. Shorter is guessable by luck, longer turns a 6 miss budget
//     into a coin flip.
//   • Plain common nouns and adjectives. No proper nouns, nothing a non native
//     speaker would need trivia to reach.
//   • Letters only. No hyphens, apostrophes, spaces or accents, because the board
//     masks every character it does not reveal and a punctuation mark in the mask
//     leaks structure for free.
//   • Nothing that reads as an insult or a slur when partially revealed.
//
// hangmanState lowercases on the way in, so casing here is cosmetic; kept lower
// so a stray capital cannot look meaningful.

export const HANGMAN_WORDS: readonly string[] = [
	"anchor", "arcade", "autumn", "avenue", "balcony", "bandit", "banner", "basket",
	"beacon", "bishop", "blanket", "blossom", "bottle", "boulder", "bracket", "branch",
	"bridge", "bronze", "bucket", "bundle", "cabinet", "camera", "candle", "canyon",
	"carpet", "castle", "cavern", "cellar", "chapel", "cheese", "circus", "cluster",
	"cobalt", "column", "compass", "copper", "coral", "cottage", "council", "crater",
	"crimson", "crystal", "cyclone", "dagger", "dolphin", "dragon", "drifter", "eagle",
	"ember", "engine", "fabric", "falcon", "fathom", "feather", "ferry", "fiddle",
	"forest", "fortune", "fossil", "fountain", "furnace", "gallery", "garden", "gauntlet",
	"glacier", "granite", "gravity", "harbor", "harvest", "helmet", "hollow", "horizon",
	"hunter", "island", "jasmine", "journey", "jungle", "kettle", "kingdom", "lantern",
	"lattice", "legend", "lagoon", "lumber", "magnet", "mammoth", "mantle", "marble",
	"meadow", "mercury", "meteor", "mirror", "monsoon", "mosaic", "nectar", "nomad",
	"oasis", "obsidian", "orchard", "otter", "outpost", "palace", "parade", "pebble",
	"pelican", "pepper", "pigment", "pillar", "pirate", "planet", "plateau", "plunder",
	"pocket", "portal", "prairie", "prism", "puzzle", "quarry", "quartz", "quiver",
	"rabbit", "raccoon", "rampart", "ravine", "relic", "ribbon", "ridge", "rocket",
	"rubble", "saddle", "salmon", "sapphire", "satchel", "scarlet", "sculpture", "seagull",
	"shadow", "shovel", "signal", "silver", "socket", "spiral", "sprout", "squire",
	"stable", "statue", "stellar", "summit", "sunset", "tavern", "temple", "thicket",
	"thistle", "thunder", "timber", "torrent", "tower", "treasure", "trellis", "tribute",
	"tundra", "turtle", "valley", "vessel", "village", "vineyard", "violet", "voyage",
	"walnut", "warden", "whisper", "willow", "window", "wonder", "wreath", "zephyr",
] as const;

// Pull a word at random. rng is injectable so a test can pin the choice without
// stubbing Math.random globally, matching rollFortune.ts and versusResolve.ts.
export function pickWord(rng: () => number = Math.random): string {
	return HANGMAN_WORDS[Math.floor(rng() * HANGMAN_WORDS.length)];
}
