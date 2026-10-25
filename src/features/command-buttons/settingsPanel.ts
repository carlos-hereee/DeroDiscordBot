import {
	ChannelSelectMenuBuilder,
	CheckboxGroupBuilder,
	CheckboxGroupOptionBuilder,
	LabelBuilder,
	ModalBuilder,
	RadioGroupBuilder,
	RadioGroupOptionBuilder,
	RoleSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ChannelType,
	type ModalSubmitFields,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { OptionChoice } from "@handlers/commandOptions.js";
import type { FormValue } from "./formOptionReader.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the settings panel ───────────────────────────────────────────────────────
// What:  the primitive behind the admin guide's settings modals (post-launch plan
//        item 9): one modal that shows a command's switches and choices as they
//        stand now, and turns what the admin submits into the command runs that
//        change exactly what differs.
// Who:   adminCommandLauncher builds the modal and reads the submit; settingsPanels
//        declares what each command's panel holds. Pure apart from the discord.js
//        builders, so its tests need no client.
// Why not the plan's button table: a modal cannot hold a button, and a message of
//        buttons carries Discord's Dismiss link, which item 9 exists to remove. The
//        owner chose a real modal (2026-10-25): a checkbox group stands in for the
//        switches, a radio group for a choice, role and channel selects for a list.
// How:   ① buildSettingsModal draws each control with its current value preset;
//        ② readSettingsPanel reads the submit back into one answer per control;
//        ③ planSettingsChanges compares each answer with the current value and
//        returns the command leaves to run, nothing for a control left as it was.
//        The leaves are the slash command's own subcommands, so a saved setting goes
//        through the one handler that already validates, writes and audits it.

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;
// Discord's ceiling on a label's description and an option's description.
const MAX_DESCRIPTION_LENGTH = 100;
const INTEGER_PATTERN = /^-?\d+$/;

/** One run of a command leaf that a changed setting asks for: the leaf's path and the option values it reads. */
export interface LeafCall {
	path: string;
	values: ReadonlyMap<string, FormValue>;
}

/** One switch in a checkbox group: checked means on. */
export interface PanelSwitch {
	value: string;
	label: string;
	description?: string;
	on: boolean;
	callsFor(on: boolean): LeafCall[];
}

interface ControlBase {
	/** The component's customId, unique within its panel. */
	id: string;
	label: string;
	description: string;
}

/** Several on or off settings as one checkbox group. */
export interface SwitchesControl extends ControlBase {
	kind: "switches";
	switches: readonly PanelSwitch[];
}

/** One setting with a fixed list of values, as a radio group. */
export interface ChoiceControl extends ControlBase {
	kind: "choice";
	choices: readonly OptionChoice[];
	current: string;
	callsFor(value: string): LeafCall[];
}

/** A list of roles or channels, as a multi select preset to the list. `current` holds only what Discord can still show. */
export interface PickControl extends ControlBase {
	kind: "roles" | "channels";
	channelTypes?: readonly ChannelType[];
	current: ReadonlyMap<string, FormValue>;
	callsFor(change: { added: FormValue[]; removed: FormValue[] }): LeafCall[];
}

/** One whole number, as a text field holding its current value. */
export interface NumberControl extends ControlBase {
	kind: "number";
	current: number;
	min: number;
	max: number;
	callsFor(value: number): LeafCall[];
}

export type PanelControl = SwitchesControl | ChoiceControl | PickControl | NumberControl;

/** One command's settings as they stand now. */
export interface SettingsPanel {
	title: string;
	controls: readonly PanelControl[];
}

/** What the admin submitted for one control. */
export type PanelAnswer =
	| { kind: "switches"; on: ReadonlySet<string> }
	| { kind: "choice"; value: string }
	| { kind: "pick"; chosen: ReadonlyMap<string, FormValue> }
	| { kind: "number"; value: number };

export type PanelReadResult = { ok: true; answers: Map<string, PanelAnswer> } | { ok: false; problem: string };

/** The slice of a modal submit's fields the reader uses. A ModalSubmitFields fits it. */
export type PanelFieldsSource = Pick<ModalSubmitFields, "fields" | "getCheckboxGroup" | "getRadioGroup" | "getSelectedRoles" | "getSelectedChannels" | "getTextInputValue">;

// ── what a modal can show ────────────────────────────────────────────────────

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

// A control Discord would refuse is left out of the modal rather than sinking the
// whole modal: a checkbox group holds 1 to 10 options, a select presets at most 25,
// and a choice needs two values to be one. A control left out has no answer, so
// nothing is planned for it and its subcommand still changes it.
function isShowable(control: PanelControl): boolean {
	switch (control.kind) {
		case "switches":
			return control.switches.length > 0 && control.switches.length <= LIMITS.MAX_CHECKBOX_OPTIONS;
		case "choice":
			return control.choices.length >= 2 && control.choices.length <= LIMITS.MAX_RADIO_OPTIONS;
		case "roles":
		case "channels":
			return control.current.size <= LIMITS.MAX_SELECT_OPTIONS;
		case "number":
			return true;
	}
}

/** The controls a panel's modal shows: the showable ones, at most a modal's five. */
export function shownControls(panel: SettingsPanel): PanelControl[] {
	return panel.controls.filter(isShowable).slice(0, LIMITS.MAX_MODAL_FIELDS);
}

// ── ① the modal ──────────────────────────────────────────────────────────────

function switchesGroup(control: SwitchesControl): CheckboxGroupBuilder {
	const options = control.switches.map((entry) => {
		const option = new CheckboxGroupOptionBuilder().setValue(entry.value).setLabel(clip(entry.label, LIMITS.MAX_SELECT_LABEL_LENGTH)).setDefault(entry.on);
		if (entry.description) option.setDescription(clip(entry.description, MAX_DESCRIPTION_LENGTH));
		return option;
	});
	// Not required and no minimum: turning every switch off is a real answer.
	return new CheckboxGroupBuilder().setCustomId(control.id).setRequired(false).setMinValues(0).setMaxValues(options.length).addOptions(options);
}

function choiceGroup(control: ChoiceControl): RadioGroupBuilder {
	const options = control.choices.map((choice) =>
		new RadioGroupOptionBuilder().setValue(choice.value).setLabel(clip(choice.name, LIMITS.MAX_SELECT_LABEL_LENGTH)).setDefault(choice.value === control.current)
	);
	return new RadioGroupBuilder().setCustomId(control.id).setRequired(true).addOptions(options);
}

function controlLabel(control: PanelControl): LabelBuilder {
	const label = new LabelBuilder().setLabel(clip(control.label, LIMITS.MAX_LABEL_LENGTH)).setDescription(clip(control.description, MAX_DESCRIPTION_LENGTH));
	switch (control.kind) {
		case "switches":
			return label.setCheckboxGroupComponent(switchesGroup(control));
		case "choice":
			return label.setRadioGroupComponent(choiceGroup(control));
		case "roles":
			return label.setRoleSelectMenuComponent(
				new RoleSelectMenuBuilder()
					.setCustomId(control.id)
					.setRequired(false)
					.setMinValues(0)
					.setMaxValues(LIMITS.MAX_SELECT_OPTIONS)
					.setDefaultRoles(...control.current.keys())
			);
		case "channels": {
			const select = new ChannelSelectMenuBuilder()
				.setCustomId(control.id)
				.setRequired(false)
				.setMinValues(0)
				.setMaxValues(LIMITS.MAX_SELECT_OPTIONS)
				.setDefaultChannels(...control.current.keys());
			if (control.channelTypes) select.setChannelTypes(...control.channelTypes);
			return label.setChannelSelectMenuComponent(select);
		}
		case "number":
			return label.setTextInputComponent(
				new TextInputBuilder()
					.setCustomId(control.id)
					.setStyle(TextInputStyle.Short)
					.setRequired(true)
					.setValue(String(control.current))
					.setPlaceholder(commandButtonsCopy.launcher.rangeHint(control.min, control.max))
			);
	}
}

/** The panel's modal, every shown control preset to the value it holds now. */
export function buildSettingsModal(customId: string, panel: SettingsPanel): ModalBuilder {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(clip(panel.title, LIMITS.MAX_MODAL_TITLE_LENGTH))
		.addLabelComponents(shownControls(panel).map(controlLabel));
}

// ── ② reading the submit ─────────────────────────────────────────────────────

const has = (source: PanelFieldsSource, id: string): boolean => source.fields.has(id);

function readPick(source: PanelFieldsSource, control: PickControl): Map<string, FormValue> {
	const chosen = new Map<string, FormValue>();
	if (control.kind === "roles") {
		// discord.js types a resolved entry as possibly null; a null one names nothing to keep.
		for (const role of source.getSelectedRoles(control.id)?.values() ?? []) if (role) chosen.set(role.id, { kind: "role", value: role });
		return chosen;
	}
	for (const channel of source.getSelectedChannels(control.id)?.values() ?? []) if (channel) chosen.set(channel.id, { kind: "channel", value: channel });
	return chosen;
}

/**
 * The admin's answer for every shown control the submit carries, or the one problem
 * to tell them. A text field cannot carry an integer's bounds, so the number is
 * checked here the way the slash command's client would have checked it.
 */
export function readSettingsPanel(source: PanelFieldsSource, panel: SettingsPanel): PanelReadResult {
	const answers = new Map<string, PanelAnswer>();
	const problems = commandButtonsCopy.problems;
	for (const control of shownControls(panel)) {
		if (!has(source, control.id)) continue;
		switch (control.kind) {
			case "switches":
				answers.set(control.id, { kind: "switches", on: new Set(source.getCheckboxGroup(control.id)) });
				break;
			case "choice": {
				const value = source.getRadioGroup(control.id);
				// A value outside the list is user input that no radio group offered;
				// it is ignored rather than written, the way the slash command's fixed
				// choices would never have sent it.
				if (value !== null && control.choices.some((choice) => choice.value === value)) answers.set(control.id, { kind: "choice", value });
				break;
			}
			case "roles":
			case "channels":
				answers.set(control.id, { kind: "pick", chosen: readPick(source, control) });
				break;
			case "number": {
				const raw = source.getTextInputValue(control.id).trim();
				if (!INTEGER_PATTERN.test(raw)) return { ok: false, problem: problems.notWholeNumber(control.label) };
				const value = Number(raw);
				if (value < control.min || value > control.max) {
					return { ok: false, problem: problems.outOfRange(control.label, commandButtonsCopy.launcher.rangeHint(control.min, control.max)) };
				}
				answers.set(control.id, { kind: "number", value });
				break;
			}
		}
	}
	return { ok: true, answers };
}

// ── ③ what to run ────────────────────────────────────────────────────────────

function pickChange(control: PickControl, chosen: ReadonlyMap<string, FormValue>): { added: FormValue[]; removed: FormValue[] } {
	const added = [...chosen].filter(([id]) => !control.current.has(id)).map(([, value]) => value);
	const removed = [...control.current].filter(([id]) => !chosen.has(id)).map(([, value]) => value);
	return { added, removed };
}

function callsForControl(control: PanelControl, answer: PanelAnswer): LeafCall[] {
	if (control.kind === "switches" && answer.kind === "switches") {
		return control.switches.flatMap((entry) => (answer.on.has(entry.value) === entry.on ? [] : entry.callsFor(answer.on.has(entry.value))));
	}
	if (control.kind === "choice" && answer.kind === "choice") return answer.value === control.current ? [] : control.callsFor(answer.value);
	if ((control.kind === "roles" || control.kind === "channels") && answer.kind === "pick") {
		const change = pickChange(control, answer.chosen);
		return change.added.length + change.removed.length === 0 ? [] : control.callsFor(change);
	}
	if (control.kind === "number" && answer.kind === "number") return answer.value === control.current ? [] : control.callsFor(answer.value);
	return [];
}

/**
 * The command leaves to run, in the panel's control order, for every answer that
 * differs from the value the control holds now. Compared against the CURRENT panel
 * (reloaded at submit), so a setting someone else changed while the modal was open
 * is only written when this admin chose differently from what is stored.
 */
export function planSettingsChanges(panel: SettingsPanel, answers: ReadonlyMap<string, PanelAnswer>): LeafCall[] {
	return shownControls(panel).flatMap((control) => {
		const answer = answers.get(control.id);
		return answer ? callsForControl(control, answer) : [];
	});
}
