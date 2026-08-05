# AGENTS.md instructions for Eidolon-Atlas

Project files are the source of truth. Keep changes scoped to this project and preserve unrelated work.

## Subagents

Use subagents ONLY for independent, bounded work where delegation materially
reduces wall-clock time, isolates substantial context, or enables useful
parallel execution.

Do not spawn a subagent merely to offload a task the main agent can complete
directly with the context it already has. Prefer the main agent for small,
single-file, tightly coupled, or low-overhead tasks.

Use the built-in `explorer` for independent, read-only codebase investigation.
Use the worker tiers below for implementation work.

Select the appropriate worker tier:

* `worker_low`: mechanical, localized, low-risk changes with an obvious solution.
* `worker_medium`: standard feature or bug-fix work requiring investigation and tests.
* `worker_high`: complex, coupled, ambiguous, or high-risk implementation.

The main agent may spawn multiple instances of the same worker role. Run workers
in parallel only when their tasks are independent and their file ownership does
not overlap.

When delegating, always select an explicit worker tier. Never use default worker. Never omit agent_type; if unsure, use worker_medium.

Give each worker a clear objective, scope, constraints, acceptance criteria,
and owned files. Workers must report work completed, files changed, validation
run, assumptions, blockers, and remaining risks.

The main agent owns decomposition, architecture, worker selection, integration,
diff review, conflict resolution, final testing, and the final response.

Do not delegate when the expected context packaging, review, or integration
overhead is comparable to completing the task directly.

## Projector

Projector is authoritative for structured TODO and working-history mutations. Do not directly edit `TODO.md` or `WORK_HISTORY.md`.

Use Projector's local API at `http://127.0.0.1:48721/v1`. Projector must be running; resolve the registered project ID with `GET /projects`.

- `POST /projects/{projectId}/todos`: `title`, `priority` (`critical|high|medium|low`), `category` (`feature|bugfix|refactor|test|documentation|research|others`), `area`, `dependencies` (TODO ID array), `rationale`, and `acceptanceCriteria`.
- `POST /projects/{projectId}/todos/{todoId}/complete`: `summary` and `limitations`; returns a pending proposal with `id`, `projectId`, `requestedAt`, `kind: "todoCompletion"`, the `todo` snapshot, and `proposedEntry`.
- `POST /projects/{projectId}/work-history`: `title`, `category`, `area`, `summary`, and `limitations`; returns a pending proposal with `id`, `projectId`, `requestedAt`, `kind: "workHistory"`, `todo: null`, and `proposedEntry`.

Use `POST /projects/{projectId}/todos` to record unfinished actionable work. Use `POST /projects/{projectId}/todos/{todoId}/complete` when that TODO is finished. Use `POST /projects/{projectId}/work-history` only for notable completed work that was not represented by an open TODO.

Send JSON with camel-case field names. Use an empty array when a TODO has no dependencies and use `none` when there are no known limitations.
