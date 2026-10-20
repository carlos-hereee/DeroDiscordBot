import { describe, it, expect } from "vitest";
import { WAV_HEADER_BYTES, wavFromPcm16kMono } from "./wavFile.js";

// ── WAV file ───────────────────────────────────────────────────────────────
// The header is the whole contract with speech to text, so it is pinned byte
// by byte against the canonical 44 byte PCM layout.

describe("wavFromPcm16kMono", () => {
	const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x10, 0x00]);
	const wav = wavFromPcm16kMono(pcm);

	it("is a 44 byte header followed by the PCM unchanged", () => {
		expect(WAV_HEADER_BYTES).toBe(44);
		expect(wav.length).toBe(44 + pcm.length);
		expect(wav.subarray(44).equals(pcm)).toBe(true);
	});

	it("writes the RIFF, WAVE, fmt and data chunk ids where a reader looks for them", () => {
		expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
		expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
		expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
		expect(wav.toString("ascii", 36, 40)).toBe("data");
	});

	it("describes 16 kHz, mono, 16 bit integer PCM, little endian", () => {
		expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
		expect(wav.readUInt32LE(16)).toBe(16);
		expect(wav.readUInt16LE(20)).toBe(1);
		expect(wav.readUInt16LE(22)).toBe(1);
		expect(wav.readUInt32LE(24)).toBe(16_000);
		expect(wav.readUInt32LE(28)).toBe(32_000);
		expect(wav.readUInt16LE(32)).toBe(2);
		expect(wav.readUInt16LE(34)).toBe(16);
		expect(wav.readUInt32LE(40)).toBe(pcm.length);
	});

	it("matches the exact header bytes", () => {
		expect([...wav.subarray(0, 44)]).toEqual([
			0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01,
			0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x08, 0x00,
			0x00, 0x00,
		]);
	});

	it("frames empty PCM as a valid, empty file", () => {
		const empty = wavFromPcm16kMono(Buffer.alloc(0));
		expect(empty.length).toBe(44);
		expect(empty.readUInt32LE(40)).toBe(0);
	});

	it("refuses half a sample", () => {
		expect(() => wavFromPcm16kMono(Buffer.alloc(3))).toThrow(RangeError);
	});
});
