import type { IPluginCopy, PluginId } from "./types.js";
import { rokCommanderCopy } from "./packs/rok-commander.pack.js";
import { generalEventsCopy } from "./packs/general-events.pack.js";

// ── COPY_PACKS, plugin → pack registry ──────────────────────────────────
// What:  the runtime registry that maps a `pluginId` to the matching copy
//        pack. `getPluginCopy` reads this when resolving a guild's voice.
// Who:   every embed builder, slash command response, and channel intro
//        eventually pulls its copy from a pack picked up here.
// When:  resolved on every render. Modules import `COPY_PACKS` once at
//        boot and the registry is frozen for the rest of the process.
// Where: lives at `@base/copy/packs` (one folder up from `packs/`, the
//        directory that holds the actual pack files). The split keeps a
//        clean import path: pack files import from siblings under
//        `./packs/`, the registry imports from `./packs/<id>.pack.js`,
//        and consumers import the registry from `@base/copy/packs`.
// How:   declared as `Partial<Record<PluginId, IPluginCopy>>` because the
//        `PluginId` union may name plugins whose pack files have not been
//        authored yet (e.g. `general-events` lands in Phase 2 of the
//        streamer-plugin spec). Missing entries are handled by the
//        fallback inside `getPluginCopy` rather than failing loudly at
//        import time. This lets Phase 1 ship the architecture without
//        forcing the Phase 2 stub to land in the same change.
export const COPY_PACKS: Partial<Record<PluginId, IPluginCopy>> = {
	"rok-commander": rokCommanderCopy,
	// general-events landed in Phase 2 of the streamer-plugin spec, plain English /
	// streamer-tone pack that satisfies the same IPluginCopy contract. ROK-only keys
	// (kvkConfirmation, configureReminders, seasonEnd, kvkConfigured) are stubbed with
	// "[unused in this plugin]" sentinels so any code path that leaks ROK config flow
	// into a general-events guild surfaces the bug loudly instead of rendering empty
	// content. See packs/general-events.pack.ts for the pack body.
	"general-events": generalEventsCopy,
};

// Re-export the default plugin id used as the back-compat fallback. Schema
// migrations and call sites that need to look up "what does an unset
// pluginId resolve to" should read this constant instead of hard-coding
// the literal, that way a future renaming or default change is a single-
// file edit.
export const DEFAULT_PLUGIN_ID: PluginId = "rok-commander";
