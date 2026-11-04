import {
	ApplicationCommandOptionType,
	ChannelSelectMenuBuilder,
	ComponentType,
	LabelBuilder,
	ModalBuilder,
	RoleSelectMenuBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
	type APIApplicationCommandOption,
	type ChannelType,
	type ModalSubmitFields,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { BOT_CONSTANTS } from "@base/constants/BOT_CONSTANTS.js";
import type { OptionChoice } from "@handlers/commandOptions.js";
import type { FormValue } from "./formOptionReader.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the admin command form ───────────────────────────────────────────────────
// What:  turns a slash command's OWN builder into the form an admin button opens:
//        the list of things the command can do (its subcommands, under any group),
//        a modal field per option, and the reading of that modal back into values.
// Who:   adminCommandLauncher, the only caller. Pure apart from the discord.js
//        builders, so its tests need no client.
// Why:   reading the command's registered shape, rather than declaring each form by
//        hand, means a button can never ask for an option the command lacks or miss
//        one it has: the form and the command are one definition.
// How:   ① listLeaves walks the command JSON into leaves; ② buildForm makes one
//        modal label per option, a select wherever the option has fixed or
//        provided picks and a text field otherwise; ③ readForm validates what came
//        back the way Discord validates a slash command's options, because a modal
//        field cannot carry an integer's bounds.

const LIMITS = BOT_CONSTANTS.DISCORD_LIMITS;
// Discord's ceiling on a label's description and a text field's placeholder.
const MAX_DESCRIPTION_LENGTH = 100;
// A string option allowing more than this many characters gets a paragraph field.
const SHORT_TEXT_MAX_LENGTH = 100;
const INTEGER_PATTERN = /^-?\d+$/;

export type FormFieldType = "string" | "integer" | "number" | "boolean" | "user" | "role" | "channel";

/** One option of one leaf, as the form needs it. */
export interface FormField {
	name: string;
	description: string;
	type: FormFieldType;
	required: boolean;
	/** The option's own fixed choices, or null. */
	choices: OptionChoice[] | null;
	/** Whether the slash command autocompletes it, so the command may provide picks. */
	autocomplete: boolean;
	minValue: number | null;
	maxValue: number | null;
	minLength: number | null;
	maxLength: number | null;
	channelTypes: ChannelType[] | null;
}

/** One thing a command can do: a subcommand, a subcommand under a group, or the bare command. */
export interface CommandLeaf {
	/** "pause", "role add" under a group, or "" for a command with no subcommands. */
	path: string;
	subcommand: string | null;
	group: string | null;
	description: string;
	fields: FormField[];
}

/** What came back from a submitted form: the values, or the one problem to tell the admin. */
export type FormReadResult = { ok: true; values: Map<string, FormValue> } | { ok: false; problem: string };

/** The slice of a modal submit's fields the reader uses. A ModalSubmitFields fits it. */
export type FormFieldsSource = Pick<
	ModalSubmitFields,
	"fields" | "getTextInputValue" | "getStringSelectValues" | "getSelectedUsers" | "getSelectedRoles" | "getSelectedChannels"
>;

const FIELD_TYPES: Partial<Record<ApplicationCommandOptionType, FormFieldType>> = {
	[ApplicationCommandOptionType.String]: "string",
	[ApplicationCommandOptionType.Integer]: "integer",
	[ApplicationCommandOptionType.Number]: "number",
	[ApplicationCommandOptionType.Boolean]: "boolean",
	[ApplicationCommandOptionType.User]: "user",
	[ApplicationCommandOptionType.Role]: "role",
	[ApplicationCommandOptionType.Channel]: "channel",
};

// ── ① the leaves ─────────────────────────────────────────────────────────────

function toField(option: APIApplicationCommandOption, commandName: string): FormField {
	const type = FIELD_TYPES[option.type];
	// A mentionable or an attachment has no modal field to stand for it. No admin
	// command takes one today; the launcher test walks every admin command, so a
	// future one fails there rather than at an admin's click.
	if (!type) throw new Error(`[command-form] /${commandName} option "${option.name}" has type ${option.type}, which no form field can hold`);
	const shape = option as {
		required?: boolean;
		choices?: Array<{ name: string; value: string | number }>;
		autocomplete?: boolean;
		min_value?: number;
		max_value?: number;
		min_length?: number;
		max_length?: number;
		channel_types?: ChannelType[];
	};
	return {
		name: option.name,
		description: option.description,
		type,
		required: shape.required === true,
		choices: shape.choices ? shape.choices.map((choice) => ({ name: choice.name, value: String(choice.value) })) : null,
		autocomplete: shape.autocomplete === true,
		minValue: shape.min_value ?? null,
		maxValue: shape.max_value ?? null,
		minLength: shape.min_length ?? null,
		maxLength: shape.max_length ?? null,
		channelTypes: shape.channel_types ?? null,
	};
}

function isSubcommand(option: APIApplicationCommandOption): boolean {
	return option.type === ApplicationCommandOptionType.Subcommand;
}

function isGroup(option: APIApplicationCommandOption): boolean {
	return option.type === ApplicationCommandOptionType.SubcommandGroup;
}

function leafOf(option: APIApplicationCommandOption, group: string | null, commandName: string): CommandLeaf {
	const nested = (option as { options?: APIApplicationCommandOption[] }).options ?? [];
	return {
		path: group ? `${group} ${option.name}` : option.name,
		subcommand: option.name,
		group,
		description: option.description,
		fields: nested.map((child) => toField(child, commandName)),
	};
}

/** Every leaf a command can run, in the order the command declares them. */
export function listLeaves(json: RESTPostAPIChatInputApplicationCommandsJSONBody): CommandLeaf[] {
	const options = json.options ?? [];
	const hasSubcommands = options.some((option) => isSubcommand(option) || isGroup(option));
	if (!hasSubcommands) {
		return [{ path: "", subcommand: null, group: null, description: json.description, fields: options.map((option) => toField(option, json.name)) }];
	}
	return options.flatMap((option) => {
		if (isSubcommand(option)) return [leafOf(option, null, json.name)];
		const children = (option as { options?: APIApplicationCommandOption[] }).options ?? [];
		return children.map((child) => leafOf(child, option.name, json.name));
	});
}

/** The leaf a path names, or null for a path from an older deploy. */
export function findLeaf(leaves: readonly CommandLeaf[], path: string): CommandLeaf | null {
	return leaves.find((leaf) => leaf.path === path) ?? null;
}

// ── ② the modal ──────────────────────────────────────────────────────────────

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

function choiceSelect(field: FormField, choices: readonly OptionChoice[]): StringSelectMenuBuilder {
	const options = choices.slice(0, LIMITS.MAX_SELECT_OPTIONS).map((choice) => ({
		label: clip(choice.name, LIMITS.MAX_SELECT_LABEL_LENGTH),
		value: choice.value,
	}));
	return new StringSelectMenuBuilder()
		.setCustomId(field.name)
		.setRequired(field.required)
		.setMinValues(field.required ? 1 : 0)
		.setMaxValues(1)
		.addOptions(options);
}

function textInput(field: FormField): TextInputBuilder {
	const isNumeric = field.type === "integer" || field.type === "number";
	const input = new TextInputBuilder()
		.setCustomId(field.name)
		.setStyle(!isNumeric && (field.maxLength ?? 0) > SHORT_TEXT_MAX_LENGTH ? TextInputStyle.Paragraph : TextInputStyle.Short)
		.setRequired(field.required);
	if (field.minLength !== null) input.setMinLength(field.minLength);
	if (field.maxLength !== null) input.setMaxLength(field.maxLength);
	if (isNumeric) input.setPlaceholder(commandButtonsCopy.launcher.rangeHint(field.minValue, field.maxValue));
	return input;
}

function fieldLabel(field: FormField, picks: readonly OptionChoice[] | undefined): LabelBuilder {
	const label = new LabelBuilder()
		.setLabel(clip(field.name, LIMITS.MAX_LABEL_LENGTH))
		.setDescription(clip(field.description, MAX_DESCRIPTION_LENGTH));
	const yesNo: OptionChoice[] = [
		{ name: commandButtonsCopy.launcher.yes, value: "true" },
		{ name: commandButtonsCopy.launcher.no, value: "false" },
	];
	switch (field.type) {
		case "boolean":
			return label.setStringSelectMenuComponent(choiceSelect(field, yesNo));
		case "user":
			return label.setUserSelectMenuComponent(
				new UserSelectMenuBuilder().setCustomId(field.name).setRequired(field.required).setMinValues(field.required ? 1 : 0).setMaxValues(1)
			);
		case "role":
			return label.setRoleSelectMenuComponent(
				new RoleSelectMenuBuilder().setCustomId(field.name).setRequired(field.required).setMinValues(field.required ? 1 : 0).setMaxValues(1)
			);
		case "channel": {
			const select = new ChannelSelectMenuBuilder().setCustomId(field.name).setRequired(field.required).setMinValues(field.required ? 1 : 0).setMaxValues(1);
			if (field.channelTypes) select.setChannelTypes(...field.channelTypes);
			return label.setChannelSelectMenuComponent(select);
		}
		default: {
			const fixed = field.choices ?? picks;
			return fixed ? label.setStringSelectMenuComponent(choiceSelect(field, fixed)) : label.setTextInputComponent(textInput(field));
		}
	}
}

/**
 * The modal for one leaf. `fields` is the subset to show, at most five, and `picks`
 * holds what the command provided for its autocompleted options; an option with no
 * entry there stays a typed field.
 */
export function buildForm(params: {
	customId: string;
	commandName: string;
	leaf: CommandLeaf;
	fields: readonly FormField[];
	picks: ReadonlyMap<string, readonly OptionChoice[]>;
}): ModalBuilder {
	const title = clip(`/${params.commandName} ${params.leaf.path}`.trim(), LIMITS.MAX_MODAL_TITLE_LENGTH);
	return new ModalBuilder()
		.setCustomId(params.customId)
		.setTitle(title)
		.addLabelComponents(...params.fields.map((field) => fieldLabel(field, params.picks.get(field.name))));
}

// ── ③ reading it back ────────────────────────────────────────────────────────

const has = (source: FormFieldsSource, name: string): boolean => source.fields.has(name);

function readText(source: FormFieldsSource, name: string): string | null {
	if (!has(source, name)) return null;
	const value = source.getTextInputValue(name).trim();
	return value.length > 0 ? value : null;
}

function readPick(source: FormFieldsSource, name: string): string | null {
	if (!has(source, name)) return null;
	const [value] = source.getStringSelectValues(name);
	return value ?? null;
}

// A string or number option comes back as typed text or as a select's pick. discord.js's
// ModalSubmitFields throws ModalSubmitInteractionFieldNotFound when a select is read as a
// text input, rather than answering null, so trying text first fails the whole Submit
// (2026-11 item 289). The submitted component decides, never the FormField, because an
// autocompleted option is a select only when its command provided picks for this form.
function readTextOrPick(source: FormFieldsSource, name: string): string | null {
	const submitted = source.fields.get(name);
	if (!submitted) return null;
	return submitted.type === ComponentType.StringSelect ? readPick(source, name) : readText(source, name);
}

function inRange(field: FormField, value: number): boolean {
	if (field.minValue !== null && value < field.minValue) return false;
	return field.maxValue === null || value <= field.maxValue;
}

function readNumber(field: FormField, raw: string): { ok: true; value: FormValue } | { ok: false; problem: string } {
	const problems = commandButtonsCopy.problems;
	if (field.type === "integer" && !INTEGER_PATTERN.test(raw)) return { ok: false, problem: problems.notWholeNumber(field.name) };
	const value = Number(raw);
	if (!Number.isFinite(value)) return { ok: false, problem: problems.notNumber(field.name) };
	if (!inRange(field, value)) {
		return { ok: false, problem: problems.outOfRange(field.name, commandButtonsCopy.launcher.rangeHint(field.minValue, field.maxValue)) };
	}
	return { ok: true, value: { kind: "number", value } };
}

// One field's value, null when it was left empty. Entities come back resolved by
// Discord exactly as a slash command's options do.
function readField(source: FormFieldsSource, field: FormField): { ok: true; value: FormValue | null } | { ok: false; problem: string } {
	switch (field.type) {
		case "boolean": {
			const pick = readPick(source, field.name);
			return { ok: true, value: pick === null ? null : { kind: "boolean", value: pick === "true" } };
		}
		case "user": {
			const user = has(source, field.name) ? source.getSelectedUsers(field.name)?.first() : undefined;
			return { ok: true, value: user ? { kind: "user", value: user } : null };
		}
		case "role": {
			const role = has(source, field.name) ? source.getSelectedRoles(field.name)?.first() : undefined;
			return { ok: true, value: role ? { kind: "role", value: role } : null };
		}
		case "channel": {
			const channel = has(source, field.name) ? source.getSelectedChannels(field.name)?.first() : undefined;
			return { ok: true, value: channel ? { kind: "channel", value: channel } : null };
		}
		case "integer":
		case "number": {
			const raw = readTextOrPick(source, field.name);
			return raw === null ? { ok: true, value: null } : readNumber(field, raw);
		}
		default: {
			// Only a boolean is always a select; a string may be either, so it reads by what came back.
			const value = readTextOrPick(source, field.name);
			return { ok: true, value: value === null ? null : { kind: "string", value } };
		}
	}
}

/** Read every shown field back into values, or name the first problem. */
export function readForm(source: FormFieldsSource, fields: readonly FormField[]): FormReadResult {
	const values = new Map<string, FormValue>();
	for (const field of fields) {
		const read = readField(source, field);
		if (!read.ok) return read;
		if (read.value === null) {
			// Discord enforces a required field before the submit arrives; this is the
			// gate for a field it could not enforce (a whitespace only text answer).
			if (field.required) return { ok: false, problem: commandButtonsCopy.problems.missing(field.name) };
			continue;
		}
		values.set(field.name, read.value);
	}
	return { ok: true, values };
}
