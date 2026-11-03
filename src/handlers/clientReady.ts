import { Client, Events } from "discord.js";
import { LOG_MESSAGES } from "@base/constants/log-messages.js";

// ── clientReady ──────────────────────────────────────────────────────
// The one line Dero prints once it has logged in; main.ts wires it before login.
// It lives under handlers/, not commands/, because the command loaders in main.ts
// and deploy-commands.ts read every file under commands/ and warn on each one that
// carries no "data" or "execute", which a client listener never does.

export default (client: Client): void => {
	// When the client is ready, run this code (only once).
	// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
	// It makes some properties non-nullable.
	client.once(Events.ClientReady, (readyClient) => {
		console.log(LOG_MESSAGES.ready.loggedInAs(readyClient.user.tag));
	});
};
