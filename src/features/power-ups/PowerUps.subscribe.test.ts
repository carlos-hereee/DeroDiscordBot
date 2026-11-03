import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { ButtonInteraction } from "discord.js";

// ── Toggle pings (2026-10 item 263, owner decision after Phase 1c) ────────────
// The member's place on the announcement ping list is their own state, so the toggle
// answers with a Power ups notice only they see, and never posts or pings in a channel.

const mocks = vi.hoisted(() => ({
	buttons: new Map<string, (interaction: unknown) => Promise<void>>(),
	findByGuildId: vi.fn(),
}));

vi.mock("@handlers/interactionRegistry.js", () => ({
	registerButton: (prefix: string, handler: (interaction: unknown) => Promise<void>) => mocks.buttons.set(prefix, handler),
}));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId, update: vi.fn() } }));

import { registerPowerUpHandlers } from "./PowerUps.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";

const ROLE_ID = "role-pings";

type NoticeJson = { title: string; components: Array<{ content?: string }> };

// A member pressing Toggle pings, holding the ping role or not. The commands channel
// fetch is a spy so a test can prove nothing was posted anywhere.
function press(holdsRole: boolean) {
	const roleIds = new Set(holdsRole ? [ROLE_ID] : []);
	const member = {
		roles: {
			cache: { has: (id: string) => roleIds.has(id) },
			add: vi.fn(async (id: string) => roleIds.add(id)),
			remove: vi.fn(async (id: string) => roleIds.delete(id)),
		},
	};
	const role = { id: ROLE_ID };
	const fetchChannel = vi.fn(async () => null);
	const interaction = {
		id: "press-1",
		customId: "powerup:member:subscribe",
		guildId: "g1",
		user: { id: "member-1" },
		deferred: false,
		replied: false,
		guild: {
			roles: { cache: new Map([[ROLE_ID, role]]), fetch: vi.fn(async () => role) },
			members: { cache: new Map([["member-1", member]]), fetch: vi.fn(async () => member) },
		},
		client: { channels: { fetch: fetchChannel } },
		showModal: vi.fn(async () => undefined),
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
	};
	return { interaction: interaction as unknown as ButtonInteraction & { showModal: ReturnType<typeof vi.fn> }, member, fetchChannel };
}

const noticeOf = (interaction: { showModal: ReturnType<typeof vi.fn> }): NoticeJson => (interaction.showModal.mock.calls[0]![0] as { toJSON(): NoticeJson }).toJSON();

beforeAll(() => {
	registerPowerUpHandlers();
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findByGuildId.mockResolvedValue({ guildId: "g1", notificationsRoleId: ROLE_ID, commandOutputChannelId: "c-commands" });
});

describe("Toggle pings", () => {
	it.each([
		["joins the list", false, "🔔 You're on the announcement ping list. Tap again to opt out."],
		["leaves the list", true, "🔕 You're off the announcement ping list."],
	])("%s with a Power ups notice, posting nothing in any channel", async (_label, holdsRole, line) => {
		const { interaction, member, fetchChannel } = press(holdsRole);
		await mocks.buttons.get("powerup")!(interaction);

		expect(holdsRole ? member.roles.remove : member.roles.add).toHaveBeenCalledWith(ROLE_ID, expect.any(String));
		const notice = noticeOf(interaction);
		expect(notice.title).toBe(rokCommanderCopy.notice.powerUps);
		expect(notice.components[0]!.content).toBe(line);
		expect(fetchChannel).not.toHaveBeenCalled();
		expect(interaction.reply).not.toHaveBeenCalled();
	});
});
