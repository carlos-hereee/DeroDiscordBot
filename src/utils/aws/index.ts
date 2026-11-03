import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { discordBotAwsAccessKey, discordBotAwsBucketName, discordBotAwsRegion, discordBotAwsSecretKey } from "@utils/config.js";

// ── bot AWS helpers ──────────────────────────────────────────────────
// The bot's own S3 client and the object reads and writes it makes, signed with
// the bot's own IAM key (2026-10 item 243: write scoped to discord-bot/* on the
// shared Company Uno bucket). It has the same shape as nexious-server's
// src/utils/aws/index.ts, one shared client behind thin named helpers, but it is
// its own code: the bot is a separate repo and a separate Railway deploy, so it
// never imports across. It knows nothing about what it stores and does not check
// whether S3 is switched on; features/renderer/s3.ts decides both.
//
// ⚠️ GRANT s3:ListBucket ON THE discord-bot/ PREFIX, NOT ONLY GET AND PUT. Without
// it S3 answers a read of a key that does not exist with 403 AccessDenied rather
// than 404 NoSuchKey, so every cache miss reads as a failure instead of a miss.

// The SDK sets no network timeouts of its own (0 disables each one), so a stalled
// S3 would hold a call, and the socket and PNG behind it, for as long as TCP
// allows: minutes. These bound every call, the background card upload included.
const S3_CONNECTION_TIMEOUT_MS = 1_000;
const S3_REQUEST_TIMEOUT_MS = 3_000;
// One retry. An upload is fire and forget, and a read that fails twice is
// cheaper to answer by drawing the card again than by waiting longer.
const S3_MAX_ATTEMPTS = 2;

let client: S3Client | null = null;

// Built on the first call rather than at module load, so a process with S3
// switched off (every dev session) never builds a client with empty credentials.
function s3(): S3Client {
	client ??= new S3Client({
		region: discordBotAwsRegion,
		credentials: { accessKeyId: discordBotAwsAccessKey, secretAccessKey: discordBotAwsSecretKey },
		maxAttempts: S3_MAX_ATTEMPTS,
		requestHandler: {
			connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
			requestTimeout: S3_REQUEST_TIMEOUT_MS,
			// Without this a breached requestTimeout only logs a warning and the
			// call keeps waiting, which is the stall the timeout exists to stop.
			throwOnRequestTimeout: true,
		},
	});
	return client;
}

export interface PutObjectInput {
	key: string;
	body: Buffer;
	contentType: string;
	cacheControl?: string;
}

export interface GetObjectOptions {
	/** A budget for the whole read, retries included. Past it the read rejects, for a caller that would rather do without. */
	timeoutMs?: number;
}

/** Writes one object to the bot's bucket. Rejects with the SDK's error; the caller decides whether a failed write matters. */
export async function putObject({ key, body, contentType, cacheControl }: PutObjectInput): Promise<void> {
	await s3().send(
		new PutObjectCommand({ Bucket: discordBotAwsBucketName, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl })
	);
}

/** The bytes of one object, or null when no object has that key. Any other failure, a breached budget included, rejects. */
export async function getObjectBytes(key: string, { timeoutMs }: GetObjectOptions = {}): Promise<Buffer | null> {
	const abortSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
	try {
		const response = await s3().send(new GetObjectCommand({ Bucket: discordBotAwsBucketName, Key: key }), { abortSignal });
		if (!response.Body) return null;
		return Buffer.from(await response.Body.transformToByteArray());
	} catch (error) {
		if (error instanceof NoSuchKey) return null;
		throw error;
	}
}
