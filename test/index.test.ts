import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	Client,
	type ClientOptions,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import {
	hasBearerToken,
	isTrustedRequest,
	parseListenPort,
	startHttpServer,
} from "../src/index.js";

const MODERN: ClientOptions = {
	versionNegotiation: { mode: { pin: "2026-07-28" } },
};
const SKILL_URI = "skill://mobile-mcp/SKILL.md";
// Compiled to dist/test/, so the repository root is two levels up.
const root = (path: string) =>
	fileURLToPath(new URL(`../../${path}`, import.meta.url));

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

test("accepts only the exact bearer token", () => {
	const token = "a".repeat(32);
	assert.equal(hasBearerToken(`Bearer ${token}`, token), true);
	assert.equal(hasBearerToken(undefined, token), false);
	assert.equal(hasBearerToken(`Bearer ${token}x`, token), false);
	assert.equal(hasBearerToken(`bearer ${token}`, token), false);
	assert.equal(hasBearerToken(token, token), false);
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

test("HTTP mode rejects rebinding and missing tokens, and serves both protocol eras", async () => {
	const skills = await loadSkills(root("skills"));
	const http = await startHttpServer(0, { skills });
	const authorization = { authorization: `Bearer ${http.token}` };
	const clients = [
		new Client({ name: "legacy-http", version: "1.0.0" }),
		new Client({ name: "modern-http", version: "1.0.0" }, MODERN),
	];
	try {
		assert.equal(await post(http.url, { host: "attacker.example", ...authorization }), 403);
		assert.equal(
			await post(http.url, { origin: "http://attacker.example", ...authorization }),
			403,
		);
		assert.equal(await post(http.url, {}), 401);
		assert.equal(await post(http.url, { authorization: "Bearer wrong-token-value" }), 401);
		await assert.rejects(startHttpServer(0, { token: "short" }), /at least 16/u);

		await Promise.all(
			clients.map((client) =>
				client.connect(
					new StreamableHTTPClientTransport(new URL(http.url), {
						requestInit: { headers: authorization },
					}),
				),
			),
		);
		assert.deepEqual(
			clients.map((client) => client.getProtocolEra()),
			["legacy", "modern"],
		);
		for (const client of clients) {
			assert.ok((await client.listTools()).tools.length > 50);
			const result = await client.callTool({
				name: "mobile_set_ios_team",
				arguments: { teamId: "TEAM123456" },
			});
			assert.deepEqual(result.structuredContent, { teamId: "TEAM123456" });
			const listing = await new SkillsClient(client).list();
			assert.deepEqual(
				listing.skills.map((skill) => skill.uri),
				[SKILL_URI],
			);
		}
	} finally {
		await Promise.all(clients.map((client) => client.close()));
		await http.close();
	}
});

test("stdio serves 2025 and 2026-07-28 clients and the bundled skill", async () => {
	for (const options of [{}, MODERN]) {
		const client = new Client({ name: "stdio-test", version: "1.0.0" }, options);
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [root("dist/src/index.js")],
				stderr: "ignore",
			}),
		);
		try {
			assert.ok((await client.listTools()).tools.length > 50);
			assert.match(String(client.getInstructions()), /mobile_doctor/u);
			const skills = new SkillsClient(client);
			const [entry] = (await skills.list()).skills;
			assert.equal(entry?.uri, SKILL_URI);
			if (entry) {
				const file = await skills.read(entry);
				assert.equal(file.frontmatter?.name, "mobile-mcp");
			}
		} finally {
			await client.close();
		}
	}
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** Starts the built server with --listen and returns its stderr once it is ready. */
async function listen(env: Record<string, string>) {
	const port = await freePort();
	const child = spawn(process.execPath, [root("dist/src/index.js"), "--listen", String(port)], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`server exited with ${String(code)}: ${stderr}`)));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.includes("Authorization") || (env.MOBILE_MCP_HTTP_TOKEN && stderr.includes("ready on"))) resolve();
		});
	});
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		stderr: () => stderr,
		stop: () => new Promise<void>((resolve) => {
			child.removeAllListeners("exit");
			child.once("exit", () => resolve());
			child.kill("SIGTERM");
		}),
	};
}

test("--listen uses the configured token, never prints it, and prints a generated one", async () => {
	const token = "configured-token-0123456789abcdef";
	const configured = await listen({ MOBILE_MCP_HTTP_TOKEN: token });
	try {
		assert.equal(await post(configured.url, {}), 401);
		assert.equal(await post(configured.url, { authorization: `Bearer ${token}` }), 200);
		assert.doesNotMatch(configured.stderr(), new RegExp(token, "u"));
	} finally {
		await configured.stop();
	}
	const generated = await listen({});
	try {
		const printed = /Authorization: Bearer (\S+)/u.exec(generated.stderr())?.[1];
		assert.ok(printed && printed.length >= 32, generated.stderr());
		assert.equal(await post(generated.url, { authorization: `Bearer ${printed}` }), 200);
	} finally {
		await generated.stop();
	}
});

test("every manifest ships the package version and the same pinned server", () => {
	const json = (path: string) => JSON.parse(readFileSync(root(path), "utf8"));
	const { version } = json("package.json");
	const claude = json(".claude-plugin/plugin.json");
	const portable = json("plugin.json");
	const servers = json("mcp.json").mcpServers;
	assert.equal(claude.version, version);
	assert.equal(portable.version, version);
	const pinned = ["-y", "--allow-git=root", `github:gitsoufiane/mobile-simulator-emulator-mcp#v${version}`];
	assert.deepEqual(claude.mcpServers.mobile.args, pinned);
	assert.deepEqual(servers.mobile.args, pinned);
	assert.equal(claude.mcpServers.mobile.command, servers.mobile.command);
});
