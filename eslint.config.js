import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
	js.configs.recommended,

	{
		files: ["**/*.ts"],

		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				// NOT tsconfig.json. That one excludes **/*.test.ts so tests never
				// compile into dist/, which left every colocated test file outside
				// any project and failing to parse. tsconfig.eslint.json is the same
				// config minus that exclusion, so tests get linted with the same
				// rules as the code they cover. See the header of that file.
				project: "./tsconfig.eslint.json",
			},
		},

		plugins: {
			"@typescript-eslint": tsPlugin,
			import: importPlugin,
			prettier: prettierPlugin,
		},

		rules: {
			// ── formatting (prettier owns these) ──────────────────
			"prettier/prettier": "off",
			"arrow-spacing": ["warn", { before: true, after: true }],
			"brace-style": ["error", "stroustrup", { allowSingleLine: true }],
			"comma-dangle": ["error", "always-multiline"],
			"comma-spacing": "error",
			"comma-style": "error",
			curly: ["error", "multi-line", "consistent"],
			"dot-location": ["error", "property"],
			"keyword-spacing": "error",
			"max-nested-callbacks": ["error", { max: 4 }],
			"max-statements-per-line": ["error", { max: 2 }],
			"no-floating-decimal": "error",
			"no-lonely-if": "error",
			"no-multi-spaces": "error",
			"no-multiple-empty-lines": ["error", { max: 2, maxEOF: 1, maxBOF: 0 }],
			"no-trailing-spaces": ["error"],
			"object-curly-spacing": ["error", "always"],
			semi: ["error", "always"],
			"space-before-blocks": "error",
			"space-before-function-paren": [
				"error",
				{
					anonymous: "never",
					named: "never",
					asyncArrow: "always",
				},
			],
			"space-in-parens": "error",
			"space-infix-ops": "error",
			"space-unary-ops": "error",
			"spaced-comment": "error",
			yoda: "error",

			// ── variables ─────────────────────────────────────────
			"no-var": "error",
			"prefer-const": "error",

			// ── turned off, TypeScript handles these natively ────
			"no-undef": "off", // TS already catches undefined variables
			"no-console": "off", // needed for scheduler/tracker logging
			"no-inline-comments": "off", // your codebase uses inline comments heavily
			"handle-callback-err": "off",

			// ── shadow, relaxed for common Discord.js patterns ───
			"no-shadow": [
				"error",
				{
					allow: ["err", "resolve", "reject", "interaction", "client", "event"],
					//                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
					//                                   these are reused across every
					//                                   command and listener, not a bug
				},
			],

			// ── unused vars, use TS version, not base ESLint ─────
			// base eslint rule off, it doesn't understand TS interfaces
			"no-unused-vars": "off",

			// TS version on, understands interfaces, type params etc
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_", // _details, _emoji etc
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					ignoreRestSiblings: true, // common in object destructuring
				},
			],

			// ── removed @typescript-eslint/no-explicit-any ────────
			// 'any' is sometimes necessary in Discord.js, e.g interaction handlers,
			// partial types, dynamic command loading. Enforcing this causes more
			// suppression comments than it prevents actual bugs.
			// If you want a softer version, use warn instead:
			// "@typescript-eslint/no-explicit-any": "warn",

			// ── empty functions, off for TS interfaces/abstracts ─
			// base rule off, flags interface method signatures as "empty"
			"no-empty-function": "off",
			// TS version understands the difference
			"@typescript-eslint/no-empty-function": [
				"error",
				{
					allow: [
						"private-constructors", // singleton pattern
						"protected-constructors", // abstract base classes
						"decoratedFunctions", // if you add decorators later
						"overrideMethods", // interface implementations
					],
				},
			],

			// ── import extensions ─────────────────────────────────
			"import/extensions": [
				"error",
				"always",
				{
					js: "always",
					ts: "never",
				},
			],
		},
	},

	// prettier must be last
	prettierConfig,

	{
		ignores: ["dist/**", "node_modules/**", "scripts/**"],
	},
];
