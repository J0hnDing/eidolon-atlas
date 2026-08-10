// The agent surface is deliberately small and read-only.  Keep this catalog
// machine-readable: clients should be able to discover the callable methods
// without inferring inputs from prose or route names.

const emptyInput = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {},
});

export const AGENT_TOOLS = Object.freeze([
  Object.freeze({
    name: 'get_personal_info',
    description: 'Return the active person profile using only non-sensitive built-in fields. Custom fields, links, revisions, metadata, and government identifiers are excluded.',
    method: 'POST',
    endpoint: '/api/agent/get_personal_info',
    input_schema: emptyInput,
  }),
  Object.freeze({
    name: 'list_experiences',
    description: 'Return active, non-trashed experiences ordered newest first. Each item contains only its title, partial-date time range, ongoing flag, and description.',
    method: 'POST',
    endpoint: '/api/agent/list_experiences',
    input_schema: emptyInput,
  }),
  Object.freeze({
    name: 'get_goals',
    description: 'Return the active goal hierarchy recursively, with importance and target dates, plus the sibling prerequisite DAG in an explicit edge list.',
    method: 'POST',
    endpoint: '/api/agent/get_goals',
    input_schema: emptyInput,
  }),
  Object.freeze({
    name: 'list_projects',
    description: 'Return active, non-trashed projects alphabetically with their descriptions and GitHub links.',
    method: 'POST',
    endpoint: '/api/agent/list_projects',
    input_schema: emptyInput,
  }),
]);

