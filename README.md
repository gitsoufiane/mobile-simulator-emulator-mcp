<p align="center">
  <img src="assets/logo.svg" width="120" alt="Mobile Simulator and Emulator MCP logo">
</p>

<h1 align="center">Mobile Simulator & Emulator MCP</h1>

<p align="center">Let your AI agent test your app on iOS Simulators, Android Emulators, and real phones.</p>

## What it does

Your coding agent can open, tap, type, scroll, and check apps on a local device, through [MCP (Model Context Protocol)](https://modelcontextprotocol.io/).

- **55 tools** for apps, screen actions, screenshots, logs, location, permissions, and device settings.
- **Finds buttons by their text**, so the agent does not guess screen positions.
- **Waits and scrolls for you** with `mobile_wait_for_element` and `mobile_scroll_to_element`.
- **Real phones too**: iPhones, iPads, and Android phones connected to your Mac (see [Physical devices](#physical-devices)).
- **Local and safe**: no shell access, no telemetry.

## How it works

| Platform | Uses |
| --- | --- |
| iOS Simulator | `xcrun simctl` and [Appium WebDriverAgent](https://github.com/appium/WebDriverAgent) |
| Android Emulator | Google `adb` and `emulator` |
| Physical iPhone or iPad | `xcrun devicectl` and WebDriverAgent over the CoreDevice tunnel |
| Physical Android phone | Google `adb` |

It runs over stdio. Add `--listen` for HTTP on your own machine only.

## Requirements

- macOS with Xcode 15 or newer.
- Node.js 22.18+ or 24.2+.
- For Android: Android SDK Platform Tools (`adb`). Add the Android Emulator for virtual devices.
- At least one device: an installed iOS Simulator runtime, an Android virtual device, or a connected phone.

Check the native tools:

```bash
xcrun simctl list devices     # iOS Simulators
xcrun devicectl list devices  # iPhones and iPads
adb devices -l                # Android emulators and phones
emulator -list-avds           # Android virtual devices
```

## Connect your agent

The commands below run the server straight from GitHub. On first use, npm clones, installs, and builds it. `--allow-git=root` is required on npm 12, which blocks git packages by default.

### Pi

```bash
pi mcp add mobile --description "iOS Simulators, Android Emulators, and real phones: apps, screenshots, taps, typing. Load the mobile-mcp skill first." -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
pi mcp list
```

The first iOS UI call can take several minutes, and Pi's default per-request timeout is 60 seconds. Add `"timeout": 300` to the `mobile` entry in `~/.pi/agent/mcp.json`.

### Claude Code

```bash
claude mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
```

### Codex

```bash
codex mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
```

For a physical iPhone or iPad, also pass your Apple team ID: `--env MOBILE_MCP_IOS_TEAM_ID=<TEAM_ID>` for Pi and Codex, or `-e MOBILE_MCP_IOS_TEAM_ID=<TEAM_ID>` for Claude Code. Put it before `--`.

### Other MCP clients

Clients that run local stdio servers can use this entry:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "npx",
      "args": ["-y", "--allow-git=root", "github:gitsoufiane/mobile-simulator-emulator-mcp"]
    }
  }
}
```

To run a local build instead, build from source and point the client at `dist/src/index.js`:

```bash
git clone https://github.com/gitsoufiane/mobile-simulator-emulator-mcp.git
cd mobile-simulator-emulator-mcp
npm ci --ignore-scripts
npm run build
```

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

Restart the client after you change its configuration.

App, media, and certificate paths must be beneath the server's working directory. Clients that start the server in your project need no extra setting. Otherwise, set the client's `cwd` to your project, or set `MOBILE_MCP_APP_ROOT`.

### HTTP mode (`--listen`)

For clients that connect by URL instead of starting a process:

```bash
node dist/src/index.js --listen 3000
# ready on http://127.0.0.1:3000/mcp
```

The listener binds to `127.0.0.1` only and has no authentication, so it has the same trust model as stdio. It rejects with HTTP 403 any request whose `Host` or `Origin` is not `127.0.0.1`, `localhost`, or `[::1]`, so a web page cannot reach it through DNS rebinding. All sessions share one set of device controllers and one WebDriverAgent process.

## Add the agent skill

This repository includes the [Agent Skills](https://agentskills.io/specification) skill `skills/mobile-mcp`. It tells the agent how to call the tools in Pi, Claude Code, and Codex, how to read the server instructions, and how to treat real phones safely. It helps most in Pi, which shows only one line of MCP server instructions to the model.

### Install the skill

With the [skills CLI](https://github.com/vercel-labs/skills), for all three agents at once:

```bash
npx skills add gitsoufiane/mobile-simulator-emulator-mcp --skill mobile-mcp -g -a pi claude-code codex
```

This puts the skill in `~/.agents/skills/mobile-mcp` (Pi and Codex) and links it from `~/.claude/skills/mobile-mcp` (Claude Code). The skills CLI sends install telemetry; set `DO_NOT_TRACK=1` to turn it off.

Or copy it by hand:

```bash
git clone https://github.com/gitsoufiane/mobile-simulator-emulator-mcp.git
mkdir -p ~/.agents/skills ~/.claude/skills
cp -R mobile-simulator-emulator-mcp/skills/mobile-mcp ~/.agents/skills/   # Pi and Codex
cp -R mobile-simulator-emulator-mcp/skills/mobile-mcp ~/.claude/skills/   # Claude Code
```

Restart the agent, or run `/reload` in Pi.

### Use the MCP with the skill

1. Connect the server with the command for your agent (see [Connect your agent](#connect-your-agent)).
2. Install the skill.
3. Ask for the task in plain words, for example: "Open Settings on my connected iPhone and take a screenshot." The agent loads the skill when the task matches.
4. To force the skill, start the request with `/skill:mobile-mcp` in Pi or `/mobile-mcp` in Claude Code. In Codex, name the skill in your request ("use the mobile-mcp skill").

With the skill, the agent checks that the `mobile` tools exist (and gives you the setup command if not), reads the server instructions, and asks you before it installs, uninstalls, or resets anything on a real phone.

## Physical devices

`mobile_list_devices` marks real devices with `physical: true`. They support app install, launch, terminate, uninstall, and app lists, plus screenshots, UI reading, taps, swipes, typing, keys, alerts, orientation, and URLs. Tools that need simulator or emulator features (boot, shutdown, erase, push, clipboard, status bar, permissions, location, media, SMS, sensors, snapshots, and similar) return a clear error.

**Android**: turn on USB debugging, connect by USB or `adb pair`/`adb connect`, and accept the prompt on the phone.

**iPhone or iPad** (Xcode 15 or newer):

1. Turn on Developer Mode on the device, connect it, and trust this Mac.
2. Set `MOBILE_MCP_IOS_TEAM_ID` to your Apple Developer team ID. A free Personal Team works.
3. The first UI call builds, signs, and installs WebDriverAgent on the device. Xcode registers the bundle ID `local.mobilemcp.<TEAM_ID>.WebDriverAgentRunner` in that team.
4. On the device, open Settings > General > VPN & Device Management and trust the developer certificate. Keep the device unlocked.

Notes for physical iOS devices:

- WebDriverAgent listens only on the private CoreDevice tunnel address, not on your Wi-Fi network.
- App installs need a device-signed `.app`.
- App logs and crash logs are not available; use Xcode or Console.
- A free Personal Team profile expires after 7 days. The next UI call then rebuilds WebDriverAgent, and you may need to trust the certificate again.

## Agent workflow

The server sends this guidance to the agent as MCP instructions. The first iOS UI call builds WebDriverAgent through Xcode and can take several minutes; later calls reuse it.

1. Call `mobile_doctor`.
2. Call `mobile_list_devices` and keep the returned ID.
3. Boot a shutdown Simulator or virtual device if needed.
4. Install and launch the app. Use `mobile_list_apps` to look up the exact bundle ID or package name instead of guessing, and `mobile_get_foreground_app` to confirm the launch landed.
5. Set the permissions or simulated location that the scenario needs (Simulators and emulators only).
6. Call `mobile_list_elements` before using coordinates. It returns compact elements with tap-ready `center` coordinates; pass `query` to find one element. Use `mobile_take_screenshot` for visual context and `mobile_get_ui_tree` only when you need the full native hierarchy.
7. Interact with `mobile_tap`, `mobile_swipe`, `mobile_type_text`, and `mobile_press_key`.
8. Re-read the UI tree or screenshot after each state-changing action. Use `mobile_wait_for_element` to wait for a screen to load instead of sleeping, and `mobile_scroll_to_element` to reach rows that are not on screen yet.
9. Collect `mobile_get_logs` when a workflow fails. Use `mobile_reset_app` only when a clean app state is required.

## Example requests

Once connected, an agent can handle requests such as:

- “List my available simulators and emulators, then boot the shutdown iPhone.”
- “On my connected iPhone, open Settings and take a screenshot.”
- “Install the Android debug APK, launch it, and take a screenshot.”
- “Open `myapp://checkout/123`, inspect the UI tree, and tap Continue.”
- “Set the emulator location to San Francisco and test the nearby-results screen.”
- “Collect the last five minutes of logs for `com.example.app`.”
- “Reset the test app, grant location permission, and rerun the onboarding flow.”

Destructive tools run without an extra MCP-side confirmation. Configure this server only for trusted agents and disposable app and device data. On a physical device, they change real data on that phone.

## Tools

| Tool | Purpose |
| --- | --- |
| `mobile_doctor` | Check native tools, device counts, and WDA status |
| `mobile_list_devices` | List iOS Simulators, Android Emulators, configured AVDs, and connected physical devices |
| `mobile_boot_device` | Boot and wait for an iOS Simulator or Android AVD |
| `mobile_shutdown_device` | Shut down a running target without deleting data |
| `mobile_install_app` | Install `.app` or `.apk` artifacts from the active project root |
| `mobile_launch_app` | Launch an app by bundle/package ID, optionally with a locale, iOS arguments/environment, or Android intent extras |
| `mobile_terminate_app` | Stop an app without clearing data |
| `mobile_list_apps` | List installed bundle IDs/package names (user apps by default) |
| `mobile_get_foreground_app` | Report which app (and Android activity) is in front |
| `mobile_get_logs` | Return bounded logs for one installed app |
| `mobile_reset_app` | Clear Android app data or uninstall an iOS app |
| `mobile_set_permission` | Grant/revoke Android runtime permissions or grant/revoke/reset allowlisted iOS privacy services |
| `mobile_set_location` | Set simulated GPS coordinates; iOS also clears the simulation or moves along a waypoint route |
| `mobile_send_push` | Send a ≤4096-byte APNs payload to an iOS Simulator app |
| `mobile_add_media` | Add photos, videos, or vCard contacts to the device library |
| `mobile_uninstall_app` | Uninstall an app and its data |
| `mobile_erase_device` | Shut down and erase an iOS Simulator |
| `mobile_set_clipboard` | Replace iOS Simulator pasteboard text |
| `mobile_get_clipboard` | Read iOS Simulator pasteboard text |
| `mobile_set_status_bar` | Override or clear typed iOS status-bar values |
| `mobile_set_appearance` | Switch light/dark appearance on either platform |
| `mobile_set_accessibility` | Reduce motion and screen reader (VoiceOver/TalkBack) on both; iOS Dynamic Type, contrast, transparency; Android font scale |
| `mobile_set_battery` | Set Android Emulator battery capacity and charging state |
| `mobile_send_sms` | Deliver a simulated inbound Android SMS |
| `mobile_fingerprint` | Touch/remove an enrolled Android Emulator fingerprint |
| `mobile_set_network` | Set Android Emulator speed and latency profiles |
| `mobile_set_connectivity` | Toggle Android Emulator airplane mode, wifi, or mobile data |
| `mobile_rotate` | Rotate an Android Emulator clockwise |
| `mobile_set_orientation` | Set an absolute orientation on either platform; Android `auto` restores sensor rotation |
| `mobile_open_url` | Open an allowed URL or deep link |
| `mobile_take_screenshot` | Return a PNG image directly to the client |
| `mobile_get_ui_tree` | Return iOS JSON or Android XML UI hierarchy |
| `mobile_list_elements` | Return compact labeled/interactive elements with tap-ready center coordinates |
| `mobile_tap_element` | Tap, double tap, or long press an element found by label, identifier, value, or type |
| `mobile_wait_for_element` | Wait until an element is visible or gone, retrying transient screen-read errors (timeout up to 60 s) |
| `mobile_scroll_to_element` | Swipe in a direction until an element's center is on screen; stops at the end of the content |
| `mobile_double_tap` | Double tap validated coordinates |
| `mobile_handle_alert` | List, accept, or dismiss the visible iOS alert, optionally by button label |
| `mobile_dismiss_keyboard` | Hide the software keyboard |
| `mobile_set_lock` | Lock or unlock the screen and report the resulting state |
| `mobile_simulate_biometric` | Enroll/unenroll iOS Face ID or Touch ID and deliver matching or failing scans (Xcode 27) |
| `mobile_record_screen` | Record an `.mp4` beneath the app root, for a fixed time or from `start` to `stop` |
| `mobile_get_crash_logs` | Return an app's Android crash buffer or summarized iOS Simulator crash reports |
| `mobile_accessibility_audit` | Run Apple's XCTest accessibility audit on the foreground iOS app |
| `mobile_keychain` | Add a root or regular certificate to, or reset, the iOS Simulator keychain |
| `mobile_emulator_snapshot` | List, save, load, or delete Android Emulator snapshots |
| `mobile_phone_call` | Simulate an inbound Android call and accept, hold, busy, or end it |
| `mobile_set_sensor` | Set Android Emulator acceleration, gyroscope, light, proximity, and other sensors |
| `mobile_set_proxy` | Set or clear the Android Emulator HTTP proxy |
| `mobile_get_screen_info` | Return screen width, height, orientation, and density |
| `mobile_tap` | Tap validated coordinates |
| `mobile_long_press` | Press and hold validated coordinates |
| `mobile_swipe` | Swipe between validated coordinates |
| `mobile_type_text` | Type into the focused field |
| `mobile_press_key` | Press HOME/BACK/ENTER/app-switch/volume keys as supported; Android `NOTIFICATIONS` opens the shade |

## Device IDs

- iOS Simulator or device: `ios:<UDID>`
- Running Android emulator or phone: `android:<serial>`, such as `android:emulator-5554`
- Shutdown Android AVD: `android-avd:<AVD-name>`

Always use IDs from the latest `mobile_list_devices` result.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOBILE_MCP_APP_ROOT` | MCP process working directory | Apps, media, and certificates are read, and recordings are written, only beneath this directory |
| `MOBILE_MCP_URL_SCHEMES` | empty | Comma-separated extra deep-link schemes; `http` and `https` are always allowed |
| `MOBILE_MCP_SHOW_XCODE_LOG` | `0` | Set to `1` for verbose Xcode/WDA diagnostics on stderr |
| `MOBILE_MCP_IOS_TEAM_ID` | none | Apple Developer team ID that signs WebDriverAgent for physical iOS devices |
| `ANDROID_SDK_ROOT` / `ANDROID_HOME` | executable lookup | Android SDK location |

## Security model

- stdio by default. The optional `--listen` HTTP transport binds to `127.0.0.1` only and rejects non-loopback `Host`/`Origin` headers (DNS-rebinding protection). There is no remote listener or authentication surface.
- No arbitrary shell, `adb shell`, or `simctl spawn` tool is exposed.
- Native commands use argument arrays, explicit Android serials, timeouts, and output limits.
- Device creation/deletion, raw native-command passthrough, and arbitrary host shell access are not supported.
- Curated destructive operations—including app reset/uninstall and iOS Simulator erase—execute without per-call confirmation. The MCP client configuration is the trust boundary. On a physical device these change real data on that phone.
- Emulator-console and simulator-only commands are refused before they reach a physical device.
- URL schemes, device identifiers, app IDs, permissions, coordinates, environment profiles, durations, push payloads, locales, launch environment names, intent-extra keys, proxy addresses, snapshot names, and file paths are validated.
- Recordings are written only as new `.mp4` files inside an existing directory beneath `MOBILE_MCP_APP_ROOT`; existing files are never overwritten.
- The Android emulator console reports failures as `KO:` with exit code 0. Every console call checks for it, so a rejected command is an error, never a silent success.
- WebDriverAgent is contacted only at `127.0.0.1:8100` for Simulators, or at the CoreDevice tunnel address for a physical iOS device.

Treat this server like any local developer tool: it runs with the MCP client's operating-system permissions and can interact with apps displayed in test devices.

## Limits

- One iOS device (Simulator or physical) can own the WebDriverAgent process at a time, across all stdio or HTTP sessions of one server process. Android can run concurrently.
- `mobile_list_elements` keeps elements that have a label, identifier, or value, or that are interactive. Layout containers and iOS keyboard keys are omitted; use `mobile_get_ui_tree` when you need them.
- `mobile_get_ui_tree` and Android input need the screen on and unlocked. A sleeping Android Emulator makes `uiautomator dump` fail, and the server reports that as an error rather than returning an empty tree.
- `mobile_set_accessibility` splits by platform: `contentSize`/`increaseContrast`/`reduceTransparency` are iOS-only, `fontScale` is Android-only. `reduceMotion` and `screenReader` work on both; on iOS they need Xcode 27 `devicectl`, and Android TalkBack must be installed in the emulator image.
- Android `mobile_set_orientation` locks rotation; pass `auto` to restore sensor rotation. iOS uses `devicectl` on Xcode 27 (works on the portrait-only home screen) and falls back to WebDriverAgent on older Xcode.
- `mobile_record_screen` records for 1–180 s. The default `record` action blocks; use `action: "start"`, act, then `action: "stop"` to record your own taps. Android `screenrecord` has no audio and stops at 180 s.
- `mobile_get_crash_logs` on iOS reads `~/Library/Logs/DiagnosticReports` and keeps only reports whose `coalitionName` names the target Simulator.
- The Android proxy is applied by the emulator process on the Mac, so use a Mac-side address such as `127.0.0.1:8888`, not the guest alias `10.0.2.2`.
- Android `mobile_set_lock` unlock dismisses only the default swipe keyguard; a PIN, pattern, or password stays locked and the tool reports an error.
- Android per-app locale (`mobile_launch_app` `locale`) needs Android 13+ and persists until you launch with `locale: "system"`.
- `mobile_list_apps` returns Android package names without display labels; iOS returns `CFBundleDisplayName` when the app declares one.
- Android `input text` supports printable ASCII only. iOS typing supports Unicode through WDA.
- UI trees depend on apps exposing useful accessibility labels/identifiers.
- Trees and logs over one million characters return `truncated: true`; treat the result as incomplete.
- Android Emulator has no official command to clear its last GPS fix; the release gate restores it to `0,0`.
- Android AVD wipe is a boot-time option, so `mobile_erase_device` is iOS-only.
- Clipboard, cosmetic status-bar control, alerts, Face ID/Touch ID, keychain, accessibility audits, and location routes are iOS-only in the installed official tools. SMS, fingerprint, network profiles, battery state, snapshots, calls, sensors, proxy, and `mobile_rotate` are Android-only.
- Android clipboard: the platform has no shell clipboard command (`cmd clipboard` reports no implementation), so clipboard stays iOS-only.
- Simulated push delivery is iOS-only. Android FCM requires Firebase rather than `adb`.
- Apple exposes no supported command for Simulator network conditioning; it remains out of scope.
- App-container host paths, iCloud sync, and device create/clone/delete/rename stay out of scope: they leak host paths or manage fleets rather than test a running device.
- Android foldable posture, multi-display, and screen-size overrides, plus iOS Siri, remain unimplemented.
- MCP resources, prompts, and completions are not implemented. Device state changes too quickly to cache as resources, and every workflow here is better expressed as an explicit tool call.
- Simulators and emulators do not reproduce all real-device sensors, performance, or hardware behavior.

## Troubleshooting

### `mobile_doctor` reports a missing Android command

Set `ANDROID_SDK_ROOT` or `ANDROID_HOME` to the Android SDK directory and ensure its `platform-tools` and `emulator` directories are installed. You can also add both directories to `PATH`.

### iOS UI calls time out on first use

WebDriverAgent may need several minutes to compile through Xcode. Set `MOBILE_MCP_SHOW_XCODE_LOG=1` in the MCP environment to send detailed build logs to stderr.

### App installation is rejected

The artifact must resolve beneath the agent project's working directory, or beneath `MOBILE_MCP_APP_ROOT` when explicitly configured. Android requires an `.apk` file. iOS requires a built `.app` directory: a Simulator build for a Simulator, or a device-signed build for a physical device.

### A deep link scheme is rejected

`http` and `https` are enabled by default. Add custom schemes as a comma-separated environment value, for example `MOBILE_MCP_URL_SCHEMES=myapp,example-beta`.

### A device ID is rejected

Call `mobile_list_devices` again and use its exact current ID.

### A physical iPhone or iPad fails to start WebDriverAgent

- `xcodebuild failed with code 65`: set `MOBILE_MCP_SHOW_XCODE_LOG=1` and read the Xcode log. The usual causes are an untrusted developer certificate (Settings > General > VPN & Device Management) or a locked device.
- `Not authorized for performing UI testing actions`: the device locked while WebDriverAgent was running. Unlock it, stop the agent with `mobile_terminate_app` and `appId` `local.mobilemcp.<TEAM_ID>.WebDriverAgentRunner.xctrunner`, then retry.

## Development and release checks

```bash
npm run check
npm run live
npm run live:deep
npm run live:tools
npm run live:extended
npm run live:destructive
npm audit --omit=dev
```

Every tool must pass a live test before you push. Boot one iOS Simulator and one Android Emulator, then run all the commands above. Together the `live*` gates call all 55 tools.

`npm run live:extended` exercises every 0.5.0 tool on both platforms against Settings and Safari and restores each change: locale, launch arguments/extras, element taps, keyboard, orientation (including a landscape tap beyond the portrait width), double tap, lock, recording, crash logs, snapshots, calls and console `KO:` errors, sensors, proxy, reduce motion, TalkBack/VoiceOver, the notification shade, Face ID, alerts, and the accessibility audit.

`npm run live:tools` covers the app-discovery, appearance, accessibility, screen-info, and long-press tools, and asserts that platform and coordinate rejections still reject. It exercises Android in full and skips the iOS paths that would take over the Simulator with WebDriverAgent; set `MOBILE_MCP_LIVE_WDA=1` to include them.

`npm run live` performs fast screenshots, UI-tree reads, and HOME input on both platforms. `npm run live:deep` uses the MCP stdio protocol to manipulate Android and iOS Settings, exercise a spare iOS boot/shutdown when available, set simulated locations, collect app logs, round-trip the iOS clipboard, override/clear the iOS status bar, change/restore Android battery and network profiles, rotate Android four times, remove a fingerprint touch, type and swipe, open `https://example.com`, verify screenshots and UI changes, exercise rejected inputs, and restore managed state.

`npm run live:destructive` tests the tools that install, delete, or erase. It never touches your devices: it creates a throwaway iOS Simulator and Android Emulator (AVD `mobile_mcp_disposable`), builds a tiny test app for each, and deletes all of them at the end. It covers boot, shutdown, install, uninstall, reset, permissions, push, media, keychain, SMS, connectivity, and erase. It needs Xcode, Android build-tools 37.0.0, the `android-36` platform, the `android-37.0` Play Store 16 KB system image, a JDK (`keytool`), and `openssl`. It takes a few minutes, mostly for the emulator cold boot.

## Official references

The implementation and tool limits were checked against:

- [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) for strict inputs, structured results, annotations, errors, and the client-side trust model for sensitive operations.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) for Streamable HTTP, loopback binding, and `Origin` validation against DNS rebinding.
- [Apple Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference) and the installed `xcrun simctl help` for Simulator lifecycle, logs, privacy, location, push, and screenshots.
- [Android Debug Bridge](https://developer.android.com/tools/adb), [Logcat](https://developer.android.com/studio/command-line/logcat), and [Emulator console](https://developer.android.com/studio/run/emulator-console) for app state, permissions, logs, location, and emulator lifecycle.

See [PLAN.md](PLAN.md) for the approved scope and release gates.
