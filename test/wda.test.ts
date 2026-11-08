import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebDriverAgent } from "appium-webdriveragent";
import { WdaController } from "../src/wda.js";

test("switches signing teams safely, with or without an environment default", async (t) => {
	const original = process.env.MOBILE_MCP_IOS_TEAM_ID;
	process.env.MOBILE_MCP_IOS_TEAM_ID = "WORK123456";
	const launched: WebDriverAgent["args"][] = [];
	t.mock.method(WebDriverAgent.prototype, "launch", async function (this: WebDriverAgent) {
		launched.push(this.args);
	});
	const quit = t.mock.method(WebDriverAgent.prototype, "quit", async () => undefined);
	t.mock.method(globalThis, "fetch", async () =>
		new Response(JSON.stringify({ value: { ready: true } })),
	);
	let wda = new WdaController();
	const target = async () => ({ platformVersion: "18.0", tunnelAddress: "::1" });
	try {
		await wda.use("phone", target, async () => undefined);
		assert.equal(launched[0]?.xcodeOrgId, "WORK123456", "environment is the default");
		await assert.rejects(wda.setIosTeam("personal"), /10 uppercase/u);
		assert.equal(quit.mock.callCount(), 0, "invalid selection leaves the agent running");

		let startAction: () => void = () => undefined;
		const started = new Promise<void>((resolve) => { startAction = () => resolve(); });
		let finishAction: () => void = () => undefined;
		const finish = new Promise<void>((resolve) => { finishAction = () => resolve(); });
		const action = wda.use("phone", target, async () => {
			startAction();
			await finish;
		});
		await started;
		const selection = wda.setIosTeam("PERS123456");
		await Promise.resolve();
		assert.equal(quit.mock.callCount(), 0, "selection waits for the active action");
		finishAction();
		await Promise.all([action, selection]);
		assert.equal(quit.mock.callCount(), 1);
		await wda.use("phone", target, async () => undefined);
		assert.equal(launched[1]?.xcodeOrgId, "PERS123456");
		assert.equal(launched[1]?.updatedWDABundleId, "local.mobilemcp.PERS123456.WebDriverAgentRunner");
		assert.equal(launched[1]?.xcodeSigningId, "Apple Development");
		await wda.setIosTeam("PERS123456");
		await wda.use("phone", target, async () => undefined);
		assert.equal(launched.length, 2, "selecting the same team reuses the agent");
		await wda.setIosTeam("WORK123456");
		await wda.use("phone", target, async () => undefined);
		assert.equal(launched[2]?.xcodeOrgId, "WORK123456");
		assert.equal(process.env.MOBILE_MCP_IOS_TEAM_ID, "WORK123456");

		await wda.close();
		wda = new WdaController();
		launched.length = 0;
		delete process.env.MOBILE_MCP_IOS_TEAM_ID;
		await assert.rejects(wda.ensure("phone", target), /mobile_set_ios_team/u);
		await wda.setIosTeam("PERS123456");
		await wda.use("phone", target, async () => undefined);
		await wda.close();
		await wda.use("other-phone", target, async () => undefined);
		assert.deepEqual(launched.map((args) => args.xcodeOrgId), ["PERS123456", "PERS123456"]);
		assert.equal(process.env.MOBILE_MCP_IOS_TEAM_ID, undefined);
	} finally {
		await wda.close();
		if (original === undefined) delete process.env.MOBILE_MCP_IOS_TEAM_ID;
		else process.env.MOBILE_MCP_IOS_TEAM_ID = original;
	}
});

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
