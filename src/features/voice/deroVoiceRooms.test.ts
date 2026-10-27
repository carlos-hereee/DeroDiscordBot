import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@db/stores/deroVoiceConfigStore.js", () => ({
	deroVoiceConfigStore: { addToList: vi.fn(), removeFromList: vi.fn() },
}));

import { deroVoiceConfigStore } from "@db/stores/deroVoiceConfigStore.js";
import { allowDeroVoiceRooms, replaceDeroVoiceRoom, revokeDeroVoiceRooms } from "./deroVoiceRooms.js";

// ── Dero's own voice rooms on the allow list (2026-10 item 257 Phase 2b, owner item 8) ──

const store = deroVoiceConfigStore as unknown as { addToList: ReturnType<typeof vi.fn>; removeFromList: ReturnType<typeof vi.fn> };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	store.addToList.mockResolvedValue(null);
	store.removeFromList.mockResolvedValue(null);
});

describe("allowDeroVoiceRooms", () => {
	it("adds every present room through $addToSet and skips a missing one", async () => {
		await allowDeroVoiceRooms("g1", ["meeting-1", null, "lounge-1", undefined]);
		expect(store.addToList.mock.calls).toEqual([
			["g1", "allowedVoiceChannelIds", "meeting-1"],
			["g1", "allowedVoiceChannelIds", "lounge-1"],
		]);
		expect(store.removeFromList).not.toHaveBeenCalled();
	});

	it("never throws when a write fails, and still tries the next room", async () => {
		store.addToList.mockRejectedValueOnce(new Error("mongo down"));
		await expect(allowDeroVoiceRooms("g1", ["meeting-1", "lounge-1"])).resolves.toBeUndefined();
		expect(store.addToList).toHaveBeenCalledTimes(2);
	});
});

describe("revokeDeroVoiceRooms", () => {
	it("pulls only the rooms it is given, never an admin's own entry", async () => {
		await revokeDeroVoiceRooms("g1", ["meeting-1", "lounge-1"]);
		expect(store.removeFromList.mock.calls).toEqual([
			["g1", "allowedVoiceChannelIds", "meeting-1"],
			["g1", "allowedVoiceChannelIds", "lounge-1"],
		]);
	});
});

describe("replaceDeroVoiceRoom", () => {
	it("swaps a rebuilt room's old id for its new one", async () => {
		await replaceDeroVoiceRoom("g1", "old-1", "new-1");
		expect(store.removeFromList).toHaveBeenCalledWith("g1", "allowedVoiceChannelIds", "old-1");
		expect(store.addToList).toHaveBeenCalledWith("g1", "allowedVoiceChannelIds", "new-1");
	});

	it("only adds when the room had no id before, or kept the same one", async () => {
		await replaceDeroVoiceRoom("g1", null, "new-1");
		await replaceDeroVoiceRoom("g1", "same-1", "same-1");
		expect(store.removeFromList).not.toHaveBeenCalled();
		expect(store.addToList).toHaveBeenCalledTimes(2);
	});
});
