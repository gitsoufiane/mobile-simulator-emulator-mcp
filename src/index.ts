#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createControllers, createMobileServer } from "./server.js";

const DEFAULT_LISTEN_PORT = 3000;
// Grace period before forcing exit when a native child keeps the loop alive.
const EXIT_GRACE_MS = 5_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function exitAfterCleanup(exitCode: number): void {
	process.exitCode = exitCode;
	setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
}

async function runStdio(): Promise<void> {
	const { server, close } = createMobileServer();
	let shuttingDown = false;

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		await close().catch((error: unknown) =>
			process.stderr.write(`cleanup failed: ${errorMessage(error)}\n`),
		);
		await server.close();
		exitAfterCleanup(exitCode);
	}

	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
	// MCP stdio clients shut down by closing stdin; without this, WebDriverAgent
	// and xcodebuild would outlive the client.
	process.stdin.once("end", () => void shutdown(0));

	try {
		await server.connect(new StdioServerTransport());
		process.stderr.write("local-mobile-mcp-server ready on stdio\n");
	} catch (error) {
		process.stderr.write(
			`local-mobile-mcp-server failed: ${errorMessage(error)}\n`,
		);
		await shutdown(1);
	}
}

function reject(res: ServerResponse, status: number, message: string): void {
	res
		.writeHead(status, { "content-type": "application/json" })
		.end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32000, message },
				id: null,
			}),
		);
}

/**
 * Serves Streamable HTTP on loopback. Every MCP session gets its own protocol
 * server, but all sessions share one set of device controllers because
 * WebDriverAgent owns a single fixed port.
 */
export async function startHttpServer(
	port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
	const controllers = createControllers();
	const sessions = new Map<string, StreamableHTTPServerTransport>();

	async function openSession(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const { server } = createMobileServer({ controllers });
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				sessions.set(id, transport);
			},
		});
		transport.onclose = () => {
			const id = transport.sessionId;
			// server.close() re-enters onclose; the delete guard stops recursion.
			if (id !== undefined && sessions.delete(id)) void server.close();
		};
		// Cast: the SDK's onclose getter type clashes with Transport under
		// exactOptionalPropertyTypes; runtime shape is compatible.
		await server.connect(transport as Transport);
		await transport.handleRequest(req, res);
		// A first request that is not `initialize` never creates a session.
		if (transport.sessionId === undefined) await server.close();
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		if (!isTrustedRequest(req.headers.host, req.headers.origin)) {
			reject(res, 403, "Forbidden: Host and Origin must be loopback");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/mcp") {
			reject(res, 404, "Not found: use /mcp");
			return;
		}
		const sessionId = req.headers["mcp-session-id"];
		if (typeof sessionId === "string") {
			const transport = sessions.get(sessionId);
			// 404 tells spec-compliant clients to reinitialize.
			if (transport === undefined) reject(res, 404, "Session not found");
			else await transport.handleRequest(req, res);
			return;
		}
		if (req.method !== "POST") {
			reject(res, 405, "POST an initialize request first");
			return;
		}
		await openSession(req, res);
	}

	const httpServer = createHttpServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			process.stderr.write(`request failed: ${errorMessage(error)}\n`);
			if (res.headersSent) res.end();
			else reject(res, 500, "Internal server error");
		});
	});

	// Loopback only: this server drives local simulators/emulators and must
	// never be reachable from the network. No auth for the same reason.
	await new Promise<void>((resolve, rejectListen) => {
		httpServer.once("error", rejectListen);
		httpServer.listen(port, "127.0.0.1", resolve);
	});
	const { port: boundPort } = httpServer.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${boundPort}/mcp`,
		close: async () => {
			const closed = new Promise<void>((resolve) =>
				httpServer.close(() => resolve()),
			);
			// transport.close() fires onclose, which closes the session server.
			await Promise.all(
				[...sessions.values()].map((transport) => transport.close()),
			);
			httpServer.closeAllConnections();
			await closed;
			await controllers.wda.close();
		},
	};
}

async function runHttp(port: number): Promise<void> {
	const { url, close } = await startHttpServer(port);
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
}

if (import.meta.main) {
	try {
		const port = parseListenPort(process.argv.slice(2));
		if (port === undefined) await runStdio();
		else await runHttp(port);
	} catch (error) {
		process.stderr.write(
			`local-mobile-mcp-server failed: ${errorMessage(error)}\n`,
		);
		process.exitCode = 1;
	}
}
