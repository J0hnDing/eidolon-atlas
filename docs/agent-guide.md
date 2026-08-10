# Agent guide

Use the Agent API only for read-only context from a local, unlocked
Eidolon-Atlas instance. Present the returned fields as user-owned data and do
not infer sensitive values that the API deliberately omits.

Goals have two different structures. `subgoals` is the ordered parent/child
hierarchy. `progressions` describes prerequisite edges between siblings; an
edge `{ prerequisite_goal_id, dependent_goal_id }` means the first goal must
be completed before the second. Do not treat prerequisite edges as additional
parents, and do not assume a goal's array position is a prerequisite.

Knowledge is available to the browser under `/api/knowledge` and `/knowledge`.
Its names, explanations, and terms are encrypted; structural parentage,
status, revisions, timestamps, and connection topology are metadata. Knowledge
is included in encrypted Atlas backups. The agent surface intentionally does
not expose Knowledge mutation or transfer operations yet.

Agent credentials are installation-local, shown once at creation or rotation,
stored only as a verifier, and excluded from backups. A `401` means the
credential is absent or invalid; `423` means the credential is valid but Atlas
is locked. Keep the key out of prompts, logs, and source control.
