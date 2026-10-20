import { describe, it, expect } from "vitest";
import { pcm24kMonoToPcm48kStereo, pcm48kStereoTo16kMono } from "./resample.js";

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

// ── downsample, for speech to text ──

function stereoPcm(frames: Array<[number, number]>): Buffer {
	const buffer = Buffer.alloc(frames.length * 4);
	frames.forEach(([left, right], index) => {
		buffer.writeInt16LE(left, index * 4);
		buffer.writeInt16LE(right, index * 4 + 2);
	});
	return buffer;
}

function monoSamples(buffer: Buffer): number[] {
	const samples: number[] = [];
	for (let offset = 0; offset < buffer.length; offset += 2) samples.push(buffer.readInt16LE(offset));
	return samples;
}

describe("pcm48kStereoTo16kMono", () => {
	it("makes one 16 bit mono sample from every three whole stereo frames", () => {
		const twentyMsFrame = Buffer.alloc(960 * 4);
		expect(pcm48kStereoTo16kMono(twentyMsFrame).length).toBe(320 * 2);
	});

	it("averages both channels and all three frames of a group", () => {
		const input = stereoPcm([
			[300, 600],
			[900, 0],
			[-300, 300],
			[6, 6],
			[6, 6],
			[6, 6],
		]);
		// (300 + 600 + 900 + 0 - 300 + 300) / 6 = 300, then a flat 6
		expect(monoSamples(pcm48kStereoTo16kMono(input))).toEqual([300, 6]);
	});

	it("floors a fractional average, negative values included", () => {
		expect(monoSamples(pcm48kStereoTo16kMono(stereoPcm([[1, 0], [0, 0], [0, 0]])))).toEqual([0]);
		expect(monoSamples(pcm48kStereoTo16kMono(stereoPcm([[-1, 0], [0, 0], [0, 0]])))).toEqual([-1]);
	});

	it("stays inside the 16 bit range at full scale", () => {
		const loud = stereoPcm([[32767, 32767], [32767, 32767], [32767, 32767], [-32768, -32768], [-32768, -32768], [-32768, -32768]]);
		expect(monoSamples(pcm48kStereoTo16kMono(loud))).toEqual([32767, -32768]);
	});

	it("drops a trailing group shorter than three frames", () => {
		expect(monoSamples(pcm48kStereoTo16kMono(stereoPcm([[10, 10], [10, 10], [10, 10], [99, 99], [99, 99]])))).toEqual([10]);
		expect(pcm48kStereoTo16kMono(Buffer.alloc(0)).length).toBe(0);
	});

	it("refuses input that is not whole stereo frames", () => {
		expect(() => pcm48kStereoTo16kMono(Buffer.alloc(6))).toThrow(RangeError);
	});
});
