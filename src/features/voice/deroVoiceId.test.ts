import { describe, it, expect } from "vitest";
import { resolveDeroVoiceId } from "./deroVoiceId.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";

describe("resolveDeroVoiceId", () => {
	it("is George by default", () => {
		expect(BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID).toBe("JBFqnCBsd6RMkjVDRZzb");
	});

	// Rows saved before the default existed carry an explicit null, which a schema
	// default never rewrites, so this fallback is what gives those guilds a voice.
	it("reads a stored null as the default voice", () => {
		expect(resolveDeroVoiceId({ voiceId: null })).toBe(BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID);
	});

	it("reads a guild with no row as the default voice", () => {
		expect(resolveDeroVoiceId(null)).toBe(BOT_CONSTANTS.DERO_DEFAULT_VOICE_ID);
	});

	it("keeps a stored id", () => {
		expect(resolveDeroVoiceId({ voiceId: "abcDEF1234567890wxyz" })).toBe("abcDEF1234567890wxyz");
	});
});
