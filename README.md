# Mobile Simulator & Emulator MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets coding agents inspect, control, and test Apple iOS Simulators and Google Android Emulators. It exposes 39 typed tools for device lifecycle, app discovery and management, UI automation, compact element lookup, screenshots, logs, permissions, location, appearance/accessibility, and platform-specific test conditions.

It defaults to stdio and can also serve Streamable HTTP on loopback with `--listen`.

It uses:

- `xcrun simctl` for iOS Simulator lifecycle, apps, URLs, and screenshots.
- [Appium WebDriverAgent](https://github.com/appium/WebDriverAgent) for iOS UI trees and input.
- Google `adb` and `emulator` for Android lifecycle, apps, UI trees, screenshots, and input.

Physical devices are intentionally rejected.

## Requirements

- macOS with Xcode and at least one installed iOS Simulator runtime.
- Android SDK Platform Tools and Android Emulator.
- Node.js 22.18+ or 24.2+.
- A booted simulator/emulator for interaction tools. `mobile_boot_device` can boot an installed target returned by `mobile_list_devices`.

Verify the native tools:

```bash
xcrun simctl list devices
adb devices -l
emulator -list-avds
```

## Quick start

Run it straight from GitHub. npm clones the repository, installs dependencies, and builds it on first use:

```bash
npx -y github:gitsoufiane/mobile-simulator-emulator-mcp
```

Or build from source:

```bash
git clone https://github.com/gitsoufiane/mobile-simulator-emulator-mcp.git
cd mobile-simulator-emulator-mcp
npm ci --ignore-scripts
npm run build
```

Start the devices you want the agent to use:

```bash
# iOS: boot a Simulator from Xcode or the command line
open -a Simulator

# Android: list and start an installed AVD
emulator -list-avds
emulator -avd <AVD_NAME>
```

Then verify both native toolchains:

```bash
xcrun simctl list devices
adb devices -l
npm run live
```

The first iOS UI interaction builds and launches WebDriverAgent through Xcode. It can take several minutes. Later calls reuse that process until the MCP server exits or another iOS Simulator is selected.

## Configure an MCP client

Any MCP client that supports local stdio servers can run this server. Add one of the following server definitions to the client's MCP configuration.

With `npx` (no clone needed):

```json
{
  "mcpServers": {
    "mobile": {
      "command": "npx",
      "args": ["-y", "github:gitsoufiane/mobile-simulator-emulator-mcp"]
    }
  }
}
```

From a local build, replacing the absolute path:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "node",
      "args": [
        "/absolute/path/to/mobile-simulator-emulator-mcp/dist/src/index.js"
      ]
    }
  }
}
```

### HTTP mode (`--listen`)

For MCP clients that connect by URL instead of spawning a stdio process
(for example flue's `connectMcpServer`), start the server in Streamable
HTTP mode:

```bash
node dist/src/index.js --listen 3000
# ready on http://127.0.0.1:3000/mcp
```

The HTTP listener binds to `127.0.0.1` only and has no authentication — it
is strictly a same-machine transport with the same trust model as stdio.
As the MCP transport specification requires, it rejects with HTTP 403 any
request whose `Host` or `Origin` header is not `127.0.0.1`, `localhost`, or
`[::1]`, so a web page cannot reach it through DNS rebinding.
Each MCP session gets its own protocol server, and all sessions share one
set of device controllers, so they share one WebDriverAgent process.
Sessions are cleaned up on disconnect. stdio remains the default when
`--listen` is not given.

Restart the MCP client after changing its configuration. The first calls should be:

1. `mobile_doctor` with `{}`.
2. `mobile_list_devices` with `{}`.
3. Use the returned `ios:...`, `android:...`, or `android-avd:...` ID in later calls.

By default, `.app` and `.apk` installation paths are resolved beneath the MCP process working directory. Clients that launch the server from the active agent project—such as Pi's MCP adapter when no `cwd` is configured—therefore need no extra environment setting.

If another MCP client starts the server from a fixed directory, set that client's `cwd` to the mobile project. `MOBILE_MCP_APP_ROOT` remains available as an optional explicit override.

The server writes MCP protocol messages only to stdout. Diagnostics and WebDriverAgent logs go to stderr.

## Recommended agent workflow

1. Call `mobile_doctor`.
2. Call `mobile_list_devices` and keep the returned stable ID.
3. Boot a shutdown target if needed.
4. Install and launch the app. Use `mobile_list_apps` to look up the exact bundle ID or package name instead of guessing, and `mobile_get_foreground_app` to confirm the launch landed.
5. Set permissions or simulated location needed by the scenario.
6. Call `mobile_list_elements` before using coordinates. It returns compact elements with tap-ready `center` coordinates; pass `query` to find one element. Use `mobile_take_screenshot` for visual context and `mobile_get_ui_tree` only when you need the full native hierarchy.
7. Interact with `mobile_tap`, `mobile_swipe`, `mobile_type_text`, and `mobile_press_key`.
8. Re-read the UI tree or screenshot after each state-changing action.
9. Collect `mobile_get_logs` when a workflow fails. Use `mobile_reset_app` only when a clean app state is required.

## Example requests

Once connected, an agent can handle requests such as:

- “List my available simulators and emulators, then boot the shutdown iPhone.”
- “Install the Android debug APK, launch it, and take a screenshot.”
- “Open `myapp://checkout/123`, inspect the UI tree, and tap Continue.”
- “Set the emulator location to San Francisco and test the nearby-results screen.”
- “Collect the last five minutes of logs for `com.example.app`.”
- “Reset the test app, grant location permission, and rerun the onboarding flow.”

Destructive tools run without an extra MCP-side confirmation. Configure this server only for trusted agents and disposable simulator/emulator data.

## Tools

| Tool | Purpose |
|---|---|
| `mobile_doctor` | Check native tools, device counts, and WDA status |
| `mobile_list_devices` | List iOS Simulators, running Android Emulators, and configured AVDs |
| `mobile_boot_device` | Boot and wait for an iOS Simulator or Android AVD |
| `mobile_shutdown_device` | Shut down a running target without deleting data |
| `mobile_install_app` | Install `.app` or `.apk` artifacts from the active project root |
| `mobile_launch_app` | Launch an app by bundle/package ID |
| `mobile_terminate_app` | Stop an app without clearing data |
| `mobile_list_apps` | List installed bundle IDs/package names (user apps by default) |
| `mobile_get_foreground_app` | Report which app (and Android activity) is in front |
| `mobile_get_logs` | Return bounded logs for one installed app |
| `mobile_reset_app` | Clear Android app data or uninstall an iOS app |
| `mobile_set_permission` | Grant/revoke Android runtime permissions or grant/revoke/reset allowlisted iOS privacy services |
| `mobile_set_location` | Set simulated GPS coordinates; iOS also supports clearing the simulation |
| `mobile_send_push` | Send a ≤4096-byte APNs payload to an iOS Simulator app |
| `mobile_add_media` | Add photos, videos, or vCard contacts to the device library |
| `mobile_uninstall_app` | Uninstall an app and its data |
| `mobile_erase_device` | Shut down and erase an iOS Simulator |
| `mobile_set_clipboard` | Replace iOS Simulator pasteboard text |
| `mobile_get_clipboard` | Read iOS Simulator pasteboard text |
| `mobile_set_status_bar` | Override or clear typed iOS status-bar values |
| `mobile_set_appearance` | Switch light/dark appearance on either platform |
| `mobile_set_accessibility` | iOS Dynamic Type and contrast; Android font scale |
| `mobile_set_battery` | Set Android Emulator battery capacity and charging state |
| `mobile_send_sms` | Deliver a simulated inbound Android SMS |
| `mobile_fingerprint` | Touch/remove an enrolled Android Emulator fingerprint |
| `mobile_set_network` | Set Android Emulator speed and latency profiles |
| `mobile_set_connectivity` | Toggle Android Emulator airplane mode, wifi, or mobile data |
| `mobile_rotate` | Rotate an Android Emulator clockwise |
| `mobile_set_orientation` | Set an absolute iOS Simulator orientation |
| `mobile_open_url` | Open an allowed URL or deep link |
| `mobile_take_screenshot` | Return a PNG image directly to the client |
| `mobile_get_ui_tree` | Return iOS JSON or Android XML UI hierarchy |
| `mobile_list_elements` | Return compact labeled/interactive elements with tap-ready center coordinates |
| `mobile_get_screen_info` | Return screen width, height, orientation, and density |
| `mobile_tap` | Tap validated coordinates |
| `mobile_long_press` | Press and hold validated coordinates |
| `mobile_swipe` | Swipe between validated coordinates |
| `mobile_type_text` | Type into the focused field |
| `mobile_press_key` | Press HOME/BACK/ENTER/app-switch/volume keys as supported |

## Device IDs

- Booted iOS: `ios:<simulator-UDID>`
- Running Android: `android:emulator-5554`
- Shutdown Android AVD: `android-avd:<AVD-name>`

Always use IDs from the latest `mobile_list_devices` result.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MOBILE_MCP_APP_ROOT` | MCP process working directory | Only `.app`/`.apk` paths beneath this directory may be installed |
| `MOBILE_MCP_URL_SCHEMES` | empty | Comma-separated extra deep-link schemes; `http` and `https` are always allowed |
| `MOBILE_MCP_SHOW_XCODE_LOG` | `0` | Set to `1` for verbose Xcode/WDA diagnostics on stderr |
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` | executable lookup | Android SDK location |

## Security model

- stdio by default. The optional `--listen` HTTP transport binds to `127.0.0.1` only and rejects non-loopback `Host`/`Origin` headers (DNS-rebinding protection). There is no remote listener or authentication surface.
- No arbitrary shell, `adb shell`, or `simctl spawn` tool is exposed.
- Native commands use argument arrays, explicit Android serials, timeouts, and output limits.
- Physical devices, device creation/deletion, raw native-command passthrough, and arbitrary host shell access are not supported.
- Curated destructive operations—including app reset/uninstall and iOS Simulator erase—execute without per-call confirmation. The MCP client configuration is the trust boundary.
- URL schemes, device identifiers, app IDs, permissions, coordinates, environment profiles, durations, push payloads, and install paths are validated.
- WebDriverAgent is contacted only at `127.0.0.1:8100`.

Treat this server like any local developer tool: it runs with the MCP client's operating-system permissions and can interact with apps displayed in test devices.

## Limits

- One iOS Simulator can own the WDA process on port 8100 at a time, across all stdio or HTTP sessions of one server process. Android can run concurrently.
- `mobile_list_elements` keeps elements that have a label, identifier, or value, or that are interactive. Layout containers and iOS keyboard keys are omitted; use `mobile_get_ui_tree` when you need them.
- `mobile_get_ui_tree` and Android input need the screen on and unlocked. A sleeping Android Emulator makes `uiautomator dump` fail, and the server reports that as an error rather than returning an empty tree.
- `mobile_set_accessibility` splits by platform: `contentSize`/`increaseContrast` are iOS-only, `fontScale` is Android-only.
- `mobile_list_apps` returns Android package names without display labels; iOS returns `CFBundleDisplayName` when the app declares one.
- Android `input text` supports printable ASCII only. iOS typing supports Unicode through WDA.
- UI trees depend on apps exposing useful accessibility labels/identifiers.
- Trees and logs over one million characters return `truncated: true`; treat the result as incomplete.
- Android Emulator has no official command to clear its last GPS fix; the release gate restores it to `0,0`.
- Android AVD wipe is a boot-time option, so `mobile_erase_device` is iOS-only.
- Clipboard and cosmetic status-bar control are iOS-only in the installed official CLIs. SMS, fingerprint, network profiles, battery state, and rotation are Android-only.
- Simulated push delivery is iOS-only. Android FCM requires Firebase rather than `adb`.
- Apple exposes no supported `simctl` command for network conditioning or Face ID/Touch ID events; those remain out of scope.
- Video recording remains out of scope because it requires a long-running stream lifecycle and artifact storage policy.
- Simulator keychain manipulation, app-container host paths, iCloud sync, and device create/clone/delete/rename stay out of scope: they leak host paths or manage fleets rather than test a running device.
- MCP resources, prompts, and completions are not implemented. Device state changes too quickly to cache as resources, and every workflow here is better expressed as an explicit tool call.
- Simulators and emulators do not reproduce all real-device sensors, performance, or hardware behavior.

## Troubleshooting

### `mobile_doctor` reports a missing Android command

Set `ANDROID_SDK_ROOT` or `ANDROID_HOME` to the Android SDK directory and ensure its `platform-tools` and `emulator` directories are installed. You can also add both directories to `PATH`.

### iOS UI calls time out on first use

WebDriverAgent may need several minutes to compile through Xcode. Set `MOBILE_MCP_SHOW_XCODE_LOG=1` in the MCP environment to send detailed build logs to stderr.

### App installation is rejected

The artifact must resolve beneath the agent project's working directory, or beneath `MOBILE_MCP_APP_ROOT` when explicitly configured. Android requires an `.apk` file; iOS requires a built `.app` directory for the Simulator architecture.

### A deep link scheme is rejected

`http` and `https` are enabled by default. Add custom schemes as a comma-separated environment value, for example `MOBILE_MCP_URL_SCHEMES=myapp,example-beta`.

### A device ID is rejected

Call `mobile_list_devices` again and use its exact current ID. Physical Android and Apple devices are intentionally unsupported.

## Development and release checks

```bash
npm run check
npm run live
npm run live:deep
npm run live:tools
npm audit --omit=dev
```

`npm run live:tools` covers the app-discovery, appearance, accessibility, screen-info, and long-press tools, and asserts that platform and coordinate rejections still reject. It exercises Android in full and skips the iOS paths that would take over the Simulator with WebDriverAgent; set `MOBILE_MCP_LIVE_WDA=1` to include them.

`npm run live` performs fast screenshots, UI-tree reads, and HOME input on both platforms. `npm run live:deep` uses the MCP stdio protocol to manipulate Android and iOS Settings, exercise a spare iOS boot/shutdown when available, set simulated locations, collect app logs, round-trip the iOS clipboard, override/clear the iOS status bar, change/restore Android battery and network profiles, rotate Android four times, remove a fingerprint touch, type and swipe, open `https://example.com`, verify screenshots and UI changes, exercise rejected inputs, and restore managed state.

Destructive app/device tools, permission changes, push, SMS, and install/uninstall need a disposable application/device fixture. The release gate does not run them against system apps.

## Official references

The implementation and tool limits were checked against:

- [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) for strict inputs, structured results, annotations, errors, and the client-side trust model for sensitive operations.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) for Streamable HTTP, loopback binding, and `Origin` validation against DNS rebinding.
- [Apple Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference) and the installed `xcrun simctl help` for Simulator lifecycle, logs, privacy, location, push, and screenshots.
- [Android Debug Bridge](https://developer.android.com/tools/adb), [Logcat](https://developer.android.com/studio/command-line/logcat), and [Emulator console](https://developer.android.com/studio/run/emulator-console) for app state, permissions, logs, location, and emulator lifecycle.

See [PLAN.md](PLAN.md) for the approved scope and release gates.
