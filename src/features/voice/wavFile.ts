// ── WAV file ───────────────────────────────────────────────────────────────
// What:  wrap one utterance of 16 kHz mono PCM in a 44 byte RIFF header, so
//        speech to text receives an ordinary .wav file it can read with no
//        format hints.
// Who:   turnLoop, once per utterance, right before elevenLabsStt uploads it.
// When:  in memory only. The file is a Buffer that exists for the length of one
//        upload and is dropped with the utterance; nothing here touches a disk.
// Where: pure. resample.ts makes the PCM; this file only frames it.
// How:   the canonical PCM WAV layout: a RIFF chunk, a 16 byte fmt chunk (format
//        1 for integer PCM, 1 channel, 16000 Hz, 16 bits), then the data chunk.
//        Every number is little endian, as RIFF requires.

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN;
const FORMAT_INTEGER_PCM = 1;
const FMT_CHUNK_BYTES = 16;

export const WAV_HEADER_BYTES = 44;
// The RIFF size counts everything after its own 8 byte "RIFF" plus size field.
const RIFF_SIZE_OVERHEAD = WAV_HEADER_BYTES - 8;

/**
 * A complete WAV file for 16 kHz mono s16le PCM. Throws a RangeError on an odd
 * byte length, because half a sample means the PCM was cut and every sample
 * after it would be read one byte off.
 */
export function wavFromPcm16kMono(pcm: Buffer): Buffer {
	if (pcm.length % BYTES_PER_SAMPLE !== 0) {
		throw new RangeError(`wavFromPcm16kMono needs whole 16 bit samples, got ${pcm.length} bytes`);
	}

	const header = Buffer.alloc(WAV_HEADER_BYTES);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(RIFF_SIZE_OVERHEAD + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(FMT_CHUNK_BYTES, 16);
	header.writeUInt16LE(FORMAT_INTEGER_PCM, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(BYTE_RATE, 28);
	header.writeUInt16LE(BLOCK_ALIGN, 32);
	header.writeUInt16LE(BITS_PER_SAMPLE, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
