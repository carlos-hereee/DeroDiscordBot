import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { errorEmbed } from "@utils/embedBuilder.js";
import { gamesCopy } from "@features/games/gamesCopy.js";
import { fortuneCopy } from "@features/fortune/fortuneCopy.js";
import { runDuel } from "@features/games/duelHandler.js";
import { runRps } from "@features/games/rpsHandler.js";
import { runHangman } from "@features/games/hangmanHandler.js";
import { runFortune } from "@features/games/fortuneHandler.js";

// ── /mini-game ─────────────────────────────────────────────────────────────
// The single home for every Dero game. Four games ship as native Discord
// SUBCOMMANDS of one command rather than four separate slash commands, because
// four fun commands crowd a member's picker and bury the bot's real work.
// Typing /mini-game makes Discord's own picker render the game menu, with each
// game's description and its own typed options, at zero cost in bot code.
//
// Open to every member: deliberately NOT in BOT_CONSTANTS.ADMIN_COMMANDS and
// NOT in EARLY_ACCESS_FEATURES. Both of those gates key on
// interaction.commandName alone, which for any subcommand here resolves to the
// bare "mini-game", so listing this command would gate all four games at once,
// including fortune, which is already generally available to everyone. Gating
// one game would first need a composite `mini-game <subcommand>` gate key. Do
// not add this command to either set.
//
// /secret-code is deliberately NOT part of this command. Redeeming a code is a
// persistent account action that happens to buff the fortune subcommand, not a
// game, so it stays its own top level command at src/commands/fun/secret-code.ts.

// ── the command builder ────────────────────────────────────────────────────
// `data` is deliberately UNANNOTATED. Calling .addSubcommand() narrows the
// builder's type away from SlashCommandBuilder, so an explicit
// `: SlashCommandBuilder` annotation would not compile. Every command file in
// this repo already relies on inference for the same reason (the old fortune.ts
// narrows via .addStringOption()), and both loaders (main.ts' boot loop and
// deploy-commands.ts) only check that the string keys "data" and "execute"
// exist, so ICommand is documentary rather than enforced. If you are here to
// "fix" this: widen ICommand's data field to a union that admits the narrowed
// builder types. Never cast to any, and never cast to SlashCommandBuilder.
//
// The parent carries NO options of its own, because Discord forbids a command
// from holding both subcommands and top level options (and makes its bare form
// uninvokable). Every option below therefore lives inside its own subcommand,
// which is also why there is no shared `private` toggle: that flag belongs to
// fortune alone.
export const data = new SlashCommandBuilder()
	.setName("mini-game")
	.setDescription(gamesCopy.commandDescription)
	.addSubcommand((sub) =>
		sub
			.setName("duel")
			.setDescription(gamesCopy.duel.subcommandDescription)
			.addUserOption((option) =>
				option.setName("opponent").setDescription(gamesCopy.duel.opponentOptionDescription).setRequired(true)
			)
			.addStringOption((option) =>
				option
					.setName("flip")
					.setDescription(gamesCopy.duel.flipOptionDescription)
					.setRequired(true)
					// Choices, not free text, so Discord rejects anything else before the
					// interaction reaches the bot and the handler never hand validates it.
					.addChoices({ name: gamesCopy.duel.diceChoiceLabel, value: "dice" }, { name: gamesCopy.duel.coinChoiceLabel, value: "coin" })
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName("rps")
			.setDescription(gamesCopy.rps.subcommandDescription)
			.addUserOption((option) =>
				option.setName("opponent").setDescription(gamesCopy.rps.opponentOptionDescription).setRequired(true)
			)
	)
	.addSubcommand((sub) => sub.setName("hangman").setDescription(gamesCopy.hangman.subcommandDescription))
	.addSubcommand((sub) =>
		sub
			// The absorbed /fortune. Option names, types, requiredness, and the 200
			// character cap are copied verbatim from the shipped command, and the
			// descriptions are READ from fortuneCopy rather than retyped, so the two
			// cannot drift while both exist. A member who used /fortune yesterday must
			// get an identical experience here.
			.setName("fortune")
			.setDescription(fortuneCopy.commandDescription)
			.addStringOption((option) =>
				option
					.setName("question")
					.setDescription(fortuneCopy.questionOptionDescription)
					.setMaxLength(200)
					.setRequired(false)
			)
			.addBooleanOption((option) =>
				option.setName("private").setDescription(fortuneCopy.privateOptionDescription).setRequired(false)
			)
	);

// ── subcommand dispatch table ──────────────────────────────────────────────
// Mirrors POWERUP_ACTIONS in src/features/power-ups/PowerUps.ts on purpose: a
// reader who knows one knows the other, and adding a fifth game is ONE entry
// here plus one addSubcommand callback above, never a new switch arm and never
// a new slash command. Every handler takes the same signature and reads its own
// options off the interaction, which keeps each game's option contract
// colocated with the game that owns it.
//
// Keys MUST match the subcommand names declared in the builder. mini-game.test.ts
// asserts that both ways round, which is the guard that catches the obvious way
// to break this file while adding a game.
export const MINI_GAME_HANDLERS = {
	duel: runDuel,
	rps: runRps,
	hangman: runHangman,
	fortune: runFortune,
} as const satisfies Record<string, (interaction: ChatInputCommandInteraction) => Promise<void>>;

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	// Discord validates the subcommand name, the presence of required options,
	// and the flip choice value before this runs, so there is nothing to hand
	// validate here. This function routes and does nothing else: no option
	// reading, no cooldown checks, no embeds, no state maps. Business logic lives
	// in src/features/games/.
	const subcommand = interaction.options.getSubcommand();
	const handler = MINI_GAME_HANDLERS[subcommand as keyof typeof MINI_GAME_HANDLERS] as
		| ((interaction: ChatInputCommandInteraction) => Promise<void>)
		| undefined;

	// Unreachable for a member: Discord will not send a subcommand the builder
	// never declared, and it will not let anyone invoke the bare /mini-game. The
	// only way here is a developer declaring a subcommand above without adding it
	// to the table, so fail LOUDLY rather than returning silently, otherwise that
	// mistake ships as a game that does nothing when clicked.
	if (!handler) {
		console.error(`[mini-game] no handler registered for subcommand '${subcommand}'`);
		await interaction.reply({ embeds: [errorEmbed(gamesCopy.unknownSubcommand)], flags: MessageFlags.Ephemeral });
		return;
	}

	await handler(interaction);
}
