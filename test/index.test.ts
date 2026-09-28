import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	isTrustedRequest,
	parseListenPort,
	startHttpServer,
} from "../src/index.js";

test("parseListenPort: stdio default, port parsing, and validation", () => {
	assert.equal(parseListenPort([]), undefined);
	assert.equal(parseListenPort(["--listen"]), 3000);
	assert.equal(parseListenPort(["--listen", "8931"]), 8931);
	assert.equal(parseListenPort(["--listen", "--other-flag"]), 3000);
	assert.throws(() => parseListenPort(["--listen", "0"]));
	assert.throws(() => parseListenPort(["--listen", "70000"]));
	assert.throws(() => parseListenPort(["--listen", "notaport"]));
});

test("accepts only loopback Host and Origin headers", () => {
	assert.equal(isTrustedRequest("127.0.0.1:3000", undefined), true);
	assert.equal(isTrustedRequest("localhost:3000", "http://localhost:6274"), true);
	assert.equal(isTrustedRequest("[::1]:3000", "http://[::1]:3000"), true);
	assert.equal(isTrustedRequest(undefined, undefined), false);
	assert.equal(isTrustedRequest("attacker.example:3000", undefined), false);
	assert.equal(isTrustedRequest("127.0.0.1:3000@attacker.example", undefined), false);
	assert.equal(
		isTrustedRequest("127.0.0.1:3000", "http://attacker.example"),
		false,
	);
	assert.equal(isTrustedRequest("127.0.0.1:3000", "null"), false);
});

function post(
	url: string,
	headers: Record<string, string>,
): Promise<number | undefined> {
	return new Promise((resolve, rejectRequest) => {
		const req = request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...headers,
				},
			},
			(res) => {
				res.resume();
				resolve(res.statusCode);
			},
		);
		req.once("error", rejectRequest);
		req.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "rebinding-test", version: "1.0.0" },
				},
			}),
		);
	});
}

test("HTTP mode rejects DNS rebinding and serves concurrent sessions", async () => {
	const http = await startHttpServer(0);
	const clients = [1, 2].map(
		(index) => new Client({ name: `http-test-${index}`, version: "1.0.0" }),
	);
	try {
		assert.equal(await post(http.url, { host: "attacker.example" }), 403);
		assert.equal(
			await post(http.url, { origin: "http://attacker.example" }),
			403,
		);

		await Promise.all(
			clients.map((client) =>
				// Cast: same SDK onclose typing clash as src/index.ts.
				client.connect(
					new StreamableHTTPClientTransport(new URL(http.url)) as Transport,
				),
			),
		);
		const listed = await Promise.all(
			clients.map((client) => client.listTools()),
		);
		for (const result of listed) assert.ok(result.tools.length > 30);
	} finally {
		await Promise.all(clients.map((client) => client.close()));
		await http.close();
	}
});
