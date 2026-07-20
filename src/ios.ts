import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, run } from "./exec.js";

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

	async launch(udid: string, bundleId: string): Promise<void> {
		await this.simctl([
			"launch",
			"--terminate-running-process",
			udid,
			bundleId,
		]);
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
			4 * 1024 * 1024,
		);
		return stdout.split(/\r?\n/u).slice(-maxLines).join("\n");
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
