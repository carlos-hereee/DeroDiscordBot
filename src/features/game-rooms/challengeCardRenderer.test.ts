import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RenderPayload } from "@features/renderer/index.js";
import type { SKRSContext2D } from "@features/renderer/canvasModule.js";

// ── the challenge card's status watermark (2026-10 item 254, Arcade 6) ──────
// Every status the corner pill shows is drawn again as a large, faint word across the
// card's diagonal, so it reads at a glance on a phone. Two checks: a recording context
// proves what the watermark draws, and the real canvas (S3 off, so nothing reaches the
// network) proves a card with it still renders in every status.

vi.mock("@utils/config.js", () => ({ discordBotS3Enabled: false }));
vi.mock("@utils/aws/index.js", () => ({ putObject: vi.fn(), getObjectBytes: vi.fn(async () => null) }));

import { clearCardCache } from "@features/renderer/cardCache.js";
import type { Guild } from "discord.js";
import { challengeCardView, drawStatusWatermark, renderChallengeCard, type ChallengeCardStatus, type ChallengeCardView } from "./challengeCardRenderer.js";
import type { OpenerCardState } from "./challengeBoardEmbeds.js";
import { gameRoomsCopy } from "./gameRoomsCopy.js";

const STATUSES = Object.keys(gameRoomsCopy.board.cardImage.status) as ChallengeCardStatus[];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DrawnText {
	text: string;
	alpha: number;
	maxWidth: number | undefined;
	font: string;
}

// A context that records the text it is asked to fill, with the alpha and font in force
// at that moment, and the turns it is given.
function recordingContext() {
	const drawn: DrawnText[] = [];
	const rotations: number[] = [];
	const stack: number[] = [];
	const context = {
		globalAlpha: 1,
		font: "",
		fillStyle: "",
		textAlign: "left",
		textBaseline: "alphabetic",
		save: vi.fn(() => stack.push(context.globalAlpha)),
		restore: vi.fn(() => {
			context.globalAlpha = stack.pop() ?? 1;
		}),
		translate: vi.fn(),
		rotate: vi.fn((angle: number) => rotations.push(angle)),
		fillText: vi.fn((text: string, _x: number, _y: number, maxWidth?: number) => drawn.push({ text, alpha: context.globalAlpha, maxWidth, font: context.font })),
	};
	return { context, drawn, rotations };
}

function view(status: ChallengeCardStatus): ChallengeCardView {
	return { game: "holdem", status, badge: "casual", host: { name: "Host", avatar: null }, challengers: [{ name: "Joiner", avatar: null }], hiddenCount: 0 };
}

beforeEach(() => clearCardCache());

describe("drawStatusWatermark", () => {
	it("draws the pill's own word for every status, faint, large and turned to the card's diagonal", () => {
		for (const status of STATUSES) {
			const { context, drawn, rotations } = recordingContext();

			drawStatusWatermark(context as unknown as SKRSContext2D, status, 960, 620);

			expect(drawn).toHaveLength(1);
			expect(drawn[0].text).toBe(gameRoomsCopy.board.cardImage.status[status]);
			expect(drawn[0].alpha).toBeGreaterThan(0);
			expect(drawn[0].alpha).toBeLessThan(0.5);
			expect(drawn[0].font).toMatch(/\b120px\b/);
			// Long words squeeze to the diagonal rather than running off a corner.
			expect(drawn[0].maxWidth).toBeLessThan(Math.hypot(960, 620));
			expect(rotations).toEqual([-Math.atan2(620, 960)]);
			// The alpha is put back, so nothing drawn after it comes out faint.
			expect(context.globalAlpha).toBe(1);
		}
	});
});

describe("renderChallengeCard with the watermark", () => {
	it("renders a PNG in every status the pill shows", async () => {
		for (const status of STATUSES) {
			const card: RenderPayload | null = await renderChallengeCard(view(status));
			expect(card, status).not.toBeNull();
			const bytes = card!.attachment.attachment;
			expect(Buffer.isBuffer(bytes) && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
		}
	});
});

// ── the Dero bots on the picture ─────────────────────────────────────────
// A bot the host seats with Add bots is a face of its own after the joiners, so the picture
// agrees with the settings line instead of showing an empty table.
describe("challengeCardView with Dero bots", () => {
	const member = (id: string) => ({ displayName: `Member ${id}`, user: { id, avatar: null, displayAvatarURL: () => `https://cdn.example/${id}.png` } });
	const guild = { members: { cache: { get: (id: string) => member(id) }, fetch: async (id: string) => member(id) } } as unknown as Guild;
	const state = (overrides: Partial<OpenerCardState>): OpenerCardState => ({ game: "holdem", hostId: "host-1", visibility: "public", pool: [], ...overrides });

	it("draws each seated bot after the joiners, named and in its variant", async () => {
		const result = await challengeCardView(guild, state({ pool: ["joiner-1"], bots: { count: 2 }, casual: true }));
		expect(result.challengers.map((face) => face.name)).toEqual(["Member joiner-1", "Dero Red", "Dero Orange"]);
		expect(result.challengers.slice(1).every((face) => face.bot && face.avatar === null)).toBe(true);
		expect(result.hiddenCount).toBe(0);
	});

	it("gives a Monopoly bot the token after the host and every joiner", async () => {
		const result = await challengeCardView(guild, state({ game: "monopoly", pool: ["joiner-1"], bots: { count: 1 }, casual: true }));
		expect(result.challengers.at(-1)?.name).toBe("Dero Gold");
		expect(result.challengers.at(-1)?.bot?.token).toBe("monopolyToken3");
	});

	it("keeps every joiner on the picture and counts the bots that do not fit", async () => {
		const pool = ["a", "b", "c", "d", "e", "f"];
		const result = await challengeCardView(guild, state({ pool, bots: { count: 2 }, casual: true }));
		expect(result.challengers).toHaveLength(6);
		expect(result.challengers.some((face) => face.bot)).toBe(false);
		expect(result.hiddenCount).toBe(2);
	});

	it("shows no bot for a card that seats none", async () => {
		const result = await challengeCardView(guild, state({ pool: [], bots: { count: 0 } }));
		expect(result.challengers).toEqual([]);
	});

	it("renders a PNG with bots on it", async () => {
		const withBots = await challengeCardView(guild, state({ bots: { count: 3 }, casual: true }));
		const card = await renderChallengeCard(withBots);
		expect(card).not.toBeNull();
		const bytes = card!.attachment.attachment;
		expect(Buffer.isBuffer(bytes) && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
	});
});
