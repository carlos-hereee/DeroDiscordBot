import OpusScript from "opusscript";

// ── opus decoder ───────────────────────────────────────────────────────────
// What:  turn the Opus packets Discord sends for one speaker into 48 kHz
//        stereo s16le PCM, one packet at a time.
// Who:   voiceListener makes one decoder per utterance and closes it when the
//        utterance ends. Nothing else decodes audio.
// When:  only for a speaker who already passed the operator gate, so a member
//        who is not on the task list never reaches this file.
// Where: opusscript (pure JavaScript and WebAssembly, already installed for the
//        speaker's encoder) is used directly; prism-media is not imported. The
//        format matches what Discord sends: 48 kHz, 2 channels, 20 ms frames.
// How:   ① one OpusScript handle per utterance, so no decoder state leaks from
//        one member's sentence into the next; ② a packet that fails to decode
//        is counted and skipped, never retried (one lost 20 ms frame is
//        inaudible, and a run of them is a symptom the caller can report);
//        ③ close() frees the WebAssembly memory and is safe to call twice.
//
// ⚠️ PRIVACY: decoded PCM is returned to the caller and never kept, logged or
// written here. A decode error is counted, not logged with its packet.

export const DECODE_SAMPLE_RATE = 48_000;
export const DECODE_CHANNELS = 2;

/** One utterance's decoder. */
export interface OpusPacketDecoder {
	/** The PCM for one packet, or null when the packet could not be decoded. */
	decode(packet: Buffer): Buffer | null;
	/** How many packets this decoder could not decode. */
	readonly failures: number;
	/** Free the decoder. Later decode() calls return null. */
	close(): void;
}

/** A decoder for one utterance, 48 kHz stereo, backed by opusscript. */
export function createOpusDecoder(): OpusPacketDecoder {
	// ①
	const handle = new OpusScript(DECODE_SAMPLE_RATE, DECODE_CHANNELS, OpusScript.Application.VOIP);
	let failures = 0;
	let closed = false;

	return {
		decode(packet) {
			if (closed) return null;
			try {
				return handle.decode(packet);
			}
			catch {
				// ② an invalid or oversized packet; skipped on purpose
				failures += 1;
				return null;
			}
		},
		get failures() {
			return failures;
		},
		close() {
			// ③
			if (closed) return;
			closed = true;
			handle.delete();
		},
	};
}
