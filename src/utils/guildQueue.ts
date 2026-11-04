// ── guildQueue ──────────────────────────────────────────────────────────────
// What:  runs one guild's tasks one after another, each starting once the last one ended.
//        Only tasks of the same guild wait for each other.
// Who:   onDemandChannel.ts, so two callers asking for one slot build it once, and
//        headquartersCards.ts, so a double press on a step card cannot post a card twice.
// Where: each module makes its OWN queue. Never share one between a build and a card sync:
//        a build that awaited a sync on a shared queue would wait on itself and never end.
// How:   one promise chain per guild. A rejected task goes back to its own caller and the
//        next task runs anyway, because one failed build must not stop a guild's queue. An
//        emptied chain is dropped, so an idle guild holds no entry.

/** One queue's way in: `task` runs after every earlier task of that guild has ended. */
export interface GuildQueue {
	run<T>(guildId: string, task: () => Promise<T>): Promise<T>;
}

/** A new, empty queue. Each module holds its own (see the module header). */
export function createGuildQueue(): GuildQueue {
	const queues = new Map<string, Promise<unknown>>();
	return {
		async run<T>(guildId: string, task: () => Promise<T>): Promise<T> {
			const previous = queues.get(guildId) ?? Promise.resolve();
			const run = previous.catch(() => undefined).then(task);
			queues.set(guildId, run);
			try {
				return await run;
			} finally {
				if (queues.get(guildId) === run) queues.delete(guildId);
			}
		},
	};
}
