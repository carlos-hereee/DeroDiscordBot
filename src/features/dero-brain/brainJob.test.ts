import { describe, it, expect, vi } from "vitest";
import { ChannelType, type Guild, type GuildMember } from "discord.js";
import { buildJobInput, offeredChannels } from "./brainJob.js";

// ── brainJob ───────────────────────────────────────────────────────────────
// The job is the brain's entire view of the guild, so these pin what it holds:
// only allowlisted channels that are live, postable and visible to the speaker,
// in allowlist order, at most 25, and nothing beyond the documented fields.

const GUILD_ID = "100000000000000001";
const BOT_ID = "300000000000000009";

function channel(id: string, name: string, options: { botCanSend?: boolean; speakerCanView?: boolean } = {}) {
	const { botCanSend = true, speakerCanView = true } = options;
	return {
		id,
		name,
		guildId: GUILD_ID,
		type: ChannelType.GuildText,
		send: vi.fn(),
		permissionsFor: (who: { id: string }) => ({ has: () => (who.id === BOT_ID ? botCanSend : speakerCanView) }),
	};
}

function world(channels: ReturnType<typeof channel>[]) {
	const guild = {
		id: GUILD_ID,
		name: "Kingdom",
		ownerId: "owner",
		channels: { cache: new Map(channels.map((entry) => [entry.id, entry])) },
		members: { me: { id: BOT_ID } },
	} as unknown as Guild;
	const speaker = { id: "speaker", displayName: "Sir Member", guild: { id: GUILD_ID } } as unknown as GuildMember;
	return { guild, speaker };
}

describe("offeredChannels", () => {
	it("keeps allowlist order and drops channels that are gone, unsendable or hidden from the speaker", () => {
		const { guild, speaker } = world([
			channel("200000000000000001", "general"),
			channel("200000000000000002", "read-only", { botCanSend: false }),
			channel("200000000000000003", "staff", { speakerCanView: false }),
			channel("200000000000000004", "events"),
		]);
		const allowlist = ["200000000000000004", "200000000000000009", "200000000000000002", "200000000000000003", "200000000000000001"];
		expect(offeredChannels(guild, speaker, allowlist)).toEqual([
			{ id: "200000000000000004", name: "events" },
			{ id: "200000000000000001", name: "general" },
		]);
	});

	it("never offers more than 25 channels", () => {
		const many = Array.from({ length: 30 }, (_, index) => channel(`20000000000000${String(index).padStart(4, "0")}`, `c${index}`));
		const { guild, speaker } = world(many);
		expect(offeredChannels(guild, speaker, many.map((entry) => entry.id))).toHaveLength(25);
	});
});

describe("buildJobInput", () => {
	it("holds only the documented fields and every capability", () => {
		const { guild, speaker } = world([channel("200000000000000001", "general")]);
		const job = buildJobInput({
			guild,
			speaker,
			text: "send hello world with an emoji in general",
			allowedChannelIds: ["200000000000000001"],
			source: "text",
		});
		expect(job).toEqual({
			source: "text",
			guild: { id: GUILD_ID, name: "Kingdom" },
			speaker: { id: "speaker", displayName: "Sir Member" },
			text: "send hello world with an emoji in general",
			channels: [{ id: "200000000000000001", name: "general" }],
			capabilities: ["post_message", "say", "open_holdem", "leave_voice"],
		});
	});
});
