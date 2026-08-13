// Structured guidance is served to agents at runtime.  Keep semantic rules
// here rather than in the HTTP router so the guide and OpenAPI description can
// be checked and consumed independently.

export const AGENT_GUIDE = Object.freeze({
  project: {
    name: 'Eidolon-Atlas',
    purpose: "A private, local atlas of one person's life and conceptual knowledge.",
    scope: 'The initial agent contract is intentionally read-only and exposes only the four bounded views below.',
  },
  access: {
    authentication: 'Send the configured local API key as Authorization: Bearer <key> on every /api/agent/* and /api/openapi.json request.',
    key_management: 'Generate, rotate, and revoke the key through the same-origin browser /api/agent-key endpoints while Atlas is unlocked. The secret is returned only on generation or rotation and is never included in backups.',
    locked_runtime: 'A correctly authenticated agent request made while Atlas is locked returns 423 LOCKED. Missing, malformed, revoked, or incorrect keys return 401 UNAUTHORIZED.',
    transport: 'Atlas binds to loopback. Keep the key local and use HTTPS or another protected local transport if the process is proxied.',
  },
  privacy: {
    default: 'Agent responses are projections, not the full record model. Only the fields listed by each operation are exposed.',
    personal_info: [
      'Passport number, national ID number, driver licence number, and tax ID are never returned.',
      'Custom fields, links, revisions, timestamps, and storage metadata are never returned.',
      'When no active Person record exists, personal_info is null.',
    ],
    records: 'Only active, non-trashed Experiences and Projects are returned.',
  },
  operations: {
    get_personal_info: {
      endpoint: '/api/agent/get_personal_info',
      result: 'personal_info is null or a stable snake_case object containing non-sensitive built-in Person fields.',
    },
    list_experiences: {
      endpoint: '/api/agent/list_experiences',
      result: 'experiences is newest-first. Each item is {title, time: {start_date, end_date, ongoing}, description}; absent optional values are null.',
    },
    get_goals: {
      endpoint: '/api/agent/get_goals',
      result: 'goals is an ordered recursive hierarchy. Each node contains only id, title, description, importance, horizon, target_date, and subgoals.',
    },
    list_projects: {
      endpoint: '/api/agent/list_projects',
      result: 'projects is alphabetically ordered and each item is {title, description, status, github_link}.',
    },
  },
  goals: {
    hierarchy: 'subgoals is the canonical parent-child tree. A child appears exactly once below its parent and ordering follows the user-defined sibling order.',
    progression: 'progressions contains ordered subgoal_ids for each parent and prerequisite-to-dependent edges. An edge {prerequisite_goal_id, dependent_goal_id} means the prerequisite should be completed before the dependent; both goals are siblings under the same parent.',
    importance: 'importance is one of low, medium, or high. Existing goals without an explicit value are treated as medium.',
    horizon: 'horizon is short, middle, long, or null when absent.',
    target_date: 'target_date preserves the stored partial date or is null when absent.',
  },
  response_interpretation: {
    nulls: 'Optional scalar fields are null rather than omitted.',
    ordering: 'Ordering in each response is intentional and stable for a given Atlas state; do not infer hidden fields.',
    mutation: 'The agent API has no write, delete, move, or key-management tools. Use the primitive unlocked browser API for user-authorized changes.',
  },
  agent_workflow: {
    state_model: 'Stateless. Each request is self-contained; Atlas does not maintain an agent cursor, selected record, or conversation state.',
    steps: [
      'Read the authenticated tool catalog and guide before relying on a response contract.',
      'Call only the read operation whose projection is needed, with {} as its body.',
      'Treat nulls, ordering, hierarchy, and progression edges according to this guide rather than inferring omitted fields.',
    ],
  },
  mutation_limits: [
    'Agent calls cannot create, edit, move, trash, restore, or delete Atlas records.',
    'Agent calls cannot generate, rotate, or revoke API keys.',
    'Agent calls cannot export, import, or reset Knowledge.',
  ],
  resources: {
    tools: '/api/agent/tools',
    guide: '/api/agent/guide',
    openapi: '/api/openapi.json',
    key: '/api/agent-key',
  },
});
