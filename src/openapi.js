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
  required: ['id', 'title', 'description', 'importance', 'target_date', 'subgoals'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    importance: { type: 'string', enum: ['low', 'medium', 'high'] },
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
  required: ['title', 'description', 'github_link'],
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
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
        responses: { 200: jsonResponse('OpenAPI 3.1 document.', { type: 'object' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/guide': {
      get: secured({
        operationId: 'get_agent_guide',
        tags: ['Discovery'],
        summary: 'Get agent privacy and response semantics',
        responses: { 200: jsonResponse('Machine-readable agent guide.', { $ref: '#/components/schemas/AgentGuide' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/tools': {
      get: secured({
        operationId: 'list_agent_tools',
        tags: ['Discovery'],
        summary: 'List authenticated agent operations',
        responses: { 200: jsonResponse('Agent discovery catalog.', { $ref: '#/components/schemas/AgentToolCatalog' }), 401: errorResponse, 423: errorResponse },
      }),
    },
    '/api/agent/get_personal_info': {
      post: secured({
        operationId: 'get_personal_info',
        tags: ['Agent'],
        summary: 'Return non-sensitive personal information',
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
  name: { type: 'string', maxLength: 120 },
  branch: { type: 'string', enum: ['subjects', 'ideologies'] },
  parentId: { type: ['integer', 'null'], minimum: 1 },
  status: { type: 'string', enum: ['unassessed', 'unknown', 'known'] },
  understanding: { type: ['string', 'null'], maxLength: 2000 },
  terms: { type: 'array', maxItems: 20, items: { $ref: '#/components/schemas/KnowledgeTermInput' } },
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
        responses: {
          200: jsonResponse('Subjects and Ideologies with recursive children.', { $ref: '#/components/schemas/KnowledgeTreeResponse' }),
          423: errorResponse,
        },
      },
    },
    '/api/knowledge/nodes': {
      get: {
        operationId: 'list_knowledge_nodes', tags: ['Knowledge'], summary: 'List all Knowledge nodes alphabetically',
        responses: {
          200: jsonResponse('Flat Knowledge node list.', { $ref: '#/components/schemas/KnowledgeNodesResponse' }),
          423: errorResponse,
        },
      },
      post: {
        operationId: 'create_knowledge_node', tags: ['Knowledge'], summary: 'Create a Knowledge node',
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
        responses: {
          200: jsonResponse('Knowledge node detail.', { $ref: '#/components/schemas/KnowledgeNodeResponse' }),
          404: errorResponse, 423: errorResponse,
        },
      },
      patch: {
        operationId: 'patch_knowledge_node', tags: ['Knowledge'], summary: 'Edit or move a Knowledge node',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/PatchKnowledgeNode' } } } },
        responses: {
          200: jsonResponse('Updated node detail.', { $ref: '#/components/schemas/KnowledgeNodeResponse' }),
          400: errorResponse, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
      delete: {
        operationId: 'delete_knowledge_node', tags: ['Knowledge'], summary: 'Delete a leaf Knowledge node',
        responses: {
          204: { description: 'Node deleted.' }, 404: errorResponse, 409: errorResponse, 423: errorResponse,
        },
      },
    },
    '/api/knowledge/connections': {
      post: {
        operationId: 'create_knowledge_connection', tags: ['Knowledge connections'], summary: 'Create an undirected node connection',
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
        responses: { 204: { description: 'Connection deleted.' }, 404: errorResponse, 423: errorResponse },
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
          id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
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
