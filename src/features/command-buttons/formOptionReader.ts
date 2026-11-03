import type { User } from "discord.js";
import type { CommandOptionReader, ResolvedChannel, ResolvedRole } from "@handlers/commandOptions.js";

// ── the form's option reader ─────────────────────────────────────────────────
// What:  answers a command handler's option reads from a submitted admin form,
//        the way interaction.options answers them for the slash command.
// Who:   adminCommandLauncher builds one per run and hands it to the command's
//        shared `run`, which cannot tell which door it was opened from.
// How:   the values arrive tagged by kind, so each read returns only a value of
//        the kind it asks for. A required read of a missing option throws, as
//        discord.js's resolver does; the form validates required fields first, so
//        reaching that throw means a handler asked for an option its leaf lacks.

/** One answered field, tagged by what it holds. Integer and number options are both numbers. */
export type FormValue =
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "boolean"; value: boolean }
	| { kind: "user"; value: User }
	| { kind: "role"; value: ResolvedRole }
	| { kind: "channel"; value: ResolvedChannel };

/** Which leaf the form ran: its subcommand and its group, null where the command has none. */
export interface FormLeafPosition {
	subcommand: string | null;
	group: string | null;
}

function missing(name: string): Error {
	return new Error(`[command-form] a handler required the option "${name}", which the submitted form did not hold`);
}

export class FormOptionReader implements CommandOptionReader {
	constructor(
		private readonly leaf: FormLeafPosition,
		private readonly values: ReadonlyMap<string, FormValue>
	) {}

	getSubcommand(required?: true): string;
	getSubcommand(required: boolean): string | null;
	getSubcommand(required = true): string | null {
		if (this.leaf.subcommand === null && required) throw missing("subcommand");
		return this.leaf.subcommand;
	}

	getSubcommandGroup(required: true): string;
	getSubcommandGroup(required?: boolean): string | null;
	getSubcommandGroup(required = false): string | null {
		if (this.leaf.group === null && required) throw missing("subcommand group");
		return this.leaf.group;
	}

	getString(name: string, required: true): string;
	getString(name: string, required?: boolean): string | null;
	getString(name: string, required = false): string | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "string" ? entry.value : null, required);
	}

	getInteger(name: string, required: true): number;
	getInteger(name: string, required?: boolean): number | null;
	getInteger(name: string, required = false): number | null {
		return this.readNumber(name, required);
	}

	getNumber(name: string, required: true): number;
	getNumber(name: string, required?: boolean): number | null;
	getNumber(name: string, required = false): number | null {
		return this.readNumber(name, required);
	}

	getBoolean(name: string, required: true): boolean;
	getBoolean(name: string, required?: boolean): boolean | null;
	getBoolean(name: string, required = false): boolean | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "boolean" ? entry.value : null, required);
	}

	getUser(name: string, required: true): User;
	getUser(name: string, required?: boolean): User | null;
	getUser(name: string, required = false): User | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "user" ? entry.value : null, required);
	}

	getRole(name: string, required: true): ResolvedRole;
	getRole(name: string, required?: boolean): ResolvedRole | null;
	getRole(name: string, required = false): ResolvedRole | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "role" ? entry.value : null, required);
	}

	getChannel(name: string, required: true): ResolvedChannel;
	getChannel(name: string, required?: boolean): ResolvedChannel | null;
	getChannel(name: string, required = false): ResolvedChannel | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "channel" ? entry.value : null, required);
	}

	private readNumber(name: string, required: boolean): number | null {
		const entry = this.values.get(name);
		return this.settle(name, entry?.kind === "number" ? entry.value : null, required);
	}

	private settle<T>(name: string, value: T | null, required: boolean): T | null {
		if (value === null && required) throw missing(name);
		return value;
	}
}
