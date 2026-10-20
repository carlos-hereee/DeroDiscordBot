import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ── privacy tripwire ───────────────────────────────────────────────────────
// What:  a mechanical check that the two folders which touch a member's voice
//        and words, src/features/voice and src/features/dero-brain, never write
//        a file and never hand a variable named transcript, text or audio to a
//        logging call (console.*, botLogStore.log, or any audit function).
// Who:   runs with the suite. It reads the SOURCE, so it catches a regression
//        the moment one is written, not when a member's words reach a log.
// How:   ① strip comments, so a comment that explains why nothing is written
//        cannot trip it; ② look for the fs write APIs anywhere; ③ find every
//        logging call, take its whole argument list (balanced parentheses),
//        remove the text of string literals but KEEP template ${...}
//        expressions, and look for the three names as whole identifiers.
//        `transcriptChars` and `audioMs` are different identifiers and pass;
//        `transcript.length` does not, because the name itself is in the call.
//        The scanner proves it has teeth on planted fixtures before it is
//        trusted with the real files.

const HERE = dirname(fileURLToPath(import.meta.url));
const FOLDERS = [HERE, join(HERE, "..", "dero-brain")];

const FS_WRITE = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b/;
// `audit(`, `deps.audit(`, `auditAction(`: any function whose name holds "audit".
const LOGGING_CALL = /\b(?:console\.(?:log|info|warn|error|debug)|botLogStore\.log|[\w$]*[aA]udit[\w$]*)\s*\(/g;
const FORBIDDEN_NAME = /\b(transcript|text|audio)\b/;

// ① comments out, strings and template literals left in place.
function stripComments(source: string): string {
	let output = "";
	let index = 0;
	let quote: string | null = null;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (quote) {
			output += char;
			if (char === "\\") {
				output += next ?? "";
				index += 2;
				continue;
			}
			if (char === quote) quote = null;
			index += 1;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		output += char;
		index += 1;
	}
	return output;
}

// ③ the argument list of a call whose "(" is at `open`, with string literal
// text blanked out and template ${...} expressions kept.
function argumentCode(source: string, open: number): string {
	let depth = 0;
	let code = "";
	let index = open;
	let quote: string | null = null;
	let templateDepth = 0;
	while (index < source.length) {
		const char = source[index];
		if (quote) {
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (quote === "`" && char === "$" && source[index + 1] === "{") {
				// Back to code inside the template until the matching brace.
				quote = null;
				templateDepth += 1;
				code += " ";
				index += 2;
				continue;
			}
			if (char === quote) quote = null;
			index += 1;
			continue;
		}
		if (templateDepth > 0 && char === "}") {
			templateDepth -= 1;
			quote = "`";
			code += " ";
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			index += 1;
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return code;
		}
		if (depth > 0 && !(depth === 1 && char === "(")) code += char;
		index += 1;
	}
	return code;
}

function violationsIn(source: string): string[] {
	const code = stripComments(source);
	const found: string[] = [];
	const write = code.match(FS_WRITE);
	if (write) found.push(`fs write API ${write[1]}`);
	for (const call of code.matchAll(LOGGING_CALL)) {
		const open = (call.index ?? 0) + call[0].length - 1;
		const name = argumentCode(code, open).match(FORBIDDEN_NAME);
		if (name) found.push(`${call[0].trim()} receives ${name[1]}`);
	}
	return found;
}

function sourceFiles(): Array<{ path: string; source: string }> {
	return FOLDERS.flatMap((folder) =>
		readdirSync(folder)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.map((name) => ({ path: join(folder, name), source: readFileSync(join(folder, name), "utf8") })),
	);
}

describe("the scanner has teeth", () => {
	it.each([
		["a transcript handed to console", "console.info(transcript);"],
		["a property named text in a template", "console.warn(`said ${result.text} now`);"],
		["audio in an audit row", "deps.audit(guildId, { bytes: 1, audio });"],
		["text in a botLogStore row", "botLogStore.log(id, event, { text: speech.text });"],
		["a file write", "await fs.promises.writeFile(path, buffer);"],
		["a write stream", "const out = createWriteStream(path);"],
	])("flags %s", (_label, fixture) => {
		expect(violationsIn(fixture)).not.toEqual([]);
	});

	it.each([
		["a count", "console.info(`chars=${transcriptChars} ms=${audioMs}`);"],
		["the word inside a string", 'console.warn("the text was dropped");'],
		["a comment", "// we never call writeFile here\nconsole.info(guildId);"],
		["a different identifier", "deps.audit(guildId, { textChars: 3, contextId });"],
	])("passes %s", (_label, fixture) => {
		expect(violationsIn(fixture)).toEqual([]);
	});
});

describe("src/features/voice and src/features/dero-brain", () => {
	it("scans every source file in both folders", () => {
		const names = sourceFiles().map((file) => relative(join(HERE, ".."), file.path).replace(/\\/g, "/"));
		expect(names).toEqual(expect.arrayContaining(["voice/turnLoop.ts", "voice/voiceListener.ts", "voice/elevenLabsStt.ts", "dero-brain/brainTurn.ts"]));
	});

	it("never writes a file and never logs a transcript, text or audio", () => {
		const violations = sourceFiles().flatMap((file) => violationsIn(file.source).map((violation) => `${relative(HERE, file.path)}: ${violation}`));
		expect(violations).toEqual([]);
	});
});
