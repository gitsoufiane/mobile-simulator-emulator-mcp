import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AndroidController } from "../src/android.js";
import type { IosController } from "../src/ios.js";
import {
	closeControllers,
	createMobileServer,
	type MobileControllers,
} from "../src/server.js";
import type { WdaController } from "../src/wda.js";

/** Connects an in-memory client to a server whose controllers are fakes. */
export async function connectFakes(fakes: {
	android?: Partial<AndroidController>;
	ios?: Partial<IosController>;
	wda?: Partial<WdaController>;
}) {
	const controllers: MobileControllers = {
		android: (fakes.android ?? {}) as AndroidController,
		ios: (fakes.ios ?? {}) as IosController,
		wda: { close: async () => undefined, ...fakes.wda } as WdaController,
		recordings: new Map(),
		simulatedLocations: new Set(),
	};
	const server = createMobileServer({ controllers });
	const client = new Client({ name: "fake-device-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return {
		controllers,
		/** Calls a tool and fails the test on an error result. */
		call: async (name: string, args: Record<string, unknown>) => {
			const result = await client.callTool({ name, arguments: args });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			return result;
		},
		callRaw: (name: string, args: Record<string, unknown>) =>
			client.callTool({ name, arguments: args }),
		close: async () => {
			await client.close();
			await closeControllers(controllers);
		},
	};
}
