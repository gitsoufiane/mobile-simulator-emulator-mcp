#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMobileServer } from "./server.js";

const DEFAULT_LISTEN_PORT = 3000;

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runStdio(): Promise<void> {
	const { server, close } = createMobileServer();
	let shuttingDown = false;

	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		await close();
		await server.close();
		process.exitCode = exitCode;
	}

	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));

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

type HttpSession = {
	transport: StreamableHTTPServerTransport;
	close: () => Promise<void>;
};

async function runHttp(port: number): Promise<void> {
	const sessions = new Map<string, HttpSession>();

	async function openSession(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const { server, close } = createMobileServer();
		const closeAll = async () => {
			await close();
			await server.close();
		};
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				sessions.set(id, { transport, close: closeAll });
			},
		});
		transport.onclose = () => {
			const id = transport.sessionId;
			if (id !== undefined && sessions.delete(id)) void closeAll();
		};
		// Cast: the SDK's onclose getter type clashes with Transport under
		// exactOptionalPropertyTypes; runtime shape is compatible.
		await server.connect(transport as Transport);
		await transport.handleRequest(req, res);
		// A first request that is not `initialize` never creates a session.
		if (transport.sessionId === undefined) {
			await transport.close();
			await closeAll();
		}
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/mcp") {
			res.writeHead(404, { "content-type": "text/plain" }).end("Use /mcp\n");
			return;
		}
		const sessionId = req.headers["mcp-session-id"];
		if (typeof sessionId === "string") {
			const session = sessions.get(sessionId);
			if (session === undefined) {
				// 404 tells spec-compliant clients to reinitialize.
				res
					.writeHead(404, { "content-type": "text/plain" })
					.end("Unknown session\n");
				return;
			}
			await session.transport.handleRequest(req, res);
			return;
		}
		if (req.method !== "POST") {
			res
				.writeHead(405, { "content-type": "text/plain" })
				.end("POST an initialize request\n");
			return;
		}
		await openSession(req, res);
	}

	const httpServer = createHttpServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			process.stderr.write(`request failed: ${errorMessage(error)}\n`);
			if (res.headersSent) res.end();
			else res.writeHead(500).end();
		});
	});

	let shuttingDown = false;
	async function shutdown(exitCode: number): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		httpServer.close();
		// transport.close() fires onclose, which removes the session and
		// closes its controllers.
		await Promise.all(
			[...sessions.values()].map(({ transport }) => transport.close()),
		);
		process.exitCode = exitCode;
	}
	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));

	// Loopback only: this server drives local simulators/emulators and must
	// never be reachable from the network. No auth for the same reason.
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, "127.0.0.1", resolve);
	});
	process.stderr.write(
		`local-mobile-mcp-server ready on http://127.0.0.1:${port}/mcp\n`,
	);
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
