# Mobile MCP implementation plan

## Goal

Build a local MCP server that lets an agent discover and control Apple iOS Simulators, Google Android Emulators, and connected iPhones, iPads, and Android phones for app testing. stdio is the default transport; `--listen` adds a loopback-only Streamable HTTP listener with a bearer token.

## Decisions

- Use the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) with strict Zod schemas. `serveStdio` and `createMcpHandler` serve both protocol eras from one factory: `2025-11-25` (initialize handshake) and the stateless `2026-07-28` revision.
- Device state that must outlive one protocol server (WebDriverAgent, background recordings) lives in shared controllers, because HTTP builds a server per request.
- Serve the bundled `skills/mobile-mcp` Agent Skill over the MCP Skills extension (SEP-2640), and ship it as a Claude Code plugin, an Agent Plugins package (Codex), and a Pi package.
- Use Apple `xcrun simctl` and Google `adb`/`emulator` through `execFile` argument arrays; never expose arbitrary shell execution.
- Use Appium's open-source `appium-webdriveragent` package only to build and keep WebDriverAgent running. Talk to WDA over loopback with `fetch` for iOS taps, swipes, typing, screenshots, and UI source.
- Support simulators, emulators, and connected physical devices. Physical iOS uses `devicectl` for apps, and with Xcode 27 for screenshots, clipboard, appearance, accessibility settings, simulated location, and screen recording where the device supports it; WDA over the CoreDevice tunnel serves UI reading and gestures. Simulator-only and emulator-console tools refuse physical targets.
- Screenshots default to a JPEG sized in tap units (iOS points from `devicectl device info displays`, Android pixels), encoded with macOS `sips`; `fullResolution` returns the native PNG.
- Use stable device IDs: `ios:<UDID>`, `android:<serial>`, and `android-avd:<name>`.
- Keep one iOS WDA session per server process. A Simulator agent takes a free loopback port per launch, so two server processes never share an agent; a physical agent listens on its device's tunnel address. Android remains independently usable at the same time.

## Tool surface

`mobile_set_ios_team` selects the physical iOS signing team; the 55 device tools follow.

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
40. `mobile_tap_element`
41. `mobile_double_tap`
42. `mobile_handle_alert`
43. `mobile_dismiss_keyboard`
44. `mobile_set_lock`
45. `mobile_simulate_biometric`
46. `mobile_record_screen`
47. `mobile_get_crash_logs`
48. `mobile_accessibility_audit`
49. `mobile_keychain`
50. `mobile_emulator_snapshot`
51. `mobile_phone_call`
52. `mobile_set_sensor`
53. `mobile_set_proxy`
54. `mobile_wait_for_element`
55. `mobile_scroll_to_element`

## Safety boundaries

- stdio by default; `--listen` binds Streamable HTTP to `127.0.0.1` only, with no remote listener. Requests whose `Host` or `Origin` is not loopback get HTTP 403 (MCP transport DNS-rebinding requirement), and requests without `Authorization: Bearer <MOBILE_MCP_HTTP_TOKEN>` get HTTP 401 (constant-time compare; a random token is printed when none is set). All HTTP requests share one controller set.
- Per-command timeouts and output caps.
- Media and app install paths are confined beneath `MOBILE_MCP_APP_ROOT` by one shared resolver, with an extension allowlist for media.
- Strict identifiers, coordinates, durations, URL schemes, and local app paths.
- Every Android command targets an explicit serial with `adb -s`.
- Emulator console values reject line breaks and control characters; the console runs one command per line.
- `devicectl process launch` gets `--` before the bundle ID, so app arguments are never read as `devicectl` options.
- Text read from devices is untrusted data; the server instructions and skill say so.
- Only `http`, `https`, or explicitly configured deep-link schemes may be opened.
- No telemetry, credentials, arbitrary host paths for output, arbitrary ADB shell, or arbitrary `simctl spawn`.
- Curated destructive operations execute without per-call confirmation; the local MCP client configuration is the trust boundary.
- App reset/uninstall and iOS Simulator erase are supported. Android online AVD wipe, device creation/deletion, and device farms are out of scope. Simulated biometrics never reach a physical device.
- Raw ADB/simctl argument passthrough remains forbidden.
- iOS network conditioning remains out of scope because Apple provides no supported command for it. Face ID/Touch ID, orientation, reduce motion/transparency, and VoiceOver use Xcode 27 `devicectl`, which drives Simulators.
- Simulator keychain control is limited to adding certificates confined beneath `MOBILE_MCP_APP_ROOT` and resetting; screen recordings are bounded (<=180 s) and written only as new `.mp4` files beneath the same root.
- App-container paths, iCloud sync, and device create/clone/delete/rename remain out of scope: they leak host paths or manage fleets rather than drive a running device.
- Emulator console commands (`adb emu`) exit 0 with `KO:` on failure; the shared console helper converts that to an error.
- MCP prompts and completions remain unimplemented, and the only resources are the bundled skill's files; device state is too volatile to cache as a resource and every workflow maps cleanly to a tool call.
- Native commands that exit 0 on failure (`uiautomator dump`, `xcrun simctl spawn log show`, `xcrun simctl pbcopy`) must have their output validated, never returned verbatim as a result. `uiautomator dump /dev/tty` reads the tree in one `adb exec-out` call with no file on the device.

## Build order

1. Scaffold strict TypeScript, package metadata, and the safe command runner.
2. Add Android and iOS lifecycle/app adapters.
3. Add WDA lifecycle/client and cross-platform UI actions.
4. Register MCP tools with accurate annotations and structured results.
5. Add protocol/unit tests plus live smoke checks on both installed platforms.
6. Run diagnostics, build, unit tests, live checks, dependency audit, and adversarial review; fix blockers and repeat up to three review rounds.

## Release gates

- `npm run check` passes (TypeScript + Node test runner), including `2025-11-25` and `2026-07-28` clients over stdio and HTTP and the Skills extension read.
- `npm audit` reports no vulnerabilities; CI runs Node 22, 24, and 26.
- `claude plugin validate .` passes and the skill passes the Agent Skills `skills-ref validate`.
- Every tool except `mobile_take_screenshot` advertises an `outputSchema`; the SDK validates `structuredContent` against it on every call.
- The server advertises `instructions` describing the doctor -> list -> act sequence.
- `npm run live:tools` passes against a booted emulator for app discovery, appearance, accessibility, screen info, and long press.
- MCP in-memory test covers tool listing, a valid call, and schema rejection.
- Injection/path/scheme validation tests pass.
- Live Android checks list `emulator-5554`, capture a screenshot, and read UI XML.
- Live iOS checks list the booted simulator, start WDA, capture a JPEG in points that is far smaller than the full-resolution PNG, read UI source, collect bounded app logs, and perform reversible interaction/location changes.
- Live Android checks collect bounded app logs, set a geo fix, and change/restore battery and network profiles through the official emulator console path.
- Live iOS checks round-trip clipboard text, override/clear the status bar, and boot/shut down a spare Simulator when one is available.
- Live Android checks rotate four times to restore orientation and remove a simulated fingerprint touch.
- Destructive app/device tools, permission changes, push, SMS, and install/uninstall require a disposable app/device fixture and are validated manually rather than against system apps.
- Physical-device changes (clipboard, appearance, location) are checked only with the owner's permission and restored afterward.
