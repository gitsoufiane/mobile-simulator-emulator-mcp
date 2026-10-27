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

/** W3C error from WebDriverAgent; `code` is the W3C `error` string. */
export class WdaError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | undefined,
	) {
		super(message);
		this.name = "WdaError";
	}
}

export function isInvalidSession(error: unknown): boolean {
	return error instanceof WdaError && error.code === "invalid session id";
}

function object(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`WebDriverAgent returned invalid ${context}`);
	}
	return value as Record<string, unknown>;
}

/** What WDA needs to start; `tunnelAddress` is set only for a physical device. */
export interface WdaTarget {
	platformVersion: string;
	tunnelAddress?: string;
}

export class WdaController {
	private agent: WebDriverAgent | undefined;
	private udid: string | undefined;
	private sessionPath: string | undefined;
	private operationQueue: Promise<void> = Promise.resolve();
	private baseUrl: string;

	/** `defaultUrl` exists for tests; a Simulator agent always binds port 8100. */
	constructor(private readonly defaultUrl = WDA_URL) {
		this.baseUrl = defaultUrl;
	}

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
		const response = await fetch(`${this.baseUrl}${path}`, requestInit);
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
			const detail = object(payload, "error response").value;
			const code =
				detail && typeof detail === "object" && "error" in detail
					? String(detail.error)
					: undefined;
			// W3C errors carry {error, message, traceback}; the Objective-C
			// traceback is noise for an agent, so report only code and message.
			const message =
				detail && typeof detail === "object" && "message" in detail
					? `${code ?? "error"}: ${String(detail.message)}`
					: JSON.stringify(detail ?? payload);
			throw new WdaError(
				`WebDriverAgent HTTP ${response.status} ${message}`,
				response.status,
				code,
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

	/**
	 * Starts WDA for `udid` unless it is already serving that device. The
	 * target is resolved lazily because it costs a device-list call that a
	 * warm agent never needs.
	 */
	async ensure(
		udid: string,
		resolveTarget: () => Promise<WdaTarget>,
	): Promise<void> {
		if (this.agent && this.udid === udid && (await this.isReady())) return;
		await this.stopAgent();
		const { platformVersion, tunnelAddress } = await resolveTarget();
		const teamId = process.env.MOBILE_MCP_IOS_TEAM_ID ?? "";
		if (tunnelAddress && !/^[A-Z0-9]{10}$/u.test(teamId))
			throw new Error(
				"Physical iOS devices need MOBILE_MCP_IOS_TEAM_ID: the 10-character Apple Developer team ID that Xcode uses to sign WebDriverAgent",
			);
		const common = {
			device: { udid },
			platformVersion,
			iosSdkVersion: platformVersion,
			wdaLocalPort: 8100,
			wdaRemotePort: 8100,
			showXcodeLog: process.env.MOBILE_MCP_SHOW_XCODE_LOG === "1",
		};
		this.agent = new WebDriverAgent(
			tunnelAddress
				? {
						...common,
						xcodeOrgId: teamId,
						xcodeSigningId: "Apple Development",
						updatedWDABundleId: `local.mobilemcp.${teamId}.WebDriverAgentRunner`,
						realDevice: true,
						allowProvisioningDeviceRegistration: true,
						// Bind only to the private USB/Wi-Fi CoreDevice tunnel, not the LAN.
						wdaBindingIP: tunnelAddress,
						// The first build also signs and installs WDA on the device.
						wdaLaunchTimeout: 300_000,
					}
				: {
						...common,
						host: "127.0.0.1",
						wdaBindingIP: "127.0.0.1",
						realDevice: false,
						wdaLaunchTimeout: 180_000,
					},
			stderrLogger,
		);
		if (tunnelAddress) {
			// The package joins wdaBindingIP and port without IPv6 brackets.
			this.baseUrl = `http://[${tunnelAddress}]:8100`;
			this.agent.url = this.baseUrl;
		}
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
		resolveTarget: () => Promise<WdaTarget>,
		operation: () => Promise<T>,
	): Promise<T> {
		const result = this.operationQueue.then(async () => {
			await this.ensure(udid, resolveTarget);
			return operation();
		});
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async createSession(): Promise<string> {
		const created = await this.request("/session", {
			method: "POST",
			body: JSON.stringify({
				capabilities: { alwaysMatch: { platformName: "iOS" } },
			}),
		});
		const sessionId = object(created.value, "session").sessionId;
		if (typeof sessionId !== "string" || !sessionId)
			throw new Error("WebDriverAgent did not return a session ID");
		return `/session/${encodeURIComponent(sessionId)}`;
	}

	/**
	 * WDA serves one session at a time, so reuse it instead of paying a
	 * create/delete round trip per gesture. WDA rejects a stale session during
	 * routing, before the command runs, so one retry cannot repeat an action.
	 */
	private async withSession<T>(
		operation: (sessionPath: string) => Promise<T>,
	): Promise<T> {
		this.sessionPath ??= await this.createSession();
		try {
			return await operation(this.sessionPath);
		} catch (error) {
			if (!isInvalidSession(error)) throw error;
			this.sessionPath = await this.createSession();
			return operation(this.sessionPath);
		}
	}

	async source(): Promise<unknown> {
		// WDA 16's router rejects the trailing-slash `/source/` form.
		return (await this.request("/source?format=json")).value;
	}

	async screenshot(): Promise<Buffer> {
		// The caller's PNG check rejects a missing or broken value.
		return Buffer.from(String((await this.request("/screenshot")).value), "base64");
	}

	async openUrl(url: string): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/url`, {
				method: "POST",
				body: JSON.stringify({ url }),
			});
		});
	}

	async uiTree(): Promise<string> {
		return JSON.stringify(await this.source());
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
		await this.request("/orientation", {
			method: "POST",
			body: JSON.stringify({ orientation }),
		});
	}

	async screenInfo(): Promise<{
		width: number;
		height: number;
		orientation: string;
	}> {
		const [size, orientation] = await Promise.all([
			this.screenSize(),
			this.getOrientation(),
		]);
		return { ...size, orientation };
	}

	async longPress(x: number, y: number, durationMs: number): Promise<void> {
		await this.validatePoint(x, y);
		await this.withSession(async (sessionPath) => {
			// WDA's touchAndHold duration is expressed in seconds.
			await this.request(`${sessionPath}/wda/touchAndHold`, {
				method: "POST",
				body: JSON.stringify({ x, y, duration: durationMs / 1_000 }),
			});
		});
	}

	private async screenSize(): Promise<{ width: number; height: number }> {
		const response = await this.request("/wda/screen");
		const size = object(
			object(response.value, "screen").screenSize,
			"screen size",
		);
		if (typeof size.width !== "number" || typeof size.height !== "number") {
			throw new Error("WebDriverAgent returned an invalid screen size");
		}
		return { width: size.width, height: size.height };
	}

	private async validatePoint(...points: number[]): Promise<void> {
		const { width, height } = await this.screenSize();
		for (let index = 0; index < points.length; index += 2) {
			const x = points[index] ?? 0;
			const y = points[index + 1] ?? 0;
			if (x >= width || y >= height)
				throw new Error(
					`Coordinates (${x}, ${y}) exceed screen size ${width}x${height}`,
				);
		}
	}

	private async actions(
		actions: Record<string, unknown>[],
		points: number[],
	): Promise<void> {
		await this.validatePoint(...points);
		await this.withSession(async (sessionPath) => {
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

	async doubleTap(x: number, y: number): Promise<void> {
		await this.validatePoint(x, y);
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/wda/doubleTap`, {
				method: "POST",
				body: JSON.stringify({ x, y }),
			});
		});
	}

	/** Button labels of the visible alert, or [] when no alert is open. */
	async alertButtons(): Promise<string[]> {
		try {
			const { value } = await this.withSession((sessionPath) =>
				this.request(`${sessionPath}/wda/alert/buttons`),
			);
			return Array.isArray(value) ? value.map(String) : [];
		} catch (error) {
			if (error instanceof WdaError && error.code === "no such alert") return [];
			throw error;
		}
	}

	async handleAlert(
		action: "accept" | "dismiss",
		button?: string,
	): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/alert/${action}`, {
				method: "POST",
				body: JSON.stringify(button ? { name: button } : {}),
			});
		});
	}

	async dismissKeyboard(): Promise<void> {
		await this.withSession(async (sessionPath) => {
			await this.request(`${sessionPath}/wda/keyboard/dismiss`, {
				method: "POST",
				body: JSON.stringify({}),
			});
		});
	}

	async setLocked(locked: boolean): Promise<boolean> {
		await this.request(locked ? "/wda/lock" : "/wda/unlock", {
			method: "POST",
			body: JSON.stringify({}),
		});
		return (await this.request("/wda/locked")).value === true;
	}

	/** XCUIApplication.performAccessibilityAudit (iOS 17+) on the foreground app. */
	async accessibilityAudit(auditTypes: readonly string[]): Promise<
		Array<{
			auditType: string;
			description: string;
			detail?: string;
			element?: { type?: string; label?: string; rect?: unknown };
		}>
	> {
		const { value } = await this.withSession((sessionPath) =>
			this.request(`${sessionPath}/wda/performAccessibilityAudit`, {
				method: "POST",
				body: JSON.stringify(auditTypes.length ? { auditTypes } : {}),
			}),
		);
		if (!Array.isArray(value))
			throw new Error("WebDriverAgent returned an invalid accessibility audit");
		return value.map((raw) => {
			const issue = object(raw, "audit issue");
			const attributes =
				issue.elementAttributes && typeof issue.elementAttributes === "object"
					? (issue.elementAttributes as Record<string, unknown>)
					: {};
			const text = (key: string) =>
				typeof attributes[key] === "string" && attributes[key]
					? { [key]: attributes[key] as string }
					: {};
			const detail = String(issue.detailedDescription ?? "");
			return {
				auditType: String(issue.auditType ?? "unknown"),
				description: String(issue.compactDescription || detail),
				...(detail ? { detail } : {}),
				element: {
					...text("type"),
					...text("label"),
					...(attributes.rect ? { rect: attributes.rect } : {}),
				},
			};
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
			[x, y],
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
			[fromX, fromY, toX, toY],
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
		this.sessionPath = undefined;
		this.baseUrl = this.defaultUrl;
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
