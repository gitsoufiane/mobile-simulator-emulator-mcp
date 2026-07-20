#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMobileServer } from "./server.js";

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
		`local-mobile-mcp-server failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	await shutdown(1);
}
