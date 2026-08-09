import type { ChatInputCommandInteraction } from "discord.js";
import { respondWithFortune } from "@features/fortune/respondWithFortune.js";

// ── /mini-game fortune ─────────────────────────────────────────────────────
// What:  a thin adapter, nothing more. It reads the two options off the fortune
//        subcommand and hands them to respondWithFortune, which already owns the
//        kill switch, the cooldown, the luck buff read, the tier roll, the orb
//        attachment, and the mention safety.
// Who:   MINI_GAME_HANDLERS in src/commands/fun/mini-game.ts. The
//        #command-center Summon Dero card's Fortune button does NOT come through
//        here, it calls respondWithFortune directly from PowerUps.ts and is
//        untouched by the command merge.
// When:  every /mini-game fortune invocation.
// Where: this file exists so the dispatch table has four entries of one uniform
//        shape and the command file reads no options of its own. It replaces the
//        30 line src/commands/fun/fortune.ts, whose body this is, and carries no
//        fortune logic itself.
// How:   both options are optional, matching the shipped /fortune contract
//        exactly. `private` defaults to false (public reading) when omitted, so a
//        member who typed /fortune yesterday gets an identical result today.
//
// NOTE for Phase 5: deleting src/commands/fun/fortune.ts is what retires the old
// /fortune name. No deregistration call is needed, deploy-commands.ts PUTs the
// whole command set and a PUT replaces rather than merges. FortuneBuff rows are
// keyed by userId with no command name in the schema, so there is no migration.
export async function runFortune(interaction: ChatInputCommandInteraction): Promise<void> {
	const question = interaction.options.getString("question", false);
	const isPrivate = interaction.options.getBoolean("private", false) ?? false;
	await respondWithFortune(interaction, { question, isPrivate });
}
