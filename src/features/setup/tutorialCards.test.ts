import { describe, it, expect, vi, beforeEach } from "vitest";
import { ButtonStyle, type ButtonInteraction } from "discord.js";
import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";

// ── tutorialCards ───────────────────────────────────────────────────────────
// The notice board tutorial in 🧭onboarding (2026-11 item 285 Phase 3). A card's mark is
// read off its slot alone, and its button builds through onDemandChannel and nowhere else.

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	gateOwnerOrAdmin: vi.fn(),
	ensureOnDemandChannel: vi.fn(),
	send: vi.fn(),
	beginChannelAnswer: vi.fn(),
	showNotice: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@utils/permissions.js", () => ({ gateOwnerOrAdmin: mocks.gateOwnerOrAdmin }));
vi.mock("@utils/answerInChannel.js", () => ({ beginChannelAnswer: mocks.beginChannelAnswer }));
vi.mock("@utils/textModal.js", () => ({ showNotice: mocks.showNotice }));
vi.mock("./onDemandChannel.js", () => ({ ensureOnDemandChannel: mocks.ensureOnDemandChannel }));

import { TUTORIAL_CHANNELS, buildCards, handleAddChannel, tutorialCustomId, tutorialKeyOf } from "./tutorialCards.js";

const GUILD_ID = "g1";
// The en dash and the em dash, built from their code points so this file carries neither.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const interaction = (): ButtonInteraction => ({ guild: { id: GUILD_ID }, user: { id: "u-admin" } }) as unknown as ButtonInteraction;

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: GUILD_ID, introChannelId: null });
	mocks.gateOwnerOrAdmin.mockReset().mockResolvedValue(true);
	mocks.ensureOnDemandChannel.mockReset().mockResolvedValue({ id: "built-intro" });
	mocks.send.mockReset().mockResolvedValue({ channelId: "c-onboarding" });
	mocks.beginChannelAnswer.mockReset().mockResolvedValue({ channelId: "c-onboarding", send: mocks.send });
	mocks.showNotice.mockReset().mockResolvedValue(undefined);
});

describe("the cards", () => {
	it("are the seven owner approved channels, in card order", () => {
		expect(Object.keys(TUTORIAL_CHANNELS)).toEqual(["intro", "announcements", "schedule", "welcome", "rules", "commands", "meetingVoice"]);
		expect(buildCards(null, rokCommanderCopy).map((card) => card.field)).toEqual([
			"introChannelId",
			"announcementsChannelId",
			"scheduleChannelId",
			"welcomeChannelId",
			"rulesChannelId",
			"commandsChannelId",
			"meetingVoiceChannelId",
		]);
	});

	it("render pending, with an Add this channel button, while the slot is empty", () => {
		const card = buildCards({ introChannelId: null }, rokCommanderCopy)[0]!;
		const button = card.message.components[0]!.toJSON().components[0] as { custom_id: string; label: string; style: number };
		expect(card.done).toBe(false);
		expect(card.message.embeds[0]!.data.description).toContain("Not built yet");
		expect(button).toMatchObject({ custom_id: "hqstep:onboarding:tutorial-intro", label: "Add this channel", style: ButtonStyle.Primary });
	});

	it("render done, naming the channel, once the slot holds an id", () => {
		const card = buildCards({ introChannelId: "c-intro" }, rokCommanderCopy)[0]!;
		const button = card.message.components[0]!.toJSON().components[0] as { label: string; style: number };
		expect(card.done).toBe(true);
		expect(card.message.embeds[0]!.data.description).toContain("<#c-intro>");
		expect(button).toMatchObject({ label: "Channel ready", style: ButtonStyle.Success });
	});

	it("keep the same title done or pending, so a card whose id was lost is found again", () => {
		const pending = buildCards(null, rokCommanderCopy).map((card) => card.title);
		const done = buildCards(Object.fromEntries(Object.values(TUTORIAL_CHANNELS).map((field) => [field, "x"])), rokCommanderCopy).map((card) => card.title);
		expect(done).toEqual(pending);
	});

	it("teach from the guild's pack, both packs carrying every card", () => {
		for (const pack of [rokCommanderCopy, generalEventsCopy]) {
			for (const card of buildCards(null, pack)) {
				expect(card.title.length).toBeGreaterThan(0);
				expect(card.message.embeds[0]!.data.description!.length).toBeGreaterThan(80);
			}
		}
		expect(buildCards(null, generalEventsCopy)[0]!.message.embeds[0]!.data.description).toContain("Where newcomers say hello");
	});

	it("carry no em or en dash in any teaching paragraph", () => {
		for (const pack of [rokCommanderCopy, generalEventsCopy]) {
			for (const teaching of Object.values(pack.channelContent.tutorial)) expect(`${teaching.title}${teaching.body}`).not.toMatch(LONG_DASHES);
		}
	});
});

describe("the customIds", () => {
	it("round trip through tutorialKeyOf", () => {
		for (const key of Object.keys(TUTORIAL_CHANNELS) as Array<keyof typeof TUTORIAL_CHANNELS>) {
			expect(tutorialKeyOf(tutorialCustomId(key).split(":")[2]!)).toBe(key);
		}
		expect(tutorialKeyOf("tutorial-leaderboard")).toBeNull();
		expect(tutorialKeyOf("1")).toBeNull();
	});
});

describe("Add this channel", () => {
	it("delegates the build to ensureOnDemandChannel as the admin's explicit request", async () => {
		await handleAddChannel(interaction(), "intro");
		expect(mocks.ensureOnDemandChannel).toHaveBeenCalledWith({ id: GUILD_ID }, "introChannelId", { explicitRequest: true, actorUserId: "u-admin" });
		expect(mocks.beginChannelAnswer).toHaveBeenCalledWith(expect.anything(), "onboarding", expect.anything());
		expect(JSON.stringify(mocks.send.mock.calls[0]![0])).toContain("<#built-intro> is ready");
	});

	it("says nothing new was built when the channel was already there", async () => {
		mocks.findByGuildId.mockResolvedValue({ guildId: GUILD_ID, introChannelId: "built-intro" });
		await handleAddChannel(interaction(), "intro");
		expect(JSON.stringify(mocks.send.mock.calls[0]![0])).toContain("already there");
	});

	it("refuses a member who is neither the owner nor an admin, building nothing", async () => {
		mocks.gateOwnerOrAdmin.mockResolvedValue(false);
		await handleAddChannel(interaction(), "intro");
		expect(mocks.showNotice).toHaveBeenCalledTimes(1);
		expect(mocks.ensureOnDemandChannel).not.toHaveBeenCalled();
		expect(mocks.beginChannelAnswer).not.toHaveBeenCalled();
	});

	it("answers with the failure when nothing could be built, or the build threw", async () => {
		mocks.ensureOnDemandChannel.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("50013"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await handleAddChannel(interaction(), "welcome");
		await handleAddChannel(interaction(), "welcome");
		expect(mocks.send).toHaveBeenCalledTimes(2);
		for (const call of mocks.send.mock.calls) expect(JSON.stringify(call[0])).toContain("could not build");
	});
});
