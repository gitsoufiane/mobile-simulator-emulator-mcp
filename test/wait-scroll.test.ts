import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AndroidController } from "../src/android.js";
import type { IosController } from "../src/ios.js";
import { createMobileServer } from "../src/server.js";
import type { WdaController } from "../src/wda.js";

const device = "android:emulator-5554";

function screen(...labels: Array<[string, number]>): string {
	const nodes = labels
		.map(
			([text, top]) =>
				`<node text="${text}" resource-id="" class="android.widget.TextView" content-desc="" clickable="true" bounds="[0,${top}][1080,${top + 100}]" />`,
		)
		.join("");
	return `<hierarchy rotation="0">${nodes}</hierarchy>`;
}

/** Fake Android controller: each uiTree call returns the next screen. */
async function connect(screens: Array<string | Error>) {
	const swipes: number[][] = [];
	let reads = 0;
	const android = {
		uiTree: async () => {
			const next = screens[Math.min(reads, screens.length - 1)];
			reads += 1;
			if (next instanceof Error) throw next;
			return next ?? "";
		},
		screenInfo: async () => ({
			width: 1080,
			height: 2400,
			orientation: "portrait" as const,
		}),
		swipe: async (_serial: string, ...line: number[]) => {
			swipes.push(line);
		},
	};
	const created = createMobileServer({
		controllers: {
			android: android as unknown as AndroidController,
			ios: {} as IosController,
			wda: {} as WdaController,
		},
	});
	const client = new Client({ name: "wait-scroll-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await Promise.all([
		client.connect(clientTransport),
		created.server.connect(serverTransport),
	]);
	return {
		call: (name: string, args: Record<string, unknown>) =>
			client.callTool({ name, arguments: { device, ...args } }),
		swipes,
		reads: () => reads,
		close: async () => {
			await client.close();
			await created.close();
		},
	};
}

test("waits through transient read errors until the element appears", async () => {
	const session = await connect([
		screen(["Loading", 200]),
		new Error("null root node returned by UiTestAutomationBridge"),
		screen(["Welcome", 200]),
	]);
	try {
		const result = await session.call("mobile_wait_for_element", {
			query: "welcome",
			timeoutMs: 5_000,
		});
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const data = result.structuredContent as Record<string, unknown>;
		assert.equal(data.state, "visible");
		assert.equal(data.matches, 1);
		assert.equal((data.element as { label: string }).label, "Welcome");
		assert.equal(session.reads(), 3);
	} finally {
		await session.close();
	}
});

test("waits until an element is gone and times out with the last error", async () => {
	const gone = await connect([screen(["Spinner", 200]), screen(["Done", 200])]);
	try {
		const result = await gone.call("mobile_wait_for_element", {
			query: "Spinner",
			state: "gone",
			timeoutMs: 5_000,
		});
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(
			(result.structuredContent as { element?: unknown }).element,
			undefined,
		);
	} finally {
		await gone.close();
	}

	const failing = await connect([new Error("could not get idle state")]);
	try {
		const result = await failing.call("mobile_wait_for_element", {
			query: "Welcome",
			timeoutMs: 600,
		});
		assert.equal(result.isError, true);
		assert.match(
			JSON.stringify(result.content),
			/within 600 ms.*could not get idle state/u,
		);
	} finally {
		await failing.close();
	}
});

test("scrolls down until the element center is on screen", async () => {
	const session = await connect([
		// Below the 2400 px screen: listed by uiautomator but not reachable.
		screen(["Wi-Fi", 200], ["About phone", 2500]),
		screen(["Wi-Fi", 100], ["Battery", 1200]),
		screen(["Battery", 300], ["About phone", 1800]),
	]);
	try {
		const result = await session.call("mobile_scroll_to_element", {
			query: "About phone",
		});
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const data = result.structuredContent as Record<string, unknown>;
		assert.equal(data.swipes, 2);
		assert.deepEqual((data.element as { center: unknown }).center, {
			x: 540,
			y: 1850,
		});
		// "down" reveals content below: the finger moves up the middle 40%.
		assert.deepEqual(session.swipes, [
			[540, 1680, 540, 720, 400],
			[540, 1680, 540, 720, 400],
		]);
	} finally {
		await session.close();
	}
});

test("stops scrolling when the screen stops changing", async () => {
	const session = await connect([screen(["Last row", 200])]);
	try {
		const result = await session.call("mobile_scroll_to_element", {
			query: "Missing",
			direction: "up",
		});
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /stopped changing after 1 swipes up/u);
		assert.deepEqual(session.swipes, [[540, 720, 540, 1680, 400]]);
	} finally {
		await session.close();
	}
});
