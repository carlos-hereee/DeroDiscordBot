import type { ErrorRequestHandler } from "express";

// The last middleware startApiServer mounts. Without it Express answers an error with its own
// default page, which carries the stack trace whenever NODE_ENV is not "production", and the
// JSON body parser runs BEFORE verifySignature, so an unsigned caller could read it by sending
// a malformed body to any /api path. It answers a bare JSON status instead and never echoes the
// error. It does not authorize anything and never replaces a route's own answers; a route that
// already began its response is handed back to Express to close the socket.

// The body parser's errors carry their HTTP status (400 for bad JSON, 413 for a body too large).
const CLIENT_ERROR_MIN = 400;
const CLIENT_ERROR_MAX = 499;

/** The status an error asks for when it names a client error (a bad body, a body too large), else 500. */
export function statusForApiError(error: unknown): number {
	const raw = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
	return typeof raw === "number" && raw >= CLIENT_ERROR_MIN && raw <= CLIENT_ERROR_MAX ? raw : 500;
}

export const apiErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
	if (res.headersSent) {
		next(error);
		return;
	}
	const status = statusForApiError(error);
	// Only server faults are logged with their error; a client's bad body is routine noise.
	if (status >= 500) console.error(`[api] ${req.method} ${req.path} failed`, error);
	res.status(status).json({ error: status >= 500 ? "Internal error" : "Bad request" });
};
