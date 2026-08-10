import type { IPluginCopy, PluginId } from "./types.js";
import { COPY_PACKS, DEFAULT_PLUGIN_ID } from "./packs.js";

// ── lookup helpers for plugin-aware copy ─────────────────────────────────
// What:  the runtime entry points that resolve "which words should this
//        guild see?" for a given GuildConfig. Two surfaces:
//          1. `getPluginCopy(guildConfig)` returns the entire pack object
//             so a caller can destructure a sub-namespace and read it
//             directly (e.g. `const c = ...`, then `c.scheduleBoard.title`).
//          2. `getCopyOverride(key, guildConfig)` returns the per-guild
//             owner-authored override for one dotted key, or undefined
//             when no override is set. Phase 3 of the streamer-plugin
//             spec ships the editor UI that writes those overrides;
//             Phase 1 only stages the read path so call sites can opt in
//             without a second migration later.
// Who:   embed builders, slash command handlers, ChannelContent.
// When:  on every render of a user-facing string. Cheap, registry lookup
//        plus, when overrides are present, a single Map.get.
// Where: lives at `@base/copy/getCopy`. The Discord-rendered copy lives
//        in the copy packs (`@base/copy/packs`); brand constants (colors,
//        footer) live in `@base/copy/brand`. The legacy back-compat shim
//        has been retired, so call sites now use `getPluginCopy(guildConfig)`
//        (which honors per-guild overrides) or import `rokCommanderCopy` /
//        the brand constants directly.
// How:   the override layer reads from a Mongoose-shaped Map. Mongoose
//        Maps expose a `.get` method at runtime, but TypeScript sees them
//        as `Map<string, string>` once cast through the Mongoose Document
//        layer. We accept the loose `{ get?(key): string | undefined }`
//        shape so test doubles, plain objects, and Mongoose Maps all work
//        without forcing every caller to convert.

// Loosely-typed view of the GuildConfig fields we need. We don't import
// the Mongoose model directly because that would couple `@base/` to
// `@db/`, which inverts the layer dependency (base is meant to be leaf).
// Anything that produces a config-shaped object (Mongoose doc, plain
// object built in tests, partial config from a webhook payload) can be
// passed in.
export interface ICopyConfig {
	pluginId?: PluginId | string | null;
	copyOverrides?: { get?: (key: string) => string | undefined } | Map<string, string> | null;
}

// Resolve the active pack for a guild. A null/undefined config or a
// config whose `pluginId` is unset both fall back to the rok-commander
// pack, which preserves the pre-Phase-1 behaviour of every existing
// guild. A config that names a plugin we have not registered yet (e.g.
// `general-events` before Phase 2 ships its pack) ALSO falls back,
// silently, and intentionally. The streamer-plugin rollout is a
// content-first then content-only migration; the schema is allowed to
// march ahead of the registry.
export function getPluginCopy(guildConfig?: ICopyConfig | null): IPluginCopy {
	const pluginId = (guildConfig?.pluginId ?? DEFAULT_PLUGIN_ID) as PluginId;
	const pack = COPY_PACKS[pluginId];
	// Fallback chain: requested pack, then the default pack, then a hard
	// throw if neither is registered (which would only happen if someone
	// removed rok-commander from the registry, a misconfiguration worth
	// failing on rather than masking).
	if (pack) return pack;
	const fallback = COPY_PACKS[DEFAULT_PLUGIN_ID];
	if (!fallback) {
		throw new Error(
			`[getPluginCopy] no copy pack registered for "${pluginId}" and no fallback "${DEFAULT_PLUGIN_ID}" pack present. ` +
				"Check src/base/copy/packs.ts."
		);
	}
	return fallback;
}

// Resolve a per-guild override for a single dotted key. Returns undefined
// when no override is set, which the caller treats as "use the pack
// default." This function is intentionally narrow: the override layer
// only stores final strings, not function templates, so it cannot replace
// a builder like `scheduleBoard.intervalLabel(hours)`. Static keys
// (`listEvents.title`, `error.title`, `responses.commandExecuteFailure`)
// are the universe of overridable strings in v1; Phase 3's editor UI
// enumerates them explicitly.
export function getCopyOverride(key: string, guildConfig?: ICopyConfig | null): string | undefined {
	const overrides = guildConfig?.copyOverrides;
	if (!overrides) return undefined;
	// Mongoose Maps and JS Maps both expose `.get`; plain objects passed
	// in by tests can also implement it. The optional chain guards against
	// a partial test double that omits `get`.
	return typeof overrides.get === "function" ? overrides.get(key) : undefined;
}
