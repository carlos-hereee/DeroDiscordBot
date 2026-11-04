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

import {
	TUTORIAL_CHANNELS,
	buildCards,
	cardKeyOf,
	channelSteps,
	handleAddChannel,
	isResolved,
	parseStepId,
	progressOf,
	revealedSteps,
	removeCustomId,
	skipCustomId,
	stepIdOf,
	tutorialCustomId,
	tutorialKeyOf,
	type TutorialRow,
} from "./tutorialCards.js";
import type { SetupStep } from "./headquartersCards.js";
import { setupCopy } from "./setupCopy.js";
import type { IPluginCopy } from "@base/copy/types.js";

const GUILD_ID = "g1";
// The en dash and the em dash, built from their code points so this file carries neither.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const interaction = (): ButtonInteraction => ({ guild: { id: GUILD_ID }, user: { id: "u-admin" } }) as unknown as ButtonInteraction;

const cardCopy = setupCopy.headquarters.stepCards;
const channelCards = (row: TutorialRow | null, pack: IPluginCopy = rokCommanderCopy) => buildCards(channelSteps(row, pack), "onboarding", row);
const buttonsOf = (card: { message: { components: Array<{ toJSON(): { components: unknown[] } }> } }) =>
	card.message.components.flatMap((row) => row.toJSON().components as Array<{ custom_id: string; label: string; style: number }>);

beforeEach(() => {
	mocks.findByGuildId.mockReset().mockResolvedValue({ guildId: GUILD_ID, introChannelId: null });
	mocks.gateOwnerOrAdmin.mockReset().mockResolvedValue(true);
	mocks.ensureOnDemandChannel.mockReset().mockResolvedValue({ id: "built-intro" });
	mocks.send.mockReset().mockResolvedValue({ channelId: "c-onboarding" });
	mocks.beginChannelAnswer.mockReset().mockResolvedValue({ channelId: "c-onboarding", send: mocks.send });
	mocks.showNotice.mockReset().mockResolvedValue(undefined);
});

describe("the cards", () => {
	it("are the ten owner approved channels, in card order", () => {
		expect(Object.keys(TUTORIAL_CHANNELS)).toEqual(["intro", "announcements", "schedule", "welcome", "rules", "commands", "meetingVoice", "commandOutput", "leaderboard", "nextDecree"]);
		expect(channelCards(null).map((card) => card.key)).toEqual([
			"introChannelId",
			"announcementsChannelId",
			"scheduleChannelId",
			"welcomeChannelId",
			"rulesChannelId",
			"commandsChannelId",
			"meetingVoiceChannelId",
			"commandOutputChannelId",
			"leaderboardChannelId",
			"nextDecreeChannelId",
		]);
	});

	it("render an open channel with Add this channel and Skip while the slot is empty", () => {
		const card = channelCards({ introChannelId: null })[0]!;
		expect(card.message.embeds[0]!.data.description).toContain("Not built yet");
		expect(buttonsOf(card)).toMatchObject([
			{ custom_id: "hqstep:onboarding:tutorial-intro", label: "Add this channel", style: ButtonStyle.Primary },
			{ custom_id: "hqstep:onboarding:skip-intro", label: "Skip", style: ButtonStyle.Secondary },
		]);
	});

	it("render a skipped channel with its skipped line and Add this channel alone", () => {
		const card = channelCards({ setupStepsSkipped: ["onboarding:intro"] })[0]!;
		expect(card.message.embeds[0]!.data.description).toContain(cardCopy.skippedLine);
		expect(card.message.embeds[0]!.data.description).not.toContain("Not built yet");
		expect(buttonsOf(card)).toMatchObject([{ custom_id: "hqstep:onboarding:tutorial-intro", label: "Add this channel", style: ButtonStyle.Primary }]);
	});

	it("render a done channel naming the channel, with Channel ready and Remove", () => {
		const card = channelCards({ introChannelId: "c-intro" })[0]!;
		expect(card.message.embeds[0]!.data.description).toContain("<#c-intro>");
		expect(buttonsOf(card)).toMatchObject([
			{ custom_id: "hqstep:onboarding:tutorial-intro", label: "Channel ready", style: ButtonStyle.Success },
			{ custom_id: "hqstep:onboarding:remove-intro", label: "Remove", style: ButtonStyle.Danger },
		]);
	});

	it("let done beat skipped, so a channel added after its Skip reads ready", () => {
		const card = channelCards({ introChannelId: "c-intro", setupStepsSkipped: ["onboarding:intro"] })[0]!;
		expect(card.message.embeds[0]!.data.description).not.toContain(cardCopy.skippedLine);
		expect(buttonsOf(card).map((button) => button.label)).toEqual(["Channel ready", "Remove"]);
	});

	it("keep the same title done or pending, so a card whose id was lost is found again", () => {
		const pending = channelCards(null).map((card) => card.title);
		const done = channelCards(Object.fromEntries(Object.values(TUTORIAL_CHANNELS).map((field) => [field, "x"]))).map((card) => card.title);
		expect(done).toEqual(pending);
	});

	it("teach from the guild's pack, both packs carrying every card", () => {
		for (const pack of [rokCommanderCopy, generalEventsCopy]) {
			for (const card of channelCards(null, pack)) {
				expect(card.title.length).toBeGreaterThan(0);
				expect(card.message.embeds[0]!.data.description!.length).toBeGreaterThan(80);
			}
		}
		expect(channelCards(null, generalEventsCopy)[0]!.message.embeds[0]!.data.description).toContain("Where newcomers say hello");
	});

	it("carry no em or en dash in any teaching paragraph", () => {
		for (const pack of [rokCommanderCopy, generalEventsCopy]) {
			for (const teaching of Object.values(pack.channelContent.tutorial)) expect(`${teaching.title}${teaching.body}`).not.toMatch(LONG_DASHES);
		}
	});
});

// ── the step model (2026-11 item 289) ──
// progressOf is what a step shows and revealedSteps which steps keep a card; both read only
// the row, which is why one rule can serve a new server and an old one alike.
const flow = (key: string, overrides: Partial<SetupStep> = {}): SetupStep => ({ key, kind: "flow", label: key, done: false, needsContinue: false, teaching: "teaches", customId: `c-${key}`, ...overrides });
const channel = (key: string, overrides: Partial<SetupStep> = {}): SetupStep => ({ ...flow(key), kind: "channel", ...overrides });

describe("progressOf", () => {
	it("reads open, then skipped once listed, and done beats skipped", () => {
		expect(progressOf(flow("voice"), "deroConfig", [])).toBe("open");
		expect(progressOf(flow("voice"), "deroConfig", ["deroConfig:voice"])).toBe("skipped");
		expect(progressOf(flow("voice", { done: true }), "deroConfig", ["deroConfig:voice"])).toBe("done");
	});

	it("reads a pressed Continue as done, never skipped, even on a step that reads not done", () => {
		expect(progressOf(flow("rename", { needsContinue: true }), "serverConfig", [])).toBe("open");
		expect(progressOf(flow("rename", { needsContinue: true }), "serverConfig", ["serverConfig:rename"])).toBe("done");
	});

	it("reads only its own domain's ids", () => {
		expect(progressOf(flow("voice"), "deroConfig", ["serverConfig:voice"])).toBe("open");
	});
});

describe("isResolved", () => {
	it("needs a listing or a done mark, and a needsContinue step needs its press even when it reads done", () => {
		expect(isResolved(flow("a"), "deroConfig", [])).toBe(false);
		expect(isResolved(flow("a"), "deroConfig", ["deroConfig:a"])).toBe(true);
		expect(isResolved(flow("a", { done: true }), "deroConfig", [])).toBe(true);
		expect(isResolved(flow("a", { done: true, needsContinue: true }), "deroConfig", [])).toBe(false);
		expect(isResolved(flow("a", { done: true, needsContinue: true }), "deroConfig", ["deroConfig:a"])).toBe(true);
	});
});

describe("cardKeyOf and stepIdOf", () => {
	it("key a channel card by its slot, a flow card by <domain>-<key>, and an id by domain:key", () => {
		expect(cardKeyOf(channel("intro"), "onboarding")).toBe("introChannelId");
		expect(cardKeyOf(flow("gating"), "onboarding")).toBe("onboarding-gating");
		expect(stepIdOf("serverConfig", "timezone")).toBe("serverConfig:timezone");
	});
});

describe("revealedSteps", () => {
	const keys = (result: { kept: SetupStep[] }) => result.kept.map((step) => step.key);

	it("keeps only the frontier on a fresh row", () => {
		const result = revealedSteps([channel("intro"), channel("rules"), flow("a"), flow("b")], "onboarding", [], {});
		expect(keys(result)).toEqual(["intro"]);
		expect(result.finished).toBe(false);
	});

	it("keeps a resolved channel step before the frontier, so its Remove has a home", () => {
		const result = revealedSteps([channel("intro", { done: true }), channel("rules"), flow("a")], "onboarding", [], {});
		expect(keys(result)).toEqual(["intro", "rules"]);
	});

	it("gives a resolved flow step no card of its own, however many there are", () => {
		const result = revealedSteps([flow("a", { done: true }), flow("b", { done: true }), flow("c")], "serverConfig", [], {});
		expect(keys(result)).toEqual(["c"]);
	});

	it("keeps a stored card past the frontier, because a posted card is never deleted", () => {
		const stored = { "serverConfig-c": "m-c", "serverConfig-a": "m-a" };
		const result = revealedSteps([flow("a", { done: true }), flow("b"), flow("c")], "serverConfig", [], stored);
		expect(keys(result)).toEqual(["a", "b", "c"]);
	});

	it("leaves a resolved channel step past the frontier cardless until the walk reaches it", () => {
		const result = revealedSteps([channel("intro"), channel("rules", { done: true })], "onboarding", [], {});
		expect(keys(result)).toEqual(["intro"]);
	});

	it("finishes when no step is unresolved, a skipped one counting, and keeps every resolved channel step", () => {
		const result = revealedSteps([channel("intro", { done: true }), channel("rules"), flow("a", { done: true })], "onboarding", ["onboarding:rules"], {});
		expect(keys(result)).toEqual(["intro", "rules"]);
		expect(result.finished).toBe(true);
	});

	it("reveals one new flow step at a time, the needsContinue step that reads done among them", () => {
		const steps = [flow("a", { done: true, needsContinue: true }), flow("b")];
		expect(keys(revealedSteps(steps, "serverConfig", [], {}))).toEqual(["a"]);
		expect(keys(revealedSteps(steps, "serverConfig", ["serverConfig:a"], {}))).toEqual(["b"]);
	});
});

describe("a flow card", () => {
	const card = (step: SetupStep, skipped: string[] = []) => buildCards([step], "serverConfig", { setupStepsSkipped: skipped })[0]!;
	const labelled = (built: ReturnType<typeof card>) => buttonsOf(built).map((button) => [button.label, button.style]);

	it("stores under <domain>-<key>, titled by its label, teaching its step", () => {
		const built = card(flow("timezone", { label: "The server's timezone" }));
		expect(built.key).toBe("serverConfig-timezone");
		expect(built.title).toBe("The server's timezone");
		expect(built.message.embeds[0]!.data.description).toBe("teaches");
	});

	it("reads open with Open and Skip, Open carrying the step's own customId", () => {
		const built = card(flow("timezone"));
		expect(labelled(built)).toEqual([
			["Open", ButtonStyle.Primary],
			["Skip", ButtonStyle.Secondary],
		]);
		expect(buttonsOf(built).map((button) => button.custom_id)).toEqual(["c-timezone", "hqstep:serverConfig:skip-timezone"]);
	});

	it("reads skipped with its line and Open alone", () => {
		const built = card(flow("timezone"), ["serverConfig:timezone"]);
		expect(built.message.embeds[0]!.data.description).toContain(cardCopy.skippedLine);
		expect(buttonsOf(built).map((button) => button.label)).toEqual(["Open"]);
	});

	it("reads done with Open alone and no line", () => {
		const built = card(flow("timezone", { done: true }));
		expect(built.message.embeds[0]!.data.description).toBe("teaches");
		expect(buttonsOf(built).map((button) => button.label)).toEqual(["Open"]);
	});

	it("offers Continue where a step needs one, never Skip, whether or not it reads done", () => {
		for (const done of [true, false]) {
			const built = card(flow("template", { needsContinue: true, done }));
			expect(built.message.embeds[0]!.data.description).toBe("teaches");
			expect(labelled(built)).toEqual([
				["Open", ButtonStyle.Secondary],
				["Continue", ButtonStyle.Primary],
			]);
			expect(buttonsOf(built)[1]!.custom_id).toBe("hqstep:serverConfig:skip-template");
		}
	});

	it("keeps Open once Continue is pressed, with the noted line and never the skipped one", () => {
		const built = card(flow("template", { needsContinue: true }), ["serverConfig:template"]);
		expect(built.message.embeds[0]!.data.description).toContain(cardCopy.continuedLine);
		expect(built.message.embeds[0]!.data.description).not.toContain(cardCopy.skippedLine);
		expect(buttonsOf(built).map((button) => button.label)).toEqual(["Open"]);
	});

	it("shows gating, which has no flow to open, Continue alone and then nothing", () => {
		const gating = flow("gating", { needsContinue: true, customId: null });
		expect(buildCards([gating], "onboarding", {})[0]!.message.components[0]!.toJSON().components).toHaveLength(1);
		const pressed = buildCards([gating], "onboarding", { setupStepsSkipped: ["onboarding:gating"] })[0]!;
		expect(pressed.message.components).toEqual([]);
		expect(pressed.message.embeds[0]!.data.description).toContain(cardCopy.continuedLine);
	});

	it("never carries its mark in its title, read or skipped", () => {
		const open = card(flow("timezone", { label: "Label" }));
		const skipped = card(flow("timezone", { label: "Label" }), ["serverConfig:timezone"]);
		expect(skipped.title).toBe(open.title);
	});
});

describe("parseStepId", () => {
	it("knows every channel and flow step, and the arcade's enable step", () => {
		expect(parseStepId("onboarding:intro")).toEqual({ domain: "onboarding", key: "intro" });
		expect(parseStepId("onboarding:gating")).toEqual({ domain: "onboarding", key: "gating" });
		expect(parseStepId("arcadeControl:enable")).toEqual({ domain: "arcadeControl", key: "enable" });
		expect(parseStepId("serverConfig:rename")).toEqual({ domain: "serverConfig", key: "rename" });
	});

	it("refuses a domain or a key no step carries, a channel key on another domain, and a prototype word", () => {
		for (const id of ["onboarding:nope", "arcade:chips", "deroConfig:intro", "serverConfig:enable", "onboarding:toString", "constructor:intro", "onboarding", "onboarding:intro:extra"]) {
			expect(parseStepId(id), id).toBeNull();
		}
	});
});

describe("the customIds", () => {
	it("round trip through tutorialKeyOf", () => {
		for (const key of Object.keys(TUTORIAL_CHANNELS) as Array<keyof typeof TUTORIAL_CHANNELS>) {
			expect(tutorialKeyOf(tutorialCustomId(key).split(":")[2]!)).toBe(key);
		}
		expect(tutorialKeyOf("tutorial-arcade")).toBeNull();
		expect(tutorialKeyOf("1")).toBeNull();
	});

	it("name Skip by domain and step, and Remove by channel, within Discord's 100 characters", () => {
		expect(skipCustomId("serverConfig", "kvkSeason")).toBe("hqstep:serverConfig:skip-kvkSeason");
		expect(removeCustomId("nextDecree")).toBe("hqstep:onboarding:remove-nextDecree");
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
