import { describe, it, expect, vi, afterEach } from "vitest";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// The bot's own S3 credentials, faked. Mocked by the same specifier index.ts
// imports, so the client is built with these and never with the real env.
vi.mock("@utils/config.js", () => ({
	discordBotAwsAccessKey: "test-access-key",
	discordBotAwsSecretKey: "test-secret-key",
	discordBotAwsBucketName: "test-bucket",
	discordBotAwsRegion: "us-east-1",
}));

import { getObjectBytes, putObject } from "./index.js";

// ── bot AWS helpers ──────────────────────────────────────────────────
// Pins the two commands the renderer's S3 store sends and the one error that
// means a cache miss rather than a failure. send is stubbed on the client's
// prototype, so no request ever leaves the process.

type SendStub = (command: unknown) => Promise<unknown>;

function stubSend(implementation: SendStub) {
	return vi.spyOn(S3Client.prototype, "send").mockImplementation(implementation as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("putObject", () => {
	it("sends one PutObjectCommand to the bot's bucket", async () => {
		const send = stubSend(async () => ({}));
		const body = Buffer.from("png");

		await putObject({ key: "discord-bot/renders/smoke/1/abc.png", body, contentType: "image/png", cacheControl: "immutable" });

		const [command] = send.mock.calls[0] as unknown[];
		expect(command).toBeInstanceOf(PutObjectCommand);
		expect((command as PutObjectCommand).input).toEqual({
			Bucket: "test-bucket",
			Key: "discord-bot/renders/smoke/1/abc.png",
			Body: body,
			ContentType: "image/png",
			CacheControl: "immutable",
		});
	});
});

describe("getObjectBytes", () => {
	it("answers the object's bytes", async () => {
		const send = stubSend(async () => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }));

		await expect(getObjectBytes("discord-bot/renders/smoke/1/abc.png")).resolves.toEqual(Buffer.from([1, 2, 3]));
		const [command, options] = send.mock.calls[0] as unknown[];
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect((command as GetObjectCommand).input).toEqual({ Bucket: "test-bucket", Key: "discord-bot/renders/smoke/1/abc.png" });
		// No budget asked for, so no abort signal is attached.
		expect(options).toEqual({ abortSignal: undefined });
	});

	it("attaches an abort signal when the caller gives the read a budget", async () => {
		const send = stubSend(async () => ({ Body: { transformToByteArray: async () => new Uint8Array([1]) } }));

		await getObjectBytes("discord-bot/renders/smoke/1/abc.png", { timeoutMs: 1_500 });

		const [, options] = send.mock.calls[0] as unknown[];
		expect((options as { abortSignal?: unknown }).abortSignal).toBeInstanceOf(AbortSignal);
	});

	it("answers null for a key with no object, which is a cache miss", async () => {
		stubSend(async () => {
			throw new NoSuchKey({ message: "The specified key does not exist.", $metadata: {} });
		});

		await expect(getObjectBytes("discord-bot/renders/smoke/1/missing.png")).resolves.toBeNull();
	});

	it("answers null for a response with no body", async () => {
		stubSend(async () => ({}));

		await expect(getObjectBytes("discord-bot/renders/smoke/1/empty.png")).resolves.toBeNull();
	});

	it("rejects on any other failure, so the caller can log it as one", async () => {
		stubSend(async () => {
			throw new Error("AccessDenied");
		});

		await expect(getObjectBytes("discord-bot/renders/smoke/1/abc.png")).rejects.toThrow("AccessDenied");
	});
});
