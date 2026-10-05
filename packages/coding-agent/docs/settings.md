# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## Project Trust

On interactive startup, pi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.pi/agent/trust.json`. Trusting a project allows pi to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.pi/agent/settings.json`, or change it with `/settings`.

`pi config` and package commands use the same project trust flow, except `pi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.pi/agent/trust.json` only; the current session is not reloaded, so restart pi for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### Agent-owned execution upgrades

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `executionUpgrade.enabled` | boolean | `false` | Expose `upgrade_execution` and runtime observations to main and child agents |
| `executionUpgrade.modelOrder` | string[] | `[]` | Exact `provider/model` IDs in user-declared weakest-to-strongest order |
| `executionUpgrade.reminderRounds` | number | `8` | Business rounds since the last observation reset before suggesting a review |
| `executionUpgrade.reminderToolCalls` | number | `24` | Tool attempts since the last observation reset before suggesting a review |
| `executionUpgrade.reminderRepeatedErrors` | number | `3` | Matching tool, arguments, and error results within the observation interval |
| `executionUpgrade.reminderCooldownRounds` | number | `4` | Minimum business rounds between review reminders |

Thresholds only produce a reminder; they never select a model. The executing agent must explicitly call `upgrade_execution`. With an empty model order, only higher supported thinking levels on the current model are available. See [Execution upgrades](execution-upgrades.md) for configuration, lifecycle, and trace inspection.

### Subagents

Persistent CLI/SDK sessions enable in-process subagents by default. Every root can create 8 child identities over its lifetime and run 3 children concurrently, counting every generation. Followups reuse an existing child's context and identity.

`spawn_agent` chooses a `read-only`, `read-write`, or `full` tool capability ceiling. `wait_agent.timeoutMs` only ends the wait; the parent decides whether to keep waiting or interrupt. The former `subagents.maxExecutionMs`, `minReviewIntervalMs`, and `cancellationGraceMs` settings have been removed.

See [Subagents](subagents.md) for tools, queue/message limits, ownership, cooperative cancellation, and SDK configuration.

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`PI_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

For VS Code, include `--wait` so pi resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. Opting out of telemetry does not disable update checks; Pi can still fetch `https://pi.dev/api/latest-version` to look for the latest version.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Pi version update check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Permissions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `permissions.mode` | string | `"default"` | `"default"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`, or `"plan"` |
| `permissions.audit` | boolean | `true` | Enable decision audit records when the host configures an audit path |
| `permissions.allow` | array | `[]` | Rules that pre-approve `${toolName}:${operation}` patterns |
| `permissions.deny` | array | `[]` | Rules that deny matching operations; evaluated before allow rules |

```json
{
  "permissions": {
    "mode": "default",
    "allow": [{ "pattern": "bash:git status*" }],
    "deny": [{ "pattern": "bash:git push*", "reason": "no remote writes" }]
  }
}
```

Risky built-in process, network, and external-system effects ask for confirmation. Without an interactive/RPC approval channel, `ask` fails closed. Extensions remain inside the project/package trust boundary.

### Memory and Reminders

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `memory.enabled` | boolean | `false` | Enable project memory authority and add `memory_search`/`memory_get` to the default tool set |
| `memory.scopeDefault` | string | `"project"` | Default search scope: `"global"`, `"project"`, or `"all"` |
| `memory.globalAutoWrite` | boolean | `false` | Permit automatic global-memory writes |
| `memory.archive.enabled` | boolean | `false` | Archive closed top-level evidence runs in the background |
| `memory.archive.maxConcurrencyPerProject` | number | `1` | Maximum concurrently leased archive jobs for one project |
| `memory.archive.maxFailuresPerWorkItem` | number | `3` | Technical failures allowed for one extraction or validation work item |
| `memory.archive.modelCallTimeoutMs` | number | `60000` | Timeout for each archive model call |
| `memory.archive.maxInputTokensPerCall` | number | `16000` | Maximum archive input budget per model call |
| `memory.archive.maxOutputTokensPerCall` | number | `2000` | Maximum archive output budget per model call |
| `memory.archive.maxModelCallsPerSlice` | number | `4` | Model calls before a persisted scheduling yield |
| `memory.archive.maxCandidatesPerBatch` | number | `12` | Candidate ceiling; reaching it stops the job for review |
| `memory.archive.maxModelCallsPerProjectHour` | number | `24` | Persistent rolling hourly reservation limit per project |
| `reminder.enabled` | boolean | `true` | Master switch for todo nudge and gate behavior |
| `reminder.todoNudge.enabled` | boolean | `true` | Inject periodic todo reminders when `todo_write` is active |
| `reminder.todoNudge.turnsSinceTodoWrite` | number | `3` | Turns without `todo_write` before nudging |
| `reminder.todoNudge.turnsBetweenReminders` | number | `5` | Minimum turns between nudges |
| `reminder.todoGate.enabled` | boolean | `false` | Continue while tracked todo work remains and `todo_write` is active |
| `reminder.todoGate.maxFiresPerPrompt` | number | `2` | Maximum forced continuations per user prompt |

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable automatic Shake, Compaction, and model window decisions |
| `compaction.reserveTokens` | number | `16384` | Compaction-summary output budget |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained by compaction |
| `compaction.autoCompactThresholdPercent` | number | `85` | Work-budget ceiling before the state-saving reserve |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Pi sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
