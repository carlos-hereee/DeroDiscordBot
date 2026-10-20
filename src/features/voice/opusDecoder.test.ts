import { describe, it, expect } from "vitest";
import OpusScript from "opusscript";
import { createOpusDecoder } from "./opusDecoder.js";

// ── opus decoder ───────────────────────────────────────────────────────────
// Against the real opusscript: a 20 ms Discord frame round trips to 3840 bytes
// of 48 kHz stereo PCM with the signal intact, a packet that cannot be decoded
// is counted and skipped, and a closed decoder decodes nothing.

const FRAME_SAMPLES = 960;

function tonePacket(): Buffer {
	const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
	const pcm = Buffer.alloc(FRAME_SAMPLES * 4);
	for (let index = 0; index < FRAME_SAMPLES; index++) {
		const sample = Math.round(8000 * Math.sin((2 * Math.PI * 440 * index) / 48_000));
		pcm.writeInt16LE(sample, index * 4);
		pcm.writeInt16LE(sample, index * 4 + 2);
	}
	const packet = encoder.encode(pcm, FRAME_SAMPLES);
	encoder.delete();
	return packet;
}

function rms(pcm: Buffer): number {
	let sum = 0;
	for (let offset = 0; offset < pcm.length; offset += 2) sum += pcm.readInt16LE(offset) ** 2;
	return Math.sqrt(sum / (pcm.length / 2));
}

describe("createOpusDecoder", () => {
	it("decodes one 20 ms packet to 48 kHz stereo s16le with the signal intact", () => {
		const decoder = createOpusDecoder();
		const packet = tonePacket();
		decoder.decode(packet);
		const pcm = decoder.decode(packet);
		expect(pcm?.length).toBe(FRAME_SAMPLES * 4);
		// A sine of amplitude 8000 has an RMS near 5657; a codec keeps it close.
		expect(rms(pcm as Buffer)).toBeGreaterThan(4000);
		expect(decoder.failures).toBe(0);
		decoder.close();
	});

	it("counts and skips a packet that cannot be decoded", () => {
		const decoder = createOpusDecoder();
		expect(decoder.decode(Buffer.alloc(5000))).toBeNull();
		expect(decoder.failures).toBe(1);
		decoder.close();
	});

	it("decodes nothing once closed, and closing twice is safe", () => {
		const decoder = createOpusDecoder();
		decoder.close();
		decoder.close();
		expect(decoder.decode(tonePacket())).toBeNull();
	});
});
