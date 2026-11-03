import type { ColorResolvable } from "discord.js";
import { COLORS } from "@base/copy/brand.js";
import {
	canvasColor,
	drawCardBackground,
	drawDeroPose,
	drawPanel,
	drawPill,
	drawText,
	renderCard,
	strokeCircle,
	withAlpha,
	type DrawOutcome,
	type RenderPayload,
} from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";
import type { SpeakerStatus } from "./voiceSpeaker.js";
import { voiceCopy } from "./voiceCopy.js";

// ── voicePresenceRenderer ────────────────────────────────────────────
// Dero's voice presence card (2026-10 item 243 Phase 4): Dero in a ring, the
// call's channel name, and one of three states, JOINED (the moment a call
// connects), LISTENING (in the call and quiet) or SPEAKING (a clip is playing).
// announceJoin draws the joined card on its public notice and /dero status
// draws the live state, each through withRenderFallback so the plain line or
// embed posts unchanged when the card does not draw. It never reads audio or
// a transcript: the state is the speaker's playing flag and nothing else.

export type VoicePresenceState = "joined" | "listening" | "speaking";

/** Everything the presence card draws, as plain data. */
export interface VoicePresenceView {
	state: VoicePresenceState;
	/** The voice channel's display name, since a card cannot draw a channel mention. */
	channelName: string;
}

/** The live state of a call: SPEAKING while the speaker plays a clip, LISTENING otherwise. */
export function liveVoicePresenceState(speakerStatus: SpeakerStatus): VoicePresenceState {
	return speakerStatus === "playing" ? "speaking" : "listening";
}

// Bump whenever the drawing changes, or members keep seeing cached cards.
const VOICE_PRESENCE_CARD_VERSION = 1;
const CARD_WIDTH = 900;
const CARD_HEIGHT = 300;
const PADDING = 32;
const DERO_CENTER = { x: 160, y: CARD_HEIGHT / 2 };
const DERO_DIAMETER = 176;
const TEXT_X = 320;
const TEXT_RIGHT = CARD_WIDTH - PADDING;
const PILL_HEIGHT = 40;
const PILL_WIDTH = 170;
// The rings drawn around Dero while listening: three, each this much wider than
// the last and fainter, so they read as attention spreading outward.
const LISTENING_RINGS = 3;
const RING_STEP = 26;
// The equalizer drawn while speaking. Fixed heights rather than random ones, so
// the same input always draws the same bytes and the card cache stays valid.
const SPEAKING_BAR_HEIGHTS = [0.45, 0.8, 1, 0.65, 0.9, 0.5, 0.75];
const SPEAKING_BAR_WIDTH = 10;
const SPEAKING_BAR_GAP = 8;
const SPEAKING_BAR_MAX = 64;

const STATE_ACCENT: Record<VoicePresenceState, ColorResolvable> = {
	joined: COLORS.DERO,
	listening: COLORS.VOICE_LISTENING,
	speaking: COLORS.VOICE_SPEAKING,
};

/** The presence card for one call state, or null when the line or embed should post alone. Never throws. */
export function renderVoicePresenceCard(view: VoicePresenceView): Promise<RenderPayload | null> {
	return renderCard({
		kind: "voice-presence",
		version: VOICE_PRESENCE_CARD_VERSION,
		input: view,
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		draw: drawVoicePresenceCard,
	});
}

async function drawVoicePresenceCard(context: SKRSContext2D, view: VoicePresenceView): Promise<DrawOutcome> {
	const accent = STATE_ACCENT[view.state];
	drawCardBackground(context, accent, DERO_CENTER.x, DERO_CENTER.y, CARD_WIDTH * 0.5);
	drawStateRings(context, view.state, accent);
	const deroStandIn = await drawDeroPose(context, "account", {
		x: DERO_CENTER.x - DERO_DIAMETER / 2,
		y: DERO_CENTER.y - DERO_DIAMETER / 2,
		width: DERO_DIAMETER,
		height: DERO_DIAMETER,
	});
	drawStateText(context, view, accent);
	if (view.state === "speaking") drawEqualizer(context, accent);
	return deroStandIn ? { cacheable: false } : undefined;
}

// One solid ring for a fresh join; spreading fading rings while listening; a
// bright double ring while speaking.
function drawStateRings(context: SKRSContext2D, state: VoicePresenceState, accent: ColorResolvable): void {
	const base = DERO_DIAMETER + 16;
	if (state === "joined") {
		strokeCircle(context, DERO_CENTER.x, DERO_CENTER.y, base, canvasColor(accent), 6);
		return;
	}
	if (state === "listening") {
		for (let ring = 0; ring < LISTENING_RINGS; ring += 1) {
			const alpha = 1 - ring / LISTENING_RINGS;
			strokeCircle(context, DERO_CENTER.x, DERO_CENTER.y, base + ring * RING_STEP, withAlpha(accent, alpha), 4);
		}
		return;
	}
	strokeCircle(context, DERO_CENTER.x, DERO_CENTER.y, base, canvasColor(accent), 8);
	strokeCircle(context, DERO_CENTER.x, DERO_CENTER.y, base + RING_STEP, withAlpha(accent, 0.5), 4);
}

function drawStateText(context: SKRSContext2D, view: VoicePresenceView, accent: ColorResolvable): void {
	const copy = voiceCopy.presence;
	drawPill(context, {
		x: TEXT_X,
		y: PADDING + 8,
		width: PILL_WIDTH,
		height: PILL_HEIGHT,
		fill: canvasColor(accent),
		label: copy.state[view.state],
		labelColor: canvasColor(COLORS.CARD_BACKGROUND),
	});
	drawText(context, copy.title(view.channelName), {
		x: TEXT_X,
		y: 136,
		size: 36,
		weight: "bold",
		color: canvasColor(COLORS.CARD_TEXT),
		baseline: "middle",
		maxWidth: TEXT_RIGHT - TEXT_X,
	});
	drawText(context, copy.detail[view.state], {
		x: TEXT_X,
		y: 184,
		size: 24,
		color: canvasColor(COLORS.CARD_TEXT_SECONDARY),
		baseline: "middle",
		maxWidth: TEXT_RIGHT - TEXT_X,
	});
	drawPanel(context, { x: TEXT_X, y: 222, width: TEXT_RIGHT - TEXT_X, height: 2, radius: 1, fill: withAlpha(COLORS.CARD_TEXT_MUTED, 0.4) });
	drawText(context, copy.footer, {
		x: TEXT_X,
		y: 252,
		size: 18,
		color: canvasColor(COLORS.CARD_TEXT_MUTED),
		baseline: "middle",
		maxWidth: TEXT_RIGHT - TEXT_X,
	});
}

// A short row of rounded bars in the top right corner, beside the state pill.
// drawPanel clamps its radius to half the bar's width, so each bar is fully
// rounded at both ends.
function drawEqualizer(context: SKRSContext2D, accent: ColorResolvable): void {
	const totalWidth = SPEAKING_BAR_HEIGHTS.length * (SPEAKING_BAR_WIDTH + SPEAKING_BAR_GAP) - SPEAKING_BAR_GAP;
	const left = TEXT_RIGHT - totalWidth;
	const baseline = PADDING + 8 + PILL_HEIGHT;
	SPEAKING_BAR_HEIGHTS.forEach((share, index) => {
		const height = SPEAKING_BAR_MAX * share;
		drawPanel(context, {
			x: left + index * (SPEAKING_BAR_WIDTH + SPEAKING_BAR_GAP),
			y: baseline - height,
			width: SPEAKING_BAR_WIDTH,
			height,
			radius: SPEAKING_BAR_WIDTH / 2,
			fill: canvasColor(accent),
		});
	});
}
