import { describe, it, expect, vi } from "vitest";
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from "discord.js";
import { sendDirectMessage } from "./directMessage.js";

// ── Dero's DM dispatcher (2026-11 item 283 Phase 4) ──
// A DM a user refused is "closed", anything else that fails is "failed", and neither throws.

const discordError = (code: number): DiscordAPIError => Object.assign(Object.create(DiscordAPIError.prototype) as DiscordAPIError, { code });

const clientSending = (send: () => Promise<unknown>): Client =>
	({ users: { fetch: vi.fn(async () => ({ send: vi.fn(send) })) } }) as unknown as Client;

describe("sendDirectMessage", () => {
	it("sends and says so", async () => {
		expect(await sendDirectMessage(clientSending(async () => ({})), "1234567890", { content: "hi" })).toBe("sent");
	});

	it("reads closed DMs and an unknown user as closed", async () => {
		const closed = clientSending(async () => {
			throw discordError(RESTJSONErrorCodes.CannotSendMessagesToThisUser);
		});
		expect(await sendDirectMessage(closed, "1234567890", { content: "hi" })).toBe("closed");
		const unknown = { users: { fetch: vi.fn(async () => Promise.reject(discordError(RESTJSONErrorCodes.UnknownUser))) } } as unknown as Client;
		expect(await sendDirectMessage(unknown, "1234567890", { content: "hi" })).toBe("closed");
	});

	it("reads any other failure as failed, without throwing", async () => {
		const flaky = clientSending(async () => {
			throw new Error("gateway hiccup");
		});
		expect(await sendDirectMessage(flaky, "1234567890", { content: "hi" })).toBe("failed");
	});
});
