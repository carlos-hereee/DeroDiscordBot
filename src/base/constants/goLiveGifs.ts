// ── go-live gif rotation ──────────────────────────────────────────────────
// Direct Tenor gif urls cycled at random as the "going live" announcement
// thumbnail when a guild has NOT set its own defaultEventImageUrl. These are
// external (Tenor's CDN) and reliable, so nothing is bundled in the repo for
// this. IMPORTANT: use the DIRECT media url (https://media.tenor.com/<id>/<name>.gif),
// NOT a tenor.com/view/... share link, share links do not render in a Discord
// embed image/thumbnail slot.
//
// Widen the rotation by pasting more direct urls into this array. An empty array
// is safe: postGoLiveAnnouncement falls back to the bundled Dero still.
export const GO_LIVE_GIF_URLS: readonly string[] = [
	// First batch (owner-supplied 2026-06; all HEAD-verified 200 + image/*). Paste
	// more direct media.tenor.com urls here to widen the rotation toward ~75-100.
	"https://media.tenor.com/uQgqJE4sXw4AAAAM/im-live-were-live.gif",
	"https://media.tenor.com/usyyHqpGJI0AAAAM/going-live-live.gif",
	"https://media.tenor.com/5uNtnQ7ueAEAAAAM/live-going-live.gif",
	"https://media.tenor.com/GizW68TPpHEAAAAM/argoetti-goate.gif",
	"https://media.tenor.com/io6VVbrHAHoAAAAM/now-streaming-live-on-twitch.gif",
	"https://media.tenor.com/hrL56myy00UAAAAM/kaiser-pirated-kaiser-pirates.gif",
	// the one webp in the batch (Discord renders webp thumbnails fine)
	"https://media.tenor.com/izFiLfM7NdcAAAA1/sc00bgif.webp",
	"https://media.tenor.com/Rg1BUw-0riIAAAAM/pikabooirl-live.gif",
	"https://media.tenor.com/M3D-qFiwzeYAAAAM/kylecommunist-fallout.gif",
	"https://media.tenor.com/LTKPpE2NXwgAAAAM/allure-bubbles.gif",
	"https://media.tenor.com/_fsK7iS9vogAAAAM/innervoice-media.gif",
	"https://media.tenor.com/bD3mP1Kjt8EAAAAM/boredmemes-cultonape.gif",
	"https://media.tenor.com/TElqH4GKK-IAAAAM/hej-you-come-join.gif",
	"https://media.tenor.com/M7bX8_Gb8yIAAAAM/are-you-ready-get-ready.gif",
	"https://media.tenor.com/-mpZi-Hr8E8AAAAM/love-live-joining-vc-in-5.gif",
	"https://media.tenor.com/HkszE8gqvykAAAAM/anime-join-now.gif",
	"https://media.tenor.com/cXppPYb3rBkAAAAM/dwb-dwbs.gif",
	"https://media.tenor.com/Rs8fAokgwcEAAAAd/rachelcoded-love-live.gif",
	"https://media.tenor.com/HBtK_ooJMd4AAAAM/bitcoin-wizard-wzrd.gif",
];

// Pick a random go-live gif, or null when none are configured yet. Runtime only
// (Math.random), never call from a deterministic context (e.g. a workflow script
// that must replay identically across a resume).
export function pickRandomGoLiveGif(): string | null {
	if (GO_LIVE_GIF_URLS.length === 0) return null;
	return GO_LIVE_GIF_URLS[Math.floor(Math.random() * GO_LIVE_GIF_URLS.length)];
}
