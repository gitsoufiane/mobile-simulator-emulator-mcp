import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { pngSize } from "../src/image.js";
import type { WdaController } from "../src/wda.js";
import { connectFakes } from "./harness.js";

const simulator = "ios:A8627257-2D08-47F0-A65B-C17F017A71CD";
// A made-up UDID in the physical-device format.
const phone = "ios:00008030-001A2B3C4D5E6F70";
const NEEDS_XCODE_27 = "This control needs Xcode 27 or newer (xcrun devicectl device capture screenshot)";

/** An RGB PNG: solid grey, or random noise that PNG cannot compress. */
function png(width: number, height: number, noisy = false): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Array.from({ length: height }, () =>
		Buffer.concat([Buffer.from([0]), noisy ? randomBytes(width * 3) : Buffer.alloc(width * 3, 128)]),
	);
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function image(result: CallToolResult) {
	const [picture, meta] = result.content;
	assert.ok(picture?.type === "image" && meta?.type === "text", "an image block, then a text block");
	return {
		data: Buffer.from(picture.data, "base64"),
		mimeType: picture.mimeType,
		meta: JSON.parse(meta.text) as { width: number; height: number; tapUnits: boolean; note?: string },
	};
}

test("reads PNG dimensions and rejects anything that is not a PNG", () => {
	assert.deepEqual(pngSize(png(7, 3)), { width: 7, height: 3 });
	assert.throws(() => pngSize(Buffer.from("not a png at all, really")), /invalid PNG/u);
});

test("returns screenshots as JPEG in tap units, or the native PNG on request", async () => {
	const session = await connectFakes({
		android: { screenshot: async () => png(30, 60) },
		ios: { screenshot: async () => png(90, 180), pointScale: async () => 3 },
	});
	try {
		const ios = image(await session.call("mobile_take_screenshot", { device: simulator }));
		assert.equal(ios.mimeType, "image/jpeg");
		assert.equal(ios.data.subarray(0, 3).toString("hex"), "ffd8ff");
		assert.deepEqual(
			[ios.meta.width, ios.meta.height, ios.meta.tapUnits],
			[30, 60, true],
			"iOS pixels are divided by the point scale",
		);

		// Android taps use pixels, so nothing is resized; a flat screen stays PNG
		// because the PNG is already smaller than any JPEG of it.
		const android = image(await session.call("mobile_take_screenshot", { device: "android:emulator-5554" }));
		assert.equal(android.mimeType, "image/png");
		assert.ok(android.data.equals(png(30, 60)));
		assert.deepEqual([android.meta.width, android.meta.height, android.meta.tapUnits], [30, 60, true]);

		const full = image(await session.call("mobile_take_screenshot", { device: simulator, fullResolution: true }));
		assert.equal(full.mimeType, "image/png");
		assert.deepEqual(pngSize(full.data), { width: 90, height: 180 });
		assert.equal(full.meta.tapUnits, false, "iOS pixels are not tap units");
	} finally {
		await session.close();
	}
});

test("sends a busy Android screen as the smaller JPEG", async () => {
	const native = png(128, 128, true);
	const session = await connectFakes({ android: { screenshot: async () => native } });
	try {
		const shot = image(await session.call("mobile_take_screenshot", { device: "android:emulator-5554" }));
		assert.equal(shot.mimeType, "image/jpeg");
		assert.ok(shot.data.length < native.length);
		assert.deepEqual([shot.meta.width, shot.meta.height, shot.meta.tapUnits], [128, 128, true]);
	} finally {
		await session.close();
	}
});

test("says when an iOS image stays in pixels because the scale is unknown", async () => {
	const session = await connectFakes({
		ios: {
			screenshot: async () => png(20, 40),
			pointScale: async () => {
				throw new Error(NEEDS_XCODE_27);
			},
		},
	});
	try {
		const shot = image(await session.call("mobile_take_screenshot", { device: simulator }));
		assert.deepEqual([shot.meta.width, shot.meta.height, shot.meta.tapUnits], [20, 40, false]);
		assert.match(shot.meta.note ?? "", /point scale is unknown: This control needs Xcode 27/u);
	} finally {
		await session.close();
	}
});

test("takes iPhone screenshots through WebDriverAgent before Xcode 27, but not Simulator ones", async () => {
	const wda = {
		use: async <T>(_udid: string, _target: unknown, operation: () => Promise<T>) => operation(),
		screenshot: async () => png(90, 180),
	} as unknown as Partial<WdaController>;
	const session = await connectFakes({
		ios: {
			screenshot: async () => {
				throw new Error(NEEDS_XCODE_27);
			},
			pointScale: async () => 3,
		},
		wda,
	});
	try {
		const shot = image(await session.call("mobile_take_screenshot", { device: phone }));
		assert.deepEqual([shot.meta.width, shot.meta.height], [30, 60]);
		const simulatorShot = await session.callRaw("mobile_take_screenshot", { device: simulator });
		assert.equal(simulatorShot.isError, true, "a Simulator capture error is not hidden");
	} finally {
		await session.close();
	}
});

test("gives a real iPhone its real location back when the server closes", async () => {
	const cleared: string[] = [];
	const session = await connectFakes({
		ios: {
			setLocation: async (udid: string, location?: { latitude: number; longitude: number }) => {
				if (!location) cleared.push(udid);
			},
		},
	});
	await session.call("mobile_set_location", { device: phone, action: "set", latitude: 1, longitude: 2 });
	await session.call("mobile_set_location", { device: simulator, action: "set", latitude: 1, longitude: 2 });
	assert.deepEqual([...session.controllers.simulatedLocations], ["00008030-001A2B3C4D5E6F70"]);
	await session.close();
	assert.deepEqual(cleared, ["00008030-001A2B3C4D5E6F70"], "only the phone is cleared");
});
