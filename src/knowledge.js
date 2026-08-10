import { fail } from './errors.js';

export const KNOWLEDGE_BRANCHES = Object.freeze([
  { id: 'subjects', name: 'Subjects', description: 'Objective and descriptive knowledge.' },
  { id: 'ideologies', name: 'Ideologies', description: 'Normative, interpretive, and value-dependent knowledge.' },
]);
export const KNOWLEDGE_STATUSES = Object.freeze(['unassessed', 'unknown', 'known']);
export const KNOWLEDGE_SEED_KEY = 'initial_taxonomy_v1';

export const INITIAL_KNOWLEDGE_TAXONOMY = Object.freeze({
  subjects: Object.freeze([
    'Agriculture and Food Systems', 'Anthropology', 'Arts and Design', 'Astronomy and Cosmology',
    'Biology', 'Business and Management', 'Chemistry', 'Cognitive Science', 'Communication and Media',
    'Computer Science', 'Earth Science', 'Economics', 'Education and Learning', 'Engineering',
    'Environmental Science', 'Finance and Accounting', 'Geography', 'History', 'Information Science',
    'Language and Linguistics', 'Law and Legal Systems', 'Literature', 'Logic and Formal Reasoning',
    'Mathematics', 'Medicine and Health', 'Music', 'Neuroscience', 'Physics', 'Political Science',
    'Psychology', 'Sociology', 'Statistics and Data Science', 'Technology',
  ]),
  ideologies: Object.freeze([
    'Aesthetics', 'Economic Thought', 'Environment and Nature', 'Epistemology', 'Ethics',
    'Existence and Meaning', 'Language and Meaning', 'Law and Justice', 'Metaphysics',
    'Mind and Consciousness', 'Personal Worldview', 'Politics', 'Reason and Argumentation',
    'Religion and Spirituality', 'Science and Knowledge', 'Society and Culture', 'Technology and Humanity',
  ]),
});

const BRANCH_SET = new Set(KNOWLEDGE_BRANCHES.map((branch) => branch.id));
const STATUS_SET = new Set(KNOWLEDGE_STATUSES);
const TERM_ID = /^[a-z][a-z0-9-]{0,63}$/;

function invalid(backup, code, message, details) {
  fail(400, backup ? 'INVALID_BACKUP' : code, message, details);
}

export function knowledgeId(value, label = 'id', { backup = false } = {}) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) invalid(backup, 'VALIDATION_ERROR', `${label} must be a positive integer.`);
  return id;
}

export function normalizeKnowledgeName(value, { backup = false } = {}) {
  if (typeof value !== 'string') invalid(backup, 'INVALID_NAME', 'Name must be text.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120) invalid(backup, 'INVALID_NAME', 'Name must contain between 1 and 120 characters.');
  return name;
}

export function normalizeKnowledgeBranch(value, { backup = false } = {}) {
  if (!BRANCH_SET.has(value)) invalid(backup, 'INVALID_BRANCH', 'Branch must be subjects or ideologies.');
  return value;
}

export function normalizeKnowledgeContent(status, understanding, terms, { backup = false } = {}) {
  if (!STATUS_SET.has(status)) invalid(backup, 'INVALID_STATUS', 'Status must be unassessed, unknown, or known.');
  let explanation = null;
  if (status === 'known') {
    if (typeof understanding !== 'string' || !understanding.trim()) {
      invalid(backup, 'UNDERSTANDING_REQUIRED', "A known node must include a direct explanation of the topic's essence.");
    }
    explanation = understanding.trim();
    if (explanation.length > 2000) invalid(backup, 'UNDERSTANDING_TOO_LONG', 'Explanation must be 2,000 characters or fewer.');
  }
  if (!Array.isArray(terms)) invalid(backup, 'INVALID_TERMS', 'Terms must be an array.');
  if (terms.length > 20) invalid(backup, 'TOO_MANY_TERMS', 'A node cannot contain more than 20 terms.');
  const ids = new Set();
  const normalizedTerms = terms.map((term) => {
    if (!term || typeof term !== 'object' || Array.isArray(term) ||
        Object.keys(term).sort().join(',') !== 'definition,id,label') {
      invalid(backup, 'INVALID_TERM', 'Each term must contain exactly id, label, and definition.');
    }
    if (typeof term.id !== 'string' || !TERM_ID.test(term.id)) {
      invalid(backup, 'INVALID_TERM_ID', 'Term ids must use lowercase letters, digits, or hyphens and begin with a letter.');
    }
    if (ids.has(term.id)) invalid(backup, 'DUPLICATE_TERM_ID', `Term id ${term.id} is defined more than once.`);
    ids.add(term.id);
    const label = typeof term.label === 'string' ? term.label.trim().replace(/\s+/g, ' ') : '';
    const definition = typeof term.definition === 'string' ? term.definition.trim().replace(/\s+/g, ' ') : '';
    if (!label || label.length > 80 || !definition || definition.length > 500) {
      invalid(backup, 'INVALID_TERM', 'Term labels and definitions must be non-empty and within their size limits.');
    }
    return { id: term.id, label, definition };
  });
  if (status !== 'known' && normalizedTerms.length) {
    invalid(backup, 'TERMS_REQUIRE_KNOWN_STATUS', 'Terms can be defined only on a known node.');
  }
  return { status, understanding: explanation, terms: normalizedTerms };
}

export function createInitialKnowledgeSnapshot(timestamp) {
  let id = 0;
  const nodes = Object.entries(INITIAL_KNOWLEDGE_TAXONOMY).flatMap(([branch, names]) => names.map((name) => ({
    id: ++id, name, branch, parentId: null, status: 'unassessed', understanding: null, terms: [],
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  })));
  return { nodes, connections: [], metadata: [{ key: KNOWLEDGE_SEED_KEY, value: timestamp }] };
}

export function validateKnowledgeSnapshot(value, { fallbackTimestamp } = {}) {
  if (value === undefined && fallbackTimestamp) return createInitialKnowledgeSnapshot(fallbackTimestamp);
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.connections) || !Array.isArray(value.metadata)) {
    fail(400, 'INVALID_BACKUP', 'Knowledge backup data is invalid.');
  }
  const ids = new Set();
  const nodes = value.nodes.map((node) => {
    const id = knowledgeId(node?.id, 'Knowledge node id', { backup: true });
    if (ids.has(id)) fail(400, 'INVALID_BACKUP', 'Knowledge nodes contain duplicate identifiers.');
    ids.add(id);
    const name = normalizeKnowledgeName(node?.name, { backup: true });
    const branch = normalizeKnowledgeBranch(node?.branch, { backup: true });
    const parentId = node?.parentId == null ? null : knowledgeId(node.parentId, 'Knowledge parent id', { backup: true });
    const content = normalizeKnowledgeContent(node?.status, node?.understanding, node?.terms, { backup: true });
    if (!Number.isSafeInteger(node?.revision) || node.revision < 1 || typeof node.createdAt !== 'string' || typeof node.updatedAt !== 'string') {
      fail(400, 'INVALID_BACKUP', 'A knowledge node has invalid structural metadata.');
    }
    return { id, name, branch, parentId, ...content, revision: node.revision,
      createdAt: node.createdAt, updatedAt: node.updatedAt };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const siblingNames = new Set();
  for (const node of nodes) {
    const siblingKey = `${node.branch}:${node.parentId ?? '<root>'}:${node.name.normalize('NFKC').toLocaleLowerCase('en-US')}`;
    if (siblingNames.has(siblingKey)) fail(400, 'INVALID_BACKUP', 'Knowledge sibling names must be unique.');
    siblingNames.add(siblingKey);
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (!parent || parent.branch !== node.branch || parent.status !== 'known') {
        fail(400, 'INVALID_BACKUP', 'A knowledge node has an invalid or non-known parent.');
      }
      const seen = new Set([node.id]);
      let cursor = parent;
      while (cursor) {
        if (seen.has(cursor.id)) fail(400, 'INVALID_BACKUP', 'The knowledge hierarchy contains a cycle.');
        seen.add(cursor.id);
        cursor = cursor.parentId === null ? null : byId.get(cursor.parentId);
      }
    }
  }
  for (const node of nodes) {
    if (node.status !== 'known' && nodes.some((candidate) => candidate.parentId === node.id)) {
      fail(400, 'INVALID_BACKUP', 'A knowledge node with children must be known.');
    }
  }
  const connectionIds = new Set();
  const pairs = new Set();
  const connections = value.connections.map((connection) => {
    const id = knowledgeId(connection?.id, 'Knowledge connection id', { backup: true });
    const sourceId = knowledgeId(connection?.sourceId, 'Knowledge connection source', { backup: true });
    const targetId = knowledgeId(connection?.targetId, 'Knowledge connection target', { backup: true });
    if (connectionIds.has(id) || !ids.has(sourceId) || !ids.has(targetId) || sourceId >= targetId ||
        typeof connection.createdAt !== 'string') fail(400, 'INVALID_BACKUP', 'A knowledge connection is invalid.');
    const pair = `${sourceId}:${targetId}`;
    if (pairs.has(pair)) fail(400, 'INVALID_BACKUP', 'Knowledge connections contain duplicate endpoints.');
    connectionIds.add(id); pairs.add(pair);
    return { id, sourceId, targetId, createdAt: connection.createdAt };
  });
  const metadataKeys = new Set();
  const metadata = value.metadata.map((entry) => {
    if (!entry || typeof entry.key !== 'string' || !entry.key || typeof entry.value !== 'string' || metadataKeys.has(entry.key)) {
      fail(400, 'INVALID_BACKUP', 'Knowledge metadata is invalid.');
    }
    metadataKeys.add(entry.key);
    return { key: entry.key, value: entry.value };
  });
  const depths = new Map();
  const depthOf = (node) => {
    if (depths.has(node.id)) return depths.get(node.id);
    const depth = node.parentId === null ? 0 : depthOf(byId.get(node.parentId)) + 1;
    depths.set(node.id, depth);
    return depth;
  };
  nodes.sort((left, right) => depthOf(left) - depthOf(right) || left.id - right.id);
  return { nodes, connections, metadata };
}
