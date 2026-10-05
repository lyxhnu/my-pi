# In-process subagents

Persistent CLI and SDK sessions enable subagents by default. Each child has its own AgentSession, messages, session file, settings, tools, and extension runtime, inside the root's process. Children can delegate again. All generations share the root's lifetime limit of **8 child identities** and **3 executing child runs**; the root itself uses neither quota.

A completed child remains available. `followup_task` starts another run in its existing context without consuming a new identity. Every run has a distinct `runId`; query, wait, and interrupt that ID instead of relying on an agent's changing current run.

## Tools

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Create a child with `task`, `permission: { mode }`, and `context: "none"`, `"all"`, or a positive turn count. |
| `followup_task` | Submit `task` to an existing `agentId`, optionally narrowing permission. A busy child queues the run in FIFO order. |
| `send_message` | Send information, a question, or progress to `targetAgentId`, optionally bound to `targetRunId`. Does not start an idle agent. |
| `list_agents` | Read a bounded identity list and root budget usage. |
| `get_agent_info` | Read overview, runs, queue, messages, updates, causal descendants, or paged content. |
| `wait_agent` | Wait for a run's result, update, or `subtree_stopped`. `timeoutMs` only limits this wait. |
| `interrupt_agent` | Request cancellation of `runId`, with `scope: "run"` or `"subtree"`. |

There is no overall execution deadline, review timer, automatic replacement, or takeover operation. After a wait times out, the requesting agent decides whether to wait again, ask for information, interrupt, or explicitly delegate new work. Ordinary model-request and tool timeouts still apply.

The old `task`, `task_control`, `report_subagent_progress`, and `submit_subagent_result` tools have been removed. A child's final assistant response is its result. `get_task_output` and `kill_task` remain for ordinary background tools, not subagents.

## Scheduling and interruption

Initializing, running, waiting, and stopping children hold execution slots. A new child, or a followup to an idle child, is rejected when all three slots are occupied; it is not put into a global capacity queue. Followups to the same busy child may queue, then use that child's released slot. This prevents a chain of waiting parents from silently filling a global queue that can never start.

Explicit waits and FIFO predecessor dependencies share a cycle check. Cancelling a queued middle run relinks its successor to the remaining predecessor. Cancellation follows the selected execution's causal descendants, including pending initialization and queued runs, rather than every later task of the same reusable agent.

An interrupt acknowledgement means the request was accepted. `stopping` lasts until the model, accepted continuations, and tracked tools settle. `subtree_stopped` confirms only this scope, identified as `stopScope: "agents_and_tracked_tools"`. A cleanup failure retains the execution slot and ownership instead of claiming a confirmed stop.

Cancellation is cooperative. Same-process synchronous code that never yields can block the entire host. Arbitrary external command descendants and remote effects are not guaranteed stopped or rolled back. Runs that invoke full-capability tools record `effectsUnknown`; it remains visible after completion. Before reassigning interrupted work, wait for the tracked scope to stop and account for any uncertain external effects.

## Permission tiers

| Mode | Tool capability ceiling |
| --- | --- |
| `read-only` | Read/search and session coordination/context tools. |
| `read-write` | The above plus built-in file edits and writes. |
| `full` | The above plus commands and external/custom tools, subject to normal host policy. |

Effective permission is the intersection of current root authorization, creation ancestry, run issuer, the child's original grant, and the run's requested grant. It is checked again at tool execution. Plan mode narrows the root ceiling to read-only. Tool selection and exclusion remain in force; delegation does not restore excluded tools.

These modes constrain tool capabilities. They do not provide OS filesystem/network isolation, path-based write ownership, hardlink coordination, or rollback. Read-only agents still write their own internal session/control records. Extensions are trusted host code. Unknown custom tools require `full`; an SDK host may explicitly classify a particular tool object using `withSubagentToolPermission(tool, mode)`. Renaming a custom tool to `read` does not grant read-only access.

Children use the root working directory. Coordinate concurrent writes explicitly, including generated files and Git metadata. There is no automatic worktree creation or patch publication step.

## Messages, results, and limits

Messages are delivered at safe points, without starting a second model loop. Idle mail remains pending until an explicit followup. A run-bound message cannot spill into a later run. Root and issuing agents can retrieve the results they supervise, so nested delegation does not require the root to relay every result.

| Resource | Limit |
| --- | ---: |
| Pending followups across the root | 32 / 2 MiB of task text |
| One task | 64 KiB UTF-8 |
| Pending mail across the root | 256 / 1 MiB |
| One message | 16 KiB UTF-8 |
| One tool response | 32 KiB |
| Page size | 20 by default, at most 50 |
| One wait | 30 seconds by default, at most 1 hour |

Oversized input and full queues are rejected explicitly. Queries use section/filter-bound, fixed-version cursors; read every returned `nextCursor` when completeness matters. Long task/result/message bodies expose `contentRef` and byte length for UTF-8-safe reads. Reading an updates page acknowledges only that page. A state of `running`, recent activity, or a child progress message does not prove useful progress.

Historical runs, messages, and results remain on disk and can grow over time. They are not all loaded into ordinary model context or one query response; the limits above do not claim a fixed lifetime disk budget.

## Ownership, closing, and recovery

The root exclusively owns its control journal and all child session files. Each child header binds its `rootSessionId`; opening it through the ordinary root/session-import path is rejected. File writes and migration require the matching root ownership token. The root journal commits identity creation and the initial run together; pending creations reserve quota, and successful identities are never refunded on completion or cancellation.

Closing first blocks every creation/start path, cancels queued and active work, then waits for tracked cleanup before releasing ownership. On reopening, old queued work is cancelled and interrupted live work is recorded as interrupted with uncertain effects. Neither is automatically replayed. An explicit followup can reuse the recovered child history under current permissions.

Context rollover keeps the same agents and run IDs. Continuation notes use the existing `subagentContinuations[].taskId` field to hold the **runId**. The current branch's real `spawn_agent`/`followup_task` call and durable control record must agree. Recovery includes the original task, parent relation, and result-handling plan; a later run of the same agent cannot replace the retained result reference. Rollover does not restart or cancel a child.

## SDK integration

`createAgentSession()` manages root ownership and prompt/dispose lifetimes automatically for persistent sessions. In-memory sessions do not enable this persistent subsystem. `subagents: false` disables it for a fresh unmanaged root; an already managed root must reopen through its coordinator. `tools`, `excludeTools`, and `noTools` also apply to the seven built-in collaboration tools.

`RootSubagentOptions` can provide a current permission callback, child resource/tool factories, and a recovery hook for externally tracked operations. Factories must create child-owned instances. Default children receive copied root skills, prompts, and context files; full-capability children load fresh instances of root-loaded file-backed extensions. Inline extension closures and root custom-tool instances are not automatically shared: supply child factories when needed. Model/provider registration and authentication use the host's existing connection; model/thinking selection and subsequent upgrades are child-local.

The old worker and timeout-supervision specifications describe historical implementations. This document defines the current behavior.
