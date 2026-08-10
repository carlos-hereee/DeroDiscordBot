import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── vitest config for the bot ─────────────────────────────────────────
// the bot is pure ESM with bundler moduleResolution. source files import
// with the .js suffix convention (e.g. "@features/events/event.types.js").
// vite-tsconfig-paths teaches vitest to resolve the @-prefixed aliases from
// tsconfig.json, and vite's default extension resolution strips .js → .ts
// automatically. this keeps test files looking identical to source files.
//
// tests are colocated next to the module they cover (e.g.
// occurrenceCalculator.test.ts next to occurrenceCalculator.ts). the testing
// strategy doc prescribes this layout.
//
// ── alias duplication note ──
// What:  resolve.alias mirrors the tsconfig.json `paths` block. Why
//        duplicate? tsconfig excludes `**/*.test.ts` so the production
//        type checker never sees test files. vite-tsconfig-paths honors
//        that exclude, which means top-level `@base/...` imports from
//        within a *.test.ts file do NOT get path-rewritten. Production
//        modules that the tests *transitively* import resolve fine
//        (those files are NOT excluded), but direct test-file imports
//        of @-prefixed paths fail with "Cannot find package".
// Who:   every test that imports an @-aliased module at top level,
//        TestReminderJob.test.ts, GuildSetupManager.test.ts, and
//        ChannelDeleteWatcher.test.ts were the original surfacing.
// When:  in effect for every vitest run. The plugin and the explicit
//        aliases are additive: tsconfig-paths handles transitive
//        production imports, the explicit map below handles direct
//        test-file imports. Removing either would re-break one of the
//        two surfaces.
// Where: the `${"./src/<dir>"}` shape mirrors the tsconfig paths value
//        with the trailing `/*` stripped, Vite's alias matches by
//        prefix and rewrites the rest of the path verbatim.
// How:   import.meta.url + dirname gives us the project root in a way
//        that survives any future hoist of this config file. resolve()
//        produces an absolute path Vite can stat without ambiguity.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			"@utils": resolve(__dirname, "./src/utils"),
			"@base": resolve(__dirname, "./src/base"),
			"@api": resolve(__dirname, "./src/api"),
			"@features": resolve(__dirname, "./src/features"),
			"@commands": resolve(__dirname, "./src/commands"),
			"@db": resolve(__dirname, "./src/db"),
			"@handlers": resolve(__dirname, "./src/handlers"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: [
				"src/features/events/occurrenceCalculator.ts",
				"src/api/middleware/**",
				"src/api/routes/**",
				"src/features/reminders/**",
			],
		},
	},
});
