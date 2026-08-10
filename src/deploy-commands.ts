import { REST, RESTPostAPIApplicationCommandsJSONBody, Routes } from "discord.js";
import type { RESTPutAPIApplicationGuildCommandsResult } from "discord-api-types/v10";
import { clientId, discordGuildIds, discordToken, isProduction } from "@utils/config.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands: RESTPostAPIApplicationCommandsJSONBody[] = [];

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js") || file.endsWith(".cjs"));

	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const commandModule = await import(pathToFileURL(filePath).href);
		const command = commandModule.default ?? commandModule;
		if ("data" in command && "execute" in command) {
			commands.push(command.data.toJSON());
		} else {
			console.warn(LOG_MESSAGES.deploy.commandLoadWarning(filePath));
		}
	}
}

if (!clientId || !discordToken) {
	console.error(LOG_MESSAGES.deploy.missingCredentials);
	process.exit(1);
}

if (!isProduction && discordGuildIds.length === 0) {
	console.error(LOG_MESSAGES.deploy.missingGuildId);
	process.exit(1);
}

const rest = new REST().setToken(discordToken);

try {
	console.log(LOG_MESSAGES.deploy.refreshing(commands.length, isProduction ? "GLOBAL" : "GUILD"));

	if (isProduction) {
		const data = (await rest.put(Routes.applicationCommands(clientId), {
			body: commands,
		})) as RESTPutAPIApplicationGuildCommandsResult;

		console.log(LOG_MESSAGES.deploy.globalSuccess(data.length));
		console.log(LOG_MESSAGES.deploy.globalPropagationNote);
	} else {
		// Iterate over every guildId in DISCORD_GUILD_ID. Single-id values
		// produce a one-element array and still work; comma-separated values
		// let dev mode push to multiple test guilds in one run so a bot
		// owner testing the same patch across several servers does not have
		// to swap env vars or rerun the script. Sequential loop so one
		// guild's 4xx (eg revoked applications.commands scope) does not
		// abort the whole run, log the failure and continue.
		console.log(
			`[deploy] Targeting ${discordGuildIds.length} guild${discordGuildIds.length === 1 ? "" : "s"}: ${discordGuildIds.join(", ")}`
		);
		let successCount = 0;
		let failureCount = 0;
		for (const guildId of discordGuildIds) {
			try {
				const data = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
					body: commands,
				})) as RESTPutAPIApplicationGuildCommandsResult;
				console.log(`[deploy] Guild ${guildId}: ${LOG_MESSAGES.deploy.guildSuccess(data.length)}`);
				successCount += 1;
			} catch (guildError) {
				console.error(`[deploy] Guild ${guildId} failed:`, guildError);
				failureCount += 1;
			}
		}
		console.log(`[deploy] Done. Success: ${successCount}, Failed: ${failureCount}.`);
		if (successCount === 0 && failureCount > 0) {
			// Surface a non-zero exit when nothing landed so CI / build
			// pipelines treat the run as a failure. A partial success
			// (some guilds OK) does not exit non-zero, losing one guild
			// out of three is recoverable; the other two still got the
			// update and the failing one can be retried separately.
			process.exit(1);
		}
	}
} catch (error) {
	console.error(error);
	process.exit(1);
}
