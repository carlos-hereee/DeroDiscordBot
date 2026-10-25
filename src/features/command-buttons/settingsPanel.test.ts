import { describe, it, expect } from "vitest";
import { ComponentType, type Role } from "discord.js";
import { buildSettingsModal, planSettingsChanges, readSettingsPanel, shownControls, type PanelFieldsSource, type SettingsPanel } from "./settingsPanel.js";
import type { FormValue } from "./formOptionReader.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the settings panel ───────────────────────────────────────────────────────
// A panel is pinned in its three halves on one made here: the modal presets every
// control to its current value, the submit reads back into one answer per control,
// and only an answer that differs from the current value becomes a command run.

const role = (id: string): FormValue => ({ kind: "role", value: { id } as unknown as Role });

function panel(): SettingsPanel {
	return {
		title: "Sample settings",
		controls: [
			{
				id: "switches",
				kind: "switches",
				label: "Switches",
				description: "Checked is on",
				switches: [
					{ value: "heal", label: "Auto heal", on: true, callsFor: (on) => [{ path: "heal", values: new Map([["enabled", { kind: "boolean", value: on }]]) }] },
					{ value: "track", label: "Tracking", on: false, callsFor: (on) => [{ path: on ? "track on" : "track off", values: new Map() }] },
				],
			},
			{
				id: "week",
				kind: "choice",
				label: "Week",
				description: "Which day",
				choices: [
					{ name: "Sunday", value: "sunday" },
					{ name: "Monday", value: "monday" },
				],
				current: "sunday",
				callsFor: (value) => [{ path: "week", values: new Map([["start", { kind: "string", value }]]) }],
			},
			{
				id: "roles",
				kind: "roles",
				label: "Roles",
				description: "Who may",
				current: new Map([["r1", role("r1")], ["r2", role("r2")]]),
				callsFor: ({ added, removed }) => [
					...added.map((value) => ({ path: "role add", values: new Map([["role", value]]) })),
					...removed.map((value) => ({ path: "role remove", values: new Map([["role", value]]) })),
				],
			},
			{ id: "cap", kind: "number", label: "Cap", description: "Dollars", current: 10, min: 0, max: 50, callsFor: (value) => [{ path: "cap", values: new Map([["dollars", { kind: "number", value }]]) }] },
		],
	};
}

function source(answers: { switches?: string[]; week?: string; roles?: string[]; cap?: string }): PanelFieldsSource {
	const present = Object.keys(answers);
	return {
		fields: new Map(present.map((id) => [id, {}])),
		getCheckboxGroup: () => answers.switches ?? [],
		getRadioGroup: () => answers.week ?? null,
		getSelectedRoles: () => new Map((answers.roles ?? []).map((id) => [id, { id }])),
		getSelectedChannels: () => null,
		getTextInputValue: () => answers.cap ?? "",
	} as unknown as PanelFieldsSource;
}

describe("buildSettingsModal", () => {
	it("presets every control to the value it holds now", () => {
		const json = buildSettingsModal("admincmd_panel:sample", panel()).toJSON();
		expect(json.custom_id).toBe("admincmd_panel:sample");
		const components = json.components.map((label) => (label as { component: Record<string, unknown> }).component);

		expect(components[0]).toMatchObject({ type: ComponentType.CheckboxGroup, min_values: 0, required: false });
		expect((components[0].options as Array<{ value: string; default?: boolean }>).map((option) => [option.value, option.default])).toEqual([
			["heal", true],
			["track", false],
		]);
		expect((components[1].options as Array<{ value: string; default?: boolean }>).find((option) => option.default)?.value).toBe("sunday");
		expect(components[2]).toMatchObject({ type: ComponentType.RoleSelect, min_values: 0, default_values: [{ id: "r1" }, { id: "r2" }].map((entry) => expect.objectContaining(entry)) });
		expect(components[3]).toMatchObject({ type: ComponentType.TextInput, value: "10" });
	});

	it("leaves out a control Discord would refuse rather than sinking the modal", () => {
		const crowded = panel();
		const many = new Map(Array.from({ length: 26 }, (_, index) => [`r${index}`, role(`r${index}`)]));
		const controls = crowded.controls.map((control) => (control.kind === "roles" ? { ...control, current: many } : control));
		expect(shownControls({ ...crowded, controls }).map((control) => control.id)).toEqual(["switches", "week", "cap"]);
	});
});

describe("readSettingsPanel and planSettingsChanges", () => {
	it("runs nothing when every answer matches what is stored", () => {
		const read = readSettingsPanel(source({ switches: ["heal"], week: "sunday", roles: ["r1", "r2"], cap: "10" }), panel());
		expect(read.ok).toBe(true);
		if (read.ok) expect(planSettingsChanges(panel(), read.answers)).toEqual([]);
	});

	it("runs exactly the leaves whose setting changed, in control order", () => {
		const read = readSettingsPanel(source({ switches: ["track"], week: "monday", roles: ["r2", "r3"], cap: "25" }), panel());
		if (!read.ok) throw new Error(read.problem);
		const calls = planSettingsChanges(panel(), read.answers);
		expect(calls.map((call) => call.path)).toEqual(["heal", "track on", "week", "role add", "role remove", "cap"]);
		expect(calls[0].values.get("enabled")).toEqual({ kind: "boolean", value: false });
		expect((calls[3].values.get("role") as { value: { id: string } }).value.id).toBe("r3");
		expect((calls[4].values.get("role") as { value: { id: string } }).value.id).toBe("r1");
		expect(calls[5].values.get("dollars")).toEqual({ kind: "number", value: 25 });
	});

	it("leaves a control the submit does not carry as it is", () => {
		const read = readSettingsPanel(source({ week: "monday" }), panel());
		if (!read.ok) throw new Error(read.problem);
		expect(planSettingsChanges(panel(), read.answers).map((call) => call.path)).toEqual(["week"]);
	});

	it("ignores a choice no radio group offered", () => {
		const read = readSettingsPanel(source({ week: "friday" }), panel());
		if (!read.ok) throw new Error(read.problem);
		expect(planSettingsChanges(panel(), read.answers)).toEqual([]);
	});

	it("refuses a number that is not whole or is out of range, naming the setting", () => {
		expect(readSettingsPanel(source({ cap: "2.5" }), panel())).toEqual({ ok: false, problem: commandButtonsCopy.problems.notWholeNumber("Cap") });
		expect(readSettingsPanel(source({ cap: "99" }), panel())).toEqual({
			ok: false,
			problem: commandButtonsCopy.problems.outOfRange("Cap", commandButtonsCopy.launcher.rangeHint(0, 50)),
		});
	});
});
