import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageFlags, type RepliableInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({ findByGuildId: vi.fn(), registerModal: vi.fn() }));
vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("@handlers/interactionRegistry.js", () => ({ registerModal: mocks.registerModal }));

import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { generalEventsCopy } from "@base/copy/packs/general-events.pack.js";
import { RECORDS_ANSWERS, answerChannelId, answerInChannel, askInChannel, beginAnswerInPlace, beginChannelAnswer, type AnswerAudience } from "./answerInChannel.js";

// ── answerInChannel (2026-10 item 257 Phase 5) ───────────────────────────────
// Where an answer posts for each audience, the mention that names the member without a
// ping, the private fallback a server with no such channel keeps, the notice a slow answer
// opens with, the settings panel's recording stand in, and a prompt only its asker answers.

const CONFIG = {
	commandOutputChannelId: "c-commands",
	// 🏪dero-market, where a finished trade posts (2026-10 item 267 Session 2a).
	deroMarketChannelId: "c-market",
	deroConfigChannelId: "c-dero-config",
	onboardingConfigChannelId: "c-onboarding",
	arcadeControlChannelId: "c-arcade",
	// 🛠️server-config holds both its own answers and every other admin answer since
	// 🎛️admin-controls retired (2026-10 item 263 Phase 4a).
	serverConfigChannelId: "c-admin",
};

function channel(id: string) {
	const posted = { id: `m-${id}`, edit: vi.fn(async () => undefined), awaitMessageComponent: vi.fn(), createMessageComponentCollector: vi.fn() };
	return { id, isSendable: () => true, send: vi.fn(async () => posted), posted };
}

type Fake = RepliableInteraction & Record<"reply" | "followUp" | "editReply" | "deferReply" | "deferUpdate" | "deleteReply" | "showModal", ReturnType<typeof vi.fn>>;

// A slash command by default; `component` makes it a button press, `modal` a modal Submit.
function interaction(options: { kind?: "command" | "component" | "modal"; channels?: Map<string, ReturnType<typeof channel>>; deferred?: boolean } = {}): Fake {
	const kind = options.kind ?? "command";
	const channels = options.channels ?? new Map();
	const fake: Record<string, unknown> = {
		id: "int-1",
		guildId: "g-1",
		user: { id: "u-asker" },
		deferred: options.deferred ?? false,
		replied: false,
		client: { channels: { cache: channels, fetch: vi.fn(async (id: string) => channels.get(id) ?? null) } },
		reply: vi.fn(async () => ({ awaitMessageComponent: vi.fn(async () => null) })),
		followUp: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => {
			fake.deferred = true;
		}),
		deferUpdate: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		isModalSubmit: () => kind === "modal",
		isMessageComponent: () => kind === "component",
		isFromMessage: () => true,
	};
	if (kind !== "modal") fake.showModal = vi.fn(async () => undefined);
	return fake as unknown as Fake;
}

const allChannels = () => new Map(Object.values(CONFIG).map((id) => [id, channel(id)]));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.findByGuildId.mockResolvedValue(CONFIG);
});

describe("answerChannelId", () => {
	const routes: Array<[AnswerAudience, string]> = [
		["member", "c-commands"],
		["market", "c-market"],
		["deroConfig", "c-dero-config"],
		["onboarding", "c-onboarding"],
		["arcade", "c-arcade"],
		["serverConfig", "c-admin"],
		["admin", "c-admin"],
	];
	it.each(routes)("routes %s to its own channel", (audience, expected) => {
		expect(answerChannelId(CONFIG, audience)).toBe(expected);
	});

	it("has no channel for a server setup never stored one", () => {
		expect(answerChannelId(null, "member")).toBeNull();
		expect(answerChannelId({ commandOutputChannelId: null }, "member")).toBeNull();
		expect(answerChannelId({ commandOutputChannelId: "" }, "member")).toBeNull();
	});
});

describe("answerInChannel", () => {
	it("posts a finished trade in 🏪dero-market, pinging only the trader", async () => {
		const channels = allChannels();
		const fake = interaction({ kind: "modal", channels });
		const place = await answerInChannel(fake, "market", { content: "bought 1 Dero coin." });

		expect(place.channelId).toBe("c-market");
		expect(channels.get("c-market")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker> bought 1 Dero coin.", allowedMentions: { parse: [], users: ["u-asker"] } }));
		expect(channels.get("c-commands")!.send).not.toHaveBeenCalled();
	});

	it("posts a member's answer in the commands channel, pinging that one member in the content, and leaves no private message", async () => {
		const channels = allChannels();
		const fake = interaction({ kind: "component", channels });
		const place = await answerInChannel(fake, "member", { content: "Done." });

		expect(place.channelId).toBe("c-commands");
		expect(channels.get("c-commands")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker> Done.", allowedMentions: { parse: [], users: ["u-asker"] } }));
		expect(fake.deferUpdate).toHaveBeenCalled();
		expect(fake.reply).not.toHaveBeenCalled();
	});

	it.each([
		["deroConfig", "c-dero-config"],
		["onboarding", "c-onboarding"],
		["arcade", "c-arcade"],
		["serverConfig", "c-admin"],
		["admin", "c-admin"],
	] as Array<[AnswerAudience, string]>)("posts an admin's %s answer in its Headquarters channel", async (audience, expected) => {
		const channels = allChannels();
		const place = await answerInChannel(interaction({ channels }), audience, { content: "Saved." });
		expect(place.channelId).toBe(expected);
		expect(channels.get(expected)!.send).toHaveBeenCalledTimes(1);
	});

	it("answers privately when the server has no such channel stored (setup not rerun)", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...CONFIG, commandOutputChannelId: null });
		const fake = interaction();
		const place = await answerInChannel(fake, "member", { content: "Done." });
		expect(place.channelId).toBeNull();
		expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "Done.", flags: MessageFlags.Ephemeral }));
	});

	it("answers privately when the stored channel is gone", async () => {
		const place = await answerInChannel(interaction({ channels: new Map() }), "admin", { content: "Saved." });
		expect(place.channelId).toBeNull();
	});

	it("follows up privately on an interaction already acknowledged", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		const fake = interaction({ deferred: true });
		await answerInChannel(fake, "member", { content: "Late." });
		expect(fake.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: "Late.", flags: MessageFlags.Ephemeral }));
	});

	it("hands a recording stand in its answer, never posting past it into a channel", async () => {
		const channels = allChannels();
		const fake = interaction({ channels }) as unknown as Record<symbol, unknown> & Fake;
		fake[RECORDS_ANSWERS] = true;
		const place = await answerInChannel(fake, "admin", { content: "Saved." });
		expect(place.channelId).toBeNull();
		expect(fake.reply).toHaveBeenCalled();
		expect(channels.get("c-admin")!.send).not.toHaveBeenCalled();
	});
});

describe("beginChannelAnswer", () => {
	it("acknowledges a slash command with a private defer deleted at once, opens no modal, then posts the answer with its ping", async () => {
		const channels = allChannels();
		const fake = interaction({ channels });
		const answer = await beginChannelAnswer(fake, "member");

		expect(answer.channelId).toBe("c-commands");
		expect(fake.showModal).not.toHaveBeenCalled();
		expect(fake.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		expect(fake.deleteReply).toHaveBeenCalledTimes(1);
		await answer.send({ content: "Here it is." });
		expect(channels.get("c-commands")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker> Here it is.", allowedMentions: { parse: [], users: ["u-asker"] } }));
		expect(fake.followUp).not.toHaveBeenCalled();
	});

	it("acknowledges a button with deferUpdate, which shows nothing, and opens no modal", async () => {
		const channels = allChannels();
		const fake = interaction({ kind: "component", channels });
		const answer = await beginChannelAnswer(fake, "admin");

		expect(answer.channelId).toBe("c-admin");
		expect(fake.deferUpdate).toHaveBeenCalledTimes(1);
		expect(fake.showModal).not.toHaveBeenCalled();
		expect(fake.deferReply).not.toHaveBeenCalled();
		await answer.send({ content: "Saved." });
		expect(channels.get("c-admin")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker> Saved.", allowedMentions: { parse: [], users: ["u-asker"] } }));
	});

	it("puts the mention in the content even when the answer is only an embed, since an embed mention never pings", async () => {
		const channels = allChannels();
		await answerInChannel(interaction({ kind: "component", channels }), "member", { embeds: [] });
		expect(channels.get("c-commands")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker>", allowedMentions: { parse: [], users: ["u-asker"] } }));
	});

	it("pings only the asker in a confirm then act prompt too", async () => {
		const channels = allChannels();
		await askInChannel(interaction({ channels }), "admin", { content: "Sure?" });
		expect(channels.get("c-admin")!.send).toHaveBeenCalledWith(expect.objectContaining({ content: "<@u-asker> Sure?", allowedMentions: { parse: [], users: ["u-asker"] } }));
	});

	it("closes a modal Submit quietly, since a Submit cannot open a notice", async () => {
		const fake = interaction({ kind: "modal", channels: allChannels() });
		await beginChannelAnswer(fake, "arcade");
		expect(fake.deferUpdate).toHaveBeenCalled();
	});

	it("defers privately and edits that reply when the server has no channel", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		const fake = interaction();
		const answer = await beginChannelAnswer(fake, "member");
		expect(answer.channelId).toBeNull();
		expect(fake.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
		await answer.send({ content: "Here it is." });
		expect(fake.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "Here it is." }));
	});
});

describe("beginAnswerInPlace", () => {
	it("defers publicly where it was asked and edits that reply", async () => {
		const fake = interaction();
		const answer = await beginAnswerInPlace(fake);
		expect(fake.deferReply).toHaveBeenCalledWith();
		await answer.send({ content: "Public." });
		expect(fake.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "Public." }));
	});
});

describe("askInChannel", () => {
	it("resolves only the asker's press, turning anyone else away with a notice", async () => {
		const channels = allChannels();
		const posted = channels.get("c-admin")!.posted;
		const stranger = { user: { id: "u-other" }, showModal: vi.fn(async () => undefined), deferred: false, replied: false, id: "press-2" };
		const asker = { user: { id: "u-asker" }, customId: "confirm" };
		posted.awaitMessageComponent.mockImplementation(async ({ filter }: { filter: (press: unknown) => boolean }) => {
			expect(filter(stranger)).toBe(false);
			expect(filter(asker)).toBe(true);
			return asker;
		});

		const prompt = await askInChannel(interaction({ channels }), "admin", { content: "Sure?" });
		expect(prompt.channelId).toBe("c-admin");
		await expect(prompt.awaitPress(1000)).resolves.toBe(asker);
		expect(stranger.showModal).toHaveBeenCalledTimes(1);
	});

	it("falls back to the private prompt with no channel, and edits it there", async () => {
		mocks.findByGuildId.mockResolvedValue(null);
		const fake = interaction();
		const prompt = await askInChannel(fake, "admin", { content: "Sure?" });
		expect(prompt.channelId).toBeNull();
		expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
		await prompt.edit({ content: "Timed out." });
		expect(fake.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "Timed out." }));
	});
});

describe("the copy", () => {
	it("carries the same keys in both packs", () => {
		expect(Object.keys(generalEventsCopy.answerInChannel).sort()).toEqual(Object.keys(rokCommanderCopy.answerInChannel).sort());
	});

	it("keeps no copy for the retired notice that named where an answer would post", () => {
		expect(Object.keys(rokCommanderCopy.answerInChannel)).not.toContain("postsIn");
	});
});
