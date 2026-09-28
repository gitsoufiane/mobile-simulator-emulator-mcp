/**
 * Compact, token-cheap view of a UI hierarchy. Raw Android XML and iOS WDA
 * JSON trees often exceed 100k characters; agents mostly need "what can I
 * read or tap, and where". Coordinates use the same units as mobile_tap:
 * Android pixels and iOS points.
 */
export interface UiElement {
	type: string;
	label?: string;
	id?: string;
	value?: string;
	rect: { x: number; y: number; width: number; height: number };
	center: { x: number; y: number };
	flags?: string[];
}

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeXml(value: string): string {
	return value.replaceAll(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu,
		(match, entity: string) => {
			const lower = entity.toLowerCase();
			if (!lower.startsWith("#")) return XML_ENTITIES[lower] ?? match;
			const code = lower.startsWith("#x")
				? Number.parseInt(lower.slice(2), 16)
				: Number(lower.slice(1));
			return code <= 0x10ffff ? String.fromCodePoint(code) : match;
		},
	);
}

function element(
	type: string,
	x: number,
	y: number,
	width: number,
	height: number,
	fields: { label?: string; id?: string; value?: string; flags: string[] },
): UiElement {
	return {
		type,
		...(fields.label ? { label: fields.label } : {}),
		...(fields.id ? { id: fields.id } : {}),
		...(fields.value ? { value: fields.value } : {}),
		rect: { x, y, width, height },
		center: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
		...(fields.flags.length ? { flags: fields.flags } : {}),
	};
}

const ANDROID_NODE = /<node\b([^>]*)>/gu;
const ANDROID_ATTRIBUTE = /([\w:-]+)="([^"]*)"/gu;
const ANDROID_BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u;

/** Parses `uiautomator dump` XML. Serializer escapes `>` in attributes. */
export function parseAndroidElements(xml: string): UiElement[] {
	return [...xml.matchAll(ANDROID_NODE)].flatMap(([, rawAttributes = ""]) => {
		const attributes = new Map(
			[...rawAttributes.matchAll(ANDROID_ATTRIBUTE)].map(
				([, key = "", value = ""]) => [key, decodeXml(value)],
			),
		);
		const bounds = ANDROID_BOUNDS.exec(attributes.get("bounds") ?? "");
		if (!bounds) return [];
		const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
		];
		if (x2 <= x1 || y2 <= y1) return [];
		const is = (key: string) => attributes.get(key) === "true";
		const labels = [attributes.get("text"), attributes.get("content-desc")]
			.map((value) => value?.trim())
			.filter((value): value is string => Boolean(value));
		const label = [...new Set(labels)].join(" / ");
		const id = attributes.get("resource-id") ?? "";
		const flags = [
			...(is("clickable") || is("long-clickable") ? ["clickable"] : []),
			...(is("checkable") ? [is("checked") ? "checked" : "unchecked"] : []),
			...(is("scrollable") ? ["scrollable"] : []),
			...(is("focused") ? ["focused"] : []),
			...(is("selected") ? ["selected"] : []),
			...(is("password") ? ["password"] : []),
			...(attributes.get("enabled") === "false" ? ["disabled"] : []),
		];
		const interactive = flags.some((flag) =>
			["clickable", "checked", "unchecked", "scrollable"].includes(flag),
		);
		if (!label && !id && !interactive) return [];
		const type = (attributes.get("class") ?? "View").split(".").at(-1) ?? "View";
		return [
			element(type, x1, y1, x2 - x1, y2 - y1, { label, id, flags }),
		];
	});
}

// Types that matter without a label; containers and keyboard keys do not.
const IOS_INTERACTIVE = new Set([
	"Button",
	"Cell",
	"Link",
	"PickerWheel",
	"SearchField",
	"SecureTextField",
	"SegmentedControl",
	"Slider",
	"Stepper",
	"Switch",
	"Tab",
	"TextField",
	"TextView",
	"Toggle",
]);
const IOS_SKIPPED = new Set(["Application", "Window", "Key", "Keyboard"]);

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function flag(value: unknown): boolean | undefined {
	if (value === true || value === "1" || value === 1) return true;
	if (value === false || value === "0" || value === 0) return false;
	return undefined;
}

/** Walks WebDriverAgent `/source?format=json`. */
export function parseIosElements(tree: unknown): UiElement[] {
	const found: UiElement[] = [];
	const stack: unknown[] = [tree];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		const info = node as Record<string, unknown>;
		if (Array.isArray(info.children))
			stack.push(...info.children.toReversed());
		const type = text(info.type) || "Other";
		const rect = info.rect as Record<string, unknown> | undefined;
		const [x, y, width, height] = ["x", "y", "width", "height"].map(
			(key) => rect?.[key],
		);
		if (
			IOS_SKIPPED.has(type) ||
			flag(info.isVisible) === false ||
			typeof x !== "number" ||
			typeof y !== "number" ||
			typeof width !== "number" ||
			typeof height !== "number" ||
			width <= 0 ||
			height <= 0
		)
			continue;
		const label = text(info.label);
		const id = text(info.rawIdentifier);
		const rawValue = text(info.value);
		const value = rawValue === label ? "" : rawValue;
		if (!label && !id && !value && !IOS_INTERACTIVE.has(type)) continue;
		const flags = [
			...(flag(info.isFocused) ? ["focused"] : []),
			...(flag(info.isSelected) ? ["selected"] : []),
			...(flag(info.isEnabled) === false ? ["disabled"] : []),
		];
		found.push(element(type, x, y, width, height, { label, id, value, flags }));
	}
	return found;
}

/** Case-insensitive substring match over label, id, value, and type. */
export function filterElements(
	elements: UiElement[],
	query: string | undefined,
): UiElement[] {
	const needle = query?.trim().toLowerCase();
	if (!needle) return elements;
	return elements.filter((entry) =>
		[entry.label, entry.id, entry.value, entry.type].some((field) =>
			field?.toLowerCase().includes(needle),
		),
	);
}
