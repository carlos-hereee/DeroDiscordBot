import { describe, it, expect, vi, beforeEach } from "vitest";
// Dero's variant lines always pick the first, so these tests read exact words.
vi.mock("@utils/pickLine.js", () => ({ pickLine: <Line>(lines: readonly Line[]): Line => lines[0] as Line }));
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

// ── coinMarketPanel (2026-10 item 267 Session 2a) ─────────────────────────────
// The press answers every state it can know as a notice titled for the market and opens
// no modal; the Submit trades and posts in 🏪dero-market through the real answerInChannel,
// pinging the trader alone. The trades themselves are coinMarket.test.ts's; here they are
// stubs, so "moves nothing" reads as "no trade was asked for".

const mocks = vi.hoisted(() => ({
	findByGuildId: vi.fn(),
	readMarketView: vi.fn(),
	buyCoins: vi.fn(),
	sellCoins: vi.fn(),
}));

vi.mock("@db/stores/guildConfigStore.js", () => ({ guildConfigStore: { findByGuildId: mocks.findByGuildId } }));
vi.mock("./coinMarket.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./coinMarket.js")>()),
	readMarketView: mocks.readMarketView,
	buyCoins: mocks.buyCoins,
	sellCoins: mocks.sellCoins,
}));

import { rokCommanderCopy } from "@base/copy/packs/rok-commander.pack.js";
import { buildMarketModal, buildMarketRow, handleMarketPress, handleMarketSubmit } from "./coinMarketPanel.js";
import { economyCopy } from "./economyCopy.js";

const MARKET_CHANNEL = "ch-market";
const CONFIG = { chipEconomyEnabled: true, deroMarketChannelId: MARKET_CHANNEL, commandOutputChannelId: "ch-commands" };
const TITLE = rokCommanderCopy.notice.market;
const copy = economyCopy.market;

type ModalJson = { custom_id: string; title: string; components: Array<{ type: number; content?: string }> };

function marketChannel() {
	return { id: MARKET_CHANNEL, isSendable: () => true, send: vi.fn(async () => ({ id: "posted" })) };
}

function press(side: "buy" | "sell") {
	const showModal = vi.fn(async () => undefined);
	const fake = {
		id: "press-1",
		customId: `market:${side}`,
		guildId: "g1",
		user: { id: "u-trader" },
		deferred: false,
		replied: false,
		showModal,
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => undefined),
		isMessageComponent: () => true,
		isModalSubmit: () => false,
	};
	const modal = (): ModalJson => (showModal.mock.calls[0] as unknown as [{ toJSON(): ModalJson }])[0].toJSON();
	return { interaction: fake as unknown as ButtonInteraction, fake, modal };
}

function submit(side: "buy" | "sell", typed: string, channel = marketChannel()) {
	const fake: Record<string, unknown> = {
		id: "submit-1",
		customId: `market:${side}`,
		guildId: "g1",
		user: { id: "u-trader" },
		deferred: false,
		replied: false,
		fields: { getTextInputValue: () => typed },
		client: { channels: { fetch: vi.fn(async (id: string) => (id === MARKET_CHANNEL ? channel : null)) } },
		reply: vi.fn(async () => undefined),
		followUp: vi.fn(async () => undefined),
		deferUpdate: vi.fn(async () => {
			fake.deferred = true;
		}),
		deferReply: vi.fn(async () => undefined),
		deleteReply: vi.fn(async () => undefined),
		isFromMessage: () => true,
		isModalSubmit: () => true,
		isMessageComponent: () => false,
	};
	return { interaction: fake as unknown as ModalSubmitInteraction, fake: fake as Record<string, ReturnType<typeof vi.fn>>, channel };
}

const textOf = (modal: ModalJson): string => modal.components.map((component) => component.content ?? "").join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.findByGuildId.mockResolvedValue(CONFIG);
	mocks.readMarketView.mockResolvedValue({ chips: 10_000, coins: 4, buyLeftToday: 3 });
});

describe("the market's buttons", () => {
	it("carries Buy coins and Sell coins under the market prefix", () => {
		const row = buildMarketRow().toJSON() as { components: Array<{ custom_id: string; label: string }> };
		expect(row.components.map((button) => [button.custom_id, button.label])).toEqual([
			["market:buy", copy.buyLabel],
			["market:sell", copy.sellLabel],
		]);
	});
});

describe("handleMarketPress", () => {
	it("opens the buy modal with the rate, both balances and today's buys left", async () => {
		const { interaction, modal } = press("buy");

		await handleMarketPress(interaction);

		const shown = modal();
		expect(shown.custom_id).toBe("market:buy");
		expect(shown.title).toBe(copy.buyModalTitle);
		expect(textOf(shown)).toContain("2,000 chips");
		expect(textOf(shown)).toContain(copy.balances({ chips: 10_000, coins: 4, buyLeftToday: 3 }));
	});

	it("refuses a fourth coin today at the press, with the market's title, and opens no trade", async () => {
		mocks.readMarketView.mockResolvedValue({ chips: 10_000, coins: 3, buyLeftToday: 0 });
		const { interaction, modal } = press("buy");

		await handleMarketPress(interaction);

		const shown = modal();
		expect(shown.custom_id.startsWith("market:")).toBe(false);
		expect(shown.title).toBe(TITLE);
		expect(textOf(shown)).toContain("You bought your 3 Dero coins for today");
		expect(mocks.buyCoins).not.toHaveBeenCalled();
	});

	it("refuses a buy a wallet cannot afford one coin of", async () => {
		mocks.readMarketView.mockResolvedValue({ chips: 1_999, coins: 0, buyLeftToday: 3 });
		const { interaction, modal } = press("buy");

		await handleMarketPress(interaction);

		expect(textOf(modal())).toContain(copy.cannotAfford(1_999));
	});

	it("refuses a sale with no coins to sell", async () => {
		mocks.readMarketView.mockResolvedValue({ chips: 0, coins: 0, buyLeftToday: 3 });
		const { interaction, modal } = press("sell");

		await handleMarketPress(interaction);

		expect(textOf(modal())).toContain(copy.nothingToSell);
	});

	it.each(["buy", "sell"] as const)("says the market is closed on a server with chips off (%s)", async (side) => {
		mocks.findByGuildId.mockResolvedValue({ ...CONFIG, chipEconomyEnabled: false });
		const { interaction, modal } = press(side);

		await handleMarketPress(interaction);

		expect(modal().title).toBe(TITLE);
		expect(textOf(modal())).toContain(copy.closed);
		expect(mocks.readMarketView).not.toHaveBeenCalled();
	});
});

describe("handleMarketSubmit", () => {
	it("posts a finished buy in 🏪dero-market, pinging only the trader", async () => {
		mocks.buyCoins.mockResolvedValue({ kind: "bought", coins: 3, chipsPaid: 6_000 });
		mocks.readMarketView.mockResolvedValue({ chips: 4_000, coins: 7, buyLeftToday: 0 });
		const { interaction, fake, channel } = submit("buy", "3");

		await handleMarketSubmit(interaction);

		expect(mocks.buyCoins).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-trader", guildId: "g1", coins: 3 }));
		expect(channel.send).toHaveBeenCalledOnce();
		const sent = (channel.send.mock.calls[0] as unknown as [{ content: string; allowedMentions: unknown }])[0];
		expect(sent.content).toBe(`<@u-trader> ${copy.bought({ coins: 3, chipsPaid: 6_000, chips: 4_000, coinBalance: 7, buyLeftToday: 0 })} *${copy.boughtQuips[0]}*`);
		expect(sent.allowedMentions).toEqual({ parse: [], users: ["u-trader"] });
		expect(fake.followUp).not.toHaveBeenCalled();
	});

	it("posts a finished sale of 2 coins for 1,000 chips", async () => {
		mocks.sellCoins.mockResolvedValue({ kind: "sold", coins: 2, chipsPaid: 1_000 });
		mocks.readMarketView.mockResolvedValue({ chips: 1_000, coins: 2, buyLeftToday: 3 });
		const { interaction, channel } = submit("sell", "2");

		await handleMarketSubmit(interaction);

		const sent = (channel.send.mock.calls[0] as unknown as [{ content: string }])[0];
		expect(sent.content).toContain("sold **2 Dero coins** for **1,000 chips**");
	});

	it("answers a cap another trade spent privately, posting nothing", async () => {
		mocks.buyCoins.mockResolvedValue({ kind: "cap", leftToday: 1 });
		const { interaction, fake, channel } = submit("buy", "2");

		await handleMarketSubmit(interaction);

		expect(channel.send).not.toHaveBeenCalled();
		expect(fake.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: copy.capLeft(1) }));
	});

	it("refuses an amount that is no whole number of coins before any trade", async () => {
		const { interaction, fake } = submit("buy", "1.5");

		await handleMarketSubmit(interaction);

		expect(mocks.buyCoins).not.toHaveBeenCalled();
		expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ content: copy.invalidAmount }));
	});

	it("refuses a Submit once chips were switched off, trading nothing", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...CONFIG, chipEconomyEnabled: false });
		const { interaction } = submit("sell", "1");

		await handleMarketSubmit(interaction);

		expect(mocks.sellCoins).not.toHaveBeenCalled();
	});

	it("answers privately, with the reason, on a server whose market channel is not built yet", async () => {
		mocks.findByGuildId.mockResolvedValue({ ...CONFIG, deroMarketChannelId: null });
		mocks.sellCoins.mockResolvedValue({ kind: "sold", coins: 1, chipsPaid: 500 });
		const { interaction, fake, channel } = submit("sell", "1");

		await handleMarketSubmit(interaction);

		expect(channel.send).not.toHaveBeenCalled();
		const reply = (fake.followUp.mock.calls[0] as unknown as [{ content: string }])[0];
		expect(reply.content.startsWith("You sold")).toBe(true);
		expect(reply.content).toContain(copy.noMarketChannel);
	});
});

describe("buildMarketModal", () => {
	it("hints the most a member could buy now: the smaller of today's cap left and the chips", () => {
		const modal = buildMarketModal("buy", { chips: 5_000, coins: 0, buyLeftToday: 3 }).toJSON() as unknown as { components: Array<{ component?: { placeholder?: string } }> };
		const input = modal.components.find((component) => component.component?.placeholder);
		expect(input?.component?.placeholder).toBe("1 to 2");
	});
});
