# Connect the mobile MCP server

Give the user the commands for their client. Do not run them or edit their configuration yourself. Every option starts the server from GitHub with `npx`; npm 12 needs `--allow-git=root` for a git package. The plugins pin the server to their release tag. The other commands follow the default branch; add a tag such as `#v0.6.0` after the repository name to pin one.

## Claude Code

One step, with the server and this skill together (Claude Code 2.1.275 or later):

```bash
/plugin install mobile-mcp --marketplace gitsoufiane/mobile-simulator-emulator-mcp
```

Or in a shell:

```bash
claude plugin marketplace add gitsoufiane/mobile-simulator-emulator-mcp
claude plugin install mobile-mcp@gitsoufiane-mobile
```

Server only, in every project: `claude mcp add --scope user mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp`.

## Codex

The plugin adds the server and this skill:

```bash
codex plugin marketplace add gitsoufiane/mobile-simulator-emulator-mcp
codex plugin add mobile-mcp@gitsoufiane-mobile
```

Server only: `codex mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp`. Codex stops a tool call after 60 seconds and a server start after 10 seconds. For the first iOS UI call, add `tool_timeout_sec = 300` and `startup_timeout_sec = 120` under `[mcp_servers.mobile]` in `~/.codex/config.toml`.

## Pi

```bash
pi mcp add mobile -- npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp
pi install git:github.com/gitsoufiane/mobile-simulator-emulator-mcp
```

The second command installs this skill. Add `"timeout": 300` to the `mobile` entry in `~/.pi/agent/mcp.json`, then run `/reload`.

## Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

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

## VS Code

```bash
code --add-mcp '{"name":"mobile","command":"npx","args":["-y","--allow-git=root","github:gitsoufiane/mobile-simulator-emulator-mcp"]}'
```

## Other clients

- Stdio clients take the same `mcpServers` JSON as Cursor.
- Clients that load Agent Plugins read `plugin.json`, `mcp.json`, and `skills/` from the repository root.
- Clients that support the MCP Skills extension (SEP-2640) get this skill from the server itself at `skill://mobile-mcp/SKILL.md`; no install step.
- Other agents: copy `skills/mobile-mcp` from the repository into the agent's skills folder.

## Physical iPhone or iPad

- Select the signing team with `mobile_set_ios_team`, or start the server with `MOBILE_MCP_IOS_TEAM_ID=<team ID>`: `--env` in Pi and Codex, `-e` in Claude Code, placed after the server name and before `--`.
- Turn on Developer Mode, connect the device, and trust the Mac.

## HTTP mode

For clients that connect by URL:

```bash
MOBILE_MCP_HTTP_TOKEN=<random 32+ characters> npx -y --allow-git=root github:gitsoufiane/mobile-simulator-emulator-mcp --listen 3000
```

The server listens on `http://127.0.0.1:3000/mcp` only and needs `Authorization: Bearer <token>` on every request. Without `MOBILE_MCP_HTTP_TOKEN`, it makes a token and prints it on stderr.

- Claude Code: `claude mcp add --transport http mobile http://127.0.0.1:3000/mcp --header "Authorization: Bearer <token>"`
- Codex: `codex mcp add mobile --url http://127.0.0.1:3000/mcp --bearer-token-env-var MOBILE_MCP_HTTP_TOKEN`
- Pi: `pi mcp add mobile --url http://127.0.0.1:3000/mcp --bearer-token-env-var MOBILE_MCP_HTTP_TOKEN`

## Files and folders

App, media, and certificate paths, and new recordings, must be beneath `MOBILE_MCP_APP_ROOT`, which defaults to the server's working directory. A plugin may start the server in its own folder; then set `MOBILE_MCP_APP_ROOT` to the project folder.
