import { fail } from './errors.js';

export const CATEGORIES = Object.freeze([
  'person', 'experience', 'goal', 'project', 'resource', 'relationship', 'preference',
]);
export const CUSTOM_FIELD_TYPES = Object.freeze([
  'text', 'longText', 'number', 'boolean', 'date', 'url', 'singleChoice',
]);

const CATEGORY_SET = new Set(CATEGORIES);
const FIELD_TYPE_SET = new Set(CUSTOM_FIELD_TYPES);
const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireObject(value, label = 'request body') {
  if (!isPlainObject(value)) fail(400, 'VALIDATION_ERROR', `${label} must be a JSON object.`);
  return value;
}

function jsonClone(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded);
  } catch {
    fail(400, 'VALIDATION_ERROR', `${label} must contain valid JSON values.`);
  }
}

export function validateCategory(category) {
  if (!CATEGORY_SET.has(category)) {
    fail(400, 'VALIDATION_ERROR', `category must be one of: ${CATEGORIES.join(', ')}.`);
  }
  return category;
}

export function validatePartialDate(value, label) {
  if (typeof value !== 'string') fail(400, 'VALIDATION_ERROR', `${label} must be a partial date.`);
  const match = PARTIAL_DATE.exec(value);
  if (!match) fail(400, 'VALIDATION_ERROR', `${label} must use YYYY, YYYY-MM, or YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12))) {
    fail(400, 'VALIDATION_ERROR', `${label} is not a valid partial date.`);
  }
  if (day !== undefined) {
    const maximum = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > maximum) fail(400, 'VALIDATION_ERROR', `${label} is not a valid date.`);
  }
  return value;
}

function dateFloor(value) {
  const [year, month = '01', day = '01'] = value.split('-');
  return `${year}-${month}-${day}`;
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    fail(400, 'VALIDATION_ERROR', `${label} must be a non-empty string.`);
  }
  return value;
}

function validateCategoryData(category, data) {
  requireObject(data, 'data');
  if (category === 'experience') {
    if (!['event', 'period'].includes(data.kind)) {
      fail(400, 'VALIDATION_ERROR', 'Experience data.kind must be event or period.');
    }
    validatePartialDate(data.startDate, 'Experience startDate');
    if (data.endDate !== undefined && data.endDate !== null && data.endDate !== '') {
      validatePartialDate(data.endDate, 'Experience endDate');
      if (dateFloor(data.endDate) < dateFloor(data.startDate)) {
        fail(400, 'VALIDATION_ERROR', 'Experience endDate cannot precede startDate.');
      }
    }
    if (data.kind === 'event' && data.endDate) {
      fail(400, 'VALIDATION_ERROR', 'An event cannot have an endDate; use a period.');
    }
    if (data.ongoing !== undefined && typeof data.ongoing !== 'boolean') {
      fail(400, 'VALIDATION_ERROR', 'Experience ongoing must be a boolean.');
    }
    if (data.ongoing === true && data.endDate) {
      fail(400, 'VALIDATION_ERROR', 'An ongoing experience cannot have an endDate.');
    }
  }
  if (category === 'goal') {
    if (!['short', 'middle', 'long'].includes(data.horizon)) {
      fail(400, 'VALIDATION_ERROR', 'Goal horizon must be short, middle, or long.');
    }
    if (!['planned', 'active', 'paused', 'completed', 'abandoned'].includes(data.status)) {
      fail(400, 'VALIDATION_ERROR', 'Goal status is invalid.');
    }
  }
  if (category === 'project') {
    const unexpected = Object.keys(data).filter((key) => !['context', 'currentState'].includes(key));
    if (unexpected.length) {
      fail(400, 'VALIDATION_ERROR', 'Project data supports only context and currentState.', { fields: unexpected });
    }
    requireString(data.context, 'Project context', { allowEmpty: true });
    requireString(data.currentState, 'Project currentState', { allowEmpty: true });
  }
  if (category === 'resource') {
    const forbidden = ['value', 'values', 'amount', 'currency', 'price', 'ledger', 'transactions'];
    const found = Object.keys(data).filter((key) => forbidden.includes(key.toLowerCase()));
    if (found.length) {
      fail(400, 'VALIDATION_ERROR', 'Resources are inventory records and cannot contain financial values or a ledger.', { fields: found });
    }
  }
  if (category === 'relationship' && !['person', 'org', 'organization'].includes(data.kind)) {
    fail(400, 'VALIDATION_ERROR', 'Relationship data.kind must be person or org.');
  }
  if (category === 'preference' && !Object.hasOwn(data, 'value')) {
    fail(400, 'VALIDATION_ERROR', 'Preference data.value is required.');
  }
}

export function normalizeRecord(input, existing = undefined) {
  requireObject(input);
  const category = existing?.category ?? validateCategory(input.category);
  if (existing && input.category !== undefined && input.category !== category) {
    fail(400, 'VALIDATION_ERROR', 'A record category cannot be changed.');
  }
  const title = input.title === undefined ? existing?.title : requireString(input.title, 'title');
  if (title === undefined) fail(400, 'VALIDATION_ERROR', 'title is required.');
  const data = input.data === undefined ? existing?.data : jsonClone(requireObject(input.data, 'data'), 'data');
  if (data === undefined) fail(400, 'VALIDATION_ERROR', 'data is required.');
  const customFieldValues = input.customFieldValues === undefined
    ? (existing?.customFieldValues ?? {})
    : jsonClone(requireObject(input.customFieldValues, 'customFieldValues'), 'customFieldValues');
  validateCategoryData(category, data);
  return { category, title, data, customFieldValues };
}

export function normalizeCustomField(input, existing = undefined) {
  requireObject(input);
  const category = input.category === undefined ? existing?.category : validateCategory(input.category);
  if (!category) fail(400, 'VALIDATION_ERROR', 'category is required.');
  if (existing && category !== existing.category) fail(400, 'VALIDATION_ERROR', 'A custom field category cannot be changed.');
  const type = input.type === undefined ? existing?.type : input.type;
  if (!FIELD_TYPE_SET.has(type)) {
    fail(400, 'VALIDATION_ERROR', `type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}.`);
  }
  const name = input.name === undefined ? existing?.name : requireString(input.name, 'name');
  if (!name) fail(400, 'VALIDATION_ERROR', 'name is required.');
  const options = input.options === undefined ? (existing?.options ?? []) : jsonClone(input.options, 'options');
  if (type === 'singleChoice') {
    if (!Array.isArray(options) || options.length === 0 || options.some((option) => typeof option !== 'string' || !option.trim())) {
      fail(400, 'VALIDATION_ERROR', 'singleChoice options must be a non-empty array of non-empty strings.');
    }
    if (new Set(options).size !== options.length) fail(400, 'VALIDATION_ERROR', 'singleChoice options must be unique.');
  } else if (!Array.isArray(options) || options.length !== 0) {
    fail(400, 'VALIDATION_ERROR', 'Only singleChoice fields can define options.');
  }
  return { category, type, name, options };
}

export function validateCustomFieldValue(definition, value) {
  if (value === null) return;
  let valid = false;
  if (definition.type === 'text' || definition.type === 'longText') valid = typeof value === 'string';
  if (definition.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  if (definition.type === 'boolean') valid = typeof value === 'boolean';
  if (definition.type === 'date') {
    try { validatePartialDate(value, definition.name); valid = true; } catch { valid = false; }
  }
  if (definition.type === 'url') {
    try { const url = new URL(value); valid = typeof value === 'string' && ['http:', 'https:'].includes(url.protocol); } catch { valid = false; }
  }
  if (definition.type === 'singleChoice') valid = definition.options.includes(value);
  if (!valid) fail(400, 'VALIDATION_ERROR', `Invalid value for custom field ${definition.name}.`);
}

export function normalizeLink(input, existing = undefined) {
  requireObject(input);
  const sourceId = input.sourceId ?? existing?.sourceId;
  const targetId = input.targetId ?? existing?.targetId;
  requireString(sourceId, 'sourceId');
  requireString(targetId, 'targetId');
  if (sourceId === targetId) fail(400, 'VALIDATION_ERROR', 'A record cannot link to itself.');
  const type = input.type === undefined ? (existing?.type ?? 'related') : requireString(input.type, 'type');
  const label = input.label === undefined ? (existing?.label ?? '') : requireString(input.label, 'label', { allowEmpty: true });
  const notes = input.notes === undefined ? (existing?.notes ?? '') : requireString(input.notes, 'notes', { allowEmpty: true });
  return { sourceId, targetId, type, label, notes };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requireRevision(value) {
  if (!Number.isInteger(value) || value < 1) fail(400, 'VALIDATION_ERROR', 'revision must be a positive integer.');
  return value;
}
