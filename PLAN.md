# Mobile MCP implementation plan

## Goal

Build a local MCP server that lets an agent discover and control Apple iOS Simulators and Google Android Emulators for app testing. stdio is the default transport; `--listen` adds a loopback-only Streamable HTTP listener.

## Decisions

- Use the official `@modelcontextprotocol/sdk` v1 API with strict Zod schemas.
- Use Apple `xcrun simctl` and Google `adb`/`emulator` through `execFile` argument arrays; never expose arbitrary shell execution.
- Use Appium's open-source `appium-webdriveragent` package only to build and keep WebDriverAgent running. Talk to WDA over loopback with `fetch` for iOS taps, swipes, typing, screenshots, and UI source.
- Support simulators/emulators only. Reject physical devices.
- Use stable device IDs: `ios:<UDID>`, `android:<serial>`, and `android-avd:<name>`.
- Keep one iOS WDA session on loopback port 8100. Android remains independently usable at the same time.

## Tool surface

1. `mobile_doctor`
2. `mobile_list_devices`
3. `mobile_boot_device`
4. `mobile_shutdown_device`
5. `mobile_install_app`
6. `mobile_launch_app`
7. `mobile_terminate_app`
8. `mobile_open_url`
9. `mobile_take_screenshot`
10. `mobile_get_ui_tree`
11. `mobile_tap`
12. `mobile_swipe`
13. `mobile_type_text`
14. `mobile_press_key`
15. `mobile_get_logs`
16. `mobile_reset_app`
17. `mobile_set_permission`
18. `mobile_set_location`
19. `mobile_send_push`
20. `mobile_uninstall_app`
21. `mobile_erase_device`
22. `mobile_set_clipboard`
23. `mobile_get_clipboard`
24. `mobile_set_status_bar`
25. `mobile_set_battery`
26. `mobile_send_sms`
27. `mobile_fingerprint`
28. `mobile_set_network`
29. `mobile_rotate`
30. `mobile_set_connectivity`
31. `mobile_list_apps`
32. `mobile_get_foreground_app`
33. `mobile_get_screen_info`
34. `mobile_long_press`
35. `mobile_set_appearance`
36. `mobile_set_accessibility`
37. `mobile_add_media`
38. `mobile_set_orientation`
39. `mobile_list_elements`

## Safety boundaries

- stdio by default; `--listen` binds Streamable HTTP to `127.0.0.1` only, with no remote listener and the same trust model as stdio. Requests whose `Host` or `Origin` is not loopback get HTTP 403 (MCP transport DNS-rebinding requirement). All HTTP sessions share one controller set, so one WebDriverAgent serves port 8100.
- Per-command timeouts and output caps.
- Media and app install paths are confined beneath `MOBILE_MCP_APP_ROOT` by one shared resolver, with an extension allowlist for media.
- Strict identifiers, coordinates, durations, URL schemes, and local app paths.
- Every Android command targets an explicit emulator serial with `adb -s`.
- Only `http`, `https`, or explicitly configured deep-link schemes may be opened.
- No telemetry, credentials, arbitrary host paths for output, arbitrary ADB shell, or arbitrary `simctl spawn`.
- Curated destructive operations execute without per-call confirmation; the local MCP client configuration is the trust boundary.
- App reset/uninstall and iOS Simulator erase are supported. Android online AVD wipe, device creation/deletion, real devices, video recording, and device farms are out of scope.
- Raw ADB/simctl argument passthrough remains forbidden.
- iOS network conditioning and biometric events remain out of scope because Apple provides no supported `simctl` command for them.
- Simulator keychain, app-container paths, iCloud sync, and device create/clone/delete/rename remain out of scope: they leak host paths or manage fleets rather than drive a running device.
- MCP resources, prompts, and completions remain unimplemented; device state is too volatile to cache as a resource and every workflow maps cleanly to a tool call.
- Native commands that exit 0 on failure (`uiautomator dump`, `adb exec-out cat`, `xcrun simctl spawn log show`) must have their output validated, never returned verbatim as a result.

## Build order

1. Scaffold strict TypeScript, package metadata, and the safe command runner.
2. Add Android and iOS lifecycle/app adapters.
3. Add WDA lifecycle/client and cross-platform UI actions.
4. Register MCP tools with accurate annotations and structured results.
5. Add protocol/unit tests plus live smoke checks on both installed platforms.
6. Run diagnostics, build, unit tests, live checks, dependency audit, and adversarial review; fix blockers and repeat up to three review rounds.

## Release gates

- `npm run check` passes (TypeScript + Node test runner).
- Every tool except `mobile_take_screenshot` advertises an `outputSchema`; the SDK validates `structuredContent` against it on every call.
- The server advertises `instructions` describing the doctor -> list -> act sequence.
- `npm run live:tools` passes against a booted emulator for app discovery, appearance, accessibility, screen info, and long press.
- MCP in-memory test covers tool listing, a valid call, and schema rejection.
- Injection/path/scheme validation tests pass.
- Live Android checks list `emulator-5554`, capture a PNG, and read UI XML.
- Live iOS checks list the booted simulator, start WDA, capture a PNG, read UI source, collect bounded app logs, and perform reversible interaction/location changes.
- Live Android checks collect bounded app logs, set a geo fix, and change/restore battery and network profiles through the official emulator console path.
- Live iOS checks round-trip clipboard text, override/clear the status bar, and boot/shut down a spare Simulator when one is available.
- Live Android checks rotate four times to restore orientation and remove a simulated fingerprint touch.
- Destructive app/device tools, permission changes, push, SMS, and install/uninstall require a disposable app/device fixture and are validated manually rather than against system apps.
- `npm audit --omit=dev` has no high or critical vulnerability, or any exception is documented.
