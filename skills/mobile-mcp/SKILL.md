---
name: mobile-mcp
description: Controls iOS Simulators, Android Emulators, and physical iPhones, iPads, and Android phones through the `mobile` MCP server (mobile_* tools, such as mcp__mobile__mobile_tap). Use to open, launch, tap, type, swipe, scroll, screenshot, install, or inspect an app on a simulator, emulator, or connected phone, to reproduce or check a mobile UI bug, or to connect the mobile MCP server to Pi, Claude Code, or Codex. Use it instead of running xcrun simctl, xcrun devicectl, or adb directly. Not for editing app source code.
license: MIT
compatibility: Requires macOS with Xcode and the mobile MCP server (github:gitsoufiane/mobile-simulator-emulator-mcp) connected as `mobile`. Android devices also need Android SDK Platform Tools.
---

# Mobile MCP

Follow the `mobile` server's MCP instructions. When they differ from this file, they win.

## Tool names

This file uses bare tool names such as `mobile_doctor`.

- Pi: call `tools.mcp__mobile__mobile_doctor({})` inside `codemode`. Pi shows only one line of the server instructions, so read them once: `return (await describeNamespace("mcp__mobile")).instructions`. A failed call resolves with `isError: true` instead of throwing, so check it.
- Claude Code: call `mcp__mobile__mobile_doctor`. The server instructions are already in context.
- Codex: call `mobile_doctor` on the `mobile` server. Codex reads the server instructions.

## Setup

Run setup only when no `mobile` tools exist. Give the user the command for their agent; do not change their configuration yourself.

```bash
pi mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
claude mcp add --scope user mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
codex mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
```

- Physical iPhone or iPad: add `--env MOBILE_MCP_IOS_TEAM_ID=<Apple team ID>` after `mobile` and before `--`.
- The first iOS UI call builds WebDriverAgent for several minutes. Pi and Codex stop a tool call after 60 seconds by default. Set `"timeout": 300` in the Pi `mcp.json` entry. In `~/.codex/config.toml`, add `tool_timeout_sec = 300` and `startup_timeout_sec = 120` directly under the existing `[mcp_servers.mobile]` table; the first start also clones and builds the server.

## Work loop

1. `mobile_doctor`, then `mobile_list_devices`. Reuse the exact returned `id`.
2. `mobile_list_apps` for bundle IDs and package names. Add `includeSystem: true` for built-in apps such as Settings. Never guess an app ID.
3. Read the screen with `mobile_list_elements` (`query` finds one element). Use `mobile_take_screenshot` for visual checks.
4. Act. Prefer `mobile_tap_element` by label over `mobile_tap` by coordinates. Also `mobile_swipe`, `mobile_type_text`, and `mobile_press_key`.
5. After each action, call `mobile_wait_for_element` for the expected result (`timeoutMs` 500 to 60000, default 10000). Use `mobile_scroll_to_element` for off-screen items. Do not sleep.
6. On failure, collect `mobile_get_logs` or `mobile_get_crash_logs`. They are not available on physical iOS devices.

Example in a Pi `codemode` script (Settings > General on iOS):

```js
const call = async (name, args) => {
  const result = await tools[`mcp__mobile__${name}`](args);
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return result;
};
const device = "ios:<id from mobile_list_devices>";
await call("mobile_launch_app", { device, appId: "com.apple.Preferences" });
await call("mobile_wait_for_element", { device, query: "General", timeoutMs: 30000 });
await call("mobile_tap_element", { device, query: "General" });
await call("mobile_wait_for_element", { device, query: "About" });
image((await call("mobile_take_screenshot", { device })).content[0]);
```

## Physical devices

Entries with `physical: true` are physical devices with real user data.

- You MUST ask the user before any tool that installs, uninstalls, resets, erases, or changes permissions or settings on a physical device.
- Simulator-only and emulator-only tools return an error on a physical device. Do not retry them; report the limit.
- Wait for the first iOS UI call while it builds and installs WebDriverAgent. Do not start a second call.
- `xcodebuild failed with code 65`: ask the user to unlock the device and trust the developer certificate in Settings > General > VPN & Device Management. Then retry once.
- `Not authorized for performing UI testing actions`: ask the user to unlock the device. Find the app ID that ends in `.WebDriverAgentRunner.xctrunner` with `mobile_list_apps`, stop it with `mobile_terminate_app`, then retry.

## Report

Give the device ID, the steps you ran, and what you saw. Quote tool errors exactly. Show or describe the final screenshot when the result is visual.
