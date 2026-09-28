import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WdaController } from "../src/wda.js";

test("reuses one WDA session and recreates it once when WDA drops it", async () => {
	let created = 0;
	let live: string | undefined;
	const performed: string[] = [];
	const server = createServer((req, res) => {
		const reply = (status: number, value: unknown) =>
			res
				.writeHead(status, { "content-type": "application/json" })
				.end(JSON.stringify({ value }));
		req.resume();
		if (req.method === "POST" && req.url === "/session") {
			created += 1;
			live = `s${created}`;
			reply(200, { sessionId: live });
		} else if (req.url === "/wda/screen") {
			reply(200, { screenSize: { width: 400, height: 800 } });
		} else if (req.method === "POST" && req.url?.endsWith("/actions")) {
			const id = req.url.split("/")[2] ?? "";
			if (id !== live) {
				reply(404, { error: "invalid session id", message: "gone" });
				return;
			}
			performed.push(id);
			reply(200, null);
		} else reply(404, { error: "unknown command", message: req.url });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const wda = new WdaController(`http://127.0.0.1:${port}`);
	try {
		await wda.tap(10, 10);
		await wda.tap(20, 20);
		assert.equal(created, 1, "second tap reuses the first session");

		live = "restarted"; // WDA dropped s1.
		await wda.tap(30, 30);
		assert.equal(created, 2, "stale session is recreated once");
		assert.deepEqual(performed, ["s1", "s1", "s2"], "no action repeats");

		await assert.rejects(() => wda.tap(500, 10), /exceed screen size/u);
	} finally {
		server.close();
	}
});
