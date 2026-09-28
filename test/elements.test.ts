import assert from "node:assert/strict";
import { test } from "node:test";
import {
	filterElements,
	parseAndroidElements,
	parseIosElements,
} from "../src/elements.js";

test("extracts labeled and interactive Android nodes with tap centers", () => {
	// Shape from `uiautomator dump --compressed`.
	const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Save &amp; exit" resource-id="com.example:id/save" class="android.widget.Button" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][300,260]" /><node index="1" text="" resource-id="" class="android.widget.Switch" package="com.example" content-desc="Wi&#8209;Fi" checkable="true" checked="true" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,300][1080,400]" /><node index="2" text="" resource-id="" class="android.view.View" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" /></node></hierarchy>`;

	assert.deepEqual(parseAndroidElements(xml), [
		{
			type: "Button",
			label: "Save & exit",
			id: "com.example:id/save",
			rect: { x: 100, y: 200, width: 200, height: 60 },
			center: { x: 200, y: 230 },
			flags: ["clickable"],
		},
		{
			type: "Switch",
			label: "Wi\u2011Fi",
			rect: { x: 0, y: 300, width: 1080, height: 100 },
			center: { x: 540, y: 350 },
			flags: ["clickable", "checked", "disabled"],
		},
	]);
});

test("extracts visible iOS elements and skips containers and keys", () => {
	// Shape from WebDriverAgent GET /source?format=json.
	const tree = {
		type: "Application",
		label: "Settings",
		rect: { x: 0, y: 0, width: 402, height: 874 },
		children: [
			{
				type: "Other",
				label: null,
				rect: { x: 0, y: 0, width: 402, height: 874 },
				children: [
					{
						type: "Button",
						label: "General",
						rawIdentifier: "com.apple.settings.general",
						value: null,
						isEnabled: "1",
						isVisible: "1",
						rect: { x: 16, y: 300, width: 370, height: 52 },
					},
					{
						type: "TextField",
						label: "",
						value: "Search",
						isEnabled: "1",
						isFocused: "1",
						rect: { x: 16, y: 100, width: 370, height: 36 },
					},
					{
						type: "StaticText",
						label: "Hidden",
						isVisible: "0",
						rect: { x: 0, y: 900, width: 10, height: 10 },
					},
					{
						type: "Key",
						label: "q",
						rect: { x: 0, y: 700, width: 30, height: 40 },
					},
				],
			},
		],
	};

	assert.deepEqual(parseIosElements(tree), [
		{
			type: "Button",
			label: "General",
			id: "com.apple.settings.general",
			rect: { x: 16, y: 300, width: 370, height: 52 },
			center: { x: 201, y: 326 },
		},
		{
			type: "TextField",
			value: "Search",
			rect: { x: 16, y: 100, width: 370, height: 36 },
			center: { x: 201, y: 118 },
			flags: ["focused"],
		},
	]);
	assert.deepEqual(parseIosElements(null), []);
});

test("filters elements by label, id, value, or type", () => {
	const elements = parseIosElements({
		type: "Other",
		rect: { x: 0, y: 0, width: 10, height: 10 },
		children: [
			{
				type: "Button",
				label: "Continue",
				rect: { x: 0, y: 0, width: 10, height: 10 },
			},
			{
				type: "Switch",
				rawIdentifier: "airplane",
				rect: { x: 0, y: 20, width: 10, height: 10 },
			},
		],
	});
	assert.equal(filterElements(elements, "continue").length, 1);
	assert.equal(filterElements(elements, "AIRPLANE").length, 1);
	assert.equal(filterElements(elements, "switch").length, 1);
	assert.equal(filterElements(elements, undefined).length, 2);
});

test("ranks exact label matches before substring matches", () => {
	const elements = parseIosElements({
		type: "Other",
		rect: { x: 0, y: 0, width: 10, height: 10 },
		children: [
			{ type: "Button", label: "Look", rect: { x: 0, y: 0, width: 10, height: 10 } },
			{ type: "Button", label: "OK", rect: { x: 0, y: 20, width: 10, height: 10 } },
		],
	});
	assert.deepEqual(
		filterElements(elements, "ok").map((entry) => entry.label),
		["OK", "Look"],
	);
});
