// scripts/render-orbs.mjs
// Local, one-shot renderer for the /fortune magic-8-ball orbs (fortune orb work,
// FUTURE_PLANS item 88 family). Turns the vector orb into one animated GIF per
// verdict, indigo for the common tier and gold for the ultra tier, so the bot
// can attach the matching orb to a reading. Runs on your machine, no sandbox
// needed: plain Node (ESM) plus three small libs.
//
//   cd DeroDiscordBot
//   npm i -D @resvg/resvg-js pngjs gifenc
//   node scripts/render-orbs.mjs
//
// Output: assets/fortune/orbs/{common,ultra}/<slug>.gif
// GIF for now: universal in Discord and dead-reliable to generate. It is matted
// on Discord's dark card colour so the edge is clean and the orb appears to float
// (great on dark theme; light theme shows a dark tile). WebP (smaller, true
// transparency, no 256-colour banding) is the quality pass once the look and the
// Discord wiring are confirmed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "assets", "fortune", "orbs");
const CINZEL = path.join(__dirname, "fonts", "Cinzel-Bold.ttf"); // optional; download from Google Fonts
const MATTE = "#2b2d31"; // Discord embed background so the orb blends on dark theme

// ── the verdicts (edit these freely) ───────────────────────────────────────
// Terse die lines that surface in the window. One GIF is rendered per entry.
const COMMON_VERDICTS = [
	// Positive (11)
	"IT IS CERTAIN", "WITHOUT A DOUBT", "YES DEFINITELY", "RELY ON IT", "OUTLOOK GOOD",
	"MOST LIKELY", "SIGNS POINT TO YES", "ABSOLUTELY", "SHIP IT", "THE RUNES ALIGN", "DERO APPROVES",
	// Neutral (5)
	"ASK AGAIN LATER", "TOO CLOSE TO CALL", "STILL LOADING", "A RESOUNDING MAYBE", "UNCLEAR",
	// Negative (4)
	"NOT TODAY", "MY SOURCES SAY NO", "DON'T COUNT ON IT", "VERY DOUBTFUL",
];
const ULTRA_VERDICTS = [
	"WITHOUT DOUBT", "DESTINY SAYS YES", "THE STARS ALIGN", "IT IS YOUR MOMENT",
	"A CERTAINTY", "GO NOW",
];

// ── render config ──────────────────────────────────────────────────────────
const SIZE = 256; // output px, square
const FPS = 14;
const DURATION = 10.0; // seconds per loop; sets the overall pacing (shake / pause / answer). Rune spin is separate (TIERS.spinDeg).
const FRAMES = Math.round(FPS * DURATION);
const TEXT_SCALE = 0.78; // verdict text knob: lower = smaller text in the window

// ── animation timeline (fractions of the loop) ──────────────────────────────
// Shake 3.5s, then the question mark holds ~1s, then it dissolves into the answer,
// which is held ~5s before a quick fade so the loop is seamless. Tune here.
const SHAKE_END = 0.35; // 3.5s of shaking
const Q_HOLD_END = 0.45; // question mark holds ~1s past the shake, then dissolves
const Q_DISSOLVE_END = 0.48;
const VERDICT_IN_START = 0.47;
const VERDICT_IN_END = 0.51; // answer fully surfaced by ~5.1s
const ANSWER_HOLD_END = 0.96; // answer held to ~9.6s, then a quick fade

// ── palettes ───────────────────────────────────────────────────────────────
// spinDeg = degrees the rune ring turns over the whole loop, DECOUPLED from the
// loop length: it is the rune-spin knob. Under a full turn (360) it resets at the
// loop seam, which the shake at the top of the loop masks. Lower = slower.
const TIERS = {
	common: {
		shell: ["#3c3a60", "#201d3c", "#121028", "#06050e"],
		glow: "#6a61f2", rim: "#eceaff", innerRim: "#8079ff",
		rune: "#c9c2ff", runeBright: "#d8d3ff",
		win: ["#2f2a68", "#141031", "#050409"],
		verdict: "#eceaff", q: "#5049a6", glint: null, stars: false, spinDeg: 270,
	},
	ultra: {
		shell: ["#3a3324", "#1f1a0e", "#100c05", "#060401"],
		glow: "#ffdf6b", rim: "#fff3c8", innerRim: "#ffe08a",
		rune: "#ffe08a", runeBright: "#fff0b8",
		win: ["#5b4a14", "#2a2008", "#080601"],
		verdict: "#fff3c8", q: "#6e5512", glint: "#fffbe8", stars: true, spinDeg: 360,
	},
};

// ── small math ─────────────────────────────────────────────────────────────
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, x) => a + (b - a) * x;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const scaleAbout = (cx, cy, s) => `translate(${(cx * (1 - s)).toFixed(2)} ${(cy * (1 - s)).toFixed(2)}) scale(${s.toFixed(3)})`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// A sustained, decaying shake for the first SHAKE_END of the loop. Procedural
// (high-frequency sines at non-harmonic rates) so it reads as a real shake for the
// full 3.5s, easing to a settle at the end rather than one slow wobble.
function shakeAt(t) {
	if (t >= SHAKE_END) return [0, 0, 0];
	const secs = t * DURATION;
	const env = 1 - smooth(SHAKE_END * 0.82, SHAKE_END, t); // ease amplitude to 0 near the end
	return [7 * Math.sin(secs * 41) * env, 5 * Math.sin(secs * 47 + 1.3) * env, 3.5 * Math.sin(secs * 37 + 0.7) * env];
}

// verdict word-wrap + a font size that fits the window circle
function wrap(text, maxChars = 9) {
	const words = text.split(/\s+/);
	const lines = [];
	let cur = "";
	for (const w of words) {
		if (cur && cur.length + 1 + w.length > maxChars) { lines.push(cur); cur = w; }
		else cur = cur ? `${cur} ${w}` : w;
	}
	if (cur) lines.push(cur);
	return lines;
}
function fitFont(lines) {
	const D = 136; // window diameter (r68 * 2)
	const maxLen = Math.max(...lines.map((l) => l.length));
	const byWidth = (D * 0.8) / (maxLen * 0.58);
	const byHeight = (D * 0.78) / (lines.length * 1.16);
	return clamp(Math.min(byWidth, byHeight) * TEXT_SCALE, 11, 32);
}

// ── the orb SVG for one frame ──────────────────────────────────────────────
function frameSVG(tier, verdict, t) {
	const c = TIERS[tier];
	const [tx, ty, rot] = shakeAt(t);
	const ringAngle = t * c.spinDeg;
	const glintAngle = t * 360 * 2;

	// question mark: ramp in fast, hold through the shake + a 1s pause, then dissolve
	let qOp, qScale;
	if (t < 0.03) { qOp = lerp(0, 0.55, t / 0.03); qScale = 1; }
	else if (t < Q_HOLD_END) { qOp = 0.55; qScale = 1; }
	else if (t < Q_DISSOLVE_END) { const k = smooth(Q_HOLD_END, Q_DISSOLVE_END, t); qOp = lerp(0.55, 0, k); qScale = lerp(1, 1.5, k); }
	else { qOp = 0; qScale = 1.5; }

	// verdict: surface after the pause, hold ~5s, then a quick fade (0 at both ends)
	let vOp, vScale;
	if (t < VERDICT_IN_START) { vOp = 0; vScale = 0.7; }
	else if (t < VERDICT_IN_END) { const k = smooth(VERDICT_IN_START, VERDICT_IN_END, t); vOp = k; vScale = lerp(0.7, 1.0, k); }
	else if (t < ANSWER_HOLD_END) { vOp = 1; vScale = 1; }
	else { const k = smooth(ANSWER_HOLD_END, 1.0, t); vOp = lerp(1, 0, k); vScale = lerp(1, 0.9, k); }

	// window rim glow: flare up at the reveal, steady through the hold, ease back for the loop
	let glow;
	if (t < Q_HOLD_END) glow = 0.3;
	else if (t < VERDICT_IN_END) glow = lerp(0.3, 1.0, smooth(Q_HOLD_END, VERDICT_IN_END, t));
	else if (t < ANSWER_HOLD_END) glow = 0.8;
	else glow = lerp(0.8, 0.3, smooth(ANSWER_HOLD_END, 1.0, t));

	const lines = wrap(verdict);
	const size = fitFont(lines);
	const lineH = size * 1.16;
	const baseY = 168 - ((lines.length - 1) * lineH) / 2 + size * 0.34;
	const verdictText = lines
		.map((l, i) => `<text x="160" y="${(baseY + i * lineH).toFixed(1)}" text-anchor="middle" font-family="Cinzel, serif" font-weight="700" font-size="${size.toFixed(1)}" letter-spacing="1" fill="${c.verdict}">${l}</text>`)
		.join("");

	const stars = c.stars
		? [[132, 150], [150, 140], [176, 144], [190, 162], [140, 182], [186, 186], [128, 166], [176, 200], [164, 138], [150, 202]]
				.map(([x, y], i) => {
					const op = 0.2 + 0.7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t * 2 + i / 3)));
					return `<circle cx="${x}" cy="${y}" r="0.9" fill="${c.rim}" opacity="${op.toFixed(2)}"/>`;
				})
				.join("")
		: "";

	const glint = c.glint
		? `<g transform="rotate(${glintAngle.toFixed(1)} 160 168)"><circle cx="160" cy="168" r="68" fill="none" stroke="${c.glint}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="30 397" stroke-opacity="0.9"/></g>`
		: "";

	const runeDefs = `
		<g id="r1"><path d="M160 66.5L164.5 72L160 77.5L155.5 72Z" fill="${c.rune}" fill-opacity=".9"/></g>
		<g id="r2"><path d="M160 65.5L161.6 70.4L166.5 72L161.6 73.6L160 78.5L158.4 73.6L153.5 72L158.4 70.4Z" fill="${c.runeBright}" fill-opacity=".95"/></g>
		<g id="r3" stroke="${c.rune}" stroke-opacity=".85" stroke-width="1.3" stroke-linecap="round"><line x1="156" y1="68.5" x2="164" y2="68.5"/><line x1="155.5" y1="72" x2="164.5" y2="72"/><line x1="156" y1="75.5" x2="164" y2="75.5"/></g>
		<g id="r4"><polyline points="154.5,69 158,75.5 161.5,68.5 165,75" fill="none" stroke="${c.rune}" stroke-opacity=".88" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>
		<g id="r5"><path d="M158 66.5A6.2 6.2 0 1 0 158 77.5A5 5 0 1 1 158 66.5Z" fill="${c.rune}" fill-opacity=".78"/></g>
		<g id="r6"><path d="M156.5 67.5L163 72L156.5 76.5" fill="none" stroke="${c.rune}" stroke-opacity=".9" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>`;
	const order = ["r1", "r2", "r3", "r4", "r5", "r6", "r4", "r1", "r6", "r3", "r2", "r5"];
	const runes = order.map((id, i) => `<use href="#${id}" transform="rotate(${i * 30} 160 168)"/>`).join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" width="${SIZE}" height="${SIZE}">
	<defs>
		<radialGradient id="shell" cx="40%" cy="33%" r="72%"><stop offset="0%" stop-color="${c.shell[0]}"/><stop offset="40%" stop-color="${c.shell[1]}"/><stop offset="72%" stop-color="${c.shell[2]}"/><stop offset="100%" stop-color="${c.shell[3]}"/></radialGradient>
		<radialGradient id="spec" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.8"/><stop offset="45%" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
		<radialGradient id="winInner" cx="50%" cy="40%" r="64%"><stop offset="0%" stop-color="${c.win[0]}"/><stop offset="45%" stop-color="${c.win[1]}"/><stop offset="100%" stop-color="${c.win[2]}"/></radialGradient>
		<radialGradient id="winGlow" cx="50%" cy="50%" r="50%"><stop offset="55%" stop-color="${c.glow}" stop-opacity="0"/><stop offset="82%" stop-color="${c.glow}" stop-opacity="0.75"/><stop offset="100%" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
		${runeDefs}
		<clipPath id="win"><circle cx="160" cy="168" r="68"/></clipPath>
	</defs>
	<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot.toFixed(2)} 160 158)">
		<circle cx="160" cy="158" r="132" fill="url(#shell)"/>
		<circle cx="160" cy="158" r="132" fill="none" stroke="${c.glow}" stroke-opacity="0.28" stroke-width="1.5"/>
		<ellipse cx="120" cy="110" rx="46" ry="30" fill="url(#spec)"/>
		<g transform="rotate(${ringAngle.toFixed(1)} 160 168)">${runes}</g>
		<circle cx="160" cy="168" r="80" fill="url(#winGlow)" opacity="${glow.toFixed(2)}"/>
		<g clip-path="url(#win)">
			<circle cx="160" cy="168" r="67" fill="url(#winInner)"/>
			${stars}
			<circle cx="160" cy="168" r="64" fill="none" stroke="#05040a" stroke-opacity="0.5" stroke-width="3"/>
			<g transform="${scaleAbout(160, 168, qScale)}" opacity="${qOp.toFixed(3)}"><text x="160" y="186" text-anchor="middle" font-family="Cinzel, serif" font-weight="700" font-size="50" fill="${c.q}">?</text></g>
			<g transform="${scaleAbout(160, 168, vScale)}" opacity="${vOp.toFixed(3)}">${verdictText}</g>
		</g>
		<circle cx="160" cy="168" r="70" fill="none" stroke="${c.innerRim}" stroke-opacity="0.4" stroke-width="3"/>
		<circle cx="160" cy="168" r="68" fill="none" stroke="${c.rim}" stroke-opacity="0.92" stroke-width="2"/>
		${glint}
	</g>
</svg>`;
}

// ── render loop ────────────────────────────────────────────────────────────
function renderTier(tier, verdicts) {
	const dir = path.join(OUT_DIR, tier);
	fs.mkdirSync(dir, { recursive: true });
	const hasCinzel = fs.existsSync(CINZEL);
	if (!hasCinzel) console.warn("! Cinzel-Bold.ttf not found in scripts/fonts/. Using a system serif; add the font for the final look.");
	const font = hasCinzel
		? { fontFiles: [CINZEL], defaultFontFamily: "Cinzel", loadSystemFonts: true }
		: { loadSystemFonts: true, defaultFontFamily: "serif" };

	for (const verdict of verdicts) {
		const gif = GIFEncoder();
		for (let f = 0; f < FRAMES; f++) {
			const svg = frameSVG(tier, verdict, f / FRAMES);
			const png = new Resvg(svg, { fitTo: { mode: "width", value: SIZE }, background: MATTE, font }).render().asPng();
			const { data, width, height } = PNG.sync.read(png);
			const rgba = new Uint8Array(data.buffer, data.byteOffset, data.length);
			const palette = quantize(rgba, 256, { format: "rgb565" });
			const index = applyPalette(rgba, palette, "rgb565");
			gif.writeFrame(index, width, height, { palette, delay: Math.round(1000 / FPS) });
		}
		gif.finish();
		const out = path.join(dir, `${slug(verdict)}.gif`);
		fs.writeFileSync(out, Buffer.from(gif.bytes()));
		console.log("  ok", tier, path.relative(ROOT, out));
	}
}

renderTier("common", COMMON_VERDICTS);
renderTier("ultra", ULTRA_VERDICTS);
console.log(`\nDone. ${COMMON_VERDICTS.length + ULTRA_VERDICTS.length} orbs in assets/fortune/orbs/. Open a few to check them.`);
