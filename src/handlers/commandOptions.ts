import type { CommandInteractionOption, Guild, RepliableInteraction, User } from "discord.js";

// ── command options ──────────────────────────────────────────────────
// What:  the option reads a command handler makes, as ONE type that a slash
//        command's own resolver and the admin command form both satisfy.
// Who:   every handler a button shares with its slash command (2026-10 item 245
//        Phase 4b). The slash command passes interaction.options; the admin
//        command launcher passes a FormOptionReader built from its modal.
// Why:   a modal submit or a button press carries no option resolver, and
//        discord.js keeps its resolver's constructor private, so a handler that
//        read interaction.options could only ever run from a slash command. Reading
//        through this type instead is what lets one handler serve both doors.
// How:   the overloads mirror discord.js's own (required true returns the value,
//        anything else returns the value or null), and the entity types are the
//        resolver's, so interaction.options is assignable to this as it stands.

/** A channel option's value, as discord.js resolves it for a slash command and a modal alike. */
export type ResolvedChannel = NonNullable<CommandInteractionOption["channel"]>;
/** A role option's value, as discord.js resolves it for a slash command and a modal alike. */
export type ResolvedRole = NonNullable<CommandInteractionOption["role"]>;

export interface CommandOptionReader {
	getSubcommand(required?: true): string;
	getSubcommand(required: boolean): string | null;
	getSubcommandGroup(required: true): string;
	getSubcommandGroup(required?: boolean): string | null;
	getString(name: string, required: true): string;
	getString(name: string, required?: boolean): string | null;
	getInteger(name: string, required: true): number;
	getInteger(name: string, required?: boolean): number | null;
	getNumber(name: string, required: true): number;
	getNumber(name: string, required?: boolean): number | null;
	getBoolean(name: string, required: true): boolean;
	getBoolean(name: string, required?: boolean): boolean | null;
	getUser(name: string, required: true): User;
	getUser(name: string, required?: boolean): User | null;
	getRole(name: string, required: true): ResolvedRole;
	getRole(name: string, required?: boolean): ResolvedRole | null;
	getChannel(name: string, required: true): ResolvedChannel;
	getChannel(name: string, required?: boolean): ResolvedChannel | null;
}

/**
 * A handler a slash command and a button share. It reads every option through
 * the reader and replies through the interaction, so it runs the same from a
 * slash command, a button, a select or a modal submit.
 */
export type SharedCommandHandler = (interaction: RepliableInteraction, options: CommandOptionReader) => Promise<void>;

/** One pickable value for a string option: the label shown and the value the handler reads. */
export interface OptionChoice {
	name: string;
	value: string;
}

/**
 * The picks an option offers inside the admin command form, where Discord has no
 * autocomplete. `leafPath` names the subcommand ("pause", or "role add" under a
 * group, or "" for a command with none). Returning null keeps the option a typed
 * field; returning a list, even an empty one, makes it a select of exactly those.
 */
export type FormChoicesProvider = (guild: Guild, leafPath: string, optionName: string) => Promise<OptionChoice[] | null>;
