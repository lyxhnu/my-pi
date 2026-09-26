# Agent-owned execution upgrades

The executing agent can request stronger reasoning or a stronger allowed model while working. Runtime observations support its decision; no evaluator model or difficulty classifier runs. Starting model and thinking level remain user choices. There is no automatic downgrade or reset to a cheaper model after a prompt.

Enable the feature in global or trusted project settings:

```json
{
  "executionUpgrade": {
    "enabled": true,
    "modelOrder": ["your-provider/small-model", "your-provider/large-model"],
    "reminderRounds": 8,
    "reminderToolCalls": 24,
    "reminderRepeatedErrors": 3,
    "reminderCooldownRounds": 4
  }
}
```

Replace the example IDs with exact configured model IDs. The order declares allowed upgrades; runtime does not infer strength from prices or names. An empty order permits only higher supported thinking levels on the current model. A current model absent from the order cannot switch to another model automatically. The tool is added to the default tool set when enabled; explicit tool selection, exclusion, and permission deny rules still apply.

Each ordinary request includes current counters, recent tool outcomes, agent-reported todo completion transitions, the current profile, and available choices. A round is a successful model response and its complete tool batch. Provider errors, save-state requests, and recovery requests do not count as business rounds. Repeated errors compare tool name, normalized arguments, and complete error content. Counters cannot establish that a task is stalled. Todo renames and repeated identical writes do not count as completed steps.

Reminders appear only on requests that would already happen. They never prolong a completed task. Any reminder threshold plus the cooldown can prompt a review. The agent can ignore the reminder, change its approach, or call the tool; it can also call the tool before any threshold. Observation intervals reset after a reminder or committed upgrade, while cumulative counts remain. A new top-level user prompt resets counters but retains the selected profile.

The tool accepts `targetModel`, `thinkingLevel`, and a short `reason`. Same-model requests must raise supported effective reasoning. Cross-model requests must move forward in the configured order; skipping entries is allowed. Unsupported levels are rejected rather than clamped.

An initial tool result is `pending`. After the whole batch and selected steering messages are included, runtime validates the exact next request for target availability, authentication, input modalities, and context budget. Successful validation commits model and thinking together in one session record and dispatches that prepared request. It does not replay tools, change permissions, or overwrite global defaults. Context that cannot fit is rejected explicitly. The existing output-truncation reasoning limit remains in force and trace records the effective requested level separately.

Identical same-batch requests merge; conflicting targets are rejected. User model/thinking selections and cancellation invalidate pending requests. Interrupted uncommitted requests are cancelled on restore. Committed selections are restored with the session.

Children capture the parent's model, thinking level, and upgrade policy at spawn. Each child then has independent observations and upgrade state. Its changes do not affect parents or siblings. Child upgrade events are forwarded into the parent's trace with a task ID, including when the child later fails or is cancelled.

Inspect `/trace` in interactive mode, or retrieve session entries over RPC:

- `execution/status`: observations and whether a review reminder was included.
- `execution/upgrade`: `pending`, `applied`, `rejected`, or `cancelled`, including target, reason, call IDs, and request fingerprint after application.
- The subsequent `request/header`: actual provider, model, and reasoning passed to the stream function.
- `task/request`: the corresponding actual child request header, associated with its task and child session. Parent request headers remain separate.

Committed changes also emit extension `model_select` (source `upgrade`) and `thinking_level_select` events.

RPC `get_state.executionUpgrade` exposes current observations, available options, and the last upgrade outcome. `execution_upgrade` events report transitions. An `applied` event records a committed selection; inspect the following request header and assistant outcome to confirm that the provider request was actually made and succeeded.

The feature enables autonomous decisions; it does not guarantee that a model recognizes every need for stronger reasoning or that an upgrade fixes the task.
