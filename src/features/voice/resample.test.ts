import { describe, it, expect } from "vitest";
import { pcm24kMonoToPcm48kStereo } from "./resample.js";

// ── resample ───────────────────────────────────────────────────────────────
// The converter is pure, so every promise is checked on exact bytes: the length
// rule, the interpolated midpoints, the repeated last sample, the stereo copy,
// and the refusal of half a sample.

function monoPcm(samples: number[]): Buffer {
	const buffer = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
	return buffer;
}

// Read the output back as [left, right] pairs.
function stereoFrames(buffer: Buffer): Array<[number, number]> {
	const frames: Array<[number, number]> = [];
	for (let offset = 0; offset < buffer.length; offset += 4) {
		frames.push([buffer.readInt16LE(offset), buffer.readInt16LE(offset + 2)]);
	}
	return frames;
}

describe("pcm24kMonoToPcm48kStereo", () => {
	it("writes eight output bytes for every input sample", () => {
		expect(pcm24kMonoToPcm48kStereo(monoPcm([1, 2, 3])).length).toBe(3 * 8);
		expect(pcm24kMonoToPcm48kStereo(monoPcm(new Array(480).fill(0))).length).toBe(480 * 8);
	});

	it("keeps each sample, then the midpoint to the next, on both channels", () => {
		const frames = stereoFrames(pcm24kMonoToPcm48kStereo(monoPcm([0, 100, -100, 32767])));
		expect(frames).toEqual([
			[0, 0],
			[50, 50],
			[100, 100],
			[0, 0],
			[-100, -100],
			[16333, 16333],
			[32767, 32767],
			[32767, 32767],
		]);
	});

	it("repeats a single sample into two identical frames", () => {
		expect(stereoFrames(pcm24kMonoToPcm48kStereo(monoPcm([-1234])))).toEqual([
			[-1234, -1234],
			[-1234, -1234],
		]);
	});

	it("stays inside the 16 bit range at both extremes", () => {
		const frames = stereoFrames(pcm24kMonoToPcm48kStereo(monoPcm([-32768, -32768, 32767])));
		expect(frames[1]).toEqual([-32768, -32768]);
		expect(frames[3]).toEqual([-1, -1]);
	});

	it("turns empty input into empty output", () => {
		expect(pcm24kMonoToPcm48kStereo(Buffer.alloc(0)).length).toBe(0);
	});

	it("rejects an odd byte length instead of playing a shifted stream", () => {
		expect(() => pcm24kMonoToPcm48kStereo(Buffer.from([1, 2, 3]))).toThrow(RangeError);
	});
});
