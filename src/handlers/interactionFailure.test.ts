import type { RepliableInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerInteractionFailure } from "./interactionFailure.js";

// A button press in each acknowledgement state the dispatcher can meet after a handler threw.
function press(state: { deferred?: boolean; replied?: boolean }) {
	return {
		id: "interaction-1",
		deferred: state.deferred ?? false,
		replied: state.replied ?? false,
		showModal: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("answerInteractionFailure", () => {
	it("answers a fresh press with the error notice as its first response", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const interaction = press({});
		await answerInteractionFailure(interaction as unknown as RepliableInteraction, "button", new Error("boom"));
		expect(interaction.showModal).toHaveBeenCalledTimes(1);
		expect(interaction.followUp).not.toHaveBeenCalled();
	});

	it("still answers a press the handler deferred before it threw, through a follow up", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const interaction = press({ deferred: true });
		await answerInteractionFailure(interaction as unknown as RepliableInteraction, "button", new Error("boom"));
		expect(interaction.followUp).toHaveBeenCalledTimes(1);
		expect(interaction.reply).not.toHaveBeenCalled();
		expect(interaction.showModal).not.toHaveBeenCalled();
	});

	it("never throws when the answer itself fails", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const interaction = press({ replied: true });
		interaction.followUp.mockRejectedValue(new Error("Unknown interaction"));
		await expect(answerInteractionFailure(interaction as unknown as RepliableInteraction, "modal", new Error("boom"))).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("[interactions] modal threw", expect.any(Error));
	});
});
