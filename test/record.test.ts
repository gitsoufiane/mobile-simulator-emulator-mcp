import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AndroidController } from "../src/android.js";
import type { IosController } from "../src/ios.js";
import { closeControllers, createMobileServer } from "../src/server.js";
import type { WdaController } from "../src/wda.js";

const device = "android:emulator-5554";

async function connect() {
	process.env.MOBILE_MCP_APP_ROOT = await mkdtemp(join(tmpdir(), "mobile-mcp-record-"));
	let stops = 0;
	const android = {
		startScreenRecord: async (_serial: string, path: string) => ({
			stop: async () => {
				stops += 1;
				await writeFile(path, "video");
			},
		}),
	};
	const controllers = {
		android: android as unknown as AndroidController,
		ios: {} as IosController,
		wda: { close: async () => undefined } as WdaController,
		recordings: new Map(),
		simulatedLocations: new Set<string>(),
	};
	// HTTP builds a server per request, so two servers share the controllers.
	const clients = await Promise.all(
		["record-test", "record-test-other"].map(async (name) => {
			const server = createMobileServer({ controllers });
			const client = new Client({ name, version: "1.0.0" });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
			return client;
		}),
	);
	const on = (client: Client | undefined) => (args: Record<string, unknown>) => {
		assert.ok(client);
		return client.callTool({ name: "mobile_record_screen", arguments: { device, ...args } });
	};
	return {
		call: on(clients[0]),
		callOther: on(clients[1]),
		stops: () => stops,
		closeControllers: () => closeControllers(controllers),
		close: async () => {
			await Promise.all(clients.map((client) => client.close()));
			await closeControllers(controllers);
		},
	};
}

test("stops a recording from another server, and finalizes open ones on close", async () => {
	const session = await connect();
	try {
		await session.call({ action: "start", path: "shared.mp4", durationSeconds: 60 });
		const stopped = await session.callOther({ action: "stop" });
		assert.equal(stopped.isError, undefined, JSON.stringify(stopped.content));
		assert.equal(session.stops(), 1);

		await session.call({ action: "start", path: "open.mp4", durationSeconds: 60 });
		await session.closeControllers();
		assert.equal(session.stops(), 2, "shutdown finalizes the open recording");
	} finally {
		await session.close();
	}
});

test("starts a recording, refuses a second one, and stops it once", async () => {
	const session = await connect();
	try {
		const started = await session.call({ action: "start", path: "clip.mp4", durationSeconds: 60 });
		assert.equal(started.isError, undefined, JSON.stringify(started.content));
		assert.equal((started.structuredContent as { bytes?: number }).bytes, undefined);

		const second = await session.call({ action: "start", path: "other.mp4" });
		assert.match(JSON.stringify(second.content), /already recording/u);

		const stopped = await session.call({ action: "stop" });
		assert.equal(stopped.isError, undefined, JSON.stringify(stopped.content));
		assert.equal((stopped.structuredContent as { bytes: number }).bytes, 5);
		assert.equal(session.stops(), 1);

		const again = await session.call({ action: "stop" });
		assert.match(JSON.stringify(again.content), /No recording is in progress/u);
		assert.match(JSON.stringify((await session.call({ action: "start" })).content), /path is required/u);
	} finally {
		await session.close();
	}
});

test("stops at the time limit and still returns the file on stop", async () => {
	const session = await connect();
	try {
		await session.call({ action: "start", path: "short.mp4", durationSeconds: 1 });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(session.stops(), 1);
		const stopped = await session.call({ action: "stop" });
		assert.equal((stopped.structuredContent as { bytes: number }).bytes, 5);
		assert.equal(session.stops(), 1);
	} finally {
		await session.close();
	}
});
