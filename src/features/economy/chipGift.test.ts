import { beforeEach, describe, expect, it, vi } from "vitest";

// ── the birthday gift ───────────────────────────────────────────────────────
// The money rule under test: one gift pays once, however often its code is entered. The stores
// are in memory fakes that keep the real conditions (one pending gift per member, a wallet
// refusing a receipt it holds), so a failure can be injected at each write and the wallet read
// afterwards. The real filters ran against a live database when this was built; stores carry
// no tests of their own (rule 6).

const CODE = "UP DOWN UP DOWN LEFT LEFT UP RIGHT A B SELECT START";
const TYLER = "111111111111111111";
const OTHER = "222222222222222222";

const db = vi.hoisted(() => {
	type Gift = { _id: string; userId: string; chips: number; status: "pending" | "redeemed" };
	const state = {
		gifts: [] as Gift[],
		wallets: new Map<string, { balance: number; paidGifts: string[] }>(),
		failNextCredit: false,
		failNextClose: false,
		reset() {
			state.gifts = [];
			state.wallets = new Map();
			state.failNextCredit = false;
			state.failNextClose = false;
		},
	};
	return state;
});

vi.mock("@db/stores/chipGiftStore.js", () => ({
	chipGiftStore: {
		savePending: vi.fn(async (gift: { userId: string; chips: number }) => {
			const waiting = db.gifts.find((row) => row.userId === gift.userId && row.status === "pending");
			if (waiting) waiting.chips = gift.chips;
			else db.gifts.push({ _id: `gift-${db.gifts.length + 1}`, userId: gift.userId, chips: gift.chips, status: "pending" });
		}),
		findPending: vi.fn(async (userId: string) => db.gifts.find((row) => row.userId === userId && row.status === "pending") ?? null),
		hasRedeemed: vi.fn(async (userId: string) => db.gifts.some((row) => row.userId === userId && row.status === "redeemed")),
		markRedeemed: vi.fn(async (giftId: string) => {
			if (db.failNextClose) {
				db.failNextClose = false;
				throw new Error("the network dropped");
			}
			const gift = db.gifts.find((row) => row._id === giftId);
			if (gift) gift.status = "redeemed";
		}),
	},
}));

vi.mock("@db/stores/chipWalletStore.js", () => ({
	chipWalletStore: {
		creditGift: vi.fn(async ({ userId }: { userId: string }, amount: number, giftId: string) => {
			if (db.failNextCredit) {
				db.failNextCredit = false;
				throw new Error("the network dropped");
			}
			const wallet = db.wallets.get(userId) ?? { balance: 0, paidGifts: [] };
			if (wallet.paidGifts.includes(giftId)) return null;
			wallet.balance += amount;
			wallet.paidGifts.push(giftId);
			db.wallets.set(userId, wallet);
			return wallet;
		}),
	},
}));

import { grantChipGift, redeemChipGift } from "./chipGift.js";

const balanceOf = (userId: string): number => db.wallets.get(userId)?.balance ?? 0;

beforeEach(() => {
	db.reset();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("redeemChipGift", () => {
	it("pays the right member the amount set for them", async () => {
		await grantChipGift(TYLER, 100_000, "owner");

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 100_000 });
		expect(balanceOf(TYLER)).toBe(100_000);
	});

	it("pays once: a second entry pays nothing and says it was collected", async () => {
		await grantChipGift(TYLER, 100_000, "owner");
		await redeemChipGift(TYLER, CODE);

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "collected" });
		expect(balanceOf(TYLER)).toBe(100_000);
	});

	it("pays once when two presses read the same waiting gift", async () => {
		await grantChipGift(TYLER, 100_000, "owner");

		const outcomes = await Promise.all([redeemChipGift(TYLER, CODE), redeemChipGift(TYLER, CODE)]);

		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["collected", "paid"]);
		expect(balanceOf(TYLER)).toBe(100_000);
	});

	it("pays a member with no gift nothing, the same answer as a wrong code", async () => {
		await grantChipGift(TYLER, 100_000, "owner");

		expect(await redeemChipGift(OTHER, CODE)).toEqual({ status: "none" });
		expect(balanceOf(OTHER)).toBe(0);
		expect(balanceOf(TYLER)).toBe(0);
	});

	it("pays nothing for a wrong code, the right member included", async () => {
		await grantChipGift(TYLER, 100_000, "owner");

		expect(await redeemChipGift(TYLER, "UP UP DOWN DOWN")).toEqual({ status: "none" });
		expect(balanceOf(TYLER)).toBe(0);
	});

	it("reads the code the forgiving way, in any case and with any spacing", async () => {
		await grantChipGift(TYLER, 100_000, "owner");

		expect(await redeemChipGift(TYLER, " up-down up-down left left up right a b select start ")).toEqual({ status: "paid", amount: 100_000 });
	});

	it("loses nothing when the credit fails: the gift still waits and pays once on the next entry", async () => {
		await grantChipGift(TYLER, 100_000, "owner");
		db.failNextCredit = true;

		await expect(redeemChipGift(TYLER, CODE)).rejects.toThrow("the network dropped");
		expect(balanceOf(TYLER)).toBe(0);

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 100_000 });
		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "collected" });
		expect(balanceOf(TYLER)).toBe(100_000);
	});

	it("doubles nothing when the wallet paid but closing the gift failed", async () => {
		await grantChipGift(TYLER, 100_000, "owner");
		db.failNextClose = true;

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 100_000 });
		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "collected" });
		expect(balanceOf(TYLER)).toBe(100_000);
		expect(db.gifts[0].status).toBe("redeemed");
	});
});

describe("grantChipGift", () => {
	it("gives another member their own amount with the same code", async () => {
		await grantChipGift(TYLER, 100_000, "owner");
		await grantChipGift(OTHER, 2_500, "owner");

		expect(await redeemChipGift(OTHER, CODE)).toEqual({ status: "paid", amount: 2_500 });
		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 100_000 });
	});

	it("corrects the waiting amount rather than stacking a second payout", async () => {
		await grantChipGift(TYLER, 1_000, "owner");
		await grantChipGift(TYLER, 100_000, "owner");

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 100_000 });
		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "collected" });
		expect(balanceOf(TYLER)).toBe(100_000);
	});

	it("lets a member who collected one be given another later", async () => {
		await grantChipGift(TYLER, 100_000, "owner");
		await redeemChipGift(TYLER, CODE);
		await grantChipGift(TYLER, 50_000, "owner");

		expect(await redeemChipGift(TYLER, CODE)).toEqual({ status: "paid", amount: 50_000 });
		expect(balanceOf(TYLER)).toBe(150_000);
	});
});
