import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { secureRandom, SECURE_RANDOM_RANGE } from "./secureRng.js";

// ── secureRng ─────────────────────────────────────────────────────────────
// Two halves. The function: a number in [0, 1) drawn from a range of at least 2
// to the 48th values. The call sites: a source scan of src that fails any
// dealHand call outside a test that leaves out its rng argument, and pins the
// three hold em call sites (deal, act, clock fold) to secureRandom by name.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
		.map((path) => join(dir, path));
}

// Every call of `name(` with its whole argument list, balanced parentheses, so an
// argument that is itself a call does not end the match early. Declarations
// (`function dealHand(`) are skipped.
function callsOf(source: string, name: string): string[] {
	const calls: string[] = [];
	const pattern = new RegExp(`(?<![\\w$.])${name}\\(`, "g");
	for (const match of source.matchAll(pattern)) {
		const before = source.slice(Math.max(0, (match.index ?? 0) - 9), match.index);
		if (before.endsWith("function ")) continue;
		let depth = 1;
		let index = (match.index ?? 0) + match[0].length;
		const start = index;
		while (index < source.length && depth > 0) {
			if (source[index] === "(") depth++;
			if (source[index] === ")") depth--;
			index++;
		}
		calls.push(source.slice(start, index - 1));
	}
	return calls;
}

// Top level commas only, so `f(a, b)` inside an argument is one argument.
function argumentCount(args: string): number {
	if (args.trim() === "") return 0;
	let depth = 0;
	let count = 1;
	for (const char of args) {
		if ("([{".includes(char)) depth++;
		if (")]}".includes(char)) depth--;
		if (char === "," && depth === 0) count++;
	}
	return count;
}

describe("secureRandom", () => {
	it("draws from a range of at least 2 to the 48th values", () => {
		expect(SECURE_RANDOM_RANGE).toBeGreaterThanOrEqual(2 ** 48);
	});

	it("returns numbers from 0 up to but not including 1", () => {
		for (let draw = 0; draw < 5000; draw++) {
			const value = secureRandom();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it("is spread across the whole interval, not stuck in one corner", () => {
		const buckets = new Array<number>(10).fill(0);
		for (let draw = 0; draw < 10_000; draw++) buckets[Math.floor(secureRandom() * 10)]++;
		// 1000 expected per bucket; 800 is far outside chance for a uniform source.
		for (const count of buckets) expect(count).toBeGreaterThan(800);
	});
});

describe("the shuffle call sites", () => {
	it("the scanner has teeth: it sees a missing rng and a present one", () => {
		expect(callsOf("dealHand(table);", "dealHand").map(argumentCount)).toEqual([1]);
		expect(callsOf("dealHand(table, secureRandom);", "dealHand").map(argumentCount)).toEqual([2]);
		expect(callsOf("export function dealHand(table, rng) {}", "dealHand")).toEqual([]);
		expect(callsOf("x.redealHand(a)", "dealHand")).toEqual([]);
	});

	it("no dealHand call in src outside a test omits the rng argument", () => {
		const offenders: string[] = [];
		let seen = 0;
		for (const file of sourceFiles(SRC)) {
			for (const args of callsOf(readFileSync(file, "utf8"), "dealHand")) {
				seen++;
				if (argumentCount(args) < 2) offenders.push(`${relative(SRC, file)}: dealHand(${args})`);
			}
		}
		expect(seen).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	it("the hold em room handlers pass secureRandom to deal, act and the clock fold", () => {
		const handlers = readFileSync(join(SRC, "features", "game-rooms", "roomHoldemHandlers.ts"), "utf8");
		const last = (args: string) => args.split(",").pop()?.trim();
		expect(callsOf(handlers, "dealHand").map(last)).toEqual(["secureRandom"]);
		expect(callsOf(handlers, "act").map(last)).toEqual(["secureRandom"]);
		expect(callsOf(handlers, "forceFold").map(last)).toEqual(["secureRandom"]);
		expect(handlers).not.toMatch(/Math\.random/);
	});
});
