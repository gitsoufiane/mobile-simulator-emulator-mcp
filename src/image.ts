import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const JPEG_QUALITY = "80";

/** Width and height from the IHDR chunk, which always follows the 8-byte signature. */
export function pngSize(png: Buffer): { width: number; height: number } {
	if (png.length < 24 || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE)
		throw new Error("Device returned an invalid PNG screenshot");
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Resizes a PNG and encodes it as JPEG with macOS `sips`, which ships with
 * every Mac. A full-resolution iPhone PNG is about 3 MB; the point-sized
 * JPEG is about 80 KB.
 */
export async function toJpeg(
	png: Buffer,
	width: number,
	height: number,
): Promise<Buffer> {
	const folder = await mkdtemp(join(tmpdir(), "mobile-mcp-"));
	try {
		const input = join(folder, "screen.png");
		const output = join(folder, "screen.jpg");
		await writeFile(input, png);
		await run("sips", [
			"-s",
			"format",
			"jpeg",
			"-s",
			"formatOptions",
			JPEG_QUALITY,
			"--resampleHeightWidth",
			String(height),
			String(width),
			input,
			"--out",
			output,
		]);
		return await readFile(output);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}
