#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
	closeControllers,
	createControllers,
	createMobileServer,
} from "./server.js";

const DEFAULT_LISTEN_PORT = 3000;
// Grace period before forcing exit when a native child keeps the loop alive.
const EXIT_GRACE_MS = 5_000;
const MIN_TOKEN_LENGTH = 16;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Compiled to dist/src/, so the package's skills folder is two levels up.
const SKILLS_ROOT = fileURLToPath(new URL("../../skills", import.meta.url));

// undefined = stdio mode (default); a number = HTTP mode on 127.0.0.1:<port>.
export function parseListenPort(argv: string[]): number | undefined {
	const index = argv.indexOf("--listen");
	if (index === -1) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) return DEFAULT_LISTEN_PORT;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`--listen expects a port from 1 to 65535, got "${value}".`);
	}
	return port;
}

function isLoopbackUrl(value: string): boolean {
	try {
		return LOOPBACK_HOSTNAMES.has(new URL(value).hostname);
	} catch {
		return false;
	}
}

/**
 * DNS-rebinding guard required by the MCP Streamable HTTP transport: a
 * malicious web page can resolve its own hostname to 127.0.0.1, so both the
 * Host header and any browser-supplied Origin must name a loopback host.
 */
export function isTrustedRequest(
	host: string | undefined,
	origin: string | undefined,
): boolean {
	return (
		host !== undefined &&
		isLoopbackUrl(`http://${host}`) &&
		(origin === undefined || isLoopbackUrl(origin))
	);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function hasBearerToken(
	header: string | undefined,
	token: string,
): boolean {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header ?? "");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function exitAfterCleanup(exitCode: number): void {
	process.exitCode = exitCode;
	setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
}

/** The skill ships in the package; a broken copy disables only the Skills extension. */
async function loadPackageSkills(): Promise<SkillCatalog | undefined> {
	try {
		return await loadSkills(SKILLS_ROOT, {
			onWarning: ({ path, message }) =>
				process.stderr.write(`skills: ${path}: ${message}\n`),
		});
	} catch (error) {
		process.stderr.write(
			`skills: not served from ${SKILLS_ROOT}: ${errorMessage(error)}\n`,
		);
		return undefined;
	}
}

/**
 * Serves stdio for both protocol eras: serveStdio answers 2025-era
 * `initialize` openings and 2026-07-28 per-request openings from one factory.
 */
async function runStdio(skills: SkillCatalog | undefined): Promise<void> {
	const controllers = createControllers();
	let shuttingDown = false;
	const handle = serveStdio(
		() => createMobileServer({ controllers, skills }),
		{
			onerror: (error) =>
				process.stderr.write(`stdio error: ${error.message}\n`),
		},
	);

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		await handle
			.close()
			.catch((error: unknown) =>
				process.stderr.write(`close failed: ${errorMessage(error)}\n`),
			);
		await closeControllers(controllers).catch((error: unknown) =>
			process.stderr.write(`cleanup failed: ${errorMessage(error)}\n`),
		);
		exitAfterCleanup(exitCode);
	}

	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
	// MCP stdio clients shut down by closing stdin; without this, WebDriverAgent
	// and xcodebuild would outlive the client.
	process.stdin.once("end", () => void shutdown(0));
	process.stderr.write("local-mobile-mcp-server ready on stdio\n");
}

function reject(res: ServerResponse, status: number, message: string): void {
	res
		.writeHead(status, {
			"content-type": "application/json",
			...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
		})
		.end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message },
				id: null,
			}),
		);
}

function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (Array.isArray(value))
			for (const entry of value) headers.append(name, entry);
		else if (value !== undefined) headers.set(name, value);
	}
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	return new Request(new URL(req.url ?? "/", "http://127.0.0.1"), {
		method: req.method ?? "GET",
		headers,
		signal,
		...(hasBody
			? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }
			: {}),
	});
}

async function sendWebResponse(
	res: ServerResponse,
	response: Response,
): Promise<void> {
	res.writeHead(response.status, Object.fromEntries(response.headers));
	if (!response.body) {
		res.end();
		return;
	}
	await pipeline(
		Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
		res,
	);
}

export interface HttpServerOptions {
	/** Bearer token clients must send; a random one is generated when omitted. */
	token?: string | undefined;
	skills?: SkillCatalog | undefined;
}

/**
 * Serves Streamable HTTP on loopback for both protocol eras. Requests get
 * their own protocol server, but all share one set of device controllers
 * because each device has one WebDriverAgent and one recording.
 */
export async function startHttpServer(
	port: number,
	options: HttpServerOptions = {},
): Promise<{ url: string; token: string; close: () => Promise<void> }> {
	const token = options.token ?? randomBytes(32).toString("base64url");
	if (token.length < MIN_TOKEN_LENGTH)
		throw new Error(
			`The HTTP token must be at least ${MIN_TOKEN_LENGTH} characters long`,
		);
	const controllers = createControllers();
	const { skills } = options;
	const handler = createMcpHandler(
		() => createMobileServer({ controllers, skills }),
		{
			onerror: (error) =>
				process.stderr.write(`request failed: ${error.message}\n`),
		},
	);

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		if (!isTrustedRequest(req.headers.host, req.headers.origin)) {
			reject(res, 403, "Forbidden: Host and Origin must be loopback");
			return;
		}
		if (!hasBearerToken(req.headers.authorization, token)) {
			reject(res, 401, "Unauthorized: send Authorization: Bearer <token>");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/mcp") {
			reject(res, 404, "Not found: use /mcp");
			return;
		}
		const aborted = new AbortController();
		res.once("close", () => aborted.abort());
		await sendWebResponse(
			res,
			await handler.fetch(toWebRequest(req, aborted.signal)),
		);
	}

	const httpServer = createHttpServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			process.stderr.write(`request failed: ${errorMessage(error)}\n`);
			if (res.headersSent) res.end();
			else reject(res, 500, "Internal server error");
		});
	});

	// Loopback only: this server drives local simulators, emulators, and
	// phones and must never be reachable from the network.
	await new Promise<void>((resolve, rejectListen) => {
		httpServer.once("error", rejectListen);
		httpServer.listen(port, "127.0.0.1", resolve);
	});
	const { port: boundPort } = httpServer.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${boundPort}/mcp`,
		token,
		close: async () => {
			const closed = new Promise<void>((resolve) =>
				httpServer.close(() => resolve()),
			);
			await handler.close();
			httpServer.closeAllConnections();
			await closed;
			await closeControllers(controllers);
		},
	};
}

async function runHttp(
	port: number,
	skills: SkillCatalog | undefined,
): Promise<void> {
	// An empty variable means "not set", so a random token is made.
	const configured = process.env.MOBILE_MCP_HTTP_TOKEN || undefined;
	const { url, token, close } = await startHttpServer(port, {
		token: configured,
		skills,
	});
	let shuttingDown = false;
	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		await close().catch((error: unknown) =>
			process.stderr.write(`cleanup failed: ${errorMessage(error)}\n`),
		);
		exitAfterCleanup(exitCode);
	}
	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
	process.stderr.write(`local-mobile-mcp-server ready on ${url}\n`);
	// A configured token is the user's secret; print only one we generated.
	if (!configured)
		process.stderr.write(`Send this header: Authorization: Bearer ${token}\n`);
}

if (import.meta.main) {
	try {
		const port = parseListenPort(process.argv.slice(2));
		const skills = await loadPackageSkills();
		if (port === undefined) await runStdio(skills);
		else await runHttp(port, skills);
	} catch (error) {
		process.stderr.write(
			`local-mobile-mcp-server failed: ${errorMessage(error)}\n`,
		);
		process.exitCode = 1;
	}
}
