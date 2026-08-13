const errorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    details: { type: ['object', 'null'], additionalProperties: true },
  },
};

const errorResponse = {
  description: 'A stable Atlas error.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

const jsonResponse = (description, schema) => ({
  description,
  content: { 'application/json': { schema } },
});

const emptyRequest = {
  required: true,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/EmptyObject' },
    },
  },
};

const secured = (operation) => ({ ...operation, security: [{ bearerAuth: [] }] });

const personalInfo = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'name', 'preferred_name', 'gender', 'birth_date', 'birth_place', 'nationalities',
    'languages', 'marital_status', 'emails', 'phone_numbers', 'address', 'summary', 'notes',
  ],
  description: 'Stable snake_case built-in Person fields only; sensitive identifiers, custom fields, links, revisions, and metadata are excluded.',
  properties: {
    name: { type: 'string' },
    preferred_name: { type: ['string', 'null'] },
    gender: { type: ['string', 'null'] },
    birth_date: { type: ['string', 'null'] },
    birth_place: { type: ['string', 'null'] },
    nationalities: { type: 'array', items: { type: 'string' } },
    languages: { type: 'array', items: { type: 'string' } },
    marital_status: { type: ['string', 'null'] },
    emails: { type: 'array', items: { type: 'string' } },
    phone_numbers: { type: 'array', items: { type: 'string' } },
    address: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
  },
};

const experience = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'time', 'description'],
  properties: {
    title: { type: 'string' },
    time: {
      type: 'object',
      additionalProperties: false,
      required: ['start_date', 'end_date', 'ongoing'],
      properties: {
        start_date: { type: ['string', 'null'], description: 'YYYY, YYYY-MM, or YYYY-MM-DD.' },
        end_date: { type: ['string', 'null'], description: 'YYYY, YYYY-MM, or YYYY-MM-DD.' },
        ongoing: { type: ['boolean', 'null'] },
      },
    },
    description: { type: ['string', 'null'] },
  },
};

const goal = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'description', 'importance', 'horizon', 'target_date', 'subgoals'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    importance: { type: 'string', enum: ['low', 'medium', 'high'] },
    horizon: { type: ['string', 'null'], enum: ['short', 'middle', 'long', null] },
    target_date: { type: ['string', 'null'] },
    subgoals: { type: 'array', items: { $ref: '#/components/schemas/Goal' } },
  },
};

const progression = {
  type: 'object',
  additionalProperties: false,
  required: ['parent_goal_id', 'subgoal_ids', 'edges'],
  properties: {
    parent_goal_id: { type: 'string' },
    subgoal_ids: { type: 'array', items: { type: 'string' } },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prerequisite_goal_id', 'dependent_goal_id'],
        properties: {
          prerequisite_goal_id: { type: 'string' },
          dependent_goal_id: { type: 'string' },
        },
      },
    },
  },
};

const project = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'status', 'github_link'],
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: { type: ['string', 'null'], enum: ['planned', 'active', 'paused', 'completed', 'abandoned', null] },
    github_link: { type: ['string', 'null'], format: 'uri' },
  },
};

export const OPENAPI_SPEC = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Eidolon-Atlas Agent API',
    version: '1.0.0',
    summary: 'Authenticated, read-only views of an unlocked personal Atlas.',
    description: 'The agent API is stateless and intentionally narrow. Every operation returns an explicit projection and accepts an empty JSON object; it never mutates Atlas data.',
  },
  servers: [{ url: '/', description: 'The same local Eidolon-Atlas server.' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Discovery', description: 'Machine-readable agent catalog, guide, and OpenAPI specification.' },
    { name: 'Agent', description: 'Authenticated, read-only projections.' },
  ],
  'x-agent-guide': '/api/agent/guide',
  paths: {
    '/api/openapi.json': {
      get: secured({
        operationId: 'get_openapi_specification',
        tags: ['Discovery'],
        summary: 'Get the authenticated OpenAPI specification',
        description: 'Returns the machine-readable contract for the authenticated Agent API. The separate unlocked-browser Knowledge API is intentionally excluded.',
        responses: { 200: jsonResponse('OpenAPI 3.1 document.', { type: 'object' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/guide': {
      get: secured({
        operationId: 'get_agent_guide',
        tags: ['Discovery'],
        summary: 'Get agent privacy and response semantics',
        description: 'Returns structured guidance for authentication, privacy boundaries, field projections, ordering, hierarchy, and mutation limits.',
        responses: { 200: jsonResponse('Machine-readable agent guide.', { $ref: '#/components/schemas/AgentGuide' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/tools': {
      get: secured({
        operationId: 'list_agent_tools',
        tags: ['Discovery'],
        summary: 'List authenticated agent operations',
        description: 'Returns the callable Agent tool catalog with each operation name, endpoint, method, description, and input schema.',
        responses: { 200: jsonResponse('Agent discovery catalog.', { $ref: '#/components/schemas/AgentToolCatalog' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/get_personal_info': {
      post: secured({
        operationId: 'get_personal_info',
        tags: ['Agent'],
        summary: 'Return non-sensitive personal information',
        description: 'Returns the active Person projection using only documented non-sensitive built-in fields, or null when no active Person exists.',
        requestBody: emptyRequest,
        responses: {
          200: jsonResponse('Personal projection.', { $ref: '#/components/schemas/PersonalInfoResponse' }),
          400: errorResponse, 401: errorResponse, 423: errorResponse,
        },
      }),
    },
    '/api/agent/list_experiences': {
      post: secured({
        operationId: 'list_experiences',
        tags: ['Agent'],
        summary: 'List active experiences newest first',
        description: 'Returns active, non-trashed Experience projections ordered newest first, with partial-date time ranges preserved.',
        requestBody: emptyRequest,
        responses: {
          200: jsonResponse('Experience projections.', { $ref: '#/components/schemas/ExperiencesResponse' }),
          400: errorResponse, 401: errorResponse, 423: errorResponse,
        },
      }),
    },
    '/api/agent/get_goals': {
      post: secured({
        operationId: 'get_goals',
        tags: ['Agent'],
        summary: 'Return the goal hierarchy and sibling prerequisite DAG',
        description: 'A progression edge points from prerequisite_goal_id to dependent_goal_id; both are sibling subgoals of the listed parent.',
        requestBody: emptyRequest,
        responses: {
          200: jsonResponse('Goal hierarchy and progression projections.', { $ref: '#/components/schemas/GoalsResponse' }),
          400: errorResponse, 401: errorResponse, 423: errorResponse,
        },
      }),
    },
    '/api/agent/list_projects': {
      post: secured({
        operationId: 'list_projects',
        tags: ['Agent'],
        summary: 'List active projects alphabetically',
        description: 'Returns active, non-trashed Project projections alphabetically with descriptions, lifecycle statuses, and GitHub links.',
        requestBody: emptyRequest,
        responses: {
          200: jsonResponse('Project projections.', { $ref: '#/components/schemas/ProjectsResponse' }),
          400: errorResponse, 401: errorResponse, 423: errorResponse,
        },
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'atlas_…',
        description: 'Local API key generated through POST /api/agent-key. Send it as Authorization: Bearer <key>.',
      },
    },
    schemas: {
      EmptyObject: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        description: 'Every read operation accepts only an empty JSON object.',
      },
      Error: errorSchema,
      ErrorResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['error'],
        properties: { error: { $ref: '#/components/schemas/Error' } },
      },
      PersonalInfoResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['personal_info'],
        properties: { personal_info: { $ref: '#/components/schemas/PersonalInfo' } },
      },
      PersonalInfo: personalInfo,
      ExperiencesResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['experiences'],
        properties: { experiences: { type: 'array', items: { $ref: '#/components/schemas/Experience' } } },
      },
      Experience: experience,
      GoalsResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['goals', 'progressions'],
        properties: {
          goals: { type: 'array', items: { $ref: '#/components/schemas/Goal' } },
          progressions: { type: 'array', items: { $ref: '#/components/schemas/Progression' } },
        },
      },
      Goal: goal,
      Progression: progression,
      ProjectsResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['projects'],
        properties: { projects: { type: 'array', items: { $ref: '#/components/schemas/Project' } } },
      },
      Project: project,
      AgentGuide: { type: 'object', additionalProperties: true },
      AgentTool: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'method', 'endpoint', 'input_schema'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          method: { type: 'string', const: 'POST' },
          endpoint: { type: 'string' },
          input_schema: { $ref: '#/components/schemas/EmptyObject' },
        },
      },
      AgentToolCatalog: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'guide_url', 'openapi_url', 'tools'],
        properties: {
          project: { type: 'string' },
          guide_url: { type: 'string' },
          openapi_url: { type: 'string' },
          tools: { type: 'array', items: { $ref: '#/components/schemas/AgentTool' } },
        },
      },
    },
  },
});

const knowledgeTerm = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'definition'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    definition: { type: 'string' },
  },
};

const knowledgeNodeProperties = {
  id: { type: 'integer', minimum: 1 },
  name: { type: 'string' },
  branch: { type: 'string', enum: ['subjects', 'ideologies'] },
  parentId: { type: ['integer', 'null'], minimum: 1 },
  status: { type: 'string', enum: ['unassessed', 'unknown', 'known'] },
  understanding: { type: ['string', 'null'] },
  terms: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeTerm' } },
  revision: { type: 'integer', minimum: 1 },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
};

const knowledgeNodeInputProperties = {
  name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
  branch: { type: 'string', enum: ['subjects', 'ideologies'] },
  parentId: { type: ['integer', 'null'], minimum: 1 },
  status: { type: 'string', enum: ['unassessed', 'unknown', 'known'], default: 'unassessed' },
  understanding: { type: ['string', 'null'], maxLength: 2000 },
  terms: { type: 'array', maxItems: 20, default: [], items: { $ref: '#/components/schemas/KnowledgeTermInput' } },
};

export const KNOWLEDGE_OPENAPI_SPEC = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Eidolon-Atlas Knowledge API',
    version: '1.0.0',
    summary: 'Epistome-compatible browser operations for the encrypted Knowledge workspace.',
    description: 'These operations use Atlas\'s unlocked browser-session model. They are not agent tools and do not accept the agent Bearer key as authorization to mutate Knowledge.',
  },
  servers: [{ url: '/', description: 'The same local Eidolon-Atlas server.' }],
  security: [],
  tags: [
    { name: 'Knowledge', description: 'Hierarchy and node operations.' },
    { name: 'Knowledge connections', description: 'Undirected cross-connections between nodes.' },
  ],
  paths: {
    '/api/knowledge/tree': {
      get: {
        operationId: 'get_knowledge_tree', tags: ['Knowledge'], summary: 'Return both recursive Knowledge branches',
        description: 'Returns the Subjects and Ideologies roots with every descendant nested under children. Use this when hierarchy and display order matter.',
        responses: {
          200: jsonResponse('Subjects and Ideologies with recursive children.', { $ref: '#/components/schemas/KnowledgeTreeResponse' }),
          423: errorResponse,
        },
      },
    },
    '/api/knowledge/nodes': {
      get: {
        operationId: 'list_knowledge_nodes', tags: ['Knowledge'], summary: 'List all Knowledge nodes alphabetically',
        description: 'Returns a flat alphabetical list of every node without child counts or connection details. Use the node-detail operation when those relationships are needed.',
        responses: {
          200: jsonResponse('Flat Knowledge node list.', { $ref: '#/components/schemas/KnowledgeNodesResponse' }),
          423: errorResponse,
        },
      },
      post: {
        operationId: 'create_knowledge_node', tags: ['Knowledge'], summary: 'Create a Knowledge node',
        description: 'Creates a root or child node. Child nodes must use the same branch as a known parent, and sibling names must be unique ignoring case.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateKnowledgeNode' } } } },
        responses: {
          201: jsonResponse('Created node detail.', { $ref: '#/components/schemas/KnowledgeNodeResponse' }),
          400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
    },
    '/api/knowledge/nodes/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      get: {
        operationId: 'get_knowledge_node', tags: ['Knowledge'], summary: 'Return one Knowledge node with connections',
        description: 'Returns one node together with its direct-child count and alphabetically ordered undirected connection summaries.',
        responses: {
          200: jsonResponse('Knowledge node detail.', { $ref: '#/components/schemas/KnowledgeNodeResponse' }),
          400: errorResponse, 404: errorResponse, 423: errorResponse,
        },
      },
      patch: {
        operationId: 'patch_knowledge_node', tags: ['Knowledge'], summary: 'Edit or move a Knowledge node',
        description: 'Updates only the supplied fields. Moving a node preserves an acyclic hierarchy, adopts its parent branch, and requires the new parent to be known.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PatchKnowledgeNode' } } } },
        responses: {
          200: jsonResponse('Updated node detail.', { $ref: '#/components/schemas/KnowledgeNodeResponse' }),
          400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
      delete: {
        operationId: 'delete_knowledge_node', tags: ['Knowledge'], summary: 'Delete a leaf Knowledge node',
        description: 'Permanently deletes a node only when it has no children. Connections involving the node are removed with it.',
        responses: {
          204: { description: 'Node deleted.' }, 400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
    },
    '/api/knowledge/connections': {
      post: {
        operationId: 'create_knowledge_connection', tags: ['Knowledge connections'], summary: 'Create an undirected node connection',
        description: 'Connects two different existing nodes. Endpoint order is normalized, so the same undirected pair cannot be created twice.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateKnowledgeConnection' } } } },
        responses: {
          201: jsonResponse('Created connection.', { $ref: '#/components/schemas/KnowledgeConnectionResponse' }),
          400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
    },
    '/api/knowledge/connections/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      delete: {
        operationId: 'delete_knowledge_connection', tags: ['Knowledge connections'], summary: 'Delete an undirected node connection',
        description: 'Permanently removes one connection by its connection identifier without deleting either endpoint node.',
        responses: { 204: { description: 'Connection deleted.' }, 400: errorResponse, 404: errorResponse, 423: errorResponse },
      },
    },
  },
  components: {
    schemas: {
      Error: errorSchema,
      ErrorResponse: {
        type: 'object', additionalProperties: false, required: ['error'],
        properties: { error: { $ref: '#/components/schemas/Error' } },
      },
      KnowledgeTerm: knowledgeTerm,
      KnowledgeTermInput: {
        type: 'object', additionalProperties: false, required: ['id', 'label', 'definition'],
        properties: {
          id: { type: 'string', maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' },
          label: { type: 'string', minLength: 1, maxLength: 80 },
          definition: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
      KnowledgeNode: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'branch', 'parentId', 'status', 'understanding', 'terms', 'revision', 'createdAt', 'updatedAt'],
        properties: knowledgeNodeProperties,
      },
      KnowledgeTreeNode: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'branch', 'parentId', 'status', 'understanding', 'terms', 'revision', 'createdAt', 'updatedAt', 'children'],
        properties: { ...knowledgeNodeProperties, children: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeTreeNode' } } },
      },
      KnowledgeBranch: {
        type: 'object', additionalProperties: false, required: ['id', 'name', 'description', 'virtual', 'children'],
        properties: {
          id: { type: 'string', enum: ['subjects', 'ideologies'] }, name: { type: 'string' }, description: { type: 'string' },
          virtual: { type: 'boolean', const: true }, children: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeTreeNode' } },
        },
      },
      KnowledgeConnectionSummary: {
        type: 'object', additionalProperties: false, required: ['id', 'node'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          node: {
            type: 'object', additionalProperties: false, required: ['id', 'name', 'branch', 'status'],
            properties: {
              id: { type: 'integer', minimum: 1 }, name: { type: 'string' },
              branch: { type: 'string', enum: ['subjects', 'ideologies'] },
              status: { type: 'string', enum: ['unassessed', 'unknown', 'known'] },
            },
          },
        },
      },
      KnowledgeNodeDetail: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name', 'branch', 'parentId', 'status', 'understanding', 'terms', 'revision', 'createdAt', 'updatedAt', 'childCount', 'connections'],
        properties: {
          ...knowledgeNodeProperties,
          childCount: { type: 'integer', minimum: 0 },
          connections: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeConnectionSummary' } },
        },
      },
      CreateKnowledgeNode: {
        type: 'object', additionalProperties: false, required: ['name', 'branch'], properties: knowledgeNodeInputProperties,
      },
      PatchKnowledgeNode: {
        type: 'object', additionalProperties: false, properties: knowledgeNodeInputProperties,
      },
      CreateKnowledgeConnection: {
        type: 'object', additionalProperties: false, required: ['sourceId', 'targetId'],
        properties: { sourceId: { type: 'integer', minimum: 1 }, targetId: { type: 'integer', minimum: 1 } },
      },
      KnowledgeConnection: {
        type: 'object', additionalProperties: false, required: ['id', 'sourceId', 'targetId'],
        properties: {
          id: { type: 'integer', minimum: 1 }, sourceId: { type: 'integer', minimum: 1 }, targetId: { type: 'integer', minimum: 1 },
        },
      },
      KnowledgeTreeResponse: {
        type: 'object', additionalProperties: false, required: ['branches'],
        properties: { branches: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeBranch' } } },
      },
      KnowledgeNodesResponse: {
        type: 'object', additionalProperties: false, required: ['nodes'],
        properties: { nodes: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeNode' } } },
      },
      KnowledgeNodeResponse: {
        type: 'object', additionalProperties: false, required: ['node'],
        properties: { node: { $ref: '#/components/schemas/KnowledgeNodeDetail' } },
      },
      KnowledgeConnectionResponse: {
        type: 'object', additionalProperties: false, required: ['connection'],
        properties: { connection: { $ref: '#/components/schemas/KnowledgeConnection' } },
      },
    },
  },
});

const unlockedErrors = { 400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse };
const jsonObjectRequest = {
  required: true,
  content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
};
const optionalEmptyRequest = { ...emptyRequest, required: false };
const pathParameter = (name) => ({ name, in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
const queryParameter = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });
const localOperation = (operationId, tag, summary, description, responses, requestBody) => ({
  operationId, tags: [tag], summary, description, ...(requestBody ? { requestBody } : {}), responses,
});

export const BROWSER_OPENAPI_SPEC = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Eidolon-Atlas Local API',
    version: '1.0.0',
    summary: 'Complete same-origin API used by the Atlas browser application.',
    description: 'Every non-agent /api route implemented by this Atlas server. Except for status, setup, and unlock, protected operations require Atlas to be unlocked. Browser mutations also enforce the loopback same-origin request boundary. The separate Agent API uses Bearer authentication and is documented above.',
  },
  servers: [{ url: '/', description: 'The same local Eidolon-Atlas server.' }],
  security: [],
  tags: [
    { name: 'Lifecycle', description: 'Initialization, lock state, unlock, and reset.' },
    { name: 'Settings', description: 'Settings discovery and local agent-key management.' },
    { name: 'Records', description: 'Typed record CRUD, revisions, trash, and restore.' },
    { name: 'Goals', description: 'Goal progression and sibling prerequisites.' },
    { name: 'Images', description: 'Encrypted Experience image attachment operations.' },
    { name: 'Custom fields', description: 'Category-scoped custom field definitions.' },
    { name: 'Links', description: 'Encrypted cross-record links.' },
    { name: 'Knowledge', description: 'Knowledge hierarchy and node operations.' },
    { name: 'Knowledge connections', description: 'Undirected Knowledge cross-connections.' },
    { name: 'Backup', description: 'Encrypted Atlas export and import operations.' },
  ],
  paths: {
    '/api/status': {
      get: localOperation('get_status', 'Lifecycle', 'Get initialization and lock state', 'Returns only whether Atlas has been initialized and whether its encryption key is currently locked.', {
        200: jsonResponse('Current Atlas status.', { $ref: '#/components/schemas/Status' }),
      }),
    },
    '/api/setup': {
      post: localOperation('setup_atlas', 'Lifecycle', 'Initialize Atlas', 'Creates the passphrase-derived encryption configuration, unlocks Atlas, and seeds Knowledge. It is valid only before initialization.', {
        201: jsonResponse('Initialized and unlocked status.', { $ref: '#/components/schemas/Status' }),
        400: errorResponse, 409: errorResponse,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PassphraseRequest' } } } }),
    },
    '/api/unlock': {
      post: localOperation('unlock_atlas', 'Lifecycle', 'Unlock Atlas', 'Verifies the passphrase, loads the derived encryption key into memory, performs bounded data migrations, and seeds missing standard Knowledge.', {
        200: jsonResponse('Unlocked status.', { $ref: '#/components/schemas/Status' }),
        400: errorResponse, 401: errorResponse, 409: errorResponse, 500: errorResponse,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PassphraseRequest' } } } }),
    },
    '/api/lock': {
      post: localOperation('lock_atlas', 'Lifecycle', 'Lock Atlas', 'Discards the in-memory encryption key. The JSON body is accepted but ignored.', {
        200: jsonResponse('Locked status.', { $ref: '#/components/schemas/Status' }), 400: errorResponse,
      }),
    },
    '/api/reset': {
      post: localOperation('reset_atlas', 'Lifecycle', 'Clear all Atlas data', 'Verifies the current passphrase, permanently removes all data, metadata, staged imports, and agent credentials, then returns to first-time setup.', {
        200: jsonResponse('Uninitialized locked status.', { $ref: '#/components/schemas/Status' }), 400: errorResponse, 401: errorResponse, 423: errorResponse,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PassphraseRequest' } } } }),
    },
    '/api/settings/api-reference': {
      get: localOperation('get_api_reference', 'Settings', 'Get complete Settings API reference', 'Returns the agent tool catalog and guide, the Bearer Agent OpenAPI document, the complete local API document, and the separate Knowledge document.', {
        200: jsonResponse('Settings API reference bundle.', { type: 'object' }), 423: errorResponse,
      }),
    },
    '/api/agent-key': {
      get: localOperation('get_agent_key_status', 'Settings', 'Get agent-key status', 'Returns only whether an agent key is configured plus its non-secret prefix and creation time. The secret is never returned.', {
        200: jsonResponse('Sanitized agent-key status.', { $ref: '#/components/schemas/AgentKeyStatus' }), 423: errorResponse,
      }),
      post: localOperation('generate_agent_key', 'Settings', 'Generate or rotate the agent key', 'Generates a new local Bearer key and immediately invalidates any previous key. The full secret is returned exactly once.', {
        201: jsonResponse('New agent key and sanitized status.', { $ref: '#/components/schemas/GeneratedAgentKey' }), 400: errorResponse, 423: errorResponse,
      }, optionalEmptyRequest),
      delete: localOperation('revoke_agent_key', 'Settings', 'Revoke the agent key', 'Removes the stored key verifier so existing Bearer credentials stop working immediately.', {
        200: jsonResponse('Revocation result.', { type: 'object', required: ['revoked'], properties: { revoked: { type: 'boolean' } } }), 400: errorResponse, 423: errorResponse,
      }, optionalEmptyRequest),
    },
    '/api/records': {
      get: {
        ...localOperation('list_records', 'Records', 'List records', 'Lists records after optional category, encrypted-text query, and trash-state filtering. The response is a JSON array rather than an envelope.', {
          200: jsonResponse('Matching record summaries.', { type: 'array', items: { $ref: '#/components/schemas/Record' } }), 400: errorResponse, 423: errorResponse,
        }),
        parameters: [
          queryParameter('category', { type: 'string' }, 'Optional record category.'),
          queryParameter('q', { type: 'string' }, 'Optional case-insensitive search across decrypted record content.'),
          queryParameter('trashed', { type: 'string', enum: ['false', 'true', 'all'], default: 'false' }, 'Select active, trashed, or all records.'),
        ],
      },
      post: localOperation('create_record', 'Records', 'Create a typed record', 'Creates a category-specific encrypted record. Goal hierarchy fields are accepted only for Goal records.', {
        201: jsonResponse('Created record.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }, jsonObjectRequest),
    },
    '/api/records/{id}': {
      parameters: [pathParameter('id')],
      get: localOperation('get_record', 'Records', 'Get record detail', 'Returns one decrypted record with its built-in data, custom values, links, and attachment summaries.', {
        200: jsonResponse('Record detail.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }),
      patch: localOperation('patch_record', 'Records', 'Update a record', 'Applies an optimistic record edit using the supplied revision and category-specific fields.', {
        200: jsonResponse('Updated record.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }, jsonObjectRequest),
      delete: localOperation('trash_record', 'Records', 'Move a record to Recently removed', 'Optimistically trashes a record using the required current revision. Goal hierarchy restrictions still apply.', {
        200: jsonResponse('Trashed record.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevisionRequest' } } } }),
    },
    '/api/records/{id}/restore': {
      parameters: [pathParameter('id')],
      post: localOperation('restore_record', 'Records', 'Restore a trashed record', 'Restores a record from Recently removed using its current revision.', {
        200: jsonResponse('Restored record.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevisionRequest' } } } }),
    },
    '/api/records/{id}/revisions': {
      parameters: [pathParameter('id')],
      get: localOperation('list_record_revisions', 'Records', 'List record revisions', 'Returns the immutable revision history for one record, newest first.', {
        200: jsonResponse('Record revisions.', { type: 'array', items: { type: 'object' } }), ...unlockedErrors,
      }),
    },
    '/api/records/{id}/revisions/{revision}/restore': {
      parameters: [pathParameter('id'), { name: 'revision', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
      post: localOperation('restore_record_revision', 'Records', 'Restore a historical record revision', 'Creates a new current revision from the selected historical snapshot while checking the supplied current revision.', {
        200: jsonResponse('Restored record.', { $ref: '#/components/schemas/Record' }), ...unlockedErrors,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevisionRequest' } } } }),
    },
    '/api/trash': {
      delete: localOperation('empty_trash', 'Records', 'Permanently empty Recently removed', 'Permanently deletes every trashed record together with its revision history, links, and attachments.', {
        200: jsonResponse('Permanent deletion counts.', { type: 'object' }), 423: errorResponse,
      }),
    },
    '/api/goals/{id}/progression': {
      parameters: [pathParameter('id')],
      get: localOperation('get_goal_progression', 'Goals', 'Get a Goal progression graph', 'Returns one Goal, its ordered direct subgoals, and sibling prerequisite edges.', {
        200: jsonResponse('Goal progression graph.', { type: 'object' }), ...unlockedErrors,
      }),
    },
    '/api/goals/{id}/prerequisites': {
      parameters: [pathParameter('id')],
      post: localOperation('create_goal_prerequisite', 'Goals', 'Add a sibling prerequisite', 'Adds a prerequisite edge to the selected Goal. Both endpoints must be siblings and the edge must remain acyclic.', {
        201: jsonResponse('Created prerequisite edge.', { type: 'object' }), ...unlockedErrors,
      }, { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['prerequisiteId'], properties: { prerequisiteId: { type: 'string' } } } } } }),
    },
    '/api/goals/{id}/prerequisites/{prerequisiteId}': {
      parameters: [pathParameter('id'), pathParameter('prerequisiteId')],
      delete: localOperation('delete_goal_prerequisite', 'Goals', 'Remove a sibling prerequisite', 'Removes one prerequisite edge without changing either Goal.', {
        200: jsonResponse('Deletion result.', { type: 'object' }), ...unlockedErrors,
      }),
    },
    '/api/records/{id}/images': {
      parameters: [pathParameter('id')],
      get: localOperation('list_record_images', 'Images', 'List Experience images', 'Lists encrypted image attachment metadata for one Experience without returning image bytes.', {
        200: jsonResponse('Image metadata.', { type: 'array', items: { type: 'object' } }), ...unlockedErrors,
      }),
      post: localOperation('upload_record_image', 'Images', 'Upload an Experience image', 'Uploads one JPEG, PNG, or WebP body. The optional X-Filename header supplies the original filename. Images are limited to 20 MiB and 50 per Experience.', {
        201: jsonResponse('Created image metadata.', { type: 'object' }), ...unlockedErrors, 413: errorResponse, 415: errorResponse,
      }, { required: true, content: {
        'image/jpeg': { schema: { type: 'string', contentEncoding: 'binary' } },
        'image/png': { schema: { type: 'string', contentEncoding: 'binary' } },
        'image/webp': { schema: { type: 'string', contentEncoding: 'binary' } },
      } }),
    },
    '/api/images/{id}/content': {
      parameters: [pathParameter('id')],
      get: localOperation('get_image_content', 'Images', 'Download decrypted image content', 'Returns the original image bytes with the stored image media type and no-store caching.', {
        200: { description: 'JPEG, PNG, or WebP image bytes.', content: {
          'image/jpeg': { schema: { type: 'string', contentEncoding: 'binary' } },
          'image/png': { schema: { type: 'string', contentEncoding: 'binary' } },
          'image/webp': { schema: { type: 'string', contentEncoding: 'binary' } },
        } }, ...unlockedErrors,
      }),
    },
    '/api/images/{id}': {
      parameters: [pathParameter('id')],
      delete: localOperation('delete_image', 'Images', 'Delete an Experience image', 'Permanently removes one encrypted image attachment without creating a record revision.', {
        200: jsonResponse('Deletion result.', { type: 'object' }), ...unlockedErrors,
      }),
    },
    '/api/custom-fields': {
      get: {
        ...localOperation('list_custom_fields', 'Custom fields', 'List custom field definitions', 'Lists custom field definitions, optionally restricted to one record category.', {
          200: jsonResponse('Custom field definitions.', { type: 'array', items: { type: 'object' } }), 423: errorResponse,
        }),
        parameters: [queryParameter('category', { type: 'string' }, 'Optional record category.')],
      },
      post: localOperation('create_custom_field', 'Custom fields', 'Create a custom field', 'Creates a typed custom field definition for one record category.', {
        201: jsonResponse('Created custom field.', { type: 'object' }), ...unlockedErrors,
      }, jsonObjectRequest),
    },
    '/api/custom-fields/{id}': {
      parameters: [pathParameter('id')],
      patch: localOperation('patch_custom_field', 'Custom fields', 'Update a custom field', 'Updates a custom field definition while preserving type and stored-value integrity.', {
        200: jsonResponse('Updated custom field.', { type: 'object' }), ...unlockedErrors,
      }, jsonObjectRequest),
      delete: localOperation('delete_custom_field', 'Custom fields', 'Permanently delete a custom field', 'Deletes the definition and purges its values from current records and revision history.', {
        200: jsonResponse('Deletion result.', { type: 'object' }), ...unlockedErrors,
      }),
    },
    '/api/links': {
      post: localOperation('create_link', 'Links', 'Create a record link', 'Creates an encrypted typed link between two different records.', {
        201: jsonResponse('Created link.', { type: 'object' }), ...unlockedErrors,
      }, jsonObjectRequest),
    },
    '/api/links/{id}': {
      parameters: [pathParameter('id')],
      patch: localOperation('patch_link', 'Links', 'Update a record link', 'Updates the link type or note for one existing cross-record link.', {
        200: jsonResponse('Updated link.', { type: 'object' }), ...unlockedErrors,
      }, jsonObjectRequest),
      delete: localOperation('delete_link', 'Links', 'Delete a record link', 'Permanently removes one cross-record link without deleting either record.', {
        200: jsonResponse('Deletion result.', { type: 'object' }), ...unlockedErrors,
      }),
    },
    ...KNOWLEDGE_OPENAPI_SPEC.paths,
    '/api/export': {
      post: localOperation('export_atlas', 'Backup', 'Export an encrypted Atlas backup', 'Streams a versioned encrypted .atlas backup using the supplied backup passphrase. The passphrase is not stored.', {
        200: { description: 'Encrypted .atlas backup stream.', content: { 'application/vnd.eidolon-atlas-backup': { schema: { type: 'string', contentEncoding: 'binary' } } } }, 400: errorResponse, 423: errorResponse,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PassphraseRequest' } } } }),
    },
    '/api/import': {
      post: localOperation('import_legacy_backup', 'Backup', 'Import a legacy JSON backup', 'Decrypts and validates a legacy v1 JSON backup envelope before atomically replacing Atlas data.', {
        200: jsonResponse('Import result.', { type: 'object' }), 400: errorResponse, 409: errorResponse, 423: errorResponse,
      }, { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['passphrase', 'envelope'], properties: { passphrase: { type: 'string' }, envelope: { type: 'object', additionalProperties: true } } } } } }),
    },
    '/api/import-uploads': {
      post: localOperation('stage_backup_upload', 'Backup', 'Stage an encrypted backup upload', 'Streams an encrypted .atlas backup into the bounded staging area and returns an opaque upload identifier. No decryption occurs yet.', {
        201: jsonResponse('Staged upload metadata.', { type: 'object' }), 400: errorResponse, 413: errorResponse, 415: errorResponse, 423: errorResponse,
      }, { required: true, content: { 'application/vnd.eidolon-atlas-backup': { schema: { type: 'string', contentEncoding: 'binary' } }, 'application/octet-stream': { schema: { type: 'string', contentEncoding: 'binary' } } } }),
    },
    '/api/import-uploads/{id}/commit': {
      parameters: [pathParameter('id')],
      post: localOperation('commit_backup_upload', 'Backup', 'Commit a staged backup import', 'Decrypts and validates the staged backup using its passphrase, then atomically replaces Atlas data.', {
        200: jsonResponse('Import result.', { type: 'object' }), ...unlockedErrors,
      }, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PassphraseRequest' } } } }),
    },
    '/api/import-uploads/{id}': {
      parameters: [pathParameter('id')],
      delete: localOperation('cancel_backup_upload', 'Backup', 'Cancel a staged backup upload', 'Deletes one encrypted staged upload without changing Atlas data.', {
        200: jsonResponse('Cancellation result.', { type: 'object' }), ...unlockedErrors,
      }),
    },
  },
  components: {
    schemas: {
      ...KNOWLEDGE_OPENAPI_SPEC.components.schemas,
      EmptyObject: {
        type: 'object', additionalProperties: false, properties: {},
        description: 'An explicitly empty JSON object.',
      },
      Status: {
        type: 'object', additionalProperties: false, required: ['initialized', 'locked'],
        properties: { initialized: { type: 'boolean' }, locked: { type: 'boolean' } },
      },
      PassphraseRequest: {
        type: 'object', additionalProperties: false, required: ['passphrase'],
        properties: { passphrase: { type: 'string', minLength: 8, writeOnly: true, description: 'At least 8 characters and at most 1,024 UTF-8 bytes.' } },
      },
      RevisionRequest: {
        type: 'object', additionalProperties: false, required: ['revision'],
        properties: { revision: { type: 'integer', minimum: 1 } },
      },
      AgentKeyStatus: {
        type: 'object', additionalProperties: false, required: ['configured', 'prefix', 'createdAt'],
        properties: { configured: { type: 'boolean' }, prefix: { type: ['string', 'null'] }, createdAt: { type: ['string', 'null'], format: 'date-time' } },
      },
      GeneratedAgentKey: {
        allOf: [
          { $ref: '#/components/schemas/AgentKeyStatus' },
          { type: 'object', required: ['key'], properties: { key: { type: 'string', writeOnly: true, description: 'Shown once.' } } },
        ],
      },
      Record: { type: 'object', additionalProperties: true },
    },
  },
});
