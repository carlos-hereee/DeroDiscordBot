export interface IPlayerActivity {
	activityId: string;
	eventId: string;
	eventOccurrence: Date;
	userId: string;
	username: string;

	// phase 3a, reaction tracking
	acknowledgedReminder: boolean;
	acknowledgedAt: Date | null;

	// phase 3b, presence tracking
	wasOnlineAtStart: boolean;

	// phase 3c, voice tracking
	joinedVoiceDuring: boolean;
	voiceMinutes: number;

	// computed on every update
	participationScore: number;

	createdAt?: Date;
	updatedAt?: Date;
}

// shape of an active voice session held in memory
// not persisted to DB until the player leaves voice
export interface IVoiceSession {
	userId: string;
	eventId: string;
	eventOccurrence: Date;
	joinedAt: number; // Date.now() timestamp
}
