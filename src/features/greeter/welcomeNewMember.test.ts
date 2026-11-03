import { describe, it, expect, vi, beforeEach } from "vitest";
import { AttachmentBuilder, TextChannel, type GuildMember } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

// ── welcomeNewMember, the welcome card ─────────────────────────────────────
// The greeting's text is the part that matters (it pings the newcomer and asks
// the icebreaker), so these cases pin that the welcome card (2026-10 item 243
// Phase 4) only ever RIDES that message: with the card when it draws, and the
// text exactly as before when it does not.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	renderWelcomeCard: vi.fn(),
	attachListenRow: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@features/voice/listenButton.js", () => ({ attachListenRow: mocks.attachListenRow }));
vi.mock("./welcomeCardRenderer.js", () => ({ WELCOME_AVATAR_SIZE: 256, renderWelcomeCard: mocks.renderWelcomeCard }));

import { welcomeCardView, welcomeNewMember } from "./welcomeNewMember.js";

function rig(options: { bot?: boolean } = {}) {
	const send = vi.fn(async () => ({ edit: vi.fn() }));
	const channel = Object.assign(Object.create(TextChannel.prototype) as TextChannel, { id: "intro-1", send });
	const member = {
		id: "u1",
		displayName: "Silent Warrior",
		user: {
			id: "u1",
			bot: options.bot ?? false,
			avatar: "a1",
			displayAvatarURL: () => "https://cdn.discordapp.com/avatars/1/a1.png?size=256",
		},
		guild: { id: "g1", name: "Kingdom 1234", memberCount: 1205 },
		client: { channels: { fetch: vi.fn(async () => channel) } },
	} as unknown as GuildMember;
	return { member, send };
}

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ setupComplete: true, introChannelId: "intro-1" });
	mocks.renderWelcomeCard.mockReset().mockResolvedValue(null);
	mocks.attachListenRow.mockReset().mockResolvedValue(undefined);
});

describe("welcomeNewMember's welcome card", () => {
	it("posts the card on the same message as the ping, so it arrives with one notification", async () => {
		const attachment = new AttachmentBuilder(Buffer.from("png"), { name: "welcome-abc.png" });
		mocks.renderWelcomeCard.mockResolvedValue({ attachment, ref: "attachment://welcome-abc.png" });
		const { member, send } = rig();

		expect(await welcomeNewMember(member)).toBe(true);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { users: ["u1"] }, files: [attachment] }));
		const [{ content }] = send.mock.calls[0] as unknown as [{ content: string }];
		expect(content).toContain("<@u1>");
	});

	it("posts the greeting text alone when the card does not draw", async () => {
		mocks.renderWelcomeCard.mockRejectedValue(new Error("simulated renderer failure"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { member, send } = rig();

		expect(await welcomeNewMember(member)).toBe(true);

		const [payload] = send.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(payload).not.toHaveProperty("files");
		expect(payload.content).toContain("<@u1>");
	});

	it("never draws a card for a bot", async () => {
		const { member, send } = rig({ bot: true });
		expect(await welcomeNewMember(member)).toBe(false);
		expect(mocks.renderWelcomeCard).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});

describe("welcomeCardView", () => {
	it("words the card in the guild pack's voice, with the newcomer, the server and its count", () => {
		const { member } = rig();
		const view = welcomeCardView(member, rokCommanderCopy.greeter.card);
		expect(view).toEqual({
			kicker: rokCommanderCopy.greeter.card.kicker,
			title: "Welcome, Silent Warrior",
			subtitle: "The gates of Kingdom 1234 swing open",
			memberCount: "Warrior number 1,205",
			displayName: "Silent Warrior",
			avatar: { userId: "u1", avatarHash: "a1", size: 256, url: "https://cdn.discordapp.com/avatars/1/a1.png?size=256" },
		});
	});

	it("leaves the count out when the guild does not report one", () => {
		const { member } = rig();
		(member.guild as unknown as { memberCount: number }).memberCount = 0;
		expect(welcomeCardView(member, rokCommanderCopy.greeter.card).memberCount).toBeNull();
	});
});
