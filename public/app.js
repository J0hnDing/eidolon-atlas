"use strict";

const CATEGORIES = {
  person: { label: "Person", plural: "Person", icon: "person", accent: "#9b583b", eyebrow: "Identity & context", description: "Your profile: the person at the center of this private atlas." },
  experience: { label: "Experience", plural: "Experiences", icon: "spark", accent: "#806149", eyebrow: "A lived timeline", description: "Moments, seasons, places, and chapters worth remembering." },
  goal: { label: "Goal", plural: "Goals", icon: "compass", accent: "#667763", eyebrow: "Direction & intent", description: "Outcomes arranged by horizon, with small steps nested beneath them." },
  project: { label: "Project", plural: "Projects", icon: "layers", accent: "#6c6f85", eyebrow: "Work in motion", description: "A clear inventory of what you are making and its present state." },
  resource: { label: "Resource", plural: "Resources", icon: "bookmark", accent: "#8b704c", eyebrow: "Assets & capacity", description: "Wealth, capital, assets, accounts, capabilities, and other resources you can draw on." },
  relationship: { label: "Relationship", plural: "Relationships", icon: "link", accent: "#8b5f6a", eyebrow: "People & organizations", description: "The connections that shape your personal and professional world." },
  preference: { label: "Preference", plural: "Preferences", icon: "sliders", accent: "#5d7774", eyebrow: "Taste & defaults", description: "Choices, boundaries, and defaults you want to remember." }
};

const FIELD_DEFS = {
  person: [
    ["title", "Name", "text", true, "Your name"],
    ["summary", "Summary", "textarea", false, "A concise portrait, in your own words"],
    ["contact", "Contact details", "textarea", false, "One item per line"],
    ["address", "Address", "textarea", false, "A current address or concise address history"],
    ["status", "Current status", "textarea", false, "Roles, seasons, or other date-bounded statuses"]
  ],
  experience: [
    ["title", "Experience", "text", true, "What happened or what was this chapter?"],
    ["kind", "Kind", "select", true, "", [["event", "Event"], ["period", "Period"]]],
    ["startDate", "Start date", "partial", true, "YYYY, YYYY-MM, or YYYY-MM-DD"],
    ["endDate", "End date", "partial", false, "Leave empty if ongoing"],
    ["ongoing", "Ongoing", "checkbox", false, "This period is still unfolding"],
    ["location", "Location", "text", false, "Where it unfolded"],
    ["narrative", "Narrative", "textarea", false, "What made it meaningful?"]
  ],
  goal: [
    ["title", "Goal", "text", true, "A clear desired outcome"],
    ["horizon", "Horizon", "select", true, "", [["short", "Short term"], ["middle", "Middle term"], ["long", "Long term"]]],
    ["status", "Status", "select", true, "", [["planned", "Planned"], ["active", "Active"], ["paused", "Paused"], ["completed", "Completed"], ["abandoned", "Abandoned"]]],
    ["targetDate", "Target date", "partial", false, "YYYY, YYYY-MM, or YYYY-MM-DD"],
    ["progressNote", "Progress note", "textarea", false, "A concise, current progress marker"],
    ["motivation", "Motivation", "textarea", false, "Why this outcome matters"]
  ],
  project: [
    ["title", "Project", "text", true, "What are you making?"],
    ["context", "Context", "textarea", false, "Purpose, desired outcome, and the context worth preserving"],
    ["currentState", "Current state", "textarea", false, "A brief, current snapshot—not a task list"],
  ],
  resource: [
    ["title", "Resource", "text", true, "Name or title"],
    ["kind", "Kind", "select", true, "", [["wealth", "Wealth"], ["capital", "Capital"], ["asset", "Asset"], ["liability", "Liability"], ["account", "Account"], ["capability", "Capability"], ["other", "Other"]]],
    ["ownership", "Ownership", "text", false, "Owned, shared, borrowed, or another arrangement"],
    ["access", "Access", "text", false, "Where or how it can be accessed"],
    ["availability", "Availability", "select", false, "", [["available", "Available"], ["limited", "Limited"], ["unavailable", "Unavailable"]]],
    ["quantity", "Quantity", "number", false, "Count only—never a valuation"],
    ["unit", "Unit", "text", false, "Items, hours, seats, and so on"],
    ["notes", "Notes", "textarea", false, "Why it is useful"]
  ],
  relationship: [
    ["title", "Name", "text", true, "Person or organization"],
    ["kind", "Kind", "select", true, "", [["person", "Person"], ["org", "Organization"]]],
    ["relationshipType", "Relationship type", "text", false, "How you are connected"],
    ["status", "Status", "select", false, "", [["active", "Active"], ["dormant", "Dormant"], ["past", "Past"]]],
    ["importance", "Importance", "select", false, "", [["low", "Low"], ["medium", "Medium"], ["high", "High"]]],
    ["startDate", "Started", "partial", false, "YYYY, YYYY-MM, or YYYY-MM-DD"],
    ["endDate", "Ended", "partial", false, "YYYY, YYYY-MM, or YYYY-MM-DD"],
    ["contact", "Contact details", "textarea", false, "Useful contact context"],
    ["notes", "Context", "textarea", false, "Useful relationship context"]
  ],
  preference: [
    ["title", "Preference", "text", true, "A memorable label"],
    ["domain", "Area", "select", false, "", [["work", "Work"], ["communication", "Communication"], ["environment", "Environment"], ["food", "Food"], ["style", "Style"], ["other", "Other"]]],
    ["value", "Preferred choice", "text", true, "What works best"],
    ["strength", "Strength", "select", false, "", [["slight", "Slight"], ["moderate", "Moderate"], ["strong", "Strong"]]],
    ["context", "When it applies", "text", false, "Situation or boundary"],
    ["rationale", "Rationale", "textarea", false, "Nuance, reasons, or exceptions"],
    ["effectiveFrom", "Effective from", "partial", false, "YYYY, YYYY-MM, or YYYY-MM-DD"],
    ["effectiveTo", "Effective to", "partial", false, "YYYY, YYYY-MM, or YYYY-MM-DD"]
  ]
};

const FILTERS = {
  goal: ["all", "planned", "active", "paused", "completed", "abandoned"],
  resource: ["all", "available", "limited", "unavailable"],
  relationship: ["all", "person", "org"],
  preference: ["all", "work", "communication", "environment", "food", "style", "other"]
};

const ICONS = {
  archive: ["M4 7h16", "M5 7v12h14V7", "M3 3h18v4H3z", "M9 11h6"],
  bookmark: ["M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.7L6 21z"],
  check: ["m5 12 4 4L19 6"],
  chevron: ["m9 18 6-6-6-6"],
  close: ["M6 6l12 12M18 6 6 18"],
  compass: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "m15.5 8.5-2 5-5 2 2-5z"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z"],
  grid: ["M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"],
  history: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  key: ["M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1Zm0 0L15 8l3 3 3-3-3-3"],
  layers: ["m12 2 9 5-9 5-9-5z", "m3 12 9 5 9-5", "m3 17 9 5 9-5"],
  link: ["M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1", "M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1"],
  list: ["M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"],
  lock: ["M6 10h12v11H6z", "M8 10V7a4 4 0 0 1 8 0v3", "M12 14v3"],
  menu: ["M4 7h16M4 12h16M4 17h16"],
  person: ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"],
  plus: ["M12 5v14M5 12h14"],
  restore: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  search: ["m21 21-4.35-4.35", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z", "m9 12 2 2 4-5"],
  sliders: ["M4 6h7M15 6h5M4 12h3M11 12h9M4 18h9M17 18h3", "M11 4v4M7 10v4M13 16v4"],
  spark: ["m12 3 1.2 4.3L17 9l-3.8 1.7L12 15l-1.2-4.3L7 9l3.8-1.7z", "M5 17l.6 2.4L8 20l-2.4.6L5 23l-.6-2.4L2 20l2.4-.6zM19 3l.5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5l1.5-.5z"],
  trash: ["M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"],
  unlock: ["M6 10h12v11H6z", "M8 10V7a4 4 0 0 1 7.5-2", "M12 14v3"],
  upload: ["M12 16V4m-4 4 4-4 4 4", "M4 15v5h16v-5"]
};

const state = {
  category: "person",
  records: [],
  allRecords: [],
  customFields: [],
  customFieldsCategory: null,
  selected: null,
  editing: null,
  filter: "all",
  view: "cards",
  query: "",
  trash: false,
  loading: false,
  loadToken: 0
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function icon(name, label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", label ? "false" : "true");
  if (label) {
    svg.setAttribute("role", "img");
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = label;
    svg.append(title);
  }
  (ICONS[name] || ICONS.spark).forEach((d) => {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  return svg;
}

function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((node) => {
    const name = node.dataset.icon;
    if (!node.querySelector("svg")) node.prepend(icon(name));
  });
}

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (value == null) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.entries(value).forEach(([k, v]) => { node.dataset[k] = String(v); });
    else if (key === "style") Object.entries(value).forEach(([k, v]) => node.style.setProperty(k, v));
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== "form") node[key] = value;
    else node.setAttribute(key, String(value));
  });
  const list = Array.isArray(children) ? children : [children];
  list.filter((child) => child != null).forEach((child) => node.append(child.nodeType ? child : document.createTextNode(String(child))));
  return node;
}

function errorMessage(payload, fallback) {
  if (typeof payload === "string" && payload.trim()) return payload;
  return payload?.error?.message || payload?.error || payload?.message || fallback;
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: { Accept: "application/json" } };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, init);
  const type = response.headers.get("content-type") || "";
  let payload = null;
  if (response.status !== 204) {
    try { payload = type.includes("json") ? await response.json() : await response.text(); }
    catch { payload = null; }
  }
  if (!response.ok) {
    const error = new Error(errorMessage(payload, `Request failed (${response.status})`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function listPayload(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function recordPayload(payload) { return payload?.record || payload; }
function recordTitle(record) { return record?.title || "Untitled entry"; }
function recordSummary(record) {
  const data = record?.data || {};
  return data.summary || data.narrative || data.currentState || data.context || data.progressNote || data.motivation || data.notes || data.value || data.relationshipType || data.location || "";
}

function friendly(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatDate(value) {
  if (!value) return "Not set";
  const raw = String(value);
  if (/^\d{4}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const [year, month] = raw.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${raw}T00:00:00Z`));
  }
  return raw;
}

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function notify(message, kind = "info") {
  const notice = element("div", { class: `notice ${kind}`, role: "status" }, [icon(kind === "error" ? "close" : "check"), element("span", { text: message })]);
  $("#notice-region").append(notice);
  window.setTimeout(() => notice.remove(), 4600);
}

function setButtonBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.original || button.textContent;
    button.disabled = false;
  }
}

function showAuth(mode) {
  $("#app").hidden = true;
  $("#auth-view").hidden = false;
  const setup = mode === "setup";
  $("#setup-form").hidden = !setup;
  $("#unlock-form").hidden = setup;
  $("#auth-title").textContent = setup ? "Begin your private atlas" : "Welcome back";
  $("#auth-intro").textContent = setup
    ? "Create the passphrase that protects everything you place here. Your atlas stays private and opens only for you."
    : "Your atlas is locked. Enter your passphrase to return to it.";
  window.setTimeout(() => $(setup ? "#setup-form input" : "#unlock-form input")?.focus(), 50);
}

async function initialize() {
  hydrateIcons();
  buildNavigation();
  wireEvents();
  renderSkeleton();
  try {
    const status = await api("/status");
    if (!status?.initialized) showAuth("setup");
    else if (status.locked !== false) showAuth("unlock");
    else await enterAtlas();
  } catch (error) {
    showAuth("unlock");
    notify(`The atlas service could not be reached. ${error.message}`, "error");
  }
}

async function enterAtlas({ prompt = false } = {}) {
  $("#auth-view").hidden = true;
  $("#app").hidden = false;
  await Promise.all([refreshCounts(), loadCategory()]);
  if (prompt) openPromptDialog();
}

function buildNavigation() {
  const nav = $("#category-nav");
  Object.entries(CATEGORIES).forEach(([key, category]) => {
    const button = element("button", { class: "nav-row", type: "button", dataset: { category: key }, onclick: () => chooseCategory(key) }, [
      icon(category.icon), element("span", { text: category.plural }), element("span", { class: "count-pill", text: "0", dataset: { count: key } })
    ]);
    nav.append(button);
  });
  const categorySelect = $("#field-form select[name='category']");
  Object.entries(CATEGORIES).forEach(([value, meta]) => categorySelect.append(element("option", { value, text: meta.label })));
}

async function refreshCounts() {
  try {
    const [activePayload, trashPayload] = await Promise.all([api("/records?trashed=false"), api("/records?trashed=true")]);
    state.allRecords = listPayload(activePayload, "records");
    const counts = Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, 0]));
    state.allRecords.forEach((record) => { if (record.category in counts) counts[record.category] += 1; });
    Object.entries(counts).forEach(([key, count]) => { const node = $(`[data-count="${key}"]`); if (node) node.textContent = String(count); });
    $("#trash-count").textContent = String(listPayload(trashPayload, "records").length);
  } catch (error) {
    if (error.status === 401 || error.status === 423) return lockLocally();
  }
}

async function chooseCategory(category) {
  state.category = category;
  state.trash = false;
  state.query = "";
  state.filter = "all";
  $("#global-search").value = "";
  closeSidebar();
  closeDetail();
  await loadCategory();
}

function updateHeading() {
  const meta = CATEGORIES[state.category];
  $("#view-eyebrow").textContent = state.trash ? "Recover or remove" : state.query ? "Across every workspace" : meta.eyebrow;
  $("#view-title").textContent = state.trash ? "Recently removed" : state.query ? "Search results" : meta.plural;
  $("#view-description").textContent = state.trash ? "Entries remain encrypted and can be restored here." : state.query ? `Matches for “${state.query}”` : meta.description;
  $("#new-record").hidden = state.trash || Boolean(state.query);
  $("#new-record-top").hidden = state.trash;
  $$(".category-nav .nav-row").forEach((button) => button.classList.toggle("active", !state.trash && !state.query && button.dataset.category === state.category));
  $("#trash-button").classList.toggle("active", state.trash);
  const canToggle = !state.trash && !state.query && !["experience", "goal", "person"].includes(state.category);
  $("#view-toggle").hidden = !canToggle;
  $$("#view-toggle button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  renderFilters();
}

function renderFilters() {
  const bar = $("#filter-bar");
  bar.replaceChildren();
  const choices = state.trash || state.query ? [] : FILTERS[state.category] || [];
  choices.forEach((value) => {
    bar.append(element("button", { class: `filter-chip${state.filter === value ? " active" : ""}`, type: "button", text: friendly(value), onclick: () => { state.filter = value; renderRecords(); renderFilters(); } }));
  });
}

function renderSkeleton() {
  const stage = $("#content-stage");
  stage.replaceChildren(element("div", { class: "skeleton-grid", "aria-label": "Loading entries" }, [element("div", { class: "skeleton" }), element("div", { class: "skeleton" }), element("div", { class: "skeleton" })]));
}

async function loadCategory() {
  const token = ++state.loadToken;
  state.loading = true;
  updateHeading();
  renderSkeleton();
  const params = new URLSearchParams();
  if (!state.trash && !state.query) params.set("category", state.category);
  if (state.query) params.set("q", state.query);
  params.set("trashed", String(state.trash));
  try {
    const [recordsPayload, fieldsPayload] = await Promise.all([
      api(`/records?${params}`),
      state.trash || state.query ? Promise.resolve([]) : api(`/custom-fields?category=${encodeURIComponent(state.category)}`)
    ]);
    if (token !== state.loadToken) return;
    state.records = listPayload(recordsPayload, "records");
    state.customFields = listPayload(fieldsPayload, "customFields").filter((field) => field.category === state.category);
    state.customFieldsCategory = state.trash || state.query ? null : state.category;
    renderRecords();
  } catch (error) {
    if (error.status === 401 || error.status === 423) return lockLocally();
    renderFailure(error);
  } finally { if (token === state.loadToken) state.loading = false; }
}

function filteredRecords() {
  if (state.filter === "all" || state.trash || state.query) return state.records;
  const key = state.category === "relationship" ? "kind" : state.category === "preference" ? "domain" : state.category === "resource" ? "availability" : "status";
  return state.records.filter((record) => record.data?.[key] === state.filter);
}

function renderRecords() {
  const stage = $("#content-stage");
  stage.replaceChildren();
  const records = filteredRecords();
  const personExists = !state.trash && !state.query && state.category === "person" && records.length > 0;
  $("#new-record").hidden = state.trash || Boolean(state.query) || personExists;
  $("#new-record-top").hidden = state.trash || personExists;
  if (!records.length) return stage.append(renderEmpty());
  if (state.trash || state.query) return stage.append(renderStandard(records, "list"));
  if (state.category === "experience") stage.append(renderTimeline(records));
  else if (state.category === "goal") stage.append(renderGoals(records));
  else if (state.category === "person") stage.append(renderPeople(records));
  else stage.append(renderStandard(records, state.view));
}

function renderEmpty() {
  const searched = Boolean(state.query);
  const title = state.trash ? "Nothing waiting here" : searched ? "No matching markers" : `Begin your ${CATEGORIES[state.category].label.toLowerCase()} workspace`;
  const copy = state.trash ? "Removed entries will appear here until you restore them." : searched ? "Try a shorter phrase or another word." : "Your atlas grows one thoughtful entry at a time.";
  const contents = [element("div", { class: "empty-orbit" }, icon(searched ? "search" : state.trash ? "trash" : CATEGORIES[state.category].icon)), element("h2", { text: title }), element("p", { text: copy })];
  if (!state.trash && !searched) contents.push(element("button", { class: "button button-primary", type: "button", onclick: () => openRecordDialog() }, [icon("plus"), "Add the first entry"]));
  return element("section", { class: "empty-state" }, element("div", {}, contents));
}

function renderFailure(error) {
  const stage = $("#content-stage");
  stage.replaceChildren(element("section", { class: "empty-state" }, element("div", {}, [
    element("div", { class: "empty-orbit" }, icon("close")), element("h2", { text: "This view could not be opened" }), element("p", { text: error.message }), element("button", { class: "button button-secondary", type: "button", text: "Try again", onclick: loadCategory })
  ])));
}

function openRecordButton(record) {
  return element("button", { type: "button", "aria-label": `Open ${recordTitle(record)}`, onclick: () => openDetail(record.id) });
}

function renderStandard(records, mode) {
  const root = element("div", { class: mode === "list" ? "record-list" : "card-grid" });
  records.forEach((record, index) => {
    const meta = CATEGORIES[record.category] || CATEGORIES.resource;
    if (mode === "list") {
      root.append(element("article", { class: "record-row", style: { "--animation-order": index } }, [
        element("div", { class: "category-symbol", style: { "--record-accent": meta.accent } }, icon(meta.icon)),
        element("div", {}, [element("h3", { text: recordTitle(record) }), element("div", { class: "row-meta", text: `${meta.label} · ${recordSummary(record) || formatTimestamp(record.updatedAt)}` })]),
        icon("chevron"), openRecordButton(record)
      ]));
    } else {
      root.append(element("article", { class: "record-card", style: { "--record-accent": meta.accent, "animation-delay": `${Math.min(index, 12) * 24}ms` } }, [
        element("div", { class: "card-top" }, [element("div", { class: "category-symbol" }, icon(meta.icon)), element("span", { class: "eyebrow", text: meta.label })]),
        element("h3", { text: recordTitle(record) }), element("p", { class: "card-summary", text: recordSummary(record) || "No notes yet." }),
        element("div", { class: "card-meta" }, [element("span", { text: record.data?.status ? friendly(record.data.status) : `Revision ${record.revision || 1}` }), element("span", { class: "dot" }), element("span", { text: formatTimestamp(record.updatedAt) })]),
        openRecordButton(record)
      ]));
    }
  });
  return root;
}

function renderTimeline(records) {
  const sorted = [...records].sort((a, b) => String(b.data?.startDate || b.createdAt || "").localeCompare(String(a.data?.startDate || a.createdAt || "")));
  const groups = new Map();
  sorted.forEach((record) => {
    const key = String(record.data?.startDate || "Undated").slice(0, 4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  const root = element("div", { class: "timeline" });
  groups.forEach((items, year) => {
    const group = element("section", { class: "timeline-group" }, element("h2", { class: "timeline-year", text: /^\d{4}$/.test(year) ? year : "Undated" }));
    items.forEach((record, index) => group.append(element("article", { class: "timeline-card", style: { "animation-delay": `${index * 30}ms` } }, [
      element("span", { class: "timeline-date", text: [formatDate(record.data?.startDate), record.data?.ongoing ? "Ongoing" : record.data?.endDate ? formatDate(record.data.endDate) : ""].filter(Boolean).join(" — ") }),
      element("h3", { text: recordTitle(record) }), element("p", { text: recordSummary(record) || record.data?.location || "No narrative yet." }), openRecordButton(record)
    ])));
    root.append(group);
  });
  return root;
}

function renderGoals(records) {
  const horizons = [["short", "Short term"], ["middle", "Middle term"], ["long", "Long term"]];
  const root = element("div", { class: "goal-board" });
  horizons.forEach(([value, label]) => {
    const inHorizon = records.filter((record) => (record.data?.horizon || "middle") === value);
    const roots = inHorizon.filter((record) => !record.parentId).sort((a,b) => (a.position || 0) - (b.position || 0));
    const column = element("section", { class: "goal-column" }, element("header", { class: "goal-column-head" }, [element("h2", { text: label }), element("span", { text: `${inHorizon.length} ${inHorizon.length === 1 ? "goal" : "goals"}` })]));
    const stack = element("div", { class: "goal-stack" });
    roots.forEach((record, index) => {
      const cardChildren = [element("h3", { text: recordTitle(record) }), element("p", { text: recordSummary(record) || friendly(record.data?.status || "active") })];
      const descendants = renderGoalDescendants(record.id, records);
      if (descendants) cardChildren.push(descendants);
      cardChildren.push(openRecordButton(record));
      stack.append(element("article", { class: "goal-card", style: { "animation-delay": `${index * 30}ms` } }, cardChildren));
    });
    if (!roots.length) stack.append(element("p", { class: "detail-empty", text: "No goals on this horizon." }));
    column.append(stack);
    root.append(column);
  });
  return root;
}

function renderGoalDescendants(parentId, records) {
  const children = records.filter((item) => item.parentId === parentId).sort((a,b) => (a.position || 0) - (b.position || 0));
  if (!children.length) return null;
  return element("div", { class: "subgoals" }, children.map((child) => {
    const nested = renderGoalDescendants(child.id, records);
    return element("div", { class: "subgoal-node" }, [
      element("button", { class: "subgoal", type: "button", text: recordTitle(child), onclick: () => openDetail(child.id) }),
      nested,
    ]);
  }));
}

function renderPeople(records) {
  if (records.length === 1) {
    const record = records[0];
    return element("div", { class: "profile-layout" }, [profileHero(record), element("div", { class: "profile-stack" }, [
      element("article", { class: "mini-card" }, [element("h3", { text: "Current status" }), element("p", { text: record.data?.status || "Not added yet" }), openRecordButton(record)]),
      element("article", { class: "mini-card" }, [element("h3", { text: "Contact" }), element("p", { text: record.data?.contact || "Not added yet" }), openRecordButton(record)])
    ])]);
  }
  const [first, ...rest] = records;
  return element("div", { class: "profile-layout" }, [profileHero(first), element("div", { class: "profile-stack" }, rest.map((record) => element("article", { class: "mini-card" }, [element("h3", { text: recordTitle(record) }), element("p", { text: recordSummary(record) || record.data?.location || "No portrait yet." }), openRecordButton(record)]))) ]);
}

function profileHero(record) {
  return element("article", { class: "profile-card" }, [
    element("div", { class: "profile-monogram", text: recordTitle(record).trim().charAt(0).toUpperCase() || "?" }),
    element("h2", { text: recordTitle(record) }),
    element("p", { text: recordSummary(record) || "A portrait can be as sparse or as detailed as you like." }),
    openRecordButton(record)
  ]);
}

async function openDetail(id) {
  try {
    const payload = await api(`/records/${encodeURIComponent(id)}`);
    state.selected = recordPayload(payload);
    if (state.customFieldsCategory !== state.selected.category) {
      const fieldsPayload = await api(`/custom-fields?category=${encodeURIComponent(state.selected.category)}`);
      state.customFields = listPayload(fieldsPayload, "customFields").filter((field) => field.category === state.selected.category);
      state.customFieldsCategory = state.selected.category;
    }
    renderDetail(state.selected);
    $("#detail-pane").classList.add("open");
    $("#detail-pane").setAttribute("aria-hidden", "false");
    $(".workspace").classList.add("detail-open");
    window.setTimeout(() => $("#close-detail").focus(), 50);
  } catch (error) { notify(error.message, "error"); }
}

function closeDetail() {
  state.selected = null;
  $("#detail-pane").classList.remove("open");
  $("#detail-pane").setAttribute("aria-hidden", "true");
  $(".workspace").classList.remove("detail-open");
}

function renderDetail(record) {
  const root = $("#detail-content");
  root.replaceChildren();
  const meta = CATEGORIES[record.category] || CATEGORIES.resource;
  if (record.trashed || record.deletedAt) root.append(element("div", { class: "removed-banner" }, [icon("trash"), element("span", { text: "This entry is in recently removed." })]));
  root.append(element("div", { class: "detail-category" }, [icon(meta.icon), meta.label]));
  const title = element("h2", { id: "detail-title", text: recordTitle(record) });
  root.append(title, element("p", { class: "detail-lede", text: recordSummary(record) || "No description yet." }));
  const properties = element("dl", { class: "property-list" });
  const summaryKey = {
    person: "summary", experience: "narrative", goal: record.data?.progressNote ? "progressNote" : "motivation",
    project: record.data?.currentState ? "currentState" : "context", resource: "notes",
    relationship: record.data?.notes ? "notes" : "relationshipType", preference: "value"
  }[record.category];
  const skipped = new Set([summaryKey]);
  (FIELD_DEFS[record.category] || []).forEach(([key, label, type]) => {
    const value = record.data?.[key];
    if (!value || skipped.has(key)) return;
    properties.append(element("dt", { text: label }), element("dd", { text: type === "partial" ? formatDate(value) : friendly(value) }));
  });
  properties.append(element("dt", { text: "Updated" }), element("dd", { text: formatTimestamp(record.updatedAt) }), element("dt", { text: "Revision" }), element("dd", { text: String(record.revision || 1) }));
  root.append(detailSection("Details", null, properties));

  const customList = element("dl", { class: "property-list" });
  const customValues = record.customFieldValues || {};
  state.customFields.forEach((field) => {
    const value = customValues[field.id];
    if (value === undefined || value === "") return;
    customList.append(element("dt", { text: field.name }), element("dd", { text: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) }));
  });
  if (!customList.childNodes.length) customList.append(element("p", { class: "detail-empty", text: "No custom values on this entry." }));
  root.append(detailSection("Custom fields", element("button", { class: "text-button", type: "button", text: "Add field", onclick: openFieldDialog }), customList));

  const linked = element("div", { class: "linked-list" });
  const links = [...(record.links || []).map((link) => ({ ...link, direction: "out" })), ...(record.backlinks || []).map((link) => ({ ...link, direction: "in" }))];
  if (!links.length) linked.append(element("p", { class: "detail-empty", text: "No cross-links yet." }));
  links.forEach((link) => {
    const targetId = link.direction === "out" ? link.targetId : link.sourceId;
    const target = link.target || link.source || state.allRecords.find((item) => item.id === targetId);
    linked.append(element("div", { class: "linked-item" }, [
      element("span", {}, icon("link")), element("div", { class: "linked-copy" }, [element("strong", { text: target ? recordTitle(target) : "Linked entry" }), element("small", { text: `${link.direction === "in" ? "Linked here" : "Links to"}${link.label ? ` · ${link.label}` : ""}` })]),
      targetId ? element("button", { class: "icon-button", type: "button", "aria-label": "Open linked entry", onclick: () => openDetail(targetId) }, icon("chevron")) : null
    ]));
  });
  root.append(detailSection("Cross-links", element("button", { class: "text-button", type: "button", text: "Add link", onclick: openLinkDialog }), linked));

  const revisions = element("div", { class: "revision-list", id: "revision-list" }, element("p", { class: "detail-empty", text: "Loading history…" }));
  root.append(detailSection("Revision history", null, revisions));
  loadRevisions(record.id, revisions);

  const removed = Boolean(record.trashed || record.deletedAt);
  $("#detail-edit").hidden = removed;
  $("#detail-remove").replaceChildren(icon(removed ? "restore" : "trash"));
  $("#detail-remove").setAttribute("aria-label", removed ? "Restore entry" : "Move to recently removed");
}

function detailSection(title, action, content) {
  return element("section", { class: "detail-section" }, [element("header", { class: "detail-section-head" }, [element("h3", { text: title }), action]), content]);
}

async function loadRevisions(id, root) {
  try {
    const payload = await api(`/records/${encodeURIComponent(id)}/revisions`);
    const revisions = listPayload(payload, "revisions");
    root.replaceChildren();
    if (!revisions.length) return root.append(element("p", { class: "detail-empty", text: "No earlier revisions." }));
    revisions.forEach((revision) => root.append(element("div", { class: "revision-item" }, [
      icon("history"), element("div", {}, [element("strong", { text: `Revision ${revision.revision}` }), element("small", { text: formatTimestamp(revision.createdAt || revision.updatedAt) })]),
      revision.revision !== state.selected?.revision ? element("button", { class: "text-button", type: "button", text: "Restore", onclick: () => restoreRevision(revision.revision) }) : element("small", { text: "Current" })
    ])));
  } catch (error) { root.replaceChildren(element("p", { class: "detail-empty", text: `History unavailable: ${error.message}` })); }
}

async function restoreRevision(revision) {
  if (!state.selected || !window.confirm(`Restore revision ${revision}? The current state will remain in history.`)) return;
  try {
    const payload = await api(`/records/${encodeURIComponent(state.selected.id)}/revisions/${revision}/restore`, { method: "POST", body: { revision: state.selected.revision } });
    state.selected = recordPayload(payload);
    renderDetail(state.selected);
    await Promise.all([loadCategory(), refreshCounts()]);
    notify(`Revision ${revision} restored.`, "success");
  } catch (error) { notify(error.message, "error"); }
}

function inputForDefinition(definition, value = "") {
  const [key, label, type, required, placeholder, options] = definition;
  let control;
  if (type === "checkbox") {
    control = element("input", { name: key, type: "checkbox", checked: Boolean(value) });
    return element("label", { class: "check-row full" }, [control, element("span", { text: placeholder || label })]);
  }
  if (type === "textarea") control = element("textarea", { name: key, required, placeholder, value: value ?? "" });
  else if (type === "select") {
    control = element("select", { name: key, required });
    if (!required) control.append(element("option", { value: "", text: "Not set" }));
    (options || []).forEach(([optionValue, optionLabel]) => control.append(element("option", { value: optionValue, text: optionLabel, selected: optionValue === value })));
  } else control = element("input", { name: key, type: type === "number" ? "number" : type === "url" ? "url" : "text", required, placeholder, value: value ?? "", step: type === "number" ? "any" : undefined, pattern: type === "partial" ? "\\d{4}(-\\d{2}(-\\d{2})?)?" : undefined, title: type === "partial" ? "Use YYYY, YYYY-MM, or YYYY-MM-DD" : undefined });
  return element("label", { class: `field${type === "textarea" ? " full" : ""}` }, [element("span", { text: label }), control, type === "partial" ? element("small", { text: "Partial dates are welcome: year, year-month, or full date." }) : null]);
}

function customFieldInput(field, value) {
  let definition;
  if (field.type === "boolean") definition = [field.id, field.name, "checkbox", false, field.name];
  else if (field.type === "singleChoice") definition = [field.id, field.name, "select", false, "", (field.options || []).map((option) => [option, option])];
  else definition = [field.id, field.name, field.type === "longText" ? "textarea" : field.type === "date" ? "partial" : field.type, false, ""];
  const wrapper = inputForDefinition(definition, value ?? "");
  wrapper.dataset.customField = field.id;
  wrapper.dataset.customType = field.type;
  return wrapper;
}

async function openRecordDialog(record = null) {
  state.editing = record;
  const category = record?.category || state.category;
  if (state.customFieldsCategory !== category) {
    try {
      const fieldsPayload = await api(`/custom-fields?category=${encodeURIComponent(category)}`);
      state.customFields = listPayload(fieldsPayload, "customFields").filter((field) => field.category === category);
      state.customFieldsCategory = category;
    } catch (error) {
      notify(`Custom fields could not be loaded. ${error.message}`, "error");
      return;
    }
  }
  const meta = CATEGORIES[category];
  $("#record-eyebrow").textContent = meta.eyebrow;
  $("#record-dialog-title").textContent = record ? `Edit ${meta.label.toLowerCase()}` : `Add ${meta.label.toLowerCase()}`;
  const fields = $("#record-fields");
  fields.replaceChildren();
  (FIELD_DEFS[category] || []).forEach((definition) => {
    const value = definition[0] === "title" ? record?.title : record?.data?.[definition[0]];
    fields.append(inputForDefinition(definition, value ?? ""));
  });
  if (category === "goal") {
    const parent = element("select", { name: "parentId" }, element("option", { value: "", text: "No parent goal" }));
    state.records.filter((item) => item.category === "goal" && item.id !== record?.id).forEach((item) => parent.append(element("option", { value: item.id, text: recordTitle(item), selected: item.id === record?.parentId })));
    fields.append(element("label", { class: "field" }, [element("span", { text: "Parent goal" }), parent]), element("label", { class: "field" }, [element("span", { text: "Order" }), element("input", { name: "position", type: "number", min: 0, step: 1, value: record?.position ?? state.records.length })]));
  }
  state.customFields.filter((field) => !field.archived).forEach((field) => fields.append(customFieldInput(field, record?.customFieldValues?.[field.id])));
  $("#record-form").dataset.category = category;
  $("#record-dialog").showModal();
  if (category === "experience") {
    const kind = $("[name='kind']", fields);
    const ongoing = $("[name='ongoing']", fields);
    const endDate = $("[name='endDate']", fields);
    const syncExperience = () => {
      const event = kind.value === "event";
      if (event) ongoing.checked = false;
      ongoing.disabled = event;
      endDate.disabled = event || ongoing.checked;
      if (endDate.disabled) endDate.value = "";
    };
    kind.addEventListener("change", syncExperience);
    ongoing.addEventListener("change", syncExperience);
    syncExperience();
  }
  window.setTimeout(() => $("input,textarea,select", fields)?.focus(), 50);
}

async function saveRecord(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const category = form.dataset.category;
  const data = {};
  const customFieldValues = { ...(state.editing?.customFieldValues || {}) };
  (FIELD_DEFS[category] || []).forEach(([key, , type]) => {
    if (key === "title") return;
    const control = form.elements.namedItem(key);
    if (!control) return;
    data[key] = type === "checkbox" ? control.checked : type === "number" && control.value !== "" ? Number(control.value) : control.value.trim();
  });
  $$('[data-custom-field]', form).forEach((wrapper) => {
    const control = $("input,textarea,select", wrapper);
    const type = wrapper.dataset.customType;
    if (type !== "boolean" && control.value === "") { delete customFieldValues[wrapper.dataset.customField]; return; }
    customFieldValues[wrapper.dataset.customField] = type === "boolean" ? control.checked : type === "number" ? Number(control.value) : control.value.trim();
  });
  const body = { title: form.elements.title.value.trim(), data, customFieldValues };
  if (category === "goal") {
    body.parentId = form.elements.parentId.value || null;
    body.position = Number(form.elements.position.value) || 0;
  }
  const button = $("#save-record");
  setButtonBusy(button, true, "Saving…");
  try {
    if (state.editing) {
      body.revision = state.editing.revision;
      await api(`/records/${encodeURIComponent(state.editing.id)}`, { method: "PATCH", body });
      notify("Entry updated.", "success");
    } else {
      body.category = category;
      await api("/records", { method: "POST", body });
      notify("Entry added to your atlas.", "success");
    }
    $("#record-dialog").close();
    state.editing = null;
    closeDetail();
    await Promise.all([loadCategory(), refreshCounts()]);
  } catch (error) {
    if (error.status === 409) notify("This entry changed in another session. Reopen it and try again.", "error");
    else notify(error.message, "error");
  } finally { setButtonBusy(button, false); }
}

async function removeOrRestore() {
  const record = state.selected;
  if (!record) return;
  const removed = Boolean(record.trashed || record.deletedAt);
  if (!removed && !window.confirm(`Move “${recordTitle(record)}” to recently removed?`)) return;
  try {
    const path = removed ? `/records/${encodeURIComponent(record.id)}/restore` : `/records/${encodeURIComponent(record.id)}`;
    const method = removed ? "POST" : "DELETE";
    await api(path, { method, body: { revision: record.revision } });
    notify(removed ? "Entry restored." : "Entry moved to recently removed.", "success");
    closeDetail();
    await Promise.all([loadCategory(), refreshCounts()]);
  } catch (error) { notify(error.message, "error"); }
}

async function openLinkDialog() {
  if (!state.selected) return;
  try {
    const payload = await api("/records?trashed=false");
    const records = listPayload(payload, "records").filter((record) => record.id !== state.selected.id);
    const select = $("#link-target");
    select.replaceChildren(element("option", { value: "", text: "Choose an entry" }));
    records.sort((a,b) => recordTitle(a).localeCompare(recordTitle(b))).forEach((record) => select.append(element("option", { value: record.id, text: `${recordTitle(record)} · ${CATEGORIES[record.category]?.label || friendly(record.category)}` })));
    $("#link-label").value = "";
    $("#link-dialog").showModal();
  } catch (error) { notify(error.message, "error"); }
}

async function saveLink(event) {
  event.preventDefault();
  if (!state.selected || !event.currentTarget.reportValidity()) return;
  try {
    await api("/links", { method: "POST", body: { sourceId: state.selected.id, targetId: $("#link-target").value, label: $("#link-label").value.trim() } });
    $("#link-dialog").close();
    notify("Cross-link added.", "success");
    await openDetail(state.selected.id);
  } catch (error) { notify(error.message, "error"); }
}

function openFieldDialog() {
  const form = $("#field-form");
  form.reset();
  form.elements.category.value = state.selected?.category || state.category;
  $("#field-options-row").hidden = true;
  form.elements.options.required = false;
  $("#field-dialog").showModal();
}

async function saveField(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  try {
    const type = form.elements.fieldType.value;
    const options = type === "singleChoice" ? form.elements.options.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) : [];
    if (type === "singleChoice" && !options.length) return notify("Add at least one choice.", "error");
    if (new Set(options).size !== options.length) return notify("Each choice must be unique.", "error");
    await api("/custom-fields", { method: "POST", body: { category: form.elements.category.value, name: form.elements.label.value.trim(), type, options } });
    $("#field-dialog").close();
    notify("Custom field added. It will appear when you edit an entry.", "success");
    await loadCategory();
    if (state.selected) await openDetail(state.selected.id);
  } catch (error) { notify(error.message, "error"); }
}

function openBackupDialog() {
  $("#backup-form").reset();
  $("#import-button").disabled = true;
  $("#backup-dialog").showModal();
}

function requestSecret() {
  return new Promise((resolve) => {
    const dialog = $("#secret-dialog");
    const form = $("#secret-form");
    dialog.returnValue = "cancel";
    $("#secret-passphrase").value = "";
    $("#secret-title").textContent = "Export encrypted backup";
    $("#secret-copy").textContent = "Enter a passphrase for this backup. It may be the same as your atlas passphrase, but it is never retained by this page.";
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      form.removeEventListener("submit", onSubmit);
      const value = dialog.returnValue === "confirm" ? $("#secret-passphrase").value : null;
      if (!value) $("#secret-passphrase").value = "";
      resolve(value);
    };
    const onSubmit = (event) => { event.preventDefault(); if (form.reportValidity()) dialog.close("confirm"); };
    form.addEventListener("submit", onSubmit, { once: true });
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

async function exportBackup() {
  const passphrase = await requestSecret();
  if (!passphrase) return;
  try {
    const payload = await api("/export", { method: "POST", body: { passphrase } });
    const envelope = payload?.envelope ?? payload;
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = element("a", { href: url, download: `eidolon-atlas-${new Date().toISOString().slice(0,10)}.atlas.json` });
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    notify("Encrypted backup downloaded.", "success");
  } catch (error) { notify(error.message, "error"); }
}

async function importBackup() {
  const file = $("#import-file").files[0];
  const passphrase = $("#backup-passphrase").value;
  if (!file || !passphrase || !$("#import-confirm").checked) return;
  const button = $("#import-button");
  setButtonBusy(button, true, "Importing…");
  try {
    const envelope = JSON.parse(await file.text());
    await api("/import", { method: "POST", body: { passphrase, envelope } });
    $("#backup-dialog").close();
    notify("Backup imported successfully.", "success");
    closeDetail();
    await Promise.all([loadCategory(), refreshCounts()]);
  } catch (error) {
    notify(error instanceof SyntaxError ? "That file is not a valid atlas backup." : error.message, "error");
  } finally { setButtonBusy(button, false); }
}

function openPromptDialog() {
  const prompts = [
    { category: "person", icon: "person", title: "A profile to complete", recordTitle: "My profile", description: "Create a blank personal portrait.", data: { summary: "", contact: "", address: "", status: "" } },
    { category: "goal", icon: "compass", title: "A direction to name", recordTitle: "An intention to define", description: "Hold a place for one active intention.", data: { horizon: "short", status: "active", targetDate: "", progressNote: "", motivation: "" } },
    { category: "resource", icon: "bookmark", title: "Something useful", recordTitle: "A useful resource", description: "Save a place for a resource you rely on.", data: { kind: "other", ownership: "", access: "", availability: "available", quantity: "", unit: "", notes: "" } }
  ];
  const root = $("#prompt-options");
  root.replaceChildren();
  prompts.forEach((prompt, index) => root.append(element("label", { class: "prompt-option" }, [
    element("input", { type: "checkbox", value: String(index), checked: index === 0 }), element("span", {}, icon(prompt.icon)),
    element("div", {}, [element("strong", { text: prompt.title }), element("small", { text: prompt.description })])
  ])));
  $("#prompt-form")._prompts = prompts;
  $("#prompt-dialog").showModal();
}

async function savePrompts(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const selected = $$("input:checked", form).map((input) => form._prompts[Number(input.value)]);
  if (!selected.length) return $("#prompt-dialog").close();
  const button = $("button[type='submit']", form);
  setButtonBusy(button, true, "Adding…");
  try {
    for (const prompt of selected) {
      await api("/records", { method: "POST", body: { category: prompt.category, title: prompt.recordTitle, data: prompt.data, customFieldValues: {} } });
    }
    $("#prompt-dialog").close();
    notify("Your first markers are ready to refine.", "success");
    await Promise.all([loadCategory(), refreshCounts()]);
  } catch (error) { notify(error.message, "error"); }
  finally { setButtonBusy(button, false); }
}

async function lockAtlas() {
  try { await api("/lock", { method: "POST", body: {} }); }
  catch (error) { notify(error.message, "error"); return; }
  lockLocally();
}

function lockLocally() {
  closeDetail();
  state.records = [];
  state.allRecords = [];
  state.customFields = [];
  state.customFieldsCategory = null;
  state.query = "";
  $("#unlock-form").reset();
  showAuth("unlock");
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebar-scrim").hidden = false;
  window.setTimeout(() => $("#close-sidebar").focus(), 30);
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-scrim").hidden = true;
}

function wireEvents() {
  $("#setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const passphrase = form.elements.passphrase.value;
    if (passphrase !== form.elements.confirmation.value) return notify("The passphrases do not match.", "error");
    const button = $("button[type='submit']", form); setButtonBusy(button, true, "Encrypting…");
    try { await api("/setup", { method: "POST", body: { passphrase } }); form.reset(); await enterAtlas({ prompt: true }); }
    catch (error) { notify(error.message, "error"); }
    finally { setButtonBusy(button, false); }
  });
  $("#unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = $("button[type='submit']", form); setButtonBusy(button, true, "Unlocking…");
    try { await api("/unlock", { method: "POST", body: { passphrase: form.elements.passphrase.value } }); form.reset(); await enterAtlas(); }
    catch (error) { notify(error.message, "error"); form.elements.passphrase.select(); }
    finally { setButtonBusy(button, false); }
  });
  $("#new-record").addEventListener("click", () => openRecordDialog());
  $("#new-record-top").addEventListener("click", () => openRecordDialog());
  $("#record-form").addEventListener("submit", saveRecord);
  $("#close-detail").addEventListener("click", closeDetail);
  $("#detail-edit").addEventListener("click", () => state.selected && openRecordDialog(state.selected));
  $("#detail-remove").addEventListener("click", removeOrRestore);
  $("#trash-button").addEventListener("click", async () => { state.trash = true; state.query = ""; state.filter = "all"; $("#global-search").value = ""; closeSidebar(); closeDetail(); await loadCategory(); });
  $("#backup-button").addEventListener("click", () => { closeSidebar(); openBackupDialog(); });
  $("#lock-button").addEventListener("click", lockAtlas);
  $("#open-sidebar").addEventListener("click", openSidebar);
  $("#close-sidebar").addEventListener("click", closeSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $("#link-form").addEventListener("submit", saveLink);
  $("#field-form").addEventListener("submit", saveField);
  $("#field-form select[name='fieldType']").addEventListener("change", (event) => {
    $("#field-options-row").hidden = event.target.value !== "singleChoice";
    $("#field-form textarea[name='options']").required = event.target.value === "singleChoice";
  });
  $("#export-button").addEventListener("click", exportBackup);
  $("#import-button").addEventListener("click", importBackup);
  $("#prompt-form").addEventListener("submit", savePrompts);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close("cancel")));
  [$("#import-file"), $("#backup-passphrase"), $("#import-confirm")].forEach((control) => control.addEventListener("input", () => {
    $("#import-button").disabled = !$("#import-file").files.length || !$("#backup-passphrase").value || !$("#import-confirm").checked;
  }));
  let searchTimer;
  $("#global-search").addEventListener("input", (event) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { state.query = event.target.value.trim(); state.trash = false; state.filter = "all"; closeDetail(); loadCategory(); }, 240);
  });
  $$("#view-toggle button").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; updateHeading(); renderRecords(); }));
  document.addEventListener("keydown", (event) => {
    const activeTag = document.activeElement?.tagName;
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(activeTag) && !$("#app").hidden) { event.preventDefault(); $("#global-search").focus(); }
    if (event.key === "Escape" && $("#detail-pane").classList.contains("open") && !$(`dialog[open]`)) closeDetail();
  });
  window.addEventListener("scroll", () => $(".topbar")?.classList.toggle("scrolled", window.scrollY > 8), { passive: true });
}

initialize();
