// ── resample ───────────────────────────────────────────────────────────────
// What:  the two sample rate conversions a voice call needs. Speech OUT: the
//        provider's 24 kHz mono PCM up to the 48 kHz stereo PCM a Discord voice
//        player takes as raw input. Speech IN: the 48 kHz stereo PCM decoded
//        from a member's Opus packets down to the 16 kHz mono speech to text
//        is sent.
// Who:   callSpeech upsamples (the greeting, the brain's `say`, in call Listen,
//        a turn's spoken answer); turnLoop downsamples one utterance before it
//        is wrapped as a WAV file. Nothing else touches sample data.
// When:  once per clip or utterance. The clip cache keeps the 24 kHz original,
//        so a replay resamples again; that is a few milliseconds of integer
//        math and costs no provider call.
// Where: this is what keeps ffmpeg out of the bot. @discordjs/voice encodes raw
//        input and Discord sends Opus at a fixed 48 kHz, 2 channels, 20 ms
//        frames, so the only conversions needed are exact integer ratios.
// How:   UP: each input sample becomes two output frames, the sample itself,
//        then the average of it and the next sample (the last sample is
//        repeated, so its midpoint is itself); every frame writes the same value
//        to left and right. DOWN: each group of three stereo frames becomes one
//        mono sample, the average of its six values (both channels, three
//        frames); a trailing group shorter than three frames is dropped.
//        Linear interpolation and plain averaging are enough for speech; a
//        windowed filter would buy nothing a member or a transcriber can hear.
//
// Both sides are signed 16 bit little endian, the byte order ElevenLabs sends
// for pcm_* and the order StreamType.Raw expects and opusscript decodes to.

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

// ── downsample, for speech to text ──

const STEREO_FRAME_BYTES = OUTPUT_CHANNELS * BYTES_PER_SAMPLE;
const FRAMES_PER_16K_SAMPLE = 3;
const VALUES_PER_16K_SAMPLE = FRAMES_PER_16K_SAMPLE * OUTPUT_CHANNELS;

/**
 * 48 kHz stereo s16le in, 16 kHz mono s16le out: two output bytes per three
 * whole input frames. Throws a RangeError when the input is not whole stereo
 * frames, because a decoder that hands over half a frame is broken and its
 * output would be noise rather than speech.
 */
export function pcm48kStereoTo16kMono(input: Buffer): Buffer {
	if (input.length % STEREO_FRAME_BYTES !== 0) {
		throw new RangeError(`pcm48kStereoTo16kMono needs whole stereo frames, got ${input.length} bytes`);
	}

	const outputSamples = Math.floor(input.length / STEREO_FRAME_BYTES / FRAMES_PER_16K_SAMPLE);
	const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

	for (let index = 0; index < outputSamples; index++) {
		const groupOffset = index * FRAMES_PER_16K_SAMPLE * STEREO_FRAME_BYTES;
		let sum = 0;
		for (let value = 0; value < VALUES_PER_16K_SAMPLE; value++) {
			sum += input.readInt16LE(groupOffset + value * BYTES_PER_SAMPLE);
		}
		// One division of the six value sum is the same average as halving the
		// channels and then thirding the frames, without rounding twice. Floor, as
		// the upsampler does, so every value rounds the same direction.
		output.writeInt16LE(Math.floor(sum / VALUES_PER_16K_SAMPLE), index * BYTES_PER_SAMPLE);
	}
	return output;
}
