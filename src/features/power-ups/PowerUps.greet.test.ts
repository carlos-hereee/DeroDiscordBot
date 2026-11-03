import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── the member Fire a greeting power up (bot audit 2026-10-30) ──────────────
// Open to every member, and each press posts a drawn welcome card, so it is throttled per
// member. The greeting itself is mocked; only whether a press reaches it is under test.

const mocks = vi.hoisted(() => ({
	welcomeNewMember: vi.fn(),
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
}));

vi.mock("@features/greeter/welcomeNewMember.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("@features/greeter/welcomeNewMember.js")>()),
	welcomeNewMember: mocks.welcomeNewMember,
}));
vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));

import { registerPowerUpHandlers } from "./PowerUps.js";

function pressGreet(userId: string, guildId = "g1") {
	const member = { id: userId };
	return {
		customId: "powerup:member:greet",
		guildId,
		guild: { id: guildId, members: { cache: new Map([[userId, member]]), fetch: vi.fn() } },
		user: { id: userId },
		deferred: false,
		replied: false,
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
	};
}

const greet = (interaction: ReturnType<typeof pressGreet>) => mocks.buttons.get("powerup")!(interaction as unknown as ButtonInteraction);

beforeAll(() => {
	registerPowerUpHandlers();
});

beforeEach(() => {
	mocks.welcomeNewMember.mockReset().mockResolvedValue(true);
});

describe("Fire a greeting", () => {
	it("greets once, then refuses the same member's next press with a notice and posts nothing", async () => {
		const first = pressGreet("spammer");
		await greet(first);
		expect(mocks.welcomeNewMember).toHaveBeenCalledTimes(1);
		expect(first.deferUpdate).toHaveBeenCalledTimes(1);

		const second = pressGreet("spammer");
		await greet(second);
		expect(mocks.welcomeNewMember).toHaveBeenCalledTimes(1);
		expect(second.deferUpdate).not.toHaveBeenCalled();
		expect(second.showModal).toHaveBeenCalledTimes(1);
	});

	it("keeps each member's cooldown apart", async () => {
		await greet(pressGreet("member-a", "g2"));
		await greet(pressGreet("member-b", "g2"));
		expect(mocks.welcomeNewMember).toHaveBeenCalledTimes(2);
	});
});
