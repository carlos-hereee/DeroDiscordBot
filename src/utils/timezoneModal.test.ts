import { describe, expect, it } from "vitest";
import { getPluginCopy } from "@base/copy/getCopy.js";
import { HEADQUARTERS_STEP_PREFIX } from "@features/setup/headquartersCards.js";
import { buildTimezoneModal, pickedTimezone, TIMEZONE_MODAL_IDS } from "./timezoneModal.js";
import { TIMEZONE_OPTIONS } from "./tzParser.js";

// ── timezoneModal (2026-11 item 388, owner decision D26) ──
// The one timezone modal: the server's step in 🛠️server-config and a member's own pick share
// the same 25 zones and the same Submit check, and differ only in their customId and words.

describe("buildTimezoneModal", () => {
	it("keeps the server step's customId, the one the step registers", () => {
		expect(TIMEZONE_MODAL_IDS.server).toBe(`${HEADQUARTERS_STEP_PREFIX}timezone`);
		expect(buildTimezoneModal("UTC").toJSON().custom_id).toBe(TIMEZONE_MODAL_IDS.server);
	});

	it("gives the member target its own customId and words", () => {
		const modal = buildTimezoneModal("UTC", "member").toJSON();
		expect(modal.custom_id).toBe(TIMEZONE_MODAL_IDS.member);
		expect(modal.title).toBe(getPluginCopy(null).timezoneModal.member.title);
		expect(TIMEZONE_MODAL_IDS.member).not.toBe(TIMEZONE_MODAL_IDS.server);
	});

	it.each(["server", "member"] as const)("offers the shared 25 zones to the %s target, with the current zone picked", (target) => {
		const json = JSON.stringify(buildTimezoneModal("Europe/Berlin", target).toJSON());
		for (const option of TIMEZONE_OPTIONS) expect(json).toContain(`"value":"${option.value}"`);
		expect(json.match(/"default":true/g)).toHaveLength(1);
		expect(json).toContain(`"value":"Europe/Berlin","description":"Europe/Berlin","default":true`);
	});

	it("fits Discord's 45 character modal title and label caps in both packs", () => {
		for (const pluginId of ["rok-commander", "general-events"] as const) {
			for (const words of Object.values(getPluginCopy({ pluginId }).timezoneModal)) {
				expect(words.title.length).toBeLessThanOrEqual(45);
				expect(words.selectLabel.length).toBeLessThanOrEqual(45);
			}
		}
	});
});

describe("pickedTimezone", () => {
	it("takes only a zone from the list", () => {
		expect(pickedTimezone("Europe/Berlin")).toBe("Europe/Berlin");
		expect(pickedTimezone("Mars/Olympus")).toBeNull();
		expect(pickedTimezone(undefined)).toBeNull();
	});
});
