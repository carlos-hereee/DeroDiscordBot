// Not a game event, a Discord client event listener shape
export interface IClientEvent {
	name: string;
	once?: boolean;
	execute: (...args: any[]) => Promise<void>;
}
