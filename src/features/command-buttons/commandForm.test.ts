import { describe, it, expect } from "vitest";
import { ChannelType, ComponentType, SlashCommandBuilder, type User } from "discord.js";
import { buildForm, listLeaves, readForm, type FormFieldsSource } from "./commandForm.js";
import { FormOptionReader, type FormValue } from "./formOptionReader.js";
import { commandButtonsCopy } from "./commandButtonsCopy.js";

// ── the admin command form ───────────────────────────────────────────────────
// The form is read off a command's own builder, so these pin the three halves on
// a builder made here: the leaves it finds (bare, subcommand, grouped), the field
// each option type becomes, and the reading back, which has to hold a typed number
// to the bounds the slash command's client would have enforced.

const sample = new SlashCommandBuilder()
	.setName("sample")
	.setDescription("A sample command")
	.addSubcommand((sub) =>
		sub
			.setName("tune")
			.setDescription("Tune it")
			.addIntegerOption((option) => option.setName("count").setDescription("How many").setRequired(true).setMinValue(1).setMaxValue(9))
			.addBooleanOption((option) => option.setName("loud").setDescription("Loud or not"))
			.addStringOption((option) =>
				option.setName("mode").setDescription("Which mode").addChoices({ name: "Fast", value: "fast" }, { name: "Slow", value: "slow" })
			)
			.addChannelOption((option) => option.setName("where").setDescription("Where").addChannelTypes(ChannelType.GuildText))
			.addStringOption((option) => option.setName("note").setDescription("A note").setMaxLength(500))
	)
	.addSubcommandGroup((group) =>
		group
			.setName("role")
			.setDescription("Roles")
			.addSubcommand((sub) =>
				sub.setName("add").setDescription("Add a role").addRoleOption((option) => option.setName("role").setDescription("The role").setRequired(true))
			)
	);

const bare = new SlashCommandBuilder()
	.setName("bare")
	.setDescription("No subcommands")
	.addUserOption((option) => option.setName("member").setDescription("Who").setRequired(true));

function source(answers: Record<string, string | string[]>): FormFieldsSource {
	return {
		fields: new Map(Object.keys(answers).map((name) => [name, {}])),
		getTextInputValue: (name: string) => String(answers[name] ?? ""),
		getStringSelectValues: (name: string) => (Array.isArray(answers[name]) ? (answers[name] as string[]) : []),
		getSelectedUsers: () => null,
		getSelectedRoles: () => null,
		getSelectedChannels: () => null,
	} as unknown as FormFieldsSource;
}

describe("listLeaves", () => {
	it("finds every subcommand, a grouped one by its full path", () => {
		expect(listLeaves(sample.toJSON()).map((leaf) => [leaf.path, leaf.group, leaf.subcommand])).toEqual([
			["tune", null, "tune"],
			["role add", "role", "add"],
		]);
	});

	it("treats a command with no subcommands as one leaf with an empty path", () => {
		const [leaf] = listLeaves(bare.toJSON());
		expect(leaf).toMatchObject({ path: "", subcommand: null, group: null });
		expect(leaf?.fields.map((field) => [field.name, field.type, field.required])).toEqual([["member", "user", true]]);
	});

	it("keeps each option's bounds, choices and channel types", () => {
		const [tune] = listLeaves(sample.toJSON());
		const byName = new Map(tune?.fields.map((field) => [field.name, field]));
		expect(byName.get("count")).toMatchObject({ type: "integer", minValue: 1, maxValue: 9, required: true });
		expect(byName.get("mode")?.choices).toEqual([
			{ name: "Fast", value: "fast" },
			{ name: "Slow", value: "slow" },
		]);
		expect(byName.get("where")?.channelTypes).toEqual([ChannelType.GuildText]);
	});
});

describe("buildForm", () => {
	it("gives each option the field its type needs", () => {
		const [tune] = listLeaves(sample.toJSON());
		const modal = buildForm({ customId: "id", commandName: "sample", leaf: tune!, fields: tune!.fields, picks: new Map() }).toJSON();
		expect(modal.title).toBe("/sample tune");
		const kinds = (modal.components as Array<{ component: { type: number; custom_id: string } }>).map((label) => [label.component.custom_id, label.component.type]);
		expect(kinds).toEqual([
			["count", ComponentType.TextInput],
			["loud", ComponentType.StringSelect],
			["mode", ComponentType.StringSelect],
			["where", ComponentType.ChannelSelect],
			["note", ComponentType.TextInput],
		]);
	});

	it("turns provided picks into a select and leaves an option without them typed", () => {
		const autocompleted = new SlashCommandBuilder()
			.setName("pickers")
			.setDescription("Picks")
			.addStringOption((option) => option.setName("event").setDescription("Which event").setAutocomplete(true))
			.addStringOption((option) => option.setName("zone").setDescription("Which zone").setAutocomplete(true));
		const [leaf] = listLeaves(autocompleted.toJSON());
		const modal = buildForm({
			customId: "id",
			commandName: "pickers",
			leaf: leaf!,
			fields: leaf!.fields,
			picks: new Map([["event", [{ name: "Friday Stream", value: "evt-1" }]]]),
		}).toJSON();
		const [event, zone] = modal.components as Array<{ component: { type: number; options?: Array<{ value: string }> } }>;
		expect(event?.component.type).toBe(ComponentType.StringSelect);
		expect(event?.component.options?.map((option) => option.value)).toEqual(["evt-1"]);
		expect(zone?.component.type).toBe(ComponentType.TextInput);
	});
});

describe("readForm", () => {
	const [tune] = listLeaves(sample.toJSON());
	const fields = tune!.fields;

	it("reads each answer as its option's kind and skips what was left empty", () => {
		const read = readForm(source({ count: "3", loud: ["true"], mode: ["slow"], note: "  hello  " }), fields);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.values.get("count")).toEqual({ kind: "number", value: 3 });
		expect(read.values.get("loud")).toEqual({ kind: "boolean", value: true });
		expect(read.values.get("mode")).toEqual({ kind: "string", value: "slow" });
		expect(read.values.get("note")).toEqual({ kind: "string", value: "hello" });
		expect(read.values.has("where")).toBe(false);
	});

	it("refuses a whole number that is not one, or outside the bounds", () => {
		expect(readForm(source({ count: "2.5" }), fields)).toEqual({ ok: false, problem: commandButtonsCopy.problems.notWholeNumber("count") });
		expect(readForm(source({ count: "12" }), fields)).toEqual({ ok: false, problem: commandButtonsCopy.problems.outOfRange("count", "1 to 9") });
	});

	it("refuses a required field answered with nothing but spaces", () => {
		expect(readForm(source({ count: "   " }), fields)).toEqual({ ok: false, problem: commandButtonsCopy.problems.missing("count") });
	});
});

describe("FormOptionReader", () => {
	const member = { id: "u1" } as unknown as User;
	const reader = new FormOptionReader(
		{ subcommand: "add", group: "role" },
		new Map<string, FormValue>([
			["count", { kind: "number", value: 4 }],
			["member", { kind: "user", value: member }],
		])
	);

	it("answers the reads a handler makes, each only with a value of its own kind", () => {
		expect(reader.getSubcommand()).toBe("add");
		expect(reader.getSubcommandGroup()).toBe("role");
		expect(reader.getInteger("count", true)).toBe(4);
		expect(reader.getUser("member", true)).toBe(member);
		expect(reader.getString("count")).toBeNull();
		expect(reader.getBoolean("absent")).toBeNull();
	});

	it("throws on a required read of an option the form did not hold, as discord.js does", () => {
		expect(() => reader.getString("absent", true)).toThrow(/absent/);
		expect(() => new FormOptionReader({ subcommand: null, group: null }, new Map()).getSubcommand()).toThrow();
	});
});
