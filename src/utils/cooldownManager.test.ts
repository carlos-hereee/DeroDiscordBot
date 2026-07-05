import { describe, it, expect } from "vitest";
import { CooldownManager } from "./cooldownManager.js";

describe("CooldownManager", () => {
	it("lets a fresh key through", () => {
		const cd = new CooldownManager(10_000);
		expect(cd.check("user-1", 1_000).onCooldown).toBe(false);
	});

	it("blocks within the window and reports remaining time", () => {
		const cd = new CooldownManager(10_000);
		cd.record("user-1", 1_000);
		const gate = cd.check("user-1", 6_000);
		expect(gate.onCooldown).toBe(true);
		expect(gate.remainingMs).toBe(5_000);
	});

	it("clears once the window has fully elapsed", () => {
		const cd = new CooldownManager(10_000);
		cd.record("user-1", 1_000);
		expect(cd.check("user-1", 11_000).onCooldown).toBe(false);
	});

	it("tracks keys independently", () => {
		const cd = new CooldownManager(10_000);
		cd.record("user-1", 1_000);
		expect(cd.check("user-2", 2_000).onCooldown).toBe(false);
	});
});
