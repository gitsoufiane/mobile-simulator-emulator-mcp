import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { run, runBinary, sleep, tailLines } from "./exec.js";
import type { MobileApp } from "./ios.js";

export interface AndroidDevice {
	id: string;
	name: string;
	platform: "android";
	state: "online" | "offline" | "shutdown";
	version?: string;
	avd?: string;
}

export const KEYCODES = {
	HOME: "KEYCODE_HOME",
	BACK: "KEYCODE_BACK",
	ENTER: "KEYCODE_ENTER",
	APP_SWITCH: "KEYCODE_APP_SWITCH",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
	DELETE: "KEYCODE_DEL",
	TAB: "KEYCODE_TAB",
	ESCAPE: "KEYCODE_ESCAPE",
	MENU: "KEYCODE_MENU",
	SEARCH: "KEYCODE_SEARCH",
	POWER: "KEYCODE_POWER",
	DPAD_UP: "KEYCODE_DPAD_UP",
	DPAD_DOWN: "KEYCODE_DPAD_DOWN",
	DPAD_LEFT: "KEYCODE_DPAD_LEFT",
	DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
	DPAD_CENTER: "KEYCODE_DPAD_CENTER",
	NOTIFICATIONS: "KEYCODE_NOTIFICATION",
} as const satisfies Record<string, string>;

/** `wm user-rotation lock <n>` values. */
const ROTATIONS = {
	portrait: "0",
	landscape: "1",
	"portrait-upside-down": "2",
	"landscape-right": "3",
} as const;
export type AndroidOrientation = keyof typeof ROTATIONS | "auto";

export const ANDROID_SENSORS = [
	"acceleration",
	"gyroscope",
	"magnetic-field",
	"orientation",
	"temperature",
	"proximity",
	"light",
	"pressure",
	"humidity",
] as const;

export type AndroidKey = keyof typeof KEYCODES;

function sdkBinary(relativePath: string, fallback: string): string {
	const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
	if (!sdk) return fallback;
	const suffix = process.platform === "win32" ? ".exe" : "";
	const candidate = join(sdk, ...relativePath.split("/")) + suffix;
	return existsSync(candidate) ? candidate : fallback;
}

export function quoteAndroidShellArgument(value: string): string {
	if (/[\0\n\r]/u.test(value))
		throw new Error(
			"Android shell arguments cannot contain control characters",
		);
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function parseAndroidPackages(stdout: string): string[] {
	return stdout
		.split(/\r?\n/u)
		.flatMap((line) => {
			const name = line.trim().startsWith("package:")
				? line.trim().slice("package:".length).trim()
				: "";
			return name ? [name] : [];
		})
		.sort((left, right) => left.localeCompare(right));
}

/**
 * `mCurrentFocus` is authoritative when a window has focus, but it reads
 * `null` while the device is locked or animating, so `mFocusedApp` is the
 * documented fallback for the activity that owns the foreground task.
 */
export function parseAndroidForegroundApp(stdout: string): {
	appId: string;
	activity?: string;
} {
	const focus =
		/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/u.exec(
			stdout,
		) ??
		/mFocusedApp=ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)[\s}]/u.exec(
			stdout,
		);
	if (!focus?.[1])
		throw new Error("Could not read a foreground app from dumpsys window");
	return { appId: focus[1], ...(focus[2] ? { activity: focus[2] } : {}) };
}

/**
 * `uiautomator dump` and `adb exec-out cat` both exit 0 on failure, so their
 * output is the only signal that a dump actually happened. Without these
 * checks a "No such file" message is returned as if it were the UI tree.
 */
export function validateAndroidUiTree(
	dump: string,
	tree: string,
	remotePath: string,
): string {
	validateAndroidUiDump(dump, remotePath);
	if (!tree.includes("<hierarchy")) {
		throw new Error(
			`Android returned no UI hierarchy: ${tree.trim().slice(0, 200) || "empty output"}`,
		);
	}
	return tree;
}

export function validateAndroidUiDump(dump: string, remotePath: string): void {
	if (!dump.includes(remotePath)) {
		throw new Error(
			`uiautomator could not dump the UI (is the screen on and unlocked?): ${dump.trim() || "no output"}`,
		);
	}
}

/**
 * `wm size` reports the unrotated panel; `cur=` in `dumpsys window displays`
 * is the current logical size, which is what `input tap` coordinates use.
 */
export function parseAndroidDisplaySize(
	displays: string,
): { width: number; height: number } | undefined {
	const match = /\bcur=(\d+)x(\d+)/u.exec(displays);
	return match?.[1] && match[2]
		? { width: Number(match[1]), height: Number(match[2]) }
		: undefined;
}

export function parseAndroidSnapshots(stdout: string): string[] {
	return stdout.split(/\r?\n/u).flatMap((line) => {
		const tag = /^\S+\s+(\S+)\s+\S+\s+\d{4}-\d\d-\d\d\s/u.exec(line)?.[1];
		return tag ? [tag] : [];
	});
}

function safeMediaName(path: string): string {
	const name = basename(path);
	if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name))
		throw new Error(
			`Media file name must be 1-128 characters of A-Z a-z 0-9 . _ - : ${name}`,
		);
	return name;
}

const UI_DUMP_ATTEMPTS = 3;
const UI_DUMP_RETRY_MS = 500;

export class AndroidController {
	readonly adb = sdkBinary("platform-tools/adb", "adb");
	readonly emulator = sdkBinary("emulator/emulator", "emulator");
	private bootQueue: Promise<void> = Promise.resolve();

	private command(
		serial: string,
		args: readonly string[],
		timeoutMs = 30_000,
		maxBuffer = 2 * 1024 * 1024,
	) {
		return run(this.adb, ["-s", serial, ...args], { timeoutMs, maxBuffer });
	}

	/** The emulator console exits 0 and prints `KO: <reason>` on failure. */
	private async emu(serial: string, args: readonly string[], timeoutMs = 30_000) {
		const result = await this.command(serial, ["emu", ...args], timeoutMs);
		const failure = /^KO:\s*(.*)$/mu.exec(result.stdout)?.[1];
		if (failure !== undefined)
			throw new Error(
				`Emulator console rejected "${args.join(" ")}": ${failure.trim()}`,
			);
		return result;
	}

	private shell(serial: string, args: readonly string[], timeoutMs = 30_000) {
		return this.command(serial, ["shell", ...args], timeoutMs);
	}

	async listAvds(): Promise<string[]> {
		const { stdout } = await run(this.emulator, ["-list-avds"]);
		return stdout
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean);
	}

	private async rawDevices(): Promise<
		Array<{ serial: string; state: string; details: string }>
	> {
		const { stdout } = await run(this.adb, ["devices", "-l"]);
		return stdout
			.split(/\r?\n/u)
			.slice(1)
			.flatMap((line) => {
				const match = /^(emulator-\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line.trim());
				return match?.[1] && match[2]
					? [{ serial: match[1], state: match[2], details: match[3] ?? "" }]
					: [];
			});
	}

	private async avdName(serial: string): Promise<string | undefined> {
		try {
			const { stdout } = await this.emu(serial, ["avd", "name"]);
			return stdout.split(/\r?\n/u)[0]?.trim() || undefined;
		} catch {
			// Optional metadata: keep the reachable emulator in discovery results.
			return undefined;
		}
	}

	private async osVersion(serial: string): Promise<string | undefined> {
		try {
			const { stdout } = await this.command(serial, [
				"shell",
				"getprop",
				"ro.build.version.release",
			]);
			return stdout.trim() || undefined;
		} catch {
			// Optional metadata: device state remains authoritative.
			return undefined;
		}
	}

	async listDevices(): Promise<AndroidDevice[]> {
		const [attached, avds] = await Promise.all([
			this.rawDevices(),
			this.listAvds(),
		]);
		const online = await Promise.all(
			attached.map(async ({ serial, state, details }) => {
				const [avd, version] =
					state === "device"
						? await Promise.all([this.avdName(serial), this.osVersion(serial)])
						: [undefined, undefined];
				const model = /(?:^|\s)model:(\S+)/u.exec(details)?.[1];
				return {
					id: `android:${serial}`,
					name: avd ?? model ?? serial,
					platform: "android" as const,
					state:
						state === "device" ? ("online" as const) : ("offline" as const),
					...(version ? { version } : {}),
					...(avd ? { avd } : {}),
				};
			}),
		);

		const runningAvds = new Set(
			online.flatMap((device) => (device.avd ? [device.avd] : [])),
		);
		const shutdown = avds
			.filter((name) => !runningAvds.has(name))
			.map(
				(name): AndroidDevice => ({
					id: `android-avd:${name}`,
					name,
					platform: "android",
					state: "shutdown",
					avd: name,
				}),
			);
		return [...online, ...shutdown];
	}

	async boot(avd: string, timeoutMs: number): Promise<string> {
		const result = this.bootQueue.then(() => this.bootUnlocked(avd, timeoutMs));
		this.bootQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async bootUnlocked(avd: string, timeoutMs: number): Promise<string> {
		const attached = await this.rawDevices();
		// Booting a running AVD would start a conflicting second instance.
		const names = await Promise.all(
			attached.map(({ serial, state }) =>
				state === "device" ? this.avdName(serial) : undefined,
			),
		);
		const running = attached[names.indexOf(avd)];
		if (running) {
			await this.waitForBoot(running.serial, timeoutMs);
			return running.serial;
		}
		const usedPorts = new Set(
			attached.map(({ serial }) => Number(serial.slice("emulator-".length))),
		);
		const port = Array.from(
			{ length: 65 },
			(_, index) => 5554 + index * 2,
		).find((candidate) => !usedPorts.has(candidate));
		if (!port)
			throw new Error("No free Android Emulator console port is available");

		const child = spawn(this.emulator, ["-avd", avd, "-port", String(port)], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		const serial = `emulator-${port}`;
		const spawnFailure = new Promise<never>((_, reject) => {
			child.once("error", (error) =>
				reject(new Error(`Failed to start Android Emulator: ${error.message}`)),
			);
			child.once("exit", (code) => {
				if (code !== null && code !== 0)
					reject(
						new Error(
							`Android Emulator exited during startup with code ${code}`,
						),
					);
			});
		});
		try {
			await Promise.race([this.waitForBoot(serial, timeoutMs), spawnFailure]);
			return serial;
		} catch (error) {
			await this.emu(serial, ["kill"], 5_000).catch(() => {
				child.kill("SIGTERM");
			});
			throw error;
		}
	}

	private async waitForBoot(serial: string, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const poll = async (): Promise<void> => {
			if (Date.now() >= deadline)
				throw new Error(
					`${serial} did not finish booting within ${timeoutMs}ms`,
				);
			try {
				const { stdout } = await this.command(
					serial,
					["shell", "getprop", "sys.boot_completed"],
					5_000,
				);
				if (stdout.trim() === "1") return;
			} catch {
				// ADB is expected to reject commands until the emulator daemon is reachable.
			}
			await sleep(1_000);
			return poll();
		};
		return poll();
	}

	async shutdown(serial: string): Promise<void> {
		await this.emu(serial, ["kill"]);
	}

	async install(serial: string, appPath: string): Promise<void> {
		await this.command(serial, ["install", "-r", appPath], 120_000);
	}

	async launch(
		serial: string,
		packageName: string,
		options: { extras?: Record<string, string>; locale?: string } = {},
	): Promise<void> {
		if (options.locale)
			// Per-app language (Android 13+); persists until changed again. An
			// empty list restores the system language.
			await this.shell(serial, [
				"cmd",
				"locale",
				"set-app-locales",
				packageName,
				"--locales",
				options.locale === "system" ? "''" : options.locale,
			]);
		const extras = Object.entries(options.extras ?? {});
		if (extras.length) {
			await this.launchWithExtras(serial, packageName, extras);
			return;
		}
		const { stdout } = await this.command(serial, [
			"shell",
			"monkey",
			"-p",
			packageName,
			"-c",
			"android.intent.category.LAUNCHER",
			"1",
		]);
		if (!stdout.includes("Events injected: 1"))
			throw new Error(`No launchable activity found for ${packageName}`);
	}

	/** `monkey` cannot pass intent extras, so resolve and start the activity. */
	private async launchWithExtras(
		serial: string,
		packageName: string,
		extras: Array<[string, string]>,
	): Promise<void> {
		const { stdout: resolved } = await this.shell(serial, [
			"cmd",
			"package",
			"resolve-activity",
			"--brief",
			"-c",
			"android.intent.category.LAUNCHER",
			packageName,
		]);
		const component = resolved.trim().split(/\r?\n/u).at(-1)?.trim() ?? "";
		if (!component.startsWith(`${packageName}/`))
			throw new Error(`No launchable activity found for ${packageName}`);
		const { stdout } = await this.shell(serial, [
			"am",
			"start",
			"-W",
			"-S",
			"-n",
			// Inner-class activities contain `$`, which the remote shell expands.
			quoteAndroidShellArgument(component),
			...extras.flatMap(([key, value]) => [
				"--es",
				key,
				quoteAndroidShellArgument(value),
			]),
		]);
		if (/^Error/mu.test(stdout))
			throw new Error(`Android could not start ${component}: ${stdout.trim()}`);
	}

	async terminate(serial: string, packageName: string): Promise<void> {
		await this.command(serial, ["shell", "am", "force-stop", packageName]);
	}

	async resetAppData(serial: string, packageName: string): Promise<void> {
		const { stdout } = await this.command(serial, [
			"shell",
			"pm",
			"clear",
			packageName,
		]);
		if (stdout.trim() !== "Success")
			throw new Error(`Android did not clear data for ${packageName}`);
	}

	/** `crashOnly` reads the dedicated crash buffer (uncaught exceptions, native crashes). */
	async getLogs(
		serial: string,
		packageName: string,
		sinceMinutes: number,
		maxLines: number,
		crashOnly = false,
	): Promise<string> {
		const { stdout: packages } = await this.command(serial, [
			"shell",
			"cmd",
			"package",
			"list",
			"packages",
			"-U",
			packageName,
		]);
		const prefix = `package:${packageName} uid:`;
		const uid = packages
			.split(/\r?\n/u)
			.find((line) => line.startsWith(prefix))
			?.slice(prefix.length)
			.trim();
		if (!uid || !/^\d+$/u.test(uid))
			throw new Error(`${packageName} is not installed on ${serial}`);
		const since = ((Date.now() - sinceMinutes * 60_000) / 1_000).toFixed(3);
		// `-m` would stop after the oldest lines in the window; the newest lines
		// are the useful ones, so read the window and keep its tail.
		const { stdout } = await this.command(
			serial,
			[
				"logcat",
				"-d",
				...(crashOnly ? ["-b", "crash"] : []),
				"-T",
				since,
				`--uid=${uid}`,
				"-v",
				"threadtime",
			],
			30_000,
			32 * 1024 * 1024,
		);
		return tailLines(stdout, maxLines);
	}

	async setPermission(
		serial: string,
		packageName: string,
		permission: string,
		action: "grant" | "revoke",
	): Promise<void> {
		await this.command(serial, [
			"shell",
			"pm",
			action,
			packageName,
			permission,
		]);
	}

	async setLocation(
		serial: string,
		latitude: number,
		longitude: number,
	): Promise<void> {
		await this.emu(serial, [
			"geo",
			"fix",
			String(longitude),
			String(latitude),
		]);
	}

	async uninstall(serial: string, packageName: string): Promise<void> {
		await this.command(serial, ["uninstall", packageName], 120_000);
	}

	async setBattery(
		serial: string,
		capacity: number,
		charging: boolean,
	): Promise<void> {
		await this.emu(serial, ["power", "capacity", String(capacity)]);
		await this.emu(serial, ["power", "ac", charging ? "on" : "off"]);
		let status = "discharging";
		if (charging) status = capacity === 100 ? "full" : "charging";
		await this.emu(serial, ["power", "status", status]);
	}

	async sendSms(
		serial: string,
		phoneNumber: string,
		text: string,
	): Promise<void> {
		await this.emu(serial, ["sms", "send", phoneNumber, text]);
	}

	async fingerprint(
		serial: string,
		action: "touch" | "remove",
		fingerId?: number,
	): Promise<void> {
		await this.emu(serial, [
			"finger",
			action,
			...(action === "touch" ? [String(fingerId)] : []),
		]);
	}

	async setNetwork(
		serial: string,
		speed: string,
		delay: string,
	): Promise<void> {
		await this.emu(serial, ["network", "speed", speed]);
		await this.emu(serial, ["network", "delay", delay]);
	}

	async setConnectivity(
		serial: string,
		target: "airplane" | "wifi" | "data",
		enabled: boolean,
	): Promise<void> {
		if (target === "airplane")
			// cmd connectivity airplane-mode: API 30+; "enable" = radios off.
			await this.command(serial, [
				"shell",
				"cmd",
				"connectivity",
				"airplane-mode",
				enabled ? "enable" : "disable",
			]);
		else
			await this.command(serial, [
				"shell",
				"svc",
				target,
				enabled ? "enable" : "disable",
			]);
	}

	async rotate(serial: string): Promise<void> {
		await this.emu(serial, ["rotate"]);
	}

	async listApps(serial: string, includeSystem: boolean): Promise<MobileApp[]> {
		const listing = async (flag: string): Promise<string[]> =>
			parseAndroidPackages(
				(
					await this.command(
						serial,
						["shell", "pm", "list", "packages", flag],
						30_000,
						4 * 1024 * 1024,
					)
				).stdout,
			);
		const user = await listing("-3");
		const system = includeSystem ? await listing("-s") : [];
		return [
			...user.map((appId) => ({ appId, name: appId, system: false })),
			...system.map((appId) => ({ appId, name: appId, system: true })),
		].sort((left, right) => left.appId.localeCompare(right.appId));
	}

	async foregroundApp(
		serial: string,
	): Promise<{ appId: string; activity?: string }> {
		const { stdout } = await this.command(
			serial,
			["shell", "dumpsys", "window"],
			20_000,
			8 * 1024 * 1024,
		);
		return parseAndroidForegroundApp(stdout);
	}

	async getAppearance(serial: string): Promise<"light" | "dark"> {
		const { stdout } = await this.command(serial, [
			"shell",
			"cmd",
			"uimode",
			"night",
		]);
		return /:\s*(yes|true)/iu.test(stdout) ? "dark" : "light";
	}

	async setAppearance(serial: string, mode: "light" | "dark"): Promise<void> {
		await this.command(serial, [
			"shell",
			"cmd",
			"uimode",
			"night",
			mode === "dark" ? "yes" : "no",
		]);
	}

	async setFontScale(serial: string, scale: number): Promise<void> {
		await this.command(serial, [
			"shell",
			"settings",
			"put",
			"system",
			"font_scale",
			String(scale),
		]);
	}

	async addMedia(serial: string, paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			const remote = `/sdcard/Pictures/${safeMediaName(path)}`;
			await this.command(serial, ["push", path, remote], 120_000);
			await this.command(serial, [
				"shell",
				"am",
				"broadcast",
				"-a",
				"android.intent.action.MEDIA_SCANNER_SCAN_FILE",
				"-d",
				quoteAndroidShellArgument(`file://${remote}`),
			]);
		}
	}

	async screenInfo(serial: string): Promise<{
		width: number;
		height: number;
		density?: number;
		orientation: "portrait" | "landscape";
	}> {
		const { width, height } = await this.screenSize(serial);
		const { stdout } = await this.command(serial, ["shell", "wm", "density"]);
		const density = /density:\s*(\d+)/u.exec(stdout)?.[1];
		return {
			width,
			height,
			...(density ? { density: Number(density) } : {}),
			orientation: height >= width ? "portrait" : "landscape",
		};
	}

	async longPress(
		serial: string,
		x: number,
		y: number,
		durationMs: number,
	): Promise<void> {
		await this.validatePoint(serial, x, y);
		// `input swipe` with identical start/end points is the documented
		// long-press primitive; `input tap` has no duration argument.
		await this.command(serial, [
			"shell",
			"input",
			"swipe",
			String(x),
			String(y),
			String(x),
			String(y),
			String(durationMs),
		]);
	}

	async openUrl(serial: string, url: string): Promise<void> {
		await this.command(serial, [
			"shell",
			"am",
			"start",
			"-W",
			"-a",
			"android.intent.action.VIEW",
			"-d",
			quoteAndroidShellArgument(url),
		]);
	}

	async screenshot(serial: string): Promise<Buffer> {
		return runBinary(this.adb, ["-s", serial, "exec-out", "screencap", "-p"], {
			timeoutMs: 30_000,
			maxBuffer: 20 * 1024 * 1024,
		});
	}

	async uiTree(serial: string): Promise<string> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.dumpUiTree(serial);
			} catch (error) {
				// While a window opens or animates, uiautomator reports "null root
				// node" or "could not get idle state"; it succeeds once it settles.
				const transient =
					error instanceof Error &&
					/null root node|could not get idle state/iu.test(error.message);
				if (!transient || attempt >= UI_DUMP_ATTEMPTS) throw error;
				await sleep(UI_DUMP_RETRY_MS);
			}
		}
	}

	private async dumpUiTree(serial: string): Promise<string> {
		const remotePath = "/sdcard/mobile-mcp-ui.xml";
		try {
			// uiautomator reports failures such as "could not get idle state" on
			// stderr while still exiting 0, so both streams feed validation.
			const { stdout, stderr } = await this.command(
				serial,
				["shell", "uiautomator", "dump", "--compressed", remotePath],
				15_000,
			);
			const dump = `${stdout}\n${stderr}`;
			// Without a dump file, `cat` fails and hides the dump error.
			validateAndroidUiDump(dump, remotePath);
			const { stdout: tree } = await this.command(
				serial,
				["exec-out", "cat", remotePath],
				10_000,
				8 * 1024 * 1024,
			);
			return validateAndroidUiTree(dump, tree, remotePath);
		} finally {
			// safe to ignore: remote temp cleanup must not hide the UI-tree result.
			await this.command(
				serial,
				["shell", "rm", "-f", remotePath],
				5_000,
			).catch(() => undefined);
		}
	}

	private async screenSize(
		serial: string,
	): Promise<{ width: number; height: number }> {
		const { stdout: displays } = await this.command(
			serial,
			["shell", "dumpsys", "window", "displays"],
			10_000,
			8 * 1024 * 1024,
		);
		const current = parseAndroidDisplaySize(displays);
		if (current) return current;
		const { stdout } = await this.command(serial, ["shell", "wm", "size"]);
		const matches = [
			...stdout.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu),
		];
		const match = matches.at(-1);
		if (!match?.[1] || !match[2])
			throw new Error(`Could not read screen size from ${serial}`);
		return { width: Number(match[1]), height: Number(match[2]) };
	}

	private async validatePoint(
		serial: string,
		...points: number[]
	): Promise<void> {
		const { width, height } = await this.screenSize(serial);
		for (let index = 0; index < points.length; index += 2) {
			const x = points[index] ?? 0;
			const y = points[index + 1] ?? 0;
			if (x >= width || y >= height)
				throw new Error(
					`Coordinates (${x}, ${y}) exceed screen size ${width}x${height}`,
				);
		}
	}

	async tap(serial: string, x: number, y: number): Promise<void> {
		await this.validatePoint(serial, x, y);
		await this.command(serial, ["shell", "input", "tap", String(x), String(y)]);
	}

	async swipe(
		serial: string,
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		durationMs: number,
	): Promise<void> {
		await this.validatePoint(serial, fromX, fromY, toX, toY);
		await this.command(serial, [
			"shell",
			"input",
			"swipe",
			String(fromX),
			String(fromY),
			String(toX),
			String(toY),
			String(durationMs),
		]);
	}

	async typeText(serial: string, text: string): Promise<void> {
		if (!/^[\x20-\x7E]*$/u.test(text)) {
			throw new Error(
				"Android `input text` supports printable ASCII only; use an ASCII test value",
			);
		}
		const encoded = text.replaceAll("%", "\\%").replaceAll(" ", "%s");
		await this.command(serial, [
			"shell",
			"input",
			"text",
			quoteAndroidShellArgument(encoded),
		]);
	}

	async pressKey(serial: string, key: AndroidKey): Promise<void> {
		await this.command(serial, ["shell", "input", "keyevent", KEYCODES[key]]);
	}

	async doubleTap(serial: string, x: number, y: number): Promise<void> {
		await this.validatePoint(serial, x, y);
		const tap = ["input", "tap", String(x), String(y)];
		// One remote shell keeps both taps inside the system double-tap timeout.
		await this.shell(serial, [...tap, ";", ...tap]);
	}

	async isLocked(serial: string): Promise<boolean> {
		const [{ stdout: power }, { stdout: window }] = await Promise.all([
			this.command(serial, ["shell", "dumpsys", "power"], 10_000, 8 * 1024 * 1024),
			this.command(serial, ["shell", "dumpsys", "window"], 20_000, 8 * 1024 * 1024),
		]);
		return (
			!/mWakefulness=Awake/u.test(power) ||
			/isKeyguardShowing=true/u.test(window)
		);
	}

	/** Unlock works for the default swipe keyguard; a PIN or pattern still blocks. */
	async setLocked(serial: string, locked: boolean): Promise<boolean> {
		if (locked) await this.shell(serial, ["input", "keyevent", "KEYCODE_SLEEP"]);
		else {
			await this.shell(serial, ["input", "keyevent", "KEYCODE_WAKEUP"]);
			await this.shell(serial, ["wm", "dismiss-keyguard"]);
		}
		await sleep(1_000);
		return this.isLocked(serial);
	}

	async dismissKeyboard(serial: string): Promise<boolean> {
		const { stdout } = await this.command(
			serial,
			["shell", "dumpsys", "input_method"],
			10_000,
			8 * 1024 * 1024,
		);
		if (!/mInputShown=true/u.test(stdout)) return false;
		await this.pressKey(serial, "BACK");
		return true;
	}

	async setOrientation(
		serial: string,
		orientation: AndroidOrientation,
	): Promise<void> {
		await this.shell(
			serial,
			orientation === "auto"
				? ["wm", "user-rotation", "free"]
				: ["wm", "user-rotation", "lock", ROTATIONS[orientation]],
		);
	}

	async recordScreen(
		serial: string,
		localPath: string,
		seconds: number,
	): Promise<void> {
		const remote = `/sdcard/mobile-mcp-${Date.now()}.mp4`;
		try {
			await this.shell(
				serial,
				["screenrecord", "--time-limit", String(seconds), remote],
				(seconds + 30) * 1_000,
			);
			await this.command(serial, ["pull", remote, localPath], 120_000);
		} finally {
			// safe to ignore: remote temp cleanup must not hide the recording result.
			await this.shell(serial, ["rm", "-f", remote], 5_000).catch(() => undefined);
		}
	}

	async snapshot(
		serial: string,
		action: "save" | "load" | "delete",
		name: string,
	): Promise<void> {
		await this.emu(
			serial,
			["avd", "snapshot", action === "delete" ? "del" : action, name],
			180_000,
		);
	}

	async listSnapshots(serial: string): Promise<string[]> {
		return parseAndroidSnapshots(
			(await this.emu(serial, ["avd", "snapshot", "list"])).stdout,
		);
	}

	async phoneCall(
		serial: string,
		action: "call" | "accept" | "cancel" | "busy" | "hold",
		phoneNumber: string,
	): Promise<void> {
		await this.emu(serial, ["gsm", action, phoneNumber]);
	}

	async setSensor(
		serial: string,
		sensor: (typeof ANDROID_SENSORS)[number],
		values: readonly number[],
	): Promise<void> {
		await this.emu(serial, ["sensor", "set", sensor, values.join(":")]);
	}

	async setProxy(serial: string, proxy: string | undefined): Promise<void> {
		await this.emu(serial, proxy ? ["proxy", "set", proxy] : ["proxy", "clear"]);
	}

	/** Same three scales that Settings > Accessibility > Remove animations sets. */
	async setReduceMotion(serial: string, enabled: boolean): Promise<void> {
		for (const scale of [
			"window_animation_scale",
			"transition_animation_scale",
			"animator_duration_scale",
		])
			await this.shell(serial, [
				"settings",
				"put",
				"global",
				scale,
				enabled ? "0" : "1",
			]);
	}

	async setTalkBack(serial: string, enabled: boolean): Promise<void> {
		const service = "com.google.android.marvin.talkback/.TalkBackService";
		if (enabled) {
			const { stdout } = await this.shell(serial, [
				"pm",
				"path",
				"com.google.android.marvin.talkback",
			]);
			if (!stdout.includes("package:"))
				throw new Error("TalkBack is not installed on this emulator image");
		}
		// Deleting on disable restores the image default (unset), not "".
		await this.shell(
			serial,
			enabled
				? ["settings", "put", "secure", "enabled_accessibility_services", service]
				: ["settings", "delete", "secure", "enabled_accessibility_services"],
		);
		await this.shell(serial, [
			"settings",
			"put",
			"secure",
			"accessibility_enabled",
			enabled ? "1" : "0",
		]);
	}
}
