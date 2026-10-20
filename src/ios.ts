import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, run, tailLines } from "./exec.js";

/** A screen recording that runs until stop() finalizes the file. */
export interface Recording {
	stop(): Promise<void>;
}

export type IosBiometricAction = "enroll" | "unenroll" | "match" | "fail";
export type IosOrientation =
	| "portrait"
	| "landscape"
	| "landscape-right"
	| "portrait-upside-down";

/** `devicectl device orientation set` names. */
const DEVICECTL_ORIENTATIONS: Record<IosOrientation, string> = {
	portrait: "portrait",
	landscape: "landscapeLeft",
	"landscape-right": "landscapeRight",
	"portrait-upside-down": "portraitUpsideDown",
};

const CRASH_FRAME_LIMIT = 25;

/**
 * Summarizes one `.ips` crash report if it belongs to `bundleId` on the
 * Simulator `udid`. Simulator crashes land in the host DiagnosticReports
 * folder; `coalitionName` is the only field that names the Simulator.
 */
export function summarizeIosCrash(
	text: string,
	bundleId: string,
	udid: string,
): string | undefined {
	const newline = text.indexOf("\n");
	if (newline === -1) return undefined;
	let header: Record<string, unknown>;
	let body: Record<string, unknown>;
	try {
		header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
		body = JSON.parse(text.slice(newline + 1)) as Record<string, unknown>;
	} catch {
		// Not an .ips v2 JSON report (older text format); it cannot be attributed.
		return undefined;
	}
	if (
		header.bundleID !== bundleId ||
		body.coalitionName !== `com.apple.CoreSimulator.SimDevice.${udid}`
	)
		return undefined;
	const exception = (body.exception ?? {}) as Record<string, unknown>;
	const termination = (body.termination ?? {}) as Record<string, unknown>;
	const images = Array.isArray(body.usedImages)
		? (body.usedImages as Array<{ name?: unknown }>)
		: [];
	const threads = Array.isArray(body.threads)
		? (body.threads as Array<{ frames?: unknown }>)
		: [];
	const faulting =
		typeof body.faultingThread === "number" ? body.faultingThread : 0;
	const frames = Array.isArray(threads[faulting]?.frames)
		? (threads[faulting].frames as Array<Record<string, unknown>>)
		: [];
	const lines = [
		`${String(header.timestamp ?? "unknown time")} ${String(header.name ?? bundleId)} ${String(header.app_version ?? "")}`.trim(),
		`Exception: ${[exception.type, exception.signal, exception.subtype].filter(Boolean).join(" ")}`,
		...(exception.message ? [`Message: ${String(exception.message)}`] : []),
		...(termination.indicator || termination.namespace
			? [
					`Termination: ${[termination.namespace, termination.indicator].filter(Boolean).join(" ")}`,
				]
			: []),
		`Faulting thread ${faulting}:`,
		...frames.slice(0, CRASH_FRAME_LIMIT).map((frame, index) => {
			const image =
				typeof frame.imageIndex === "number"
					? images[frame.imageIndex]?.name
					: undefined;
			return `  ${index} ${String(frame.symbol ?? `+${String(frame.imageOffset ?? "?")}`)} (${String(image ?? "?")})`;
		}),
	];
	return lines.join("\n");
}

export interface SimctlDevice {
	udid: string;
	name: string;
	state: string;
	isAvailable?: boolean;
}

export interface SimctlList {
	devices?: Record<string, SimctlDevice[]>;
}

export interface IosDevice {
	id: string;
	name: string;
	platform: "ios";
	state: "online" | "shutdown";
	version: string;
}

/** Cross-platform installed-app record shared with the Android controller. */
export interface MobileApp {
	appId: string;
	name: string;
	system: boolean;
}

export function parseIosApps(
	json: string,
	includeSystem: boolean,
): MobileApp[] {
	let parsed: Record<string, Record<string, unknown>>;
	try {
		parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
	} catch (error) {
		throw new Error(
			`simctl listapps returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return Object.entries(parsed)
		.flatMap(([appId, info]) => {
			const system = info.ApplicationType !== "User";
			if (system && !includeSystem) return [];
			const display = info.CFBundleDisplayName ?? info.CFBundleName;
			return [
				{
					appId,
					name: typeof display === "string" && display ? display : appId,
					system,
				},
			];
		})
		.sort((left, right) => left.appId.localeCompare(right.appId));
}

export function isAlreadyTerminated(error: unknown): boolean {
	return (
		error instanceof CommandError &&
		error.stderr.includes("found nothing to terminate")
	);
}

export function parseIosExecutable(appInfo: string): string {
	const match = /CFBundleExecutable = (?:"([^"]+)"|([^;]+));/u.exec(appInfo);
	const executable = (match?.[1] ?? match?.[2])?.trim();
	if (!executable)
		throw new Error("simctl appinfo did not return CFBundleExecutable");
	return executable;
}

function runtimeVersion(runtime: string): string {
	const suffix = runtime.split(".SimRuntime.iOS-").at(-1) ?? runtime;
	return suffix.replaceAll("-", ".");
}

export function parseIosDevices(parsed: SimctlList): IosDevice[] {
	return Object.entries(parsed.devices ?? {}).flatMap(([runtime, devices]) => {
		if (!runtime.includes(".SimRuntime.iOS-")) return [];
		return devices.flatMap((device) =>
			device.isAvailable === false
				? []
				: [
						{
							id: `ios:${device.udid}`,
							name: device.name,
							platform: "ios" as const,
							state:
								device.state === "Booted"
									? ("online" as const)
									: ("shutdown" as const),
							version: runtimeVersion(runtime),
						},
					],
		);
	});
}

export class IosController {
	private simctl(
		args: readonly string[],
		timeoutMs = 30_000,
		maxBuffer = 2 * 1024 * 1024,
		input?: string,
	) {
		return run("xcrun", ["simctl", ...args], {
			timeoutMs,
			maxBuffer,
			...(input === undefined ? {} : { input }),
		});
	}

	async listDevices(): Promise<IosDevice[]> {
		const { stdout } = await this.simctl(["list", "devices", "--json"]);
		let parsed: SimctlList;
		try {
			parsed = JSON.parse(stdout) as SimctlList;
		} catch (error) {
			throw new Error(
				`simctl returned invalid device JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return parseIosDevices(parsed);
	}

	async getDevice(udid: string): Promise<IosDevice> {
		const found = (await this.listDevices()).find(
			(device) => device.id === `ios:${udid}`,
		);
		if (!found) throw new Error(`iOS Simulator ${udid} is not available`);
		return found;
	}

	async boot(udid: string, timeoutMs: number): Promise<void> {
		const device = await this.getDevice(udid);
		if (device.state !== "online") await this.simctl(["boot", udid], timeoutMs);
		await this.simctl(["bootstatus", udid, "-b"], timeoutMs);
	}

	async shutdown(udid: string): Promise<void> {
		const device = await this.getDevice(udid);
		if (device.state === "online") await this.simctl(["shutdown", udid]);
	}

	async install(udid: string, appPath: string): Promise<void> {
		await this.simctl(["install", udid, appPath], 120_000);
	}

	async launch(
		udid: string,
		bundleId: string,
		options: {
			arguments?: readonly string[];
			environment?: Record<string, string>;
			locale?: string;
		} = {},
	): Promise<void> {
		// Foundation reads these argument-domain defaults for per-launch language.
		const localeArgs = options.locale
			? [
					"-AppleLanguages",
					`(${options.locale.replaceAll("_", "-")})`,
					"-AppleLocale",
					options.locale.replaceAll("-", "_"),
				]
			: [];
		// simctl forwards SIMCTL_CHILD_<NAME> host variables to the launched app.
		const childEnv = Object.fromEntries(
			Object.entries(options.environment ?? {}).map(([key, value]) => [
				`SIMCTL_CHILD_${key}`,
				value,
			]),
		);
		await run(
			"xcrun",
			[
				"simctl",
				"launch",
				"--terminate-running-process",
				udid,
				bundleId,
				...localeArgs,
				...(options.arguments ?? []),
			],
			{ env: { ...process.env, ...childEnv } },
		);
	}

	/** CoreDevice control; Xcode 27 `devicectl` also drives Simulators. */
	private async devicectl(udid: string, args: readonly string[]): Promise<void> {
		try {
			await run("xcrun", ["devicectl", ...args, "--device", udid], {
				timeoutMs: 60_000,
			});
		} catch (error) {
			if (
				error instanceof CommandError &&
				/unexpected argument|not a valid|unknown (sub)?command/iu.test(
					error.stderr + error.stdout,
				)
			)
				throw new Error(
					`This control needs Xcode 27 or newer (xcrun devicectl ${args.slice(0, 3).join(" ")}); ${error.message}`,
				);
			throw error;
		}
	}

	async setBiometric(udid: string, action: IosBiometricAction): Promise<void> {
		const args = {
			enroll: ["device", "settings", "biometrics", "--enable"],
			unenroll: ["device", "settings", "biometrics", "--disable"],
			match: ["device", "simulate", "biometrics", "--success"],
			fail: ["device", "simulate", "biometrics", "--failure"],
		}[action];
		await this.devicectl(udid, args);
	}

	async setOrientation(udid: string, orientation: IosOrientation): Promise<void> {
		await this.devicectl(udid, [
			"device",
			"orientation",
			"set",
			DEVICECTL_ORIENTATIONS[orientation],
		]);
	}

	async setMotionAndTransparency(
		udid: string,
		settings: { reduceMotion?: boolean; reduceTransparency?: boolean },
	): Promise<void> {
		const onOff = (value: boolean) => (value ? "on" : "off");
		await this.devicectl(udid, [
			"device",
			"settings",
			"appearance",
			...(settings.reduceMotion === undefined
				? []
				: ["--reduce-motion", onOff(settings.reduceMotion)]),
			...(settings.reduceTransparency === undefined
				? []
				: ["--reduce-transparency", onOff(settings.reduceTransparency)]),
		]);
	}

	async setVoiceOver(udid: string, enabled: boolean): Promise<void> {
		await this.devicectl(udid, [
			"device",
			"settings",
			"voiceover",
			enabled ? "--enable" : "--disable",
		]);
	}

	async startLocationRoute(
		udid: string,
		waypoints: ReadonlyArray<{ latitude: number; longitude: number }>,
		speedMetersPerSecond: number,
	): Promise<void> {
		await this.simctl([
			"location",
			udid,
			"start",
			`--speed=${speedMetersPerSecond}`,
			...waypoints.map(({ latitude, longitude }) => `${latitude},${longitude}`),
		]);
	}

	async keychain(
		udid: string,
		action: "add-root-cert" | "add-cert" | "reset",
		certificatePath?: string,
	): Promise<void> {
		await this.simctl([
			"keychain",
			udid,
			action,
			...(certificatePath ? [certificatePath] : []),
		]);
	}

	/** simctl records until SIGINT; it then finalizes the file and exits 0. */
	async startVideo(udid: string, outputPath: string): Promise<Recording> {
		const child = spawn(
			"xcrun",
			["simctl", "io", udid, "recordVideo", "--codec=h264", outputPath],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const started = new Promise<void>((resolve) => {
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < 10_000) stderr += chunk.toString();
				if (stderr.includes("Recording started")) resolve();
			});
		});
		const startTimeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
		try {
			const first = await Promise.race([started.then(() => "started"), exited]);
			if (first !== "started")
				throw new Error(`simctl recordVideo did not start: ${stderr.trim()}`);
		} catch (error) {
			if (child.exitCode === null) child.kill("SIGKILL");
			throw error;
		} finally {
			clearTimeout(startTimeout);
		}
		return {
			stop: async () => {
				child.kill("SIGINT");
				const stopTimeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
				try {
					const code = await exited;
					if (code !== 0)
						throw new Error(
							`simctl recordVideo exited with ${String(code)}: ${stderr.trim()}`,
						);
				} finally {
					clearTimeout(stopTimeout);
				}
			},
		};
	}

	async crashReports(
		udid: string,
		bundleId: string,
		sinceMinutes: number,
	): Promise<string[]> {
		const folder = join(homedir(), "Library", "Logs", "DiagnosticReports");
		const since = Date.now() - sinceMinutes * 60_000;
		const names = await readdir(folder).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		});
		const recent = (
			await Promise.all(
				names
					.filter((name) => name.endsWith(".ips"))
					.map(async (name) => {
						const path = join(folder, name);
						const { mtimeMs } = await stat(path);
						return { path, mtimeMs };
					}),
			)
		)
			.filter(({ mtimeMs }) => mtimeMs >= since)
			.sort((left, right) => right.mtimeMs - left.mtimeMs);
		const summaries = await Promise.all(
			recent.map(async ({ path }) =>
				summarizeIosCrash(await readFile(path, "utf8"), bundleId, udid),
			),
		);
		return summaries.filter((summary): summary is string => Boolean(summary));
	}

	async terminate(udid: string, bundleId: string): Promise<void> {
		await this.simctl(["terminate", udid, bundleId]).catch((error: unknown) => {
			if (!isAlreadyTerminated(error)) throw error;
		});
	}

	async resetAppData(udid: string, bundleId: string): Promise<void> {
		await this.uninstall(udid, bundleId);
	}

	async uninstall(udid: string, bundleId: string): Promise<void> {
		await this.simctl(["uninstall", udid, bundleId]);
	}

	async erase(udid: string): Promise<void> {
		await this.shutdown(udid);
		await this.simctl(["erase", udid], 120_000);
	}

	async getLogs(
		udid: string,
		bundleId: string,
		sinceMinutes: number,
		maxLines: number,
	): Promise<string> {
		const appInfo = await this.simctl(["appinfo", udid, bundleId]);
		const executable = parseIosExecutable(appInfo.stdout);
		const { stdout } = await this.simctl(
			[
				"spawn",
				udid,
				"log",
				"show",
				"--style",
				"compact",
				"--last",
				`${sinceMinutes}m`,
				"--process",
				executable,
			],
			30_000,
			// `--last 60m` on a chatty process (e.g. CFNetwork debug spam) can
			// produce well over the previous 4 MB cap before it's sliced down
			// to maxLines below, so simctl gets killed for exceeding maxBuffer.
			32 * 1024 * 1024,
		);
		return tailLines(stdout, maxLines);
	}

	async listApps(udid: string, includeSystem: boolean): Promise<MobileApp[]> {
		const { stdout } = await this.simctl(
			["listapps", udid],
			30_000,
			16 * 1024 * 1024,
		);
		// simctl emits an old-style plist; plutil is Apple's supported converter.
		const { stdout: json } = await run(
			"plutil",
			["-convert", "json", "-o", "-", "-"],
			{ input: stdout, maxBuffer: 16 * 1024 * 1024 },
		);
		return parseIosApps(json, includeSystem);
	}

	async getAppearance(udid: string): Promise<string> {
		return (await this.simctl(["ui", udid, "appearance"])).stdout.trim();
	}

	async setAppearance(udid: string, mode: "light" | "dark"): Promise<void> {
		await this.simctl(["ui", udid, "appearance", mode]);
	}

	async setContentSize(udid: string, size: string): Promise<void> {
		await this.simctl(["ui", udid, "content_size", size]);
	}

	async setIncreaseContrast(udid: string, enabled: boolean): Promise<void> {
		await this.simctl([
			"ui",
			udid,
			"increase_contrast",
			enabled ? "enabled" : "disabled",
		]);
	}

	async addMedia(udid: string, paths: readonly string[]): Promise<void> {
		await this.simctl(["addmedia", udid, ...paths], 120_000);
	}

	async setPermission(
		udid: string,
		bundleId: string,
		service: string,
		action: "grant" | "revoke" | "reset",
	): Promise<void> {
		await this.simctl(["privacy", udid, action, service, bundleId]);
	}

	async setLocation(
		udid: string,
		location?: { latitude: number; longitude: number },
	): Promise<void> {
		await this.simctl(
			location
				? [
						"location",
						udid,
						"set",
						`${location.latitude},${location.longitude}`,
					]
				: ["location", udid, "clear"],
		);
	}

	async sendPush(
		udid: string,
		bundleId: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		const output = join(tmpdir(), `mobile-mcp-${randomUUID()}.apns`);
		try {
			await writeFile(output, JSON.stringify(payload));
			await this.simctl(["push", udid, bundleId, output]);
		} finally {
			await unlink(output).catch(() => undefined);
		}
	}

	async setClipboard(udid: string, text: string): Promise<void> {
		await this.simctl(["pbcopy", udid], 30_000, 2 * 1024 * 1024, text);
	}

	async getClipboard(udid: string): Promise<string> {
		return (await this.simctl(["pbpaste", udid])).stdout;
	}

	async setStatusBar(
		udid: string,
		action: "clear" | "override",
		args: readonly string[] = [],
	): Promise<void> {
		await this.simctl(["status_bar", udid, action, ...args]);
	}

	async openUrl(udid: string, url: string): Promise<void> {
		await this.simctl(["openurl", udid, url]);
	}

	async screenshot(udid: string): Promise<Buffer> {
		// Xcode 26 documents `-` as stdout but writes a literal file named `-`.
		const output = join(tmpdir(), `mobile-mcp-${randomUUID()}.png`);
		try {
			await this.simctl(["io", udid, "screenshot", "--type=png", output]);
			return await readFile(output);
		} finally {
			// safe to ignore: temp cleanup must not hide the screenshot result.
			await unlink(output).catch(() => undefined);
		}
	}
}
