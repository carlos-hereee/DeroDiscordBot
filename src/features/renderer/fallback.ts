import { AttachmentBuilder } from "discord.js";

// ── fallback ─────────────────────────────────────────────────────────
// The wrapper every rendered surface goes through: try the card, and when the
// render answers null or throws, answer the surface's existing text embed
// instead, so a missing native binary, an S3 outage or a renderer bug never
// reaches a member as an error. It knows nothing about any one surface; the
// surfaces of 2026-10 item 243 Phases 2 to 4 wrap their call sites in it.

/**
 * A rendered card: the attachment to send and the `attachment://` ref the
 * embed's setImage points at. Send both on the same message, or the ref
 * resolves to nothing and Discord shows an empty image slot.
 */
export interface RenderPayload {
	attachment: AttachmentBuilder;
	ref: string;
}

/** True when a withRenderFallback result is the rendered card rather than the fallback. */
export function isRenderPayload(value: unknown): value is RenderPayload {
	if (typeof value !== "object" || value === null) return false;
	if (!("attachment" in value) || !("ref" in value)) return false;
	return value.attachment instanceof AttachmentBuilder && typeof value.ref === "string";
}

/**
 * The rendered card, or `embedFn()` when the render answers null or throws.
 * embedFn runs only on the fallback path, so a surface builds its text embed
 * only when the text embed is what gets posted.
 */
export async function withRenderFallback<T>(renderFn: () => Promise<RenderPayload | null>, embedFn: () => T): Promise<RenderPayload | T> {
	try {
		const rendered = await renderFn();
		if (rendered) return rendered;
	} catch (error) {
		console.warn("[canvas-renderer] a card render threw, so its surface posts the text embed", error);
	}
	return embedFn();
}
