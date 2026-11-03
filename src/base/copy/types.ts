import type { rokCommanderCopy } from "./packs/rok-commander.pack.js";

// ── shared types for copy packs ──────────────────────────────────────────
// What:  defines the structural contract every plugin's copy pack must
//        satisfy and lifts the pre-existing IEmbedField shape (used inside
//        `commandGuide.fields` and `adminCommandGuide.fields`) into a place
//        where any pack file can import it. The copy itself lives in the
//        copy packs (@base/copy/packs); brand constants in @base/copy/brand;
//        the active-pack resolver is getPluginCopy (@base/copy/getCopy).
// Who:   pack authors (Phase 2's `general-events.pack.ts`, plus any future
//        neutral / streamer-tone packs) consume `IPluginCopy`. The lookup
//        helpers in `getCopy.ts` consume `PluginId`.
// Where: lives at `@base/copy/types`. Type-only, no runtime exports, so
//        it stays a pure shape declaration.
// How:   `IPluginCopy` is derived from `typeof rokCommanderCopy` instead of
//        being authored as a hand-rolled interface. The rok-commander pack
//        is the canonical surface; deriving the type from it guarantees the
//        contract drifts with the implementation rather than rotting in a
//        sibling .d.ts file.

// Single embed field shape used by command guides. Discord's docs cap field
// name at 256 chars and field value at 1024; we don't enforce that here, the
// pack authors do at write time.
export interface IEmbedField {
	name: string;
	value: string;
}

// A card rank in words, one and many ("ace", "aces"), for the Hold'em hand names
// in `holdemHands`. Keyed in the pack by the rank's RANK_LABELS label.
export interface IRankName {
	one: string;
	many: string;
}

// The structural contract every copy pack must satisfy. Derived from the
// rok-commander pack so adding a new key to that pack automatically widens
// the shape every other pack must implement. If a key is too rok-specific
// to make sense in a sibling pack (e.g. `kvkConfirmation`), the sibling
// pack still has to satisfy the type, common pattern is to fill those
// keys with stub values that read "[unused in this plugin]" so any
// accidental code path that hits them surfaces the bug loudly rather than
// silently rendering an empty embed.
export type IPluginCopy = typeof rokCommanderCopy;

// Pluginid registry. Add a string literal here when registering a new
// pack and the registry in `packs.ts` will fail to typecheck until the
// matching entry is wired up. Keeping it as a string-literal union (instead
// of `keyof typeof COPY_PACKS`) lets schema fields and external callers
// reference the type without circular imports.
export type PluginId = "rok-commander" | "general-events";
