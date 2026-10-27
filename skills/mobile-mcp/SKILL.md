---
name: mobile-mcp
description: Test and control apps on iOS Simulators, Android Emulators, and physical iPhones, iPads, or Android phones through the mobile MCP server (tools named mobile_*, such as mobile_tap or mcp__mobile__mobile_tap). Use when asked to open, tap, type, swipe, screenshot, install, launch, or check an app on a simulator, emulator, or real phone, to reproduce a mobile UI bug, or to set up the mobile MCP server in Pi, Claude Code, or Codex.
---

# Mobile MCP

The server's own MCP instructions are the source of truth for the tool workflow. Read them first; follow them when they differ from this file.

## 1. Reach the server

The server is registered as `mobile`. This file uses the bare tool names (`mobile_doctor`).

- Pi: call them inside `codemode`, for example `await tools.mcp__mobile__mobile_doctor({})`.
- Claude Code: call `mcp__mobile__mobile_doctor` and the other tools directly.
- Codex: call the `mobile_*` tools of the `mobile` server directly.

No `mobile` tools? Tell the user the setup command and stop:

- Pi: `pi mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp`
- Claude Code: `claude mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp`
- Codex: `codex mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp`

Physical iPhone or iPad: the server also needs `MOBILE_MCP_IOS_TEAM_ID=<Apple team ID>` in its environment (`--env` for Pi and Codex, `-e` for Claude Code, before `--`).

## 2. Read the server instructions

- Pi shows only one line of them. Read the full text: `return (await describeNamespace("mcp__mobile")).instructions`.
- Claude Code adds them to the system prompt. No action needed.
- Codex: if you do not see them, follow the loop below.

## 3. Work loop

1. `mobile_doctor`, then `mobile_list_devices`. Reuse the exact returned `id`.
2. `mobile_list_apps` for bundle IDs or package names. NEVER guess them.
3. Read before acting: `mobile_list_elements` (pass `query` for one element). Use `mobile_take_screenshot` for visual checks.
4. Act with `mobile_tap_element`, `mobile_tap`, `mobile_swipe`, `mobile_type_text`, or `mobile_press_key`.
5. After each action, `mobile_wait_for_element` for the expected result. Use `mobile_scroll_to_element` for off-screen items. Do not sleep.
6. On failure, collect `mobile_get_logs` or `mobile_get_crash_logs` (Simulators, emulators, and Android phones).

In Pi, show a screenshot to yourself with `image(result.content[0])` inside the same `codemode` script.

## 4. Physical devices

Entries with `physical: true` are real phones with real user data.

- You MUST ask the user before install, uninstall, reset, or any other destructive tool on a physical device.
- Simulator-only and emulator-only tools return an error on physical devices. Do not retry them; tell the user.
- The first iOS UI call builds and installs WebDriverAgent. It can take minutes; wait for it.
- `xcodebuild failed with code 65`: ask the user to unlock the device and trust the developer certificate in Settings > General > VPN & Device Management, then retry.
- `Not authorized for performing UI testing actions`: ask the user to unlock the device. Then call `mobile_terminate_app` with `appId` `local.mobilemcp.<TEAM_ID>.WebDriverAgentRunner.xctrunner` and retry.

## 5. Report

State the device ID, the steps you ran, and what you saw. Quote tool errors exactly. Attach or describe the final screenshot when the result is visual.
