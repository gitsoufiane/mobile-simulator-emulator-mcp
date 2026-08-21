import { randomUUID } from "node:crypto";
import { WebDriverAgent } from "appium-webdriveragent";

const WDA_URL = "http://127.0.0.1:8100";
const HTTP_TIMEOUT_MS = 30_000;

type WdaLogger = NonNullable<ConstructorParameters<typeof WebDriverAgent>[1]>;

function logError(...args: unknown[]): void {
	process.stderr.write(`[WebDriverAgent] ${args.map(String).join(" ")}\n`);
}

const stderrLogger: WdaLogger = {
	level: "error",
	levels: ["silly", "verbose", "debug", "info", "http", "warn", "error"],
	debug: () => undefined,
	info: () => undefined,
	warn: logError,
	error: logError,
	verbose: () => undefined,
	silly: () => undefined,
	http: () => undefined,
	errorAndThrow: (...args: unknown[]): never => {
		throw new Error(args.map(String).join(" "));
	},
	errorWithException: (...args: unknown[]): Error =>
		new Error(args.map(String).join(" ")),
	updateAsyncContext: () => undefined,
	unwrap: () => {
		throw new Error("The wrapped Appium logger is not exposed");
	},
};

interface WdaResponse {
	value?: unknown;
}

function object(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`WebDriverAgent returned invalid ${context}`);
	}
	return value as Record<string, unknown>;
}

export class WdaController {
	private agent: WebDriverAgent | undefined;
	private udid: string | undefined;
	private operationQueue: Promise<void> = Promise.resolve();

	private async request(
		path: string,
		init?: RequestInit,
	): Promise<WdaResponse> {
		const requestInit: RequestInit = {
			...init,
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		};
		if (init?.body) {
			const headers = new Headers(init.headers);
			headers.set("content-type", "application/json");
			requestInit.headers = headers;
		}
		const response = await fetch(`${WDA_URL}${path}`, requestInit);
		const text = await response.text();
		let payload: WdaResponse = {};
		if (text) {
			try {
				payload = JSON.parse(text) as WdaResponse;
			} catch {
				throw new Error(
					`WebDriverAgent returned non-JSON HTTP ${response.status}`,
				);
			}
		}
		if (!response.ok) {
			const message = object(payload, "error response").value;
			throw new Error(
				`WebDriverAgent HTTP ${response.status}: ${JSON.stringify(message ?? payload)}`,
			);
		}
		return payload;
	}

	private async isReady(): Promise<boolean> {
		try {
			const response = await this.request("/status");
			return object(response.value, "status").ready === true;
		} catch {
			// Readiness probes intentionally collapse transport and HTTP failures.
			return false;
		}
	}

	async status(): Promise<{ running: boolean; device?: string }> {
		return {
			running: await this.isReady(),
			...(this.udid ? { device: `ios:${this.udid}` } : {}),
		};
	}

	isBoundTo(udid: string): boolean {
		return this.udid === udid;
	}

	async ensure(udid: string, platformVersion: string): Promise<void> {
		if (this.agent && this.udid === udid && (await this.isReady())) return;
		await this.stopAgent();
		this.agent = new WebDriverAgent(
			{
				device: { udid },
				platformVersion,
				iosSdkVersion: platformVersion,
				host: "127.0.0.1",
				wdaBindingIP: "127.0.0.1",
				wdaLocalPort: 8100,
				wdaRemotePort: 8100,
				realDevice: false,
				showXcodeLog: process.env.MOBILE_MCP_SHOW_XCODE_LOG === "1",
				wdaLaunchTimeout: 180_000,
			},
			stderrLogger,
		);
		this.udid = udid;
		try {
			await this.agent.launch(randomUUID());
			if (!(await this.isReady()))
				throw new Error("WebDriverAgent did not become ready");
		} catch (error) {
			await this.stopAgent();
			throw error;
		}
	}

	async use<T>(
		udid: string,
		platformVersion: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const result = this.operationQueue.then(async () => {
			await this.ensure(udid, platformVersion);
			return operation();
		});
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async withSession<T>(
		operation: (sessionPath: string) => Promise<T>,
	): Promise<T> {
		const created = await this.request("/session", {
			method: "POST",
			body: JSON.stringify({
				capabilities: { alwaysMatch: { platformName: "iOS" } },
			}),
		});
		const sessionId = object(created.value, "session").sessionId;
		if (typeof sessionId !== "string" || !sessionId)
			throw new Error("WebDriverAgent did not return a session ID");
		const path = `/session/${encodeURIComponent(sessionId)}`;
		try {
			return await operation(path);
		} finally {
			await this.request(path, { method: "DELETE" }).catch((error: unknown) =>
				logError("Session cleanup failed:", error),
			);
		}
	}

	async uiTree(): Promise<string> {
		const response = await this.request("/source/?format=json");
		return JSON.stringify(response.value);
	}

	async activeAppInfo(): Promise<{ appId: string; processId?: number }> {
		const response = await this.request("/wda/activeAppInfo");
		const info = object(response.value, "active app info");
		if (typeof info.bundleId !== "string" || !info.bundleId)
			throw new Error("WebDriverAgent did not return a foreground bundle ID");
		return {
			appId: info.bundleId,
			...(typeof info.pid === "number" ? { processId: info.pid } : {}),
		};
	}

	async getOrientation(): Promise<string> {
		const { value } = await this.request("/orientation");
		if (typeof value !== "string")
			throw new Error("WebDriverAgent returned an invalid orientation");
		return value;
	}

	async setOrientation(orientation: string): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/orientation`, {
				method: "POST",
				body: JSON.stringify({ orientation }),
			});
		});
	}

	async screenInfo(): Promise<{
		width: number;
		height: number;
		orientation: string;
	}> {
		const size = await this.withSession((sessionPath) =>
			this.screenSize(sessionPath),
		);
		return { ...size, orientation: await this.getOrientation() };
	}

	async longPress(x: number, y: number, durationMs: number): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.validatePoint(sessionPath, x, y);
			// WDA's touchAndHold duration is expressed in seconds.
			await this.request(`${sessionPath}/wda/touchAndHold`, {
				method: "POST",
				body: JSON.stringify({ x, y, duration: durationMs / 1_000 }),
			});
		});
	}

	private async screenSize(
		sessionPath: string,
	): Promise<{ width: number; height: number }> {
		const response = await this.request(`${sessionPath}/wda/screen`);
		const size = object(
			object(response.value, "screen").screenSize,
			"screen size",
		);
		if (typeof size.width !== "number" || typeof size.height !== "number") {
			throw new Error("WebDriverAgent returned an invalid screen size");
		}
		return { width: size.width, height: size.height };
	}

	private async validatePoint(
		sessionPath: string,
		x: number,
		y: number,
	): Promise<void> {
		const { width, height } = await this.screenSize(sessionPath);
		if (x >= width || y >= height)
			throw new Error(
				`Coordinates (${x}, ${y}) exceed screen size ${width}x${height}`,
			);
	}

	private async actions(
		actions: Record<string, unknown>[],
		points: Array<[number, number]>,
	): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await Promise.all(
				points.map(([x, y]) => this.validatePoint(sessionPath, x, y)),
			);
			await this.request(`${sessionPath}/actions`, {
				method: "POST",
				body: JSON.stringify({
					actions: [
						{
							type: "pointer",
							id: "finger1",
							parameters: { pointerType: "touch" },
							actions,
						},
					],
				}),
			});
		});
	}

	async tap(x: number, y: number): Promise<void> {
		await this.actions(
			[
				{ type: "pointerMove", duration: 0, x, y },
				{ type: "pointerDown", button: 0 },
				{ type: "pause", duration: 80 },
				{ type: "pointerUp", button: 0 },
			],
			[[x, y]],
		);
	}

	async swipe(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		durationMs: number,
	): Promise<void> {
		await this.actions(
			[
				{ type: "pointerMove", duration: 0, x: fromX, y: fromY },
				{ type: "pointerDown", button: 0 },
				{ type: "pointerMove", duration: durationMs, x: toX, y: toY },
				{ type: "pointerUp", button: 0 },
			],
			[
				[fromX, fromY],
				[toX, toY],
			],
		);
	}

	async typeText(text: string): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/wda/keys`, {
				method: "POST",
				body: JSON.stringify({ value: [text] }),
			});
		});
	}

	async pressKey(
		key: "HOME" | "ENTER" | "DELETE" | "VOLUME_UP" | "VOLUME_DOWN",
	): Promise<void> {
		// WDA exposes no hardware button for these; the keyboard endpoint is
		// the supported way to deliver Return and Backspace.
		if (key === "ENTER" || key === "DELETE") {
			await this.typeText(key === "ENTER" ? "\n" : "\u0008");
			return;
		}
		const names = {
			HOME: "home",
			VOLUME_UP: "volumeup",
			VOLUME_DOWN: "volumedown",
		} as const;
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/wda/pressButton`, {
				method: "POST",
				body: JSON.stringify({ name: names[key] }),
			});
		});
	}

	private async stopAgent(): Promise<void> {
		const agent = this.agent;
		this.agent = undefined;
		this.udid = undefined;
		if (agent)
			await agent
				.quit()
				.catch((error: unknown) => logError("Cleanup failed:", error));
	}

	async close(): Promise<void> {
		await this.operationQueue;
		await this.stopAgent();
	}
}
