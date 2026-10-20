// ── resample ───────────────────────────────────────────────────────────────
// What:  turn the provider's 24 kHz mono PCM into the 48 kHz stereo PCM a
//        Discord voice player takes as raw input.
// Who:   callSpeech (the greeting now, the brain's `say` and in call Listen
//        next). Nothing else touches sample data.
// When:  once per clip, right before it is queued on the speaker. The clip
//        cache keeps the 24 kHz original, so a replay resamples again; that is
//        a few milliseconds of integer math and costs no provider call.
// Where: this is what keeps ffmpeg out of the bot. @discordjs/voice encodes raw
//        input with opusscript at a fixed 48 kHz, 2 channels, 20 ms frames, so
//        the only conversion needed is a 2x upsample and a channel copy.
// How:   each input sample becomes two output frames: the sample itself, then
//        the average of it and the next sample (the last sample is repeated, so
//        its midpoint is itself). Every frame writes the same value to left and
//        right. Linear interpolation is enough for speech; a windowed filter
//        would buy nothing a member can hear at this rate.
//
// Both sides are signed 16 bit little endian, the byte order ElevenLabs sends
// for pcm_* and the order StreamType.Raw expects.

const BYTES_PER_SAMPLE = 2;
const OUTPUT_FRAMES_PER_INPUT_SAMPLE = 2;
const OUTPUT_CHANNELS = 2;
const OUTPUT_BYTES_PER_INPUT_SAMPLE = OUTPUT_FRAMES_PER_INPUT_SAMPLE * OUTPUT_CHANNELS * BYTES_PER_SAMPLE;

function writeStereoFrame(output: Buffer, frameIndex: number, sample: number): void {
	const offset = frameIndex * OUTPUT_CHANNELS * BYTES_PER_SAMPLE;
	output.writeInt16LE(sample, offset);
	output.writeInt16LE(sample, offset + BYTES_PER_SAMPLE);
}

/**
 * 24 kHz mono s16le in, 48 kHz stereo s16le out, exactly eight output bytes
 * per input sample. Throws a RangeError on an odd byte length, because half a
 * sample means the provider's stream was cut, and playing it shifted by one
 * byte would be loud noise rather than speech.
 */
export function pcm24kMonoToPcm48kStereo(input: Buffer): Buffer {
	if (input.length % BYTES_PER_SAMPLE !== 0) {
		throw new RangeError(`pcm24kMonoToPcm48kStereo needs whole 16 bit samples, got ${input.length} bytes`);
	}

	const sampleCount = input.length / BYTES_PER_SAMPLE;
	const output = Buffer.alloc(sampleCount * OUTPUT_BYTES_PER_INPUT_SAMPLE);

	for (let index = 0; index < sampleCount; index++) {
		const current = input.readInt16LE(index * BYTES_PER_SAMPLE);
		const next = index + 1 < sampleCount ? input.readInt16LE((index + 1) * BYTES_PER_SAMPLE) : current;
		// The sum of two int16 values fits easily in a 32 bit int, and its half is
		// always back inside the int16 range. `>> 1` floors, the same direction for
		// every pair, so the midpoint never drifts upward on silence.
		const midpoint = (current + next) >> 1;

		const firstFrame = index * OUTPUT_FRAMES_PER_INPUT_SAMPLE;
		writeStereoFrame(output, firstFrame, current);
		writeStereoFrame(output, firstFrame + 1, midpoint);
	}
	return output;
}
