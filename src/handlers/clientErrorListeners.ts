import { Events } from "discord.js";
import type { Client } from "discord.js";

// ── client error listeners ───────────────────────────────────────────
// What:  log lines for the Discord client's own error, shard and warning events. main.ts
//        wires them once, before login.
// Why:   the Client is a Node EventEmitter, and an "error" emitted with no listener is
//        THROWN, which reaches the process's uncaughtException net and restarts the whole bot
//        for a gateway hiccup discord.js would have recovered from on its own. A listener turns
//        it back into a log line. The shard events make a disconnect and its reconnect visible
//        in the Railway logs, where they were silent before.
// Not:   it does not reconnect anything; discord.js resumes or reidentifies shards itself.

export function registerClientErrorListeners(client: Pick<Client, "on">): void {
	client.on(Events.Error, (error) => {
		console.error("[discord] client error", error);
	});
	client.on(Events.ShardError, (error, shardId) => {
		console.error(`[discord] shard ${shardId} error`, error);
	});
	client.on(Events.ShardDisconnect, (event, shardId) => {
		console.warn(`[discord] shard ${shardId} disconnected code=${event.code}`);
	});
	client.on(Events.ShardReconnecting, (shardId) => {
		console.warn(`[discord] shard ${shardId} reconnecting`);
	});
	client.on(Events.ShardResume, (shardId, replayedEvents) => {
		console.log(`[discord] shard ${shardId} resumed replayed=${replayedEvents}`);
	});
	client.on(Events.Warn, (message) => {
		console.warn("[discord] warning", message);
	});
}
