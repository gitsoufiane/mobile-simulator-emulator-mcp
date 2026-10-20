import { readFileSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	ANDROID_SENSORS,
	AndroidController,
	type AndroidKey,
	KEYCODES,
} from "./android.js";
import {
	filterElements,
	parseAndroidElements,
	parseIosElements,
	type UiElement,
} from "./elements.js";
import { run, sleep, tailLines } from "./exec.js";
import { IosController } from "./ios.js";
import { WdaController } from "./wda.js";

function packageVersion(): string {
	// Compiled to dist/src/, so the package manifest is two levels up.
	const manifest = new URL("../../package.json", import.meta.url);
	let parsed: { version?: unknown };
	try {
		parsed = JSON.parse(readFileSync(manifest, "utf8")) as typeof parsed;
	} catch (error) {
		throw new Error(
			`Cannot read ${manifest.pathname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed.version !== "string")
		throw new Error(`${manifest.pathname} has no version`);
	return parsed.version;
}

const VERSION = packageVersion();
const INSTRUCTIONS = `Controls local iOS Simulators and Android Emulators for app testing. Physical devices are rejected.

Call mobile_doctor first, then mobile_list_devices, and reuse the exact returned ID (ios:<UDID>, android:emulator-5554, or android-avd:<name>) in every later call.
Discover app identifiers with mobile_list_apps instead of guessing bundle IDs or package names.
Read the screen before acting: mobile_list_elements returns compact elements with tap-ready center coordinates (pass query to find one element); use mobile_take_screenshot for visual context and mobile_get_ui_tree only when the full native hierarchy is needed. Then use mobile_tap, mobile_long_press, mobile_swipe, or mobile_type_text, and re-read after every state-changing action.
After a launch, tap, or navigation, call mobile_wait_for_element instead of sleeping or polling. To reach an element below or beside the visible area, call mobile_scroll_to_element.

The first iOS UI call builds and launches WebDriverAgent through Xcode and can take several minutes; later iOS calls reuse that process.
Destructive tools (install, uninstall, reset, erase, permission changes) run without extra confirmation, so target only disposable app and device state.
Prefer mobile_tap_element (by label) over raw coordinates. On iOS, clear permission prompts and other system alerts with mobile_handle_alert.
Platform coverage differs: clipboard, push, status bar, alerts, Face ID (mobile_simulate_biometric), keychain, accessibility audit, and location routes are iOS-only; SMS, fingerprint, battery, network profiles, connectivity, snapshots, phone calls, sensors, proxy, and mobile_rotate are Android-only. Each tool reports the unsupported platform in its error message.`;
const TEXT_LIMIT = 1_000_000;
const WAIT_INTERVAL_MS = 500;
const SCROLL_SWIPE_MS = 400;
const SCROLL_MAX_SWIPES = 10;
const IOS_UUID =
	/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;
const ANDROID_SERIAL = /^emulator-\d{4}$/u;
const AVD_NAME = /^[A-Za-z0-9._-]{1,100}$/u;
const IOS_APP_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;
const ANDROID_APP_ID = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ANDROID_PERMISSION = /^[A-Za-z][A-Za-z0-9_.]{2,254}$/u;
const MEDIA_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".heic",
	".gif",
	".mp4",
	".mov",
	".m4v",
	".vcf",
]);
const CERTIFICATE_EXTENSIONS = new Set([".pem", ".crt", ".cer", ".der"]);
// BCP 47 language tag subset: fr, fr-FR, zh-Hans-CN, pt_BR.
const LOCALE = /^(?:system|[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3})$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const EXTRA_KEY = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/u;
const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,64}$/u;
// host:port with an optional http:// prefix; no credentials.
const PROXY = /^(?:http:\/\/)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}$/u;
const AUDIT_TYPES = {
	contrast: "XCUIAccessibilityAuditTypeContrast",
	"dynamic-type": "XCUIAccessibilityAuditTypeDynamicType",
	"element-detection": "XCUIAccessibilityAuditTypeElementDetection",
	"hit-region": "XCUIAccessibilityAuditTypeHitRegion",
	"sufficient-element-description":
		"XCUIAccessibilityAuditTypeSufficientElementDescription",
	"text-clipped": "XCUIAccessibilityAuditTypeTextClipped",
	trait: "XCUIAccessibilityAuditTypeTrait",
	action: "XCUIAccessibilityAuditTypeAction",
	"parent-child": "XCUIAccessibilityAuditTypeParentChild",
} as const;
const IOS_ORIENTATIONS = {
	portrait: "PORTRAIT",
	landscape: "LANDSCAPE",
	"landscape-right": "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
	"portrait-upside-down": "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
} as const;
const IOS_CONTENT_SIZES = [
	"extra-small",
	"small",
	"medium",
	"large",
	"extra-large",
	"extra-extra-large",
	"extra-extra-extra-large",
	"accessibility-medium",
	"accessibility-large",
	"accessibility-extra-large",
	"accessibility-extra-extra-large",
	"accessibility-extra-extra-extra-large",
	"increment",
	"decrement",
] as const;
const IOS_PRIVACY_SERVICES = new Set([
	"all",
	"calendar",
	"contacts-limited",
	"contacts",
	"location",
	"location-always",
	"photos-add",
	"photos",
	"media-library",
	"microphone",
	"motion",
	"reminders",
	"siri",
]);

interface OnlineDevice {
	platform: "ios" | "android";
	target: string;
}

interface BootDevice {
	platform: "ios" | "android";
	target: string;
}

export interface MobileControllers {
	android: AndroidController;
	ios: IosController;
	wda: WdaController;
}

export function createControllers(): MobileControllers {
	return {
		android: new AndroidController(),
		ios: new IosController(),
		wda: new WdaController(),
	};
}

interface ServerOptions {
	doctor?: () => Promise<Record<string, unknown>>;
	/** Shared controllers; when supplied, the caller owns their cleanup. */
	controllers?: MobileControllers;
}

export function parseOnlineDevice(id: string): OnlineDevice {
	if (id.startsWith("ios:")) {
		const target = id.slice(4);
		if (IOS_UUID.test(target)) return { platform: "ios", target };
	}
	if (id.startsWith("android:")) {
		const target = id.slice(8);
		if (ANDROID_SERIAL.test(target)) return { platform: "android", target };
	}
	throw new Error(
		`Invalid online device ID "${id}". Use mobile_list_devices for current IDs.`,
	);
}

export function parseBootDevice(id: string): BootDevice {
	if (id.startsWith("android-avd:")) {
		const target = id.slice("android-avd:".length);
		if (AVD_NAME.test(target)) return { platform: "android", target };
	}
	const online = parseOnlineDevice(id);
	if (online.platform !== "ios")
		throw new Error("Boot Android devices with an android-avd:<name> ID");
	return online;
}

export function validateAppIdentifier(
	platform: "ios" | "android",
	value: string,
): string {
	const valid =
		platform === "ios" ? IOS_APP_ID.test(value) : ANDROID_APP_ID.test(value);
	if (!valid) throw new Error(`Invalid ${platform} app identifier`);
	return value;
}

export function validatePermission(
	platform: "ios" | "android",
	value: string,
): string {
	const valid =
		platform === "ios"
			? IOS_PRIVACY_SERVICES.has(value)
			: ANDROID_PERMISSION.test(value);
	if (!valid) throw new Error(`Invalid ${platform} permission`);
	return value;
}

export function validatePushPayload(
	value: Record<string, unknown>,
): Record<string, unknown> {
	if (!value.aps || typeof value.aps !== "object" || Array.isArray(value.aps))
		throw new Error("Push payload must contain an aps object");
	if (Buffer.byteLength(JSON.stringify(value)) > 4_096)
		throw new Error("Push payload must be 4096 bytes or less");
	return value;
}

export function validateUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("URL must be absolute and include a scheme");
	}
	if (url.username || url.password)
		throw new Error("URLs containing credentials are not allowed");
	const configured = (process.env.MOBILE_MCP_URL_SCHEMES ?? "")
		.split(",")
		.map((scheme) => scheme.trim().toLowerCase())
		.filter((scheme) => /^[a-z][a-z0-9+.-]*$/u.test(scheme));
	const allowed = new Set(["http", "https", ...configured]);
	const scheme = url.protocol.slice(0, -1).toLowerCase();
	if (!allowed.has(scheme)) {
		throw new Error(
			`URL scheme "${scheme}" is not allowed. Configure MOBILE_MCP_URL_SCHEMES to opt in.`,
		);
	}
	return url.href;
}

async function appRoot(): Promise<string> {
	const configuredRoot = resolve(
		process.env.MOBILE_MCP_APP_ROOT ?? process.cwd(),
	);
	return realpath(configuredRoot).catch(() => {
		throw new Error("MOBILE_MCP_APP_ROOT does not exist");
	});
}

function isBeneath(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

/**
 * Confines a new artifact file beneath the app root. The parent directory
 * must already exist and the file must not, so nothing is ever overwritten.
 */
export async function validateOutputPath(
	value: string,
	extension: string,
): Promise<string> {
	const root = await appRoot();
	const requested = resolve(root, value);
	if (extname(requested).toLowerCase() !== extension)
		throw new Error(`Output files must end in ${extension}`);
	const parent = await realpath(dirname(requested)).catch(() => {
		throw new Error(`Output directory does not exist: ${dirname(value)}`);
	});
	if (!isBeneath(root, parent))
		throw new Error("Output path must resolve beneath MOBILE_MCP_APP_ROOT");
	const output = join(parent, basename(requested));
	const existing = await lstat(output).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (existing) throw new Error(`Output file already exists: ${value}`);
	return output;
}

export async function validateCertificatePath(value: string): Promise<string> {
	const candidate = await resolveBeneathRoot(value);
	if (!(await stat(candidate)).isFile())
		throw new Error("Certificate paths must point to a file");
	if (!CERTIFICATE_EXTENSIONS.has(extname(candidate).toLowerCase()))
		throw new Error(
			`Certificates must use one of: ${[...CERTIFICATE_EXTENSIONS].join(", ")}`,
		);
	return candidate;
}

/** Resolves a client-supplied path and confines it beneath the app root. */
async function resolveBeneathRoot(value: string): Promise<string> {
	const root = await appRoot();
	const candidate = await realpath(resolve(root, value)).catch(() => {
		throw new Error(
			`Path does not exist beneath MOBILE_MCP_APP_ROOT: ${value}`,
		);
	});
	const pathFromRoot = relative(root, candidate);
	if (pathFromRoot.startsWith("..") || pathFromRoot === "") {
		throw new Error("Path must resolve beneath MOBILE_MCP_APP_ROOT");
	}
	return candidate;
}

export async function validateMediaPath(value: string): Promise<string> {
	const candidate = await resolveBeneathRoot(value);
	const info = await stat(candidate);
	if (!info.isFile()) throw new Error("Media paths must point to a file");
	if (!MEDIA_EXTENSIONS.has(extname(candidate).toLowerCase())) {
		throw new Error(
			`Media files must use one of: ${[...MEDIA_EXTENSIONS].join(", ")}`,
		);
	}
	return candidate;
}

export async function validateAppPath(
	platform: "ios" | "android",
	value: string,
): Promise<string> {
	const candidate = await resolveBeneathRoot(value);
	const info = await stat(candidate);
	if (
		platform === "android" &&
		(!info.isFile() || !candidate.toLowerCase().endsWith(".apk"))
	) {
		throw new Error("Android installs require an .apk file");
	}
	if (
		platform === "ios" &&
		(!info.isDirectory() || !candidate.toLowerCase().endsWith(".app"))
	) {
		throw new Error("iOS Simulator installs require an .app directory");
	}
	return candidate;
}

function stringMap(key: RegExp) {
	return z
		.record(z.string().regex(key), z.string().max(4_000))
		.refine((value) => Object.keys(value).length <= 50, "At most 50 entries");
}

function jsonResult(data: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data) }],
		structuredContent: data,
	};
}

function safe<T>(
	handler: (args: T) => Promise<CallToolResult>,
): (args: T) => Promise<CallToolResult> {
	return async (args) => {
		try {
			return await handler(args);
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	};
}

/** WDA reports PORTRAIT/LANDSCAPE/UIA_DEVICE_ORIENTATION_*; collapse to an axis. */
function normalizeOrientation(value: string): "portrait" | "landscape" {
	return value.toUpperCase().includes("LANDSCAPE") ? "landscape" : "portrait";
}

function truncate(value: string): { value: string; truncated: boolean } {
	return value.length <= TEXT_LIMIT
		? { value, truncated: false }
		: { value: value.slice(0, TEXT_LIMIT), truncated: true };
}

function assertPng(buffer: Buffer): void {
	const signature = "89504e470d0a1a0a";
	if (
		buffer.length < 8 ||
		buffer.subarray(0, 8).toString("hex") !== signature
	) {
		throw new Error("Device returned an invalid PNG screenshot");
	}
}

async function check(
	label: string,
	operation: () => Promise<string>,
): Promise<Record<string, unknown>> {
	try {
		return { label, ok: true, detail: await operation() };
	} catch (error) {
		return {
			label,
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export function createMobileServer(options: ServerOptions = {}): {
	server: McpServer;
	close: () => Promise<void>;
} {
	const ownsControllers = options.controllers === undefined;
	const recordings = new Map<
		string,
		{ path: string; startedAt: number; stop: () => Promise<void> }
	>();
	const { android, ios, wda } = options.controllers ?? createControllers();
	const server = new McpServer(
		{ name: "local-mobile-mcp-server", version: VERSION },
		{ instructions: INSTRUCTIONS },
	);

	const doctor =
		options.doctor ??
		(async () => {
			const checks = await Promise.all([
				check(
					"simctl",
					async () =>
						(await run("xcrun", ["simctl", "help"])).stdout.split("\n")[0] ??
						"available",
				),
				check(
					"adb",
					async () =>
						(await run(android.adb, ["version"])).stdout.split("\n")[0] ??
						"available",
				),
				check(
					"emulator",
					async () =>
						(await run(android.emulator, ["-version"])).stdout.split("\n")[0] ??
						"available",
				),
			]);
			const [iosResult, androidResult, wdaStatus] = await Promise.all([
				ios.listDevices().then(
					(devices) => ({ devices }),
					(error: unknown) => ({ devices: [], error: String(error) }),
				),
				android.listDevices().then(
					(devices) => ({ devices }),
					(error: unknown) => ({ devices: [], error: String(error) }),
				),
				wda.status(),
			]);
			const deviceErrors = {
				...("error" in iosResult ? { ios: iosResult.error } : {}),
				...("error" in androidResult ? { android: androidResult.error } : {}),
			};
			return {
				ok:
					checks.every((entry) => entry.ok === true) &&
					Object.keys(deviceErrors).length === 0,
				checks,
				devices: {
					ios: iosResult.devices.length,
					android: androidResult.devices.length,
					iosBooted: iosResult.devices.filter(
						(device) => device.state === "online",
					).length,
					androidBooted: androidResult.devices.filter(
						(device) => device.state === "online",
					).length,
				},
				...(Object.keys(deviceErrors).length ? { deviceErrors } : {}),
				wda: wdaStatus,
			};
		});

	const getBootedIosVersion = async (udid: string): Promise<string> => {
		const device = await ios.getDevice(udid);
		if (device.state !== "online") throw new Error(`ios:${udid} is not booted`);
		return device.version;
	};
	const useWda = <T>(udid: string, operation: () => Promise<T>): Promise<T> =>
		wda.use(udid, () => getBootedIosVersion(udid), operation);

	const deviceSchema = z
		.string()
		.min(1)
		.max(128)
		.describe("Stable device ID returned by mobile_list_devices");
	const appIdSchema = z.string().min(3).max(255);
	const phoneNumberSchema = z.string().regex(/^\+?[0-9]{3,20}$/u);
	const coordinate = z.number().int().min(0).max(100_000);
	const platformSchema = z.enum(["ios", "android"]);
	const deviceEntrySchema = z.object({
		id: z.string(),
		name: z.string(),
		platform: platformSchema,
		state: z.string(),
		version: z.string().optional(),
		avd: z.string().optional(),
	});
	const appEntrySchema = z.object({
		appId: z.string(),
		name: z.string(),
		system: z.boolean(),
	});

	server.registerTool(
		"mobile_doctor",
		{
			title: "Check Mobile Tooling",
			description:
				"Check local Apple and Android command-line tools, device counts, and WebDriverAgent state without changing devices.",
			inputSchema: z.object({}).strict(),
			// Loose: the report grows with the installed toolchain and a
			// caller-supplied doctor may add its own diagnostic fields.
			outputSchema: z.object({ ok: z.boolean() }).loose(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async () => jsonResult(await doctor())),
	);

	server.registerTool(
		"mobile_list_devices",
		{
			title: "List Mobile Devices",
			description:
				"List available iOS Simulators, running Android Emulators, and configured Android virtual devices. Physical devices are excluded.",
			inputSchema: z.object({}).strict(),
			outputSchema: z.object({
				devices: z.array(deviceEntrySchema),
				errors: z.record(z.string(), z.string()).optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async () => {
			const [iosResult, androidResult] = await Promise.allSettled([
				ios.listDevices(),
				android.listDevices(),
			]);
			const errors: Record<string, string> = {};
			if (iosResult.status === "rejected")
				errors.ios = String(iosResult.reason);
			if (androidResult.status === "rejected")
				errors.android = String(androidResult.reason);
			return jsonResult({
				devices: [
					...(iosResult.status === "fulfilled" ? iosResult.value : []),
					...(androidResult.status === "fulfilled" ? androidResult.value : []),
				],
				...(Object.keys(errors).length ? { errors } : {}),
			});
		}),
	);

	server.registerTool(
		"mobile_boot_device",
		{
			title: "Boot Mobile Device",
			description:
				"Boot an iOS Simulator or configured Android virtual device and wait until it is ready.",
			inputSchema: z
				.object({
					device: deviceSchema,
					timeoutSeconds: z.number().int().min(10).max(300).default(180),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				state: z.literal("online"),
				avd: z.string().optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, timeoutSeconds }) => {
			const target = parseBootDevice(device);
			if (target.platform === "ios") {
				await ios.boot(target.target, timeoutSeconds * 1_000);
				return jsonResult({ device, state: "online" });
			}
			const serial = await android.boot(target.target, timeoutSeconds * 1_000);
			return jsonResult({
				device: `android:${serial}`,
				state: "online",
				avd: target.target,
			});
		}),
	);

	server.registerTool(
		"mobile_shutdown_device",
		{
			title: "Shut Down Mobile Device",
			description:
				"Shut down a running iOS Simulator or Android Emulator without deleting its data.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({
				device: z.string(),
				state: z.literal("shutdown"),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				if (wda.isBoundTo(target.target)) await wda.close();
				await ios.shutdown(target.target);
			} else {
				await android.shutdown(target.target);
			}
			return jsonResult({ device, state: "shutdown" });
		}),
	);

	server.registerTool(
		"mobile_install_app",
		{
			title: "Install Mobile App",
			description:
				"Install an APK on an Android Emulator or an .app directory on an iOS Simulator. Paths are confined beneath MOBILE_MCP_APP_ROOT.",
			inputSchema: z
				.object({ device: deviceSchema, path: z.string().min(1).max(2_048) })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				installed: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, path }) => {
			const target = parseOnlineDevice(device);
			const appPath = await validateAppPath(target.platform, path);
			if (target.platform === "ios") await ios.install(target.target, appPath);
			else await android.install(target.target, appPath);
			return jsonResult({ device, installed: true });
		}),
	);

	server.registerTool(
		"mobile_launch_app",
		{
			title: "Launch Mobile App",
			description:
				"Launch an installed app by iOS bundle ID or Android package name. Use mobile_list_apps to discover valid identifiers. locale sets the app language (iOS per launch, Android 13+ per app until changed). iOS accepts launch arguments and environment variables; Android accepts string intent extras.",
			inputSchema: z
				.object({
					device: deviceSchema,
					appId: appIdSchema,
					locale: z
						.string()
						.regex(LOCALE)
						.optional()
						.describe(
							"Language tag such as fr, fr-FR, or zh-Hans; system restores the device language",
						),
					arguments: z
						.array(z.string().max(1_000))
						.max(50)
						.optional()
						.describe("iOS only: process arguments"),
					environment: stringMap(ENV_NAME)
						.optional()
						.describe("iOS only: environment variables"),
					extras: stringMap(EXTRA_KEY)
						.optional()
						.describe("Android only: string intent extras (am start --es)"),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				launched: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId, locale, arguments: args, environment, extras }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			if (target.platform === "ios") {
				if (extras) throw new Error("extras is Android-only; use arguments or environment on iOS");
				await ios.launch(target.target, checkedAppId, {
					...(locale && locale !== "system" ? { locale } : {}),
					...(args ? { arguments: args } : {}),
					...(environment ? { environment } : {}),
				});
			} else {
				if (args || environment)
					throw new Error("arguments and environment are iOS-only; use extras on Android");
				await android.launch(target.target, checkedAppId, {
					...(locale ? { locale: locale.replaceAll("_", "-") } : {}),
					...(extras ? { extras } : {}),
				});
			}
			return jsonResult({ device, appId: checkedAppId, launched: true });
		}),
	);

	server.registerTool(
		"mobile_terminate_app",
		{
			title: "Terminate Mobile App",
			description:
				"Terminate an app by iOS bundle ID or Android package name without clearing app data.",
			inputSchema: z
				.object({ device: deviceSchema, appId: appIdSchema })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				terminated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			if (target.platform === "ios")
				await ios.terminate(target.target, checkedAppId);
			else await android.terminate(target.target, checkedAppId);
			return jsonResult({ device, appId: checkedAppId, terminated: true });
		}),
	);

	server.registerTool(
		"mobile_list_apps",
		{
			title: "List Installed Apps",
			description:
				"List installed apps with their iOS bundle IDs or Android package names. Returns user-installed apps unless includeSystem is true.",
			inputSchema: z
				.object({
					device: deviceSchema,
					includeSystem: z.boolean().default(false),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				apps: z.array(appEntrySchema),
				count: z.number().int().nonnegative(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, includeSystem }) => {
			const target = parseOnlineDevice(device);
			const apps =
				target.platform === "ios"
					? await ios.listApps(target.target, includeSystem)
					: await android.listApps(target.target, includeSystem);
			return jsonResult({
				device,
				platform: target.platform,
				apps,
				count: apps.length,
			});
		}),
	);

	server.registerTool(
		"mobile_get_foreground_app",
		{
			title: "Get Foreground App",
			description:
				"Return the app currently in the foreground. Use it to confirm a launch or deep link landed on the expected app before interacting.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				appId: z.string(),
				activity: z.string().optional(),
				processId: z.number().int().optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				const info = await useWda(target.target, () =>
					wda.activeAppInfo(),
				);
				return jsonResult({ device, platform: "ios", ...info });
			}
			return jsonResult({
				device,
				platform: "android",
				...(await android.foregroundApp(target.target)),
			});
		}),
	);

	server.registerTool(
		"mobile_get_logs",
		{
			title: "Get Mobile App Logs",
			description:
				"Return bounded recent logs for one installed app. Android filters by package UID; iOS filters by the app executable.",
			inputSchema: z
				.object({
					device: deviceSchema,
					appId: appIdSchema,
					sinceMinutes: z.number().int().min(1).max(60).default(5),
					maxLines: z.number().int().min(1).max(5_000).default(1_000),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				platform: z.enum(["ios", "android"]),
				logs: z.string(),
				truncated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId, sinceMinutes, maxLines }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			const logs =
				target.platform === "ios"
					? await ios.getLogs(
							target.target,
							checkedAppId,
							sinceMinutes,
							maxLines,
						)
					: await android.getLogs(
							target.target,
							checkedAppId,
							sinceMinutes,
							maxLines,
						);
			const limited = truncate(logs);
			return jsonResult({
				device,
				appId: checkedAppId,
				platform: target.platform,
				logs: limited.value,
				truncated: limited.truncated,
			});
		}),
	);

	server.registerTool(
		"mobile_reset_app",
		{
			title: "Reset Mobile App State",
			description:
				"Clear Android app data or uninstall an iOS app. Reinstall the iOS app with mobile_install_app afterward.",
			inputSchema: z
				.object({ device: deviceSchema, appId: appIdSchema })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				reset: z.boolean(),
				result: z.enum(["cleared", "uninstalled"]),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			if (target.platform === "ios")
				await ios.resetAppData(target.target, checkedAppId);
			else await android.resetAppData(target.target, checkedAppId);
			return jsonResult({
				device,
				appId: checkedAppId,
				reset: true,
				result: target.platform === "ios" ? "uninstalled" : "cleared",
			});
		}),
	);

	server.registerTool(
		"mobile_set_permission",
		{
			title: "Set Mobile App Permission",
			description:
				"Grant, revoke, or reset an allowlisted iOS Simulator privacy service; grant or revoke a declared Android runtime permission.",
			inputSchema: z
				.object({
					device: deviceSchema,
					appId: appIdSchema,
					permission: z.string().min(3).max(255),
					action: z.enum(["grant", "revoke", "reset"]),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				permission: z.string(),
				action: z.enum(["grant", "revoke", "reset"]),
				updated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId, permission, action }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			const checkedPermission = validatePermission(target.platform, permission);
			if (target.platform === "ios") {
				await ios.setPermission(
					target.target,
					checkedAppId,
					checkedPermission,
					action,
				);
			} else {
				if (action === "reset")
					throw new Error("Android permissions support grant or revoke only");
				await android.setPermission(
					target.target,
					checkedAppId,
					checkedPermission,
					action,
				);
			}
			return jsonResult({
				device,
				appId: checkedAppId,
				permission: checkedPermission,
				action,
				updated: true,
			});
		}),
	);

	const locationSchema = z.discriminatedUnion("action", [
		z
			.object({
				device: deviceSchema,
				action: z.literal("set"),
				latitude: z.number().min(-90).max(90),
				longitude: z.number().min(-180).max(180),
			})
			.strict(),
		z.object({ device: deviceSchema, action: z.literal("clear") }).strict(),
		z
			.object({
				device: deviceSchema,
				action: z.literal("route"),
				waypoints: z
					.array(
						z
							.object({
								latitude: z.number().min(-90).max(90),
								longitude: z.number().min(-180).max(180),
							})
							.strict(),
					)
					.min(2)
					.max(100),
				speedMetersPerSecond: z.number().positive().max(1_000).default(20),
			})
			.strict(),
	]);
	server.registerTool(
		"mobile_set_location",
		{
			title: "Set Mobile Location",
			description:
				"Set simulated latitude/longitude on iOS or Android. iOS also supports clear and route (move along waypoints at a speed, returning immediately while the Simulator keeps moving).",
			inputSchema: locationSchema,
			outputSchema: z.object({
				device: z.string(),
				action: z.enum(["set", "clear", "route"]),
				waypoints: z.number().int().optional(),
				latitude: z.number().optional(),
				longitude: z.number().optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async (args) => {
			const target = parseOnlineDevice(args.device);
			if (args.action === "route") {
				if (target.platform === "android")
					throw new Error(
						"Android Emulator has no console command for routes; call set per waypoint",
					);
				await ios.startLocationRoute(
					target.target,
					args.waypoints,
					args.speedMetersPerSecond,
				);
				return jsonResult({
					device: args.device,
					action: "route",
					waypoints: args.waypoints.length,
				});
			}
			if (args.action === "clear") {
				if (target.platform === "android")
					throw new Error(
						"Android Emulator does not support clearing a geo fix",
					);
				await ios.setLocation(target.target);
				return jsonResult({ device: args.device, action: "clear" });
			}
			if (target.platform === "ios") {
				await ios.setLocation(target.target, args);
			} else {
				await android.setLocation(target.target, args.latitude, args.longitude);
			}
			return jsonResult({
				device: args.device,
				action: "set",
				latitude: args.latitude,
				longitude: args.longitude,
			});
		}),
	);

	server.registerTool(
		"mobile_send_push",
		{
			title: "Send iOS Simulator Push",
			description:
				"Send an APNs JSON payload to an installed iOS Simulator app. Android FCM has no equivalent adb command.",
			inputSchema: z
				.object({
					device: deviceSchema,
					appId: appIdSchema,
					payload: z.record(z.string(), z.unknown()),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				pushed: z.boolean(),
				bytes: z.number().int().nonnegative(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId, payload }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error("mobile_send_push supports iOS Simulators only");
			const checkedAppId = validateAppIdentifier("ios", appId);
			const checkedPayload = validatePushPayload(payload);
			await ios.sendPush(target.target, checkedAppId, checkedPayload);
			return jsonResult({
				device,
				appId: checkedAppId,
				pushed: true,
				bytes: Buffer.byteLength(JSON.stringify(checkedPayload)),
			});
		}),
	);

	server.registerTool(
		"mobile_add_media",
		{
			title: "Add Media To Device Library",
			description:
				"Add photos, videos, or vCard contacts to the device library so photo-picker and import flows have test fixtures. Paths are confined beneath MOBILE_MCP_APP_ROOT.",
			inputSchema: z
				.object({
					device: deviceSchema,
					paths: z.array(z.string().min(1).max(2_048)).min(1).max(20),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				added: z.number().int().nonnegative(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, paths }) => {
			const target = parseOnlineDevice(device);
			const resolved = await Promise.all(paths.map(validateMediaPath));
			if (target.platform === "ios")
				await ios.addMedia(target.target, resolved);
			else await android.addMedia(target.target, resolved);
			return jsonResult({ device, added: resolved.length });
		}),
	);

	server.registerTool(
		"mobile_uninstall_app",
		{
			title: "Uninstall Mobile App",
			description:
				"Uninstall an app and its data from a simulator or emulator without per-call confirmation.",
			inputSchema: z
				.object({ device: deviceSchema, appId: appIdSchema })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				uninstalled: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			if (target.platform === "ios")
				await ios.uninstall(target.target, checkedAppId);
			else await android.uninstall(target.target, checkedAppId);
			return jsonResult({ device, appId: checkedAppId, uninstalled: true });
		}),
	);

	server.registerTool(
		"mobile_erase_device",
		{
			title: "Erase iOS Simulator",
			description:
				"Shut down and erase all content and settings from an iOS Simulator. Android online wipe is not supported by the official emulator console.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({ device: z.string(), erased: z.boolean() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error(
					"Android AVD wipe is a boot-time operation and is not supported on a running emulator",
				);
			if (wda.isBoundTo(target.target)) await wda.close();
			await ios.erase(target.target);
			return jsonResult({ device, erased: true });
		}),
	);

	server.registerTool(
		"mobile_set_clipboard",
		{
			title: "Set iOS Simulator Clipboard",
			description:
				"Replace the iOS Simulator pasteboard text. The current Android emulator console has no clipboard command.",
			inputSchema: z
				.object({ device: deviceSchema, text: z.string().max(100_000) })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				characters: z.number().int().nonnegative(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, text }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error("mobile_set_clipboard supports iOS Simulators only");
			await ios.setClipboard(target.target, text);
			return jsonResult({ device, characters: [...text].length });
		}),
	);

	server.registerTool(
		"mobile_get_clipboard",
		{
			title: "Get iOS Simulator Clipboard",
			description:
				"Read text from the iOS Simulator pasteboard. The current Android emulator console has no clipboard command.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({ device: z.string(), text: z.string() }),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error("mobile_get_clipboard supports iOS Simulators only");
			return jsonResult({
				device,
				text: await ios.getClipboard(target.target),
			});
		}),
	);

	const statusBarSchema = z
		.object({
			device: deviceSchema,
			action: z.enum(["override", "clear"]),
			time: z.string().max(64).optional(),
			dataNetwork: z
				.enum([
					"hide",
					"wifi",
					"3g",
					"4g",
					"lte",
					"lte-a",
					"lte+",
					"5g",
					"5g+",
					"5g-uwb",
					"5g-uc",
				])
				.optional(),
			wifiMode: z.enum(["searching", "failed", "active"]).optional(),
			wifiBars: z.number().int().min(0).max(3).optional(),
			cellularMode: z
				.enum(["notSupported", "searching", "failed", "active"])
				.optional(),
			cellularBars: z.number().int().min(0).max(4).optional(),
			operatorName: z.string().max(64).optional(),
			batteryState: z.enum(["charging", "charged", "discharging"]).optional(),
			batteryLevel: z.number().int().min(0).max(100).optional(),
		})
		.strict();
	server.registerTool(
		"mobile_set_status_bar",
		{
			title: "Set iOS Simulator Status Bar",
			description:
				"Override or clear typed iOS Simulator status-bar values for deterministic screenshots.",
			inputSchema: statusBarSchema,
			outputSchema: z.object({
				device: z.string(),
				action: z.enum(["override", "clear"]),
				updated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async (args) => {
			const target = parseOnlineDevice(args.device);
			if (target.platform !== "ios")
				throw new Error("mobile_set_status_bar supports iOS Simulators only");
			const values: Array<[string, string | number | undefined]> = [
				["--time", args.time],
				["--dataNetwork", args.dataNetwork],
				["--wifiMode", args.wifiMode],
				["--wifiBars", args.wifiBars],
				["--cellularMode", args.cellularMode],
				["--cellularBars", args.cellularBars],
				["--operatorName", args.operatorName],
				["--batteryState", args.batteryState],
				["--batteryLevel", args.batteryLevel],
			];
			const options = values.flatMap(([flag, value]) =>
				value === undefined ? [] : [flag, String(value)],
			);
			if (args.action === "clear" && options.length)
				throw new Error("Status-bar clear does not accept override values");
			if (args.action === "override" && !options.length)
				throw new Error("Status-bar override requires at least one value");
			await ios.setStatusBar(target.target, args.action, options);
			return jsonResult({
				device: args.device,
				action: args.action,
				updated: true,
			});
		}),
	);

	server.registerTool(
		"mobile_set_appearance",
		{
			title: "Set Light Or Dark Appearance",
			description:
				"Switch the device between light and dark appearance to test both themes.",
			inputSchema: z
				.object({ device: deviceSchema, mode: z.enum(["light", "dark"]) })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				mode: z.enum(["light", "dark"]),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, mode }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios")
				await ios.setAppearance(target.target, mode);
			else await android.setAppearance(target.target, mode);
			return jsonResult({ device, platform: target.platform, mode });
		}),
	);

	server.registerTool(
		"mobile_set_accessibility",
		{
			title: "Set Accessibility Settings",
			description:
				"Change accessibility settings to test layouts and assistive technology. Both platforms: reduceMotion (Android removes animations, which also stabilizes UI tests) and screenReader (iOS VoiceOver, Android TalkBack). iOS only: contentSize (Dynamic Type), increaseContrast, reduceTransparency. Android only: fontScale. iOS reduceMotion, reduceTransparency, and screenReader need Xcode 27.",
			inputSchema: z
				.object({
					device: deviceSchema,
					contentSize: z.enum(IOS_CONTENT_SIZES).optional(),
					increaseContrast: z.boolean().optional(),
					reduceTransparency: z.boolean().optional(),
					fontScale: z.number().min(0.25).max(5).optional(),
					reduceMotion: z.boolean().optional(),
					screenReader: z.boolean().optional(),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				applied: z.array(z.string()),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async (args) => {
			const {
				device,
				contentSize,
				increaseContrast,
				reduceTransparency,
				fontScale,
				reduceMotion,
				screenReader,
			} = args;
			const target = parseOnlineDevice(device);
			const applied: string[] = [];
			if (target.platform === "ios") {
				if (fontScale !== undefined)
					throw new Error("fontScale is Android-only; use contentSize on iOS");
				if (reduceMotion !== undefined || reduceTransparency !== undefined) {
					await ios.setMotionAndTransparency(target.target, {
						...(reduceMotion === undefined ? {} : { reduceMotion }),
						...(reduceTransparency === undefined ? {} : { reduceTransparency }),
					});
					if (reduceMotion !== undefined) applied.push("reduceMotion");
					if (reduceTransparency !== undefined)
						applied.push("reduceTransparency");
				}
				if (screenReader !== undefined) {
					await ios.setVoiceOver(target.target, screenReader);
					applied.push("screenReader");
				}
				if (contentSize !== undefined) {
					await ios.setContentSize(target.target, contentSize);
					applied.push("contentSize");
				}
				if (increaseContrast !== undefined) {
					await ios.setIncreaseContrast(target.target, increaseContrast);
					applied.push("increaseContrast");
				}
			} else {
				if (
					contentSize !== undefined ||
					increaseContrast !== undefined ||
					reduceTransparency !== undefined
				)
					throw new Error(
						"contentSize, increaseContrast, and reduceTransparency are iOS-only; use fontScale on Android",
					);
				if (fontScale !== undefined) {
					await android.setFontScale(target.target, fontScale);
					applied.push("fontScale");
				}
				if (reduceMotion !== undefined) {
					await android.setReduceMotion(target.target, reduceMotion);
					applied.push("reduceMotion");
				}
				if (screenReader !== undefined) {
					await android.setTalkBack(target.target, screenReader);
					applied.push("screenReader");
				}
			}
			if (!applied.length)
				throw new Error("Provide at least one accessibility setting to change");
			return jsonResult({ device, platform: target.platform, applied });
		}),
	);

	server.registerTool(
		"mobile_set_battery",
		{
			title: "Set Android Emulator Battery",
			description:
				"Set Android Emulator battery capacity and AC charging state.",
			inputSchema: z
				.object({
					device: deviceSchema,
					capacity: z.number().int().min(0).max(100),
					charging: z.boolean(),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				capacity: z.number().int(),
				charging: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, capacity, charging }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "android")
				throw new Error("mobile_set_battery supports Android Emulators only");
			await android.setBattery(target.target, capacity, charging);
			return jsonResult({ device, capacity, charging });
		}),
	);

	server.registerTool(
		"mobile_send_sms",
		{
			title: "Send Android Emulator SMS",
			description: "Deliver a simulated inbound SMS to an Android Emulator.",
			inputSchema: z
				.object({
					device: deviceSchema,
					phoneNumber: phoneNumberSchema,
					text: z.string().min(1).max(1_000),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				phoneNumber: z.string(),
				delivered: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, phoneNumber, text }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "android")
				throw new Error("mobile_send_sms supports Android Emulators only");
			await android.sendSms(target.target, phoneNumber, text);
			return jsonResult({ device, phoneNumber, delivered: true });
		}),
	);

	const fingerprintSchema = z.discriminatedUnion("action", [
		z
			.object({
				device: deviceSchema,
				action: z.literal("touch"),
				fingerId: z.number().int().min(1).max(10),
			})
			.strict(),
		z.object({ device: deviceSchema, action: z.literal("remove") }).strict(),
	]);
	server.registerTool(
		"mobile_fingerprint",
		{
			title: "Use Android Emulator Fingerprint",
			description:
				"Touch an enrolled Android Emulator fingerprint ID or remove the simulated finger.",
			inputSchema: fingerprintSchema,
			outputSchema: z.object({
				device: z.string(),
				action: z.enum(["touch", "remove"]),
				fingerId: z.number().int().optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async (args) => {
			const target = parseOnlineDevice(args.device);
			if (target.platform !== "android")
				throw new Error("mobile_fingerprint supports Android Emulators only");
			await android.fingerprint(
				target.target,
				args.action,
				args.action === "touch" ? args.fingerId : undefined,
			);
			return jsonResult({
				device: args.device,
				action: args.action,
				...(args.action === "touch" ? { fingerId: args.fingerId } : {}),
			});
		}),
	);

	server.registerTool(
		"mobile_set_network",
		{
			title: "Set Android Emulator Network",
			description: "Set an Android Emulator network speed and latency profile.",
			inputSchema: z
				.object({
					device: deviceSchema,
					speed: z.enum(["gprs", "edge", "umts", "lte", "full"]),
					delay: z.enum(["none", "gprs", "edge", "umts", "lte"]),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				speed: z.string(),
				delay: z.string(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, speed, delay }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "android")
				throw new Error("mobile_set_network supports Android Emulators only");
			await android.setNetwork(target.target, speed, delay);
			return jsonResult({ device, speed, delay });
		}),
	);

	server.registerTool(
		"mobile_set_connectivity",
		{
			title: "Set Android Emulator Connectivity",
			description:
				"Toggle an Android Emulator's airplane mode, wifi, or mobile data. iOS Simulators share the host network and are not supported.",
			inputSchema: z
				.object({
					device: deviceSchema,
					target: z.enum(["airplane", "wifi", "data"]),
					enabled: z.boolean(),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				target: z.string(),
				enabled: z.boolean(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, target: connTarget, enabled }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "android")
				throw new Error(
					"mobile_set_connectivity supports Android Emulators only",
				);
			await android.setConnectivity(target.target, connTarget, enabled);
			return jsonResult({ device, target: connTarget, enabled });
		}),
	);

	server.registerTool(
		"mobile_rotate",
		{
			title: "Rotate Android Emulator",
			description: "Rotate the Android Emulator clockwise by 90 degrees.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({
				device: z.string(),
				rotated: z.boolean(),
				direction: z.literal("clockwise"),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "android")
				throw new Error("mobile_rotate supports Android Emulators only");
			await android.rotate(target.target);
			return jsonResult({ device, rotated: true, direction: "clockwise" });
		}),
	);

	server.registerTool(
		"mobile_set_orientation",
		{
			title: "Set Screen Orientation",
			description:
				"Set an absolute screen orientation. Android locks rotation there until orientation auto restores sensor rotation. iOS uses devicectl on Xcode 27 and falls back to WebDriverAgent on older Xcode.",
			inputSchema: z
				.object({
					device: deviceSchema,
					orientation: z.enum([
						"portrait",
						"landscape",
						"landscape-right",
						"portrait-upside-down",
						"auto",
					]),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				orientation: z.string(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, orientation }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "android") {
				await android.setOrientation(target.target, orientation);
				return jsonResult({ device, orientation });
			}
			if (orientation === "auto")
				throw new Error("orientation auto is Android-only");
			try {
				await ios.setOrientation(target.target, orientation);
				return jsonResult({ device, orientation });
			} catch (error) {
				if (!String(error).includes("needs Xcode 27")) throw error;
			}
			await useWda(target.target, () =>
				wda.setOrientation(IOS_ORIENTATIONS[orientation]),
			).catch((error: unknown) => {
				if (String(error).includes("Unable To Rotate Device"))
					throw new Error(
						`The foreground app does not support ${orientation}. The iPhone home screen is portrait-only; launch an app that supports ${orientation} first.`,
					);
				throw error;
			});
			return jsonResult({ device, orientation });
		}),
	);

	server.registerTool(
		"mobile_open_url",
		{
			title: "Open Mobile URL",
			description:
				"Open an http/https URL or an explicitly allowed deep-link scheme on a simulator or emulator.",
			inputSchema: z
				.object({ device: deviceSchema, url: z.string().min(1).max(2_048) })
				.strict(),
			outputSchema: z.object({ device: z.string(), opened: z.string() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		safe(async ({ device, url }) => {
			const target = parseOnlineDevice(device);
			const checkedUrl = validateUrl(url);
			if (target.platform === "ios")
				await ios.openUrl(target.target, checkedUrl);
			else await android.openUrl(target.target, checkedUrl);
			return jsonResult({ device, opened: checkedUrl });
		}),
	);

	server.registerTool(
		"mobile_take_screenshot",
		{
			title: "Take Mobile Screenshot",
			description:
				"Capture the current simulator or emulator screen as a PNG image returned directly to the MCP client.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			const image =
				target.platform === "ios"
					? await ios.screenshot(target.target)
					: await android.screenshot(target.target);
			assertPng(image);
			return {
				content: [
					{
						type: "image",
						data: image.toString("base64"),
						mimeType: "image/png",
					},
					{
						type: "text",
						text: JSON.stringify({
							device,
							bytes: image.length,
							mimeType: "image/png",
						}),
					},
				],
			};
		}),
	);

	server.registerTool(
		"mobile_get_ui_tree",
		{
			title: "Get Mobile UI Tree",
			description:
				"Return the current native accessibility/UI hierarchy. If truncated is true, format ends in -fragment and tree is intentionally incomplete text.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({
				device: z.string(),
				format: z.string(),
				tree: z.string(),
				truncated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			let tree: string;
			let format: "json" | "xml";
			if (target.platform === "ios") {
				tree = await useWda(target.target, () => wda.uiTree());
				format = "json";
			} else {
				tree = await android.uiTree(target.target);
				format = "xml";
			}
			const limited = truncate(tree);
			return jsonResult({
				device,
				format: limited.truncated ? `${format}-fragment` : format,
				tree: limited.value,
				truncated: limited.truncated,
			});
		}),
	);

	const rectSchema = z.object({
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
	});
	const elementSchema = z.object({
		type: z.string(),
		label: z.string().optional(),
		id: z.string().optional(),
		value: z.string().optional(),
		rect: rectSchema,
		center: z.object({ x: z.number(), y: z.number() }),
		flags: z.array(z.string()).optional(),
	});
	const readElements = async (target: OnlineDevice) =>
		target.platform === "ios"
			? parseIosElements(await useWda(target.target, () => wda.source()))
			: parseAndroidElements(await android.uiTree(target.target));
	server.registerTool(
		"mobile_list_elements",
		{
			title: "List On-Screen Elements",
			description:
				"Return a compact list of visible labeled or interactive elements with tap-ready center coordinates in mobile_tap units. Costs far fewer tokens than mobile_get_ui_tree; pass query to filter by label, identifier, value, or type.",
			inputSchema: z
				.object({
					device: deviceSchema,
					query: z.string().min(1).max(200).optional(),
					limit: z.number().int().min(1).max(1_000).default(200),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				count: z.number().int().nonnegative(),
				truncated: z.boolean(),
				elements: z.array(elementSchema),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, query, limit }) => {
			const target = parseOnlineDevice(device);
			const matched = filterElements(await readElements(target), query);
			return jsonResult({
				device,
				platform: target.platform,
				count: matched.length,
				truncated: matched.length > limit,
				elements: matched.slice(0, limit),
			});
		}),
	);

	const tapAt = async (
		target: OnlineDevice,
		action: "tap" | "double_tap" | "long_press",
		x: number,
		y: number,
	): Promise<void> => {
		if (target.platform === "ios")
			await useWda(target.target, () => {
				if (action === "double_tap") return wda.doubleTap(x, y);
				if (action === "long_press") return wda.longPress(x, y, 1_000);
				return wda.tap(x, y);
			});
		else if (action === "double_tap")
			await android.doubleTap(target.target, x, y);
		else if (action === "long_press")
			await android.longPress(target.target, x, y, 1_000);
		else await android.tap(target.target, x, y);
	};

	const swipeAt = async (
		target: OnlineDevice,
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		durationMs: number,
	): Promise<void> => {
		if (target.platform === "ios")
			await useWda(target.target, () =>
				wda.swipe(fromX, fromY, toX, toY, durationMs),
			);
		else
			await android.swipe(target.target, fromX, fromY, toX, toY, durationMs);
	};

	server.registerTool(
		"mobile_tap_element",
		{
			title: "Tap Element By Text",
			description:
				"Find an on-screen element by label, identifier, value, or type (same matching as mobile_list_elements, exact matches first) and tap, double tap, or long press its center. More robust than coordinates; re-read the screen afterwards.",
			inputSchema: z
				.object({
					device: deviceSchema,
					query: z.string().min(1).max(200),
					index: z
						.number()
						.int()
						.min(0)
						.max(999)
						.default(0)
						.describe("Which match to use when several elements match"),
					action: z.enum(["tap", "double_tap", "long_press"]).default("tap"),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				action: z.string(),
				matches: z.number().int().nonnegative(),
				element: elementSchema,
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, query, index, action }) => {
			const target = parseOnlineDevice(device);
			const matched = filterElements(await readElements(target), query);
			if (!matched.length)
				throw new Error(
					`No on-screen element matches "${query}". Call mobile_list_elements to see what is visible, or swipe to reveal it.`,
				);
			const element = matched[index];
			if (!element)
				throw new Error(
					`Only ${matched.length} elements match "${query}"; index ${index} is out of range`,
				);
			await tapAt(target, action, element.center.x, element.center.y);
			return jsonResult({
				device,
				action,
				matches: matched.length,
				element,
			});
		}),
	);

	server.registerTool(
		"mobile_wait_for_element",
		{
			title: "Wait For Element",
			description:
				"Wait until an element matching query (same matching as mobile_list_elements) is visible, or until it is gone. Reads the screen every 500 ms and retries transient read errors. Use it after launches, taps, and navigation instead of sleeping. Fails with the last error when timeoutMs passes.",
			inputSchema: z
				.object({
					device: deviceSchema,
					query: z.string().min(1).max(200),
					state: z.enum(["visible", "gone"]).default("visible"),
					timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				state: z.enum(["visible", "gone"]),
				elapsedMs: z.number().int().nonnegative(),
				matches: z.number().int().nonnegative(),
				element: elementSchema.optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, query, state, timeoutMs }) => {
			const target = parseOnlineDevice(device);
			const started = Date.now();
			let lastError: unknown;
			for (;;) {
				try {
					const matched = filterElements(await readElements(target), query);
					lastError = undefined;
					if ((state === "visible") === matched.length > 0)
						return jsonResult({
							device,
							state,
							elapsedMs: Date.now() - started,
							matches: matched.length,
							...(matched[0] ? { element: matched[0] } : {}),
						});
				} catch (error) {
					// Screens in transition make uiautomator and WDA fail briefly.
					lastError = error;
				}
				if (Date.now() - started + WAIT_INTERVAL_MS > timeoutMs) break;
				await sleep(WAIT_INTERVAL_MS);
			}
			const reason =
				lastError instanceof Error ? ` Last read error: ${lastError.message}` : "";
			throw new Error(
				state === "visible"
					? `No element matching "${query}" appeared within ${timeoutMs} ms.${reason} Call mobile_list_elements to see what is visible.`
					: `An element matching "${query}" is still visible after ${timeoutMs} ms.${reason}`,
			);
		}),
	);

	server.registerTool(
		"mobile_scroll_to_element",
		{
			title: "Scroll To Element",
			description:
				"Swipe until an element matching query (same matching as mobile_list_elements) has its center on screen. direction down reveals content below; up reveals content above. Stops when the screen no longer changes (end of content) or after 10 swipes.",
			inputSchema: z
				.object({
					device: deviceSchema,
					query: z.string().min(1).max(200),
					direction: z.enum(["down", "up"]).default("down"),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				swipes: z.number().int().nonnegative(),
				matches: z.number().int().nonnegative(),
				element: elementSchema,
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, query, direction }) => {
			const target = parseOnlineDevice(device);
			const { width, height } =
				target.platform === "ios"
					? await useWda(target.target, () => wda.screenInfo())
					: await android.screenInfo(target.target);
			const onScreen = (entry: UiElement) =>
				entry.center.x >= 0 &&
				entry.center.y >= 0 &&
				entry.center.x < width &&
				entry.center.y < height;
			// The finger moves against the scroll direction, across the middle 40%.
			const x = Math.round(width / 2);
			const low = Math.round(height * 0.7);
			const high = Math.round(height * 0.3);
			const [fromY, toY] = direction === "down" ? [low, high] : [high, low];
			let previous = "";
			for (let swipes = 0; ; swipes += 1) {
				const elements = await readElements(target);
				const matched = filterElements(elements, query).filter(onScreen);
				if (matched[0])
					return jsonResult({
						device,
						swipes,
						matches: matched.length,
						element: matched[0],
					});
				const signature = JSON.stringify(elements);
				if (signature === previous)
					throw new Error(
						`No element matching "${query}" found; the screen stopped changing after ${swipes} swipes ${direction}. Try another direction or query.`,
					);
				if (swipes === SCROLL_MAX_SWIPES)
					throw new Error(
						`No element matching "${query}" found after ${SCROLL_MAX_SWIPES} swipes ${direction}. Call it again to continue, or try the other direction.`,
					);
				previous = signature;
				await swipeAt(target, x, fromY, x, toY, SCROLL_SWIPE_MS);
				// Let scroll momentum settle so the next read sees the final layout.
				await sleep(700);
			}
		}),
	);

	server.registerTool(
		"mobile_double_tap",
		{
			title: "Double Tap Mobile Screen",
			description:
				"Double tap integer screen coordinates, for zoom, text selection, or double-tap gestures.",
			inputSchema: z
				.object({ device: deviceSchema, x: coordinate, y: coordinate })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				doubleTapped: z.object({ x: z.number().int(), y: z.number().int() }),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, x, y }) => {
			await tapAt(parseOnlineDevice(device), "double_tap", x, y);
			return jsonResult({ device, doubleTapped: { x, y } });
		}),
	);

	server.registerTool(
		"mobile_handle_alert",
		{
			title: "Handle iOS System Alert",
			description:
				"List, accept, or dismiss the visible iOS alert (permission prompts, app alerts). Pass button to press a specific label. Android dialogs are ordinary UI: use mobile_tap_element.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["list", "accept", "dismiss"]),
					button: z.string().min(1).max(200).optional(),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				action: z.string(),
				buttons: z.array(z.string()).optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action, button }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error(
					"Android dialogs are ordinary UI; use mobile_tap_element with the button label",
				);
			if (action === "list") {
				if (button) throw new Error("button is not used with action list");
				const buttons = await useWda(target.target, () => wda.alertButtons());
				return jsonResult({ device, action, buttons });
			}
			await useWda(target.target, () => wda.handleAlert(action, button));
			return jsonResult({ device, action });
		}),
	);

	server.registerTool(
		"mobile_dismiss_keyboard",
		{
			title: "Dismiss On-Screen Keyboard",
			description:
				"Hide the software keyboard so it stops covering the screen. Returns dismissed false on Android when no keyboard was shown.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({ device: z.string(), dismissed: z.boolean() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				await useWda(target.target, () => wda.dismissKeyboard());
				return jsonResult({ device, dismissed: true });
			}
			return jsonResult({
				device,
				dismissed: await android.dismissKeyboard(target.target),
			});
		}),
	);

	server.registerTool(
		"mobile_set_lock",
		{
			title: "Lock Or Unlock Screen",
			description:
				"Lock or unlock the device screen and return the resulting lock state. Android unlock works only without a PIN, pattern, or password.",
			inputSchema: z
				.object({ device: deviceSchema, locked: z.boolean() })
				.strict(),
			outputSchema: z.object({ device: z.string(), locked: z.boolean() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, locked }) => {
			const target = parseOnlineDevice(device);
			const state =
				target.platform === "ios"
					? await useWda(target.target, () => wda.setLocked(locked))
					: await android.setLocked(target.target, locked);
			if (state !== locked)
				throw new Error(
					`Device is still ${state ? "locked" : "unlocked"}${state ? "; a PIN or pattern may be set" : ""}`,
				);
			return jsonResult({ device, locked: state });
		}),
	);

	server.registerTool(
		"mobile_simulate_biometric",
		{
			title: "Simulate iOS Face ID Or Touch ID",
			description:
				"Enroll or unenroll Simulator biometrics, or deliver a matching or failing Face ID/Touch ID scan while the app is prompting. Needs Xcode 27. Use mobile_fingerprint on Android.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["enroll", "unenroll", "match", "fail"]),
				})
				.strict(),
			outputSchema: z.object({ device: z.string(), action: z.string() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error("Use mobile_fingerprint for Android Emulators");
			await ios.setBiometric(target.target, action);
			return jsonResult({ device, action });
		}),
	);

	server.registerTool(
		"mobile_record_screen",
		{
			title: "Record Screen Video",
			description:
				"Record the screen to a new .mp4 file beneath MOBILE_MCP_APP_ROOT. action record (default) blocks for durationSeconds. action start returns at once so you can tap and type while it records; durationSeconds is then the maximum. Call action stop (device only) to finish and get the file.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["record", "start", "stop"]).default("record"),
					path: z
						.string()
						.min(1)
						.max(2_048)
						.optional()
						.describe("Required for record and start"),
					durationSeconds: z.number().int().min(1).max(180).default(10),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				action: z.enum(["record", "start", "stop"]),
				path: z.string(),
				bytes: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("Set once the file is final: after record and stop"),
				durationSeconds: z.number().int(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action, path, durationSeconds }) => {
			const target = parseOnlineDevice(device);
			if (action === "stop") {
				const active = recordings.get(device);
				if (!active)
					throw new Error(`No recording is in progress on ${device}`);
				recordings.delete(device);
				await active.stop();
				const { size } = await stat(active.path);
				return jsonResult({
					device,
					action,
					path: active.path,
					bytes: size,
					durationSeconds: Math.round((Date.now() - active.startedAt) / 1_000),
				});
			}
			if (!path) throw new Error(`path is required for action ${action}`);
			if (recordings.has(device))
				throw new Error(
					`${device} is already recording; call mobile_record_screen with action stop first`,
				);
			const output = await validateOutputPath(path, ".mp4");
			const recording =
				target.platform === "ios"
					? await ios.startVideo(target.target, output)
					: await android.startScreenRecord(target.target, output, durationSeconds);
			if (action === "record") {
				await sleep(durationSeconds * 1_000);
				await recording.stop();
				const { size } = await stat(output);
				return jsonResult({ device, action, path: output, bytes: size, durationSeconds });
			}
			// Stop once: from the action stop call, the time limit, or server close.
			let stopping: Promise<void> | undefined;
			const stop = () => {
				clearTimeout(limit);
				stopping ??= recording.stop();
				return stopping;
			};
			// The error, if any, is reported by the later action stop call.
			const limit = setTimeout(() => void stop().catch(() => undefined), durationSeconds * 1_000);
			recordings.set(device, { path: output, startedAt: Date.now(), stop });
			return jsonResult({ device, action, path: output, durationSeconds });
		}),
	);

	server.registerTool(
		"mobile_get_crash_logs",
		{
			title: "Get App Crash Logs",
			description:
				"Return recent crash reports for one app: Android crash-buffer entries for its UID; iOS Simulator .ips reports summarized to exception and faulting-thread frames.",
			inputSchema: z
				.object({
					device: deviceSchema,
					appId: appIdSchema,
					sinceMinutes: z.number().int().min(1).max(1_440).default(60),
					maxLines: z.number().int().min(1).max(5_000).default(2_000),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				appId: z.string(),
				platform: platformSchema,
				found: z.boolean(),
				logs: z.string(),
				truncated: z.boolean(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, appId, sinceMinutes, maxLines }) => {
			const target = parseOnlineDevice(device);
			const checkedAppId = validateAppIdentifier(target.platform, appId);
			const logs =
				target.platform === "ios"
					? tailLines(
							(
								await ios.crashReports(target.target, checkedAppId, sinceMinutes)
							).join("\n\n"),
							maxLines,
						)
					: await android.getLogs(
							target.target,
							checkedAppId,
							sinceMinutes,
							maxLines,
							true,
						);
			const limited = truncate(logs);
			return jsonResult({
				device,
				appId: checkedAppId,
				platform: target.platform,
				found: logs.trim().length > 0,
				logs: limited.value,
				truncated: limited.truncated,
			});
		}),
	);

	server.registerTool(
		"mobile_accessibility_audit",
		{
			title: "Run iOS Accessibility Audit",
			description:
				"Run Apple's XCTest accessibility audit (iOS 17+) on the foreground app and list issues such as low contrast, clipped text, missing labels, or small hit regions. Android has no command-line audit.",
			inputSchema: z
				.object({
					device: deviceSchema,
					auditTypes: z
						.array(
							z.enum(
								Object.keys(AUDIT_TYPES) as [
									keyof typeof AUDIT_TYPES,
									...(keyof typeof AUDIT_TYPES)[],
								],
							),
						)
						.max(9)
						.optional()
						.describe("Defaults to all audit types"),
					limit: z.number().int().min(1).max(500).default(100),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				count: z.number().int().nonnegative(),
				truncated: z.boolean(),
				issues: z.array(
					z.object({
						auditType: z.string(),
						description: z.string(),
						detail: z.string().optional(),
						element: z
							.object({
								type: z.string().optional(),
								label: z.string().optional(),
								rect: z.unknown().optional(),
							})
							.optional(),
					}),
				),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, auditTypes, limit }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error(
					"Android has no command-line accessibility audit; use mobile_list_elements to check labels",
				);
			const issues = await useWda(target.target, () =>
				wda.accessibilityAudit(
					(auditTypes ?? []).map((name) => AUDIT_TYPES[name]),
				),
			);
			return jsonResult({
				device,
				count: issues.length,
				truncated: issues.length > limit,
				issues: issues.slice(0, limit),
			});
		}),
	);

	server.registerTool(
		"mobile_keychain",
		{
			title: "Manage iOS Simulator Keychain",
			description:
				"Add a trusted root certificate (for HTTPS debugging proxies), add a certificate, or reset the iOS Simulator keychain. Certificate paths are confined beneath MOBILE_MCP_APP_ROOT.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["add-root-cert", "add-cert", "reset"]),
					path: z.string().min(1).max(2_048).optional(),
				})
				.strict(),
			outputSchema: z.object({ device: z.string(), action: z.string() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action, path }) => {
			const target = parseOnlineDevice(device);
			if (target.platform !== "ios")
				throw new Error(
					"mobile_keychain supports iOS Simulators only; use mobile_set_proxy for Android traffic",
				);
			if (action === "reset") {
				if (path) throw new Error("reset does not take a path");
				await ios.keychain(target.target, action);
			} else {
				if (!path) throw new Error(`${action} requires a certificate path`);
				await ios.keychain(
					target.target,
					action,
					await validateCertificatePath(path),
				);
			}
			return jsonResult({ device, action });
		}),
	);

	const androidOnly = (device: string, tool: string): string => {
		const target = parseOnlineDevice(device);
		if (target.platform !== "android")
			throw new Error(`${tool} supports Android Emulators only`);
		return target.target;
	};

	server.registerTool(
		"mobile_emulator_snapshot",
		{
			title: "Manage Android Emulator Snapshots",
			description:
				"List, save, load, or delete Android Emulator state snapshots, to reset a test to a known device state in seconds. load replaces the current device state.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["list", "save", "load", "delete"]),
					name: z.string().regex(SNAPSHOT_NAME).optional(),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				action: z.string(),
				name: z.string().optional(),
				snapshots: z.array(z.string()).optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action, name }) => {
			const serial = androidOnly(device, "mobile_emulator_snapshot");
			if (action === "list") {
				return jsonResult({
					device,
					action,
					snapshots: await android.listSnapshots(serial),
				});
			}
			if (!name) throw new Error(`${action} requires a snapshot name`);
			await android.snapshot(serial, action, name);
			return jsonResult({ device, action, name });
		}),
	);

	server.registerTool(
		"mobile_phone_call",
		{
			title: "Simulate Android Phone Call",
			description:
				"Place a simulated inbound call, or accept, hold, reject as busy, or end a call on an Android Emulator, to test call interruptions.",
			inputSchema: z
				.object({
					device: deviceSchema,
					action: z.enum(["call", "accept", "hold", "busy", "cancel"]),
					phoneNumber: phoneNumberSchema,
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				action: z.string(),
				phoneNumber: z.string(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, action, phoneNumber }) => {
			await android.phoneCall(
				androidOnly(device, "mobile_phone_call"),
				action,
				phoneNumber,
			);
			return jsonResult({ device, action, phoneNumber });
		}),
	);

	server.registerTool(
		"mobile_set_sensor",
		{
			title: "Set Android Emulator Sensor",
			description:
				"Set a virtual sensor value on an Android Emulator: acceleration and gyroscope take x,y,z; proximity, light, temperature, pressure, and humidity take one value.",
			inputSchema: z
				.object({
					device: deviceSchema,
					sensor: z.enum(ANDROID_SENSORS),
					values: z.array(z.number().min(-10_000).max(10_000)).min(1).max(3),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				sensor: z.string(),
				values: z.array(z.number()),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device, sensor, values }) => {
			await android.setSensor(
				androidOnly(device, "mobile_set_sensor"),
				sensor,
				values,
			);
			return jsonResult({ device, sensor, values });
		}),
	);

	server.registerTool(
		"mobile_set_proxy",
		{
			title: "Set Android Emulator HTTP Proxy",
			description:
				"Route all Android Emulator TCP traffic through an HTTP proxy, or clear it. The emulator process connects from the Mac, so use a host-side address such as 127.0.0.1:8888, not the guest alias 10.0.2.2. iOS Simulators use the host network; pair a Mac proxy with mobile_keychain add-root-cert.",
			inputSchema: z.discriminatedUnion("action", [
				z
					.object({
						device: deviceSchema,
						action: z.literal("set"),
						proxy: z
							.string()
							.regex(PROXY)
							.describe("Mac-side host:port, for example 127.0.0.1:8888"),
					})
					.strict(),
				z.object({ device: deviceSchema, action: z.literal("clear") }).strict(),
			]),
			outputSchema: z.object({
				device: z.string(),
				action: z.string(),
				proxy: z.string().optional(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async (args) => {
			const serial = androidOnly(args.device, "mobile_set_proxy");
			const proxy = args.action === "set" ? args.proxy : undefined;
			await android.setProxy(serial, proxy);
			return jsonResult({
				device: args.device,
				action: args.action,
				...(proxy ? { proxy } : {}),
			});
		}),
	);

	server.registerTool(
		"mobile_get_screen_info",
		{
			title: "Get Screen Size And Orientation",
			description:
				"Return screen width, height, and orientation. Call it before tapping or swiping so coordinates match the current screen.",
			inputSchema: z.object({ device: deviceSchema }).strict(),
			outputSchema: z.object({
				device: z.string(),
				platform: platformSchema,
				width: z.number(),
				height: z.number(),
				orientation: z.enum(["portrait", "landscape"]),
				density: z.number().optional(),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		safe(async ({ device }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				const info = await useWda(target.target, () =>
					wda.screenInfo(),
				);
				return jsonResult({
					device,
					platform: "ios",
					width: info.width,
					height: info.height,
					orientation: normalizeOrientation(info.orientation),
				});
			}
			return jsonResult({
				device,
				platform: "android",
				...(await android.screenInfo(target.target)),
			});
		}),
	);

	server.registerTool(
		"mobile_tap",
		{
			title: "Tap Mobile Screen",
			description:
				"Tap integer screen coordinates on a running simulator or emulator. Get fresh coordinates from mobile_get_ui_tree or a screenshot first.",
			inputSchema: z
				.object({ device: deviceSchema, x: coordinate, y: coordinate })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				tapped: z.object({ x: z.number().int(), y: z.number().int() }),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, x, y }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				await useWda(target.target, () => wda.tap(x, y));
			} else await android.tap(target.target, x, y);
			return jsonResult({ device, tapped: { x, y } });
		}),
	);

	server.registerTool(
		"mobile_long_press",
		{
			title: "Long Press Mobile Screen",
			description:
				"Press and hold integer screen coordinates to trigger context menus, drag handles, or press-and-hold actions.",
			inputSchema: z
				.object({
					device: deviceSchema,
					x: coordinate,
					y: coordinate,
					durationMs: z.number().int().min(200).max(10_000).default(1_000),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				pressed: z.object({
					x: z.number().int(),
					y: z.number().int(),
					durationMs: z.number().int(),
				}),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, x, y, durationMs }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				await useWda(target.target, () =>
					wda.longPress(x, y, durationMs),
				);
			} else await android.longPress(target.target, x, y, durationMs);
			return jsonResult({ device, pressed: { x, y, durationMs } });
		}),
	);

	server.registerTool(
		"mobile_swipe",
		{
			title: "Swipe Mobile Screen",
			description:
				"Swipe between two integer screen coordinates on a running simulator or emulator.",
			inputSchema: z
				.object({
					device: deviceSchema,
					fromX: coordinate,
					fromY: coordinate,
					toX: coordinate,
					toY: coordinate,
					durationMs: z.number().int().min(50).max(5_000).default(300),
				})
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				swiped: z.object({
					fromX: z.number().int(),
					fromY: z.number().int(),
					toX: z.number().int(),
					toY: z.number().int(),
					durationMs: z.number().int(),
				}),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, fromX, fromY, toX, toY, durationMs }) => {
			await swipeAt(
				parseOnlineDevice(device),
				fromX,
				fromY,
				toX,
				toY,
				durationMs,
			);
			return jsonResult({
				device,
				swiped: { fromX, fromY, toX, toY, durationMs },
			});
		}),
	);

	server.registerTool(
		"mobile_type_text",
		{
			title: "Type Mobile Text",
			description:
				"Type text into the currently focused field. Android supports printable ASCII; iOS supports Unicode through WebDriverAgent.",
			inputSchema: z
				.object({ device: deviceSchema, text: z.string().max(2_000) })
				.strict(),
			outputSchema: z.object({
				device: z.string(),
				typedCharacters: z.number().int().nonnegative(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, text }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				await useWda(target.target, () => wda.typeText(text));
			} else await android.typeText(target.target, text);
			return jsonResult({ device, typedCharacters: [...text].length });
		}),
	);

	// Derived from the Android keycode table so both stay in sync.
	const keySchema = z.enum(
		Object.keys(KEYCODES) as [AndroidKey, ...AndroidKey[]],
	);
	const IOS_KEYS = new Set([
		"HOME",
		"ENTER",
		"DELETE",
		"VOLUME_UP",
		"VOLUME_DOWN",
	] as const);
	server.registerTool(
		"mobile_press_key",
		{
			title: "Press Mobile Key",
			description: `Press a supported system key. iOS supports ${[...IOS_KEYS].join(", ")}; every other key is Android-only.`,
			inputSchema: z.object({ device: deviceSchema, key: keySchema }).strict(),
			outputSchema: z.object({ device: z.string(), pressed: z.string() }),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
		},
		safe(async ({ device, key }) => {
			const target = parseOnlineDevice(device);
			if (target.platform === "ios") {
				const iosKey = [...IOS_KEYS].find((candidate) => candidate === key);
				if (!iosKey)
					throw new Error(
						`${key} is Android-only; iOS supports ${[...IOS_KEYS].join(", ")}`,
					);
				await useWda(target.target, () => wda.pressKey(iosKey));
			} else await android.pressKey(target.target, key);
			return jsonResult({ device, pressed: key });
		}),
	);

	return {
		server,
		close: async () => {
			// Finalize open recordings so their files stay playable.
			await Promise.allSettled([...recordings.values()].map((entry) => entry.stop()));
			if (ownsControllers) await wda.close();
		},
	};
}
