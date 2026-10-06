// utils/customizationResolver.js
// ─────────────────────────────────────────────────────────────────────────────
// PURE logic for per-company customization — no DB, no Redis, no I/O.
//
//   resolveCustomization(stored)         → full config (defaults + overrides)
//   validateSection(section, value, cur) → sanitised value to store (throws
//                                          CustomizationError on bad input)
//   + query helpers used across controllers/jobs/services:
//       statusKeysByCategory, defaultStatusKey, findStatus, findOutcome,
//       findTemperature, isModuleOn, permission, buildScheduledFollowUps,
//       sanitizeCustomFieldValues, companyClock …
//
// Kept separate from services/customizationService.js (which does the I/O)
// so it can be unit-tested and reused without opening Redis/Mongo.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const {
  PALETTE,
  STATUS_CATEGORIES,
  OUTCOME_BEHAVIOURS,
  FOLLOWUP_RULES,
  OUTCOME_GROUPS,
  CUSTOM_FIELD_TYPES,
  MODULE_CATALOG,
  NAV_ONLY_MODULE_KEYS,
  SECTIONS,
  ARRAY_SECTIONS,
  buildDefaults,
} = require("../config/customizationDefaults");

class CustomizationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "CustomizationError";
    this.status = 400;
    this.field = field || null;
  }
}

// ── tiny utils ───────────────────────────────────────────────────────────────
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
const cleanStr = (v, max = 200) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const colorOr = (c, fallback = "gray") => (Object.prototype.hasOwnProperty.call(PALETTE, c) ? c : fallback);
const bool = (v, fallback) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback);
const num = (v, fallback, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const isHHmm = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Deep-merge `override` onto `base`, keeping ONLY keys that exist in `base`
// and coercing each value to the base value's type. Used for object sections
// (workflows, alerts, permissions …) so unknown/malicious keys are dropped and
// a wrong type can never reach the code that reads it.
function coerceToShape(base, override, path = "") {
  if (override === undefined || override === null) return clone(base);
  if (Array.isArray(base)) {
    return Array.isArray(override) ? clone(override) : clone(base);
  }
  if (isPlainObject(base)) {
    const out = {};
    const src = isPlainObject(override) ? override : {};
    for (const k of Object.keys(base)) {
      out[k] = coerceToShape(base[k], src[k], path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof base === "boolean") return bool(override, base);
  if (typeof base === "number")  return num(override, base);
  if (typeof base === "string")  return typeof override === "string" || typeof override === "number"
    ? cleanStr(override, 5000)
    : base;
  return clone(base);
}

// ─────────────────────────────────────────────────────────────────────────────
// ARRAY SECTION NORMALISERS — used both when resolving stored data and when
// validating an incoming save. `strict` = throw on problems (save path);
// non-strict = repair silently (read path, so a bad stored value can never
// break the app).
// ─────────────────────────────────────────────────────────────────────────────

function normaliseKeyedList(items, defaults, makeItem, { strict, what }) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    const key = cleanStr(raw.key || raw.label, 60);
    if (!key) {
      if (strict) throw new CustomizationError(`Every ${what} needs a name.`);
      continue;
    }
    if (seen.has(norm(key))) {
      if (strict) throw new CustomizationError(`Duplicate ${what} "${key}".`);
      continue;
    }
    seen.add(norm(key));
    const def = defaults.find((d) => norm(d.key) === norm(key));
    out.push(makeItem(raw, def, key));
  }
  // System items can never be removed — re-add any that are missing (they
  // may be renamed/hidden instead). Also brings in system items introduced
  // by later CRM versions for companies with an older stored list.
  for (const def of defaults) {
    if (!def.system) continue;
    if (!seen.has(norm(def.key))) {
      if (strict && list.length) {
        throw new CustomizationError(`"${def.label}" is a built-in ${what} and can't be deleted — deactivate or rename it instead.`);
      }
      out.push(clone(def));
      seen.add(norm(def.key));
    }
  }
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  out.forEach((it, i) => { it.order = i + 1; });
  return out;
}

function makeStatus() {
  return (raw2, d, key) => {
    const base = d || {};
    return {
      key,                                         // stored value on leads — never changes
      label: cleanStr(raw2.label, 60) || base.label || key,
      color: colorOr(raw2.color, base.color || "gray"),
      category: STATUS_CATEGORIES.includes(raw2.category) ? raw2.category : (base.category || "open"),
      order: num(raw2.order, base.order || 999, 0, 9999),
      active: bool(raw2.active, base.active !== undefined ? base.active : true),
      isDefault: bool(raw2.isDefault, !!base.isDefault),
      employeeSelectable: bool(raw2.employeeSelectable, base.employeeSelectable !== undefined ? base.employeeSelectable : true),
      showInPipeline: bool(raw2.showInPipeline, base.showInPipeline !== undefined ? base.showInPipeline : true),
      metaEvent: ["", "Lead", "Contact", "Schedule", "SubmitApplication", "Purchase", "CompleteRegistration"].includes(raw2.metaEvent)
        ? raw2.metaEvent : (base.metaEvent || ""),
      aliases: Array.isArray(raw2.aliases) ? raw2.aliases.map((a) => cleanStr(a, 60)).filter(Boolean).slice(0, 10) : (base.aliases || []),
      system: !!base.system,
    };
  };
}

function normaliseStatuses(items, { strict = false } = {}) {
  const defaults = buildDefaults().statuses;
  const out = normaliseKeyedList(items, defaults, makeStatus(), { strict, what: "status" });

  // System statuses keep their original category — workflows depend on it.
  for (const s of out) {
    const d = defaults.find((x) => norm(x.key) === norm(s.key));
    if (d && d.system && s.category !== d.category) s.category = d.category;
  }

  if (!out.some((s) => s.active && s.category === "new")) {
    if (strict) throw new CustomizationError("At least one active status must be of type “New”.");
    const n = out.find((s) => s.category === "new");
    if (n) n.active = true;
  }
  if (!out.some((s) => s.active && s.category === "won") && strict) {
    throw new CustomizationError("At least one active status must be of type “Won” (used for conversions).");
  }
  if (!out.some((s) => s.active && s.category === "lost") && strict) {
    throw new CustomizationError("At least one active status must be of type “Lost”.");
  }
  // Exactly one default, and it must be an active "new" status.
  const defaults_ = out.filter((s) => s.isDefault && s.active && s.category === "new");
  out.forEach((s) => { s.isDefault = false; });
  const pick = defaults_[0] || out.find((s) => s.active && s.category === "new");
  if (pick) pick.isDefault = true;
  return out;
}

function makeOutcome(statusKeys) {
  return (raw, d, key) => {
    const base = d || {};
    const autoStatus = cleanStr(raw.autoStatus !== undefined ? raw.autoStatus : base.autoStatus, 60);
    return {
      key,
      label: cleanStr(raw.label, 60) || base.label || key,
      color: colorOr(raw.color, base.color || "gray"),
      group: OUTCOME_GROUPS.includes(raw.group) ? raw.group : (base.group || "answered"),
      order: num(raw.order, base.order || 999, 0, 9999),
      active: bool(raw.active, base.active !== undefined ? base.active : true),
      system: !!base.system,
      // System outcomes keep the behaviour their workflow needs.
      behavior: base.system
        ? base.behavior
        : (OUTCOME_BEHAVIOURS.includes(raw.behavior) ? raw.behavior : "none"),
      followUp: FOLLOWUP_RULES.includes(raw.followUp) ? raw.followUp : (base.followUp || "optional"),
      autoFollowUpDays: num(raw.autoFollowUpDays, base.autoFollowUpDays || 1, 0, 365),
      autoStatus: statusKeys && autoStatus && !statusKeys.has(norm(autoStatus)) ? "" : autoStatus,
      automationKey: base.system ? (base.automationKey || "") : cleanStr(raw.automationKey, 60),
      allowForManualLeads: bool(raw.allowForManualLeads, !!base.allowForManualLeads),
      countsAsConnected: bool(raw.countsAsConnected, base.countsAsConnected !== undefined ? base.countsAsConnected : true),
      automation: normaliseAutomation(raw.automation !== undefined ? raw.automation : base.automation),
    };
  };
}

// Per-outcome WhatsApp/Email automation override (null = use the company's
// built-in outcomeAutomation config for automationKey, if any).
function normaliseAutomation(a) {
  if (!isPlainObject(a)) return null;
  const wa = isPlainObject(a.whatsapp) ? a.whatsapp : {};
  const em = isPlainObject(a.email) ? a.email : {};
  let body = typeof em.bodyTemplate === "string" ? em.bodyTemplate.slice(0, 20000) : "";
  try {
    // Lazy require — sanitize-html is a backend dependency; keep the pure
    // module loadable even where it isn't installed (tests).
    const { sanitizeEmailHtml } = require("./sanitizeHtml");
    body = sanitizeEmailHtml(body) || "";
  } catch (_) { /* sanitizer unavailable — stored as-is, rendered via existing sanitising sender */ }
  return {
    whatsapp: {
      enabled: bool(wa.enabled, false),
      templateName: cleanStr(wa.templateName, 120),
      languageCode: cleanStr(wa.languageCode || "en", 10) || "en",
    },
    email: {
      enabled: bool(em.enabled, false),
      subject: cleanStr(em.subject, 300),
      fromName: cleanStr(em.fromName, 120),
      bodyTemplate: body,
    },
  };
}

function normaliseOutcomes(items, statuses, { strict = false } = {}) {
  const defaults = buildDefaults().outcomes;
  const statusKeys = new Set((statuses || buildDefaults().statuses).map((s) => norm(s.key)));
  const out = normaliseKeyedList(items, defaults, makeOutcome(statusKeys), { strict, what: "call outcome" });
  if (strict && !out.some((o) => o.active)) {
    throw new CustomizationError("At least one call outcome must be active.");
  }
  return out;
}

function normaliseTemperatures(items, { strict = false } = {}) {
  const defaults = buildDefaults().temperatures;
  return normaliseKeyedList(items, defaults, (raw, d, key) => {
    const base = d || {};
    return {
      key,
      label: cleanStr(raw.label, 40) || base.label || key,
      color: colorOr(raw.color, base.color || "gray"),
      order: num(raw.order, base.order || 999, 0, 9999),
      active: bool(raw.active, base.active !== undefined ? base.active : true),
      system: !!base.system,
      triggersColdFlow: bool(raw.triggersColdFlow, !!base.triggersColdFlow),
    };
  }, { strict, what: "lead quality" });
}

// Paths that already exist on the Lead model — a custom field must not shadow them.
const RESERVED_FIELD_KEYS = new Set([
  "name", "mobile", "email", "source", "campaign", "status", "date", "remark", "temperature",
  "user", "company", "industry", "service", "businessname", "language", "leadgenid",
  "primaryphone", "secondaryphone", "_id", "id", "createdat", "updatedat", "customfields",
  "callhistory", "scheduledcalls", "meetingremarks", "isclosed", "mergedinto", "quality",
]);

function normaliseCustomFields(items, { strict = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    const label = cleanStr(raw.label, 60);
    let key = cleanStr(raw.key || label, 40).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!label || !key) {
      if (strict) throw new CustomizationError("Every custom field needs a label.");
      continue;
    }
    if (/^\d/.test(key)) key = `f_${key}`;
    if (RESERVED_FIELD_KEYS.has(key.replace(/_/g, ""))) {
      if (strict) throw new CustomizationError(`"${label}" clashes with a built-in lead field — pick another name.`);
      continue;
    }
    if (seen.has(key)) {
      if (strict) throw new CustomizationError(`Duplicate custom field "${label}".`);
      continue;
    }
    seen.add(key);
    const type = CUSTOM_FIELD_TYPES.includes(raw.type) ? raw.type : "text";
    const options = Array.isArray(raw.options)
      ? [...new Set(raw.options.map((o) => cleanStr(o, 100)).filter(Boolean))].slice(0, 200)
      : [];
    if (strict && (type === "select" || type === "multiselect") && !options.length) {
      throw new CustomizationError(`Dropdown field "${label}" needs at least one option.`);
    }
    out.push({
      key,
      label,
      type,
      options,
      required: bool(raw.required, false),
      active: bool(raw.active, true),
      showInList: bool(raw.showInList, false),
      showInForm: bool(raw.showInForm, true),
      employeeVisible: bool(raw.employeeVisible, true),
      employeeEditable: bool(raw.employeeEditable, true),
      placeholder: cleanStr(raw.placeholder, 120),
      helpText: cleanStr(raw.helpText, 200),
      order: num(raw.order, out.length + 1, 0, 9999),
    });
  }
  if (strict && out.length > 100) throw new CustomizationError("A maximum of 100 custom fields is allowed.");
  out.sort((a, b) => a.order - b.order);
  out.forEach((f, i) => { f.order = i + 1; });
  return out;
}

function normaliseLists(value, { strict = false } = {}) {
  const base = buildDefaults().lists;
  const src = isPlainObject(value) ? value : {};
  const out = {};
  for (const k of Object.keys(base)) {
    if (!Array.isArray(src[k])) { out[k] = base[k]; continue; }
    const items = [...new Set(src[k].map((x) => cleanStr(x, 100)).filter(Boolean))];
    if (strict && items.length > 300) throw new CustomizationError(`The ${k} list can hold at most 300 items.`);
    out[k] = items.slice(0, 300);
  }
  return out;
}

function normaliseModules(value) {
  const base = buildDefaults().modules;
  const src = isPlainObject(value) ? value : {};
  const out = {};
  for (const m of MODULE_CATALOG) {
    const cur = isPlainObject(src[m.key]) ? src[m.key] : {};
    out[m.key] = {
      enabled: bool(cur.enabled, base[m.key].enabled),
      label: cleanStr(cur.label, 40),
      admin: bool(cur.admin, base[m.key].admin),
      employee: bool(cur.employee, base[m.key].employee),
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveCustomization — defaults ⊕ stored. NEVER throws.
// ─────────────────────────────────────────────────────────────────────────────
function resolveCustomization(stored) {
  const d = buildDefaults();
  const s = isPlainObject(stored) ? stored : {};
  try {
    const statuses = normaliseStatuses(s.statuses);
    const out = {
      modules:      normaliseModules(s.modules),
      statuses,
      outcomes:     normaliseOutcomes(s.outcomes, statuses),
      temperatures: normaliseTemperatures(s.temperatures),
      lists:        normaliseLists(s.lists),
      leadFields:   coerceToShape(d.leadFields, s.leadFields),
      customFields: normaliseCustomFields(s.customFields),
      workflows:    coerceToShape(d.workflows, s.workflows),
      permissions:  coerceToShape(d.permissions, s.permissions),
      alerts:       coerceToShape(d.alerts, s.alerts),
      general:      coerceToShape(d.general, s.general),
      messaging:    coerceToShape(d.messaging, s.messaging),
      dashboard:    coerceToShape(d.dashboard, s.dashboard),
      version:      Number(s.version) || 0,
    };
    if (!["round_robin", "team_lead"].includes(out.workflows.notInterested.verifier)) out.workflows.notInterested.verifier = "round_robin";
    repairWorkflowRefs(out);
    return out;
  } catch (err) {
    // A corrupt stored doc must never take the CRM down — fall back fully.
    console.error("[customization] resolve failed, using defaults:", err.message);
    return { ...d, version: 0 };
  }
}

// Workflow configs point at statuses by key. If a referenced status no longer
// exists (or is inactive), fall back to the first active status of the right
// category so the flow keeps working.
function repairWorkflowRefs(c) {
  const byCat = (cat) => (c.statuses.find((x) => x.active && x.category === cat) || c.statuses.find((x) => x.category === cat) || {}).key;
  const exists = (k) => c.statuses.some((x) => norm(x.key) === norm(k));
  const fix = (obj, field, cat) => { if (!obj[field] || !exists(obj[field])) obj[field] = byCat(cat) || obj[field]; };
  const w = c.workflows;
  fix(w.notInterested, "verificationStatus", "verification");
  fix(w.notInterested, "finalStatus", "lost");
  fix(w.notInterested, "resetStatus", "new");
  fix(w.cold, "verificationStatus", "verification");
  fix(w.cold, "returnStatus", "new");
  fix(w.invalid, "verificationStatus", "verification");
  fix(w.invalid, "closedStatus", "lost");
  fix(w.invalid, "resetStatus", "new");
  fix(w.closeByEmployee, "closedStatus", "lost");
  for (const k of ["notInterested", "cold"]) {
    w[k].followUps = (Array.isArray(w[k].followUps) ? w[k].followUps : [])
      .filter(isPlainObject)
      .map((f) => ({
        type: f.type === "verification" ? "verification" : "follow-up",
        days: num(f.days, 1, 0, 365),
        note: cleanStr(f.note, 200),
      }))
      .slice(0, 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSection — strict validation for a save. Returns the value to STORE.
// `current` is the currently resolved customization (for cross-references).
// ─────────────────────────────────────────────────────────────────────────────
function validateSection(section, value, current) {
  if (!SECTIONS.includes(section)) throw new CustomizationError(`Unknown section "${section}".`);
  const cur = current || resolveCustomization({});
  const d = buildDefaults();

  switch (section) {
    case "modules":
      return normaliseModules(value);

    case "statuses": {
      if (!Array.isArray(value)) throw new CustomizationError("Statuses must be a list.");
      if (value.length > 60) throw new CustomizationError("A maximum of 60 statuses is allowed.");
      return normaliseStatuses(value, { strict: true });
    }

    case "outcomes": {
      if (!Array.isArray(value)) throw new CustomizationError("Outcomes must be a list.");
      if (value.length > 80) throw new CustomizationError("A maximum of 80 outcomes is allowed.");
      const out = normaliseOutcomes(value, cur.statuses, { strict: true });
      for (const o of value) {
        if (isPlainObject(o) && o.autoStatus && !cur.statuses.some((s) => norm(s.key) === norm(o.autoStatus))) {
          throw new CustomizationError(`Outcome "${o.label || o.key}" moves leads to an unknown status "${o.autoStatus}".`);
        }
      }
      return out;
    }

    case "temperatures": {
      if (!Array.isArray(value)) throw new CustomizationError("Lead qualities must be a list.");
      if (value.length > 20) throw new CustomizationError("A maximum of 20 lead qualities is allowed.");
      const out = normaliseTemperatures(value, { strict: true });
      if (!out.some((t) => t.active)) throw new CustomizationError("At least one lead quality must be active.");
      return out;
    }

    case "customFields":
      return normaliseCustomFields(value, { strict: true });

    case "lists":
      return normaliseLists(value, { strict: true });

    case "leadFields":
      return coerceToShape(d.leadFields, value);

    case "workflows": {
      const w = coerceToShape(d.workflows, value);
      const tmp = { ...cur, workflows: w };
      const exists = (k) => cur.statuses.some((s) => norm(s.key) === norm(k));
      const refs = [
        ["notInterested", "verificationStatus"], ["notInterested", "finalStatus"], ["notInterested", "resetStatus"],
        ["cold", "verificationStatus"], ["cold", "returnStatus"],
        ["invalid", "verificationStatus"], ["invalid", "closedStatus"], ["invalid", "resetStatus"],
        ["closeByEmployee", "closedStatus"],
      ];
      for (const [grp, field] of refs) {
        if (!exists(w[grp][field])) {
          throw new CustomizationError(`Workflow “${grp}” points at a status that doesn't exist: "${w[grp][field]}".`, `${grp}.${field}`);
        }
      }
      if (!["least_loaded", "round_robin", "manual"].includes(w.assignment.strategy)) w.assignment.strategy = "least_loaded";
      if (!["round_robin", "least_loaded", "unassigned", "manual"].includes(w.assignment.importStrategy)) w.assignment.importStrategy = "round_robin";
      if (!["round_robin", "team_lead"].includes(w.notInterested.verifier)) w.notInterested.verifier = "round_robin";
      w.leadUpdate.defaultFollowUpHour = num(w.leadUpdate.defaultFollowUpHour, 9, 0, 23);
      w.leadUpdate.defaultFollowUpDays = num(w.leadUpdate.defaultFollowUpDays, 1, 0, 365);
      repairWorkflowRefs(tmp);
      return tmp.workflows;
    }

    case "permissions":
      return coerceToShape(d.permissions, value);

    case "alerts": {
      const a = coerceToShape(d.alerts, value);
      const n = a.noAction;
      n.firstAlertHours  = num(n.firstAlertHours, 1, 0.25, 720);
      n.secondAlertHours = num(n.secondAlertHours, 2, 0.25, 720);
      n.escalationHours  = num(n.escalationHours, 3, 0.25, 720);
      if (!(n.firstAlertHours < n.secondAlertHours && n.secondAlertHours <= n.escalationHours)) {
        throw new CustomizationError("No-action alerts must be in increasing order: first < second ≤ escalation.");
      }
      a.noFollowUpDate.afterHours       = num(a.noFollowUpDate.afterHours, 24, 1, 720);
      a.noFollowUpDate.repeatEveryHours = num(a.noFollowUpDate.repeatEveryHours, 24, 1, 720);
      a.callReminder.minutesBefore      = num(a.callReminder.minutesBefore, 15, 5, 240);
      a.leadFollowUpReminder.intervalDays = num(a.leadFollowUpReminder.intervalDays, 3, 1, 60);
      for (const [obj, field] of [[a.followUpDigest, "time"], [a.leadFollowUpReminder, "morningTime"], [a.leadFollowUpReminder, "eveningTime"]]) {
        if (!isHHmm(obj[field])) throw new CustomizationError(`"${obj[field]}" is not a valid time — use HH:mm (24-hour).`);
      }
      return a;
    }

    case "general": {
      const g = coerceToShape(d.general, value);
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: g.timezone });
      } catch (_) {
        throw new CustomizationError(`Unknown timezone "${g.timezone}".`);
      }
      g.defaultCountryCode = String(g.defaultCountryCode || "").replace(/\D/g, "").slice(0, 4) || "91";
      g.currency = cleanStr(g.currency, 3).toUpperCase() || "INR";
      g.appName = cleanStr(g.appName, 40);
      for (const k of Object.keys(g.terminology)) {
        g.terminology[k] = cleanStr(g.terminology[k], 30) || d.general.terminology[k];
      }
      return g;
    }

    case "messaging": {
      const m = coerceToShape(d.messaging, value);
      m.smsGreeting = cleanStr(m.smsGreeting, 1000) || d.messaging.smsGreeting;
      m.dailyReportTitle = cleanStr(m.dailyReportTitle, 120) || d.messaging.dailyReportTitle;
      return m;
    }

    case "dashboard":
      return coerceToShape(d.dashboard, value);

    default:
      throw new CustomizationError(`Unknown section "${section}".`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HELPERS (all take a RESOLVED customization object)
// ─────────────────────────────────────────────────────────────────────────────

/** Status keys whose category is any of `cats` (string or array). Inactive included unless activeOnly. */
function statusKeysByCategory(c, cats, { activeOnly = false } = {}) {
  const want = new Set(Array.isArray(cats) ? cats : [cats]);
  return (c?.statuses || buildDefaults().statuses)
    .filter((s) => want.has(s.category) && (!activeOnly || s.active))
    .map((s) => s.key);
}

/** Keys of every status that ends active work (won + lost). */
function closedStatusKeys(c) {
  return statusKeysByCategory(c, ["won", "lost"]);
}

/** The status new leads get when nothing else is specified. */
function defaultStatusKey(c) {
  const list = c?.statuses || buildDefaults().statuses;
  return (list.find((s) => s.isDefault) || list.find((s) => s.category === "new") || list[0] || { key: "New" }).key;
}

/** Resolve any key / label / alias to the canonical status object (or null). */
function findStatus(c, value) {
  if (value === undefined || value === null || value === "") return null;
  const v = norm(value);
  const list = c?.statuses || buildDefaults().statuses;
  return list.find((s) => norm(s.key) === v)
    || list.find((s) => norm(s.label) === v)
    || list.find((s) => (s.aliases || []).some((a) => norm(a) === v))
    || null;
}

function statusCategory(c, value) {
  return findStatus(c, value)?.category || null;
}

/** Resolve an outcome by key or label (case-insensitive). */
function findOutcome(c, value) {
  if (!value) return null;
  const v = norm(value);
  const list = c?.outcomes || buildDefaults().outcomes;
  return list.find((o) => norm(o.key) === v) || list.find((o) => norm(o.label) === v) || null;
}

function findTemperature(c, value) {
  if (!value) return null;
  const v = norm(value);
  const list = c?.temperatures || buildDefaults().temperatures;
  return list.find((t) => norm(t.key) === v) || list.find((t) => norm(t.label) === v) || null;
}

/** Whether a module is switched ON at the company level (plan gating is separate). */
function isModuleOn(c, key) {
  const m = c?.modules?.[key];
  return m ? m.enabled !== false : true;
}

/** Company-level permission lookup. role: "employee" | "admin". Unknown → true (fail open, old behaviour). */
function permission(c, role, name) {
  const group = c?.permissions?.[role === "user" ? "employee" : role];
  if (!group || !(name in group)) return true;
  return !!group[name];
}

/** Build scheduledCalls entries from a workflow followUps config. */
function buildScheduledFollowUps(followUps, now = Date.now()) {
  return (Array.isArray(followUps) ? followUps : []).map((f) => ({
    type: f.type === "verification" ? "verification" : "follow-up",
    scheduledAt: new Date(now + num(f.days, 1, 0, 365) * 24 * 60 * 60 * 1000),
    done: false,
    note: f.note || (f.type === "verification" ? `${f.days}-day verification call` : "Auto follow-up"),
  }));
}

// ── Company-local clock (alerts/reminders run on the company's timezone) ────
function companyClock(c, date = new Date()) {
  const tz = c?.general?.timezone || "Asia/Kolkata";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  } catch (_) {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
  }
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year"), m = get("month"), d = get("day"), h = get("hour") % 24, mi = get("minute");
  return {
    timezone: tz,
    dayKey: `${y}-${m}-${d}`,
    minutesOfDay: h * 60 + mi,
    hhmm: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
  };
}

// Minutes the timezone is ahead of UTC at `date` (e.g. +330 for IST).
function tzOffsetMinutes(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    }).formatToParts(date);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch (_) {
    return 330;
  }
}

/** Date for "N days from today at HH:00" in the company's timezone. */
function companyDateAt(c, daysAhead = 1, hour = 9, minute = 0) {
  const tz = c?.general?.timezone || "Asia/Kolkata";
  const now = new Date();
  const off = tzOffsetMinutes(tz, now);
  const local = new Date(now.getTime() + off * 60000);            // wall clock as UTC fields
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + Number(daysAhead || 0), hour, minute, 0, 0);
  const off2 = tzOffsetMinutes(tz, new Date(target - off * 60000)); // DST-safe second pass
  return new Date(target - off2 * 60000);
}

/** Start of "today" (00:00) in the company's timezone, as a Date. */
function companyDayStart(c) {
  return companyDateAt(c, 0, 0, 0);
}

/** "09:30" → 570 */
function hhmmToMinutes(v, fallback = 0) {
  if (!isHHmm(v)) return fallback;
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}

/** {{company}} / {{name}} … template fill (unknown tokens left untouched). */
function fillTemplate(str, vars) {
  return String(str || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) =>
    Object.prototype.hasOwnProperty.call(vars || {}, k) && vars[k] != null ? String(vars[k]) : all);
}

// ── Custom field values ─────────────────────────────────────────────────────
/**
 * Validate/clean incoming custom-field values against the company's config.
 *   input   — plain object { fieldKey: value }
 *   options — { role: "employee"|"admin", partial: boolean (PATCH semantics) }
 * Returns { values, errors } — `values` contains only known, permitted keys.
 */
function sanitizeCustomFieldValues(c, input, { role = "admin", partial = false } = {}) {
  const fields = (c?.customFields || []).filter((f) => f.active);
  const src = isPlainObject(input) ? input : {};
  const values = {};
  const errors = [];
  const isEmployee = role === "employee" || role === "user";

  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(src, f.key);
    if (!has) {
      if (!partial && f.required) errors.push(`${f.label} is required.`);
      continue;
    }
    if (isEmployee && (!f.employeeVisible || !f.employeeEditable)) continue; // silently ignore
    let v = src[f.key];
    const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) errors.push(`${f.label} is required.`);
      else values[f.key] = null;
      continue;
    }
    switch (f.type) {
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) { errors.push(`${f.label} must be a number.`); continue; }
        v = n; break;
      }
      case "checkbox": v = v === true || v === "true" || v === 1 || v === "1"; break;
      case "date":
      case "datetime": {
        const dt = new Date(v);
        if (Number.isNaN(dt.getTime())) { errors.push(`${f.label} must be a valid date.`); continue; }
        v = dt.toISOString(); break;
      }
      case "select": {
        const s = cleanStr(v, 100);
        if (!f.options.some((o) => norm(o) === norm(s))) { errors.push(`${f.label}: "${s}" is not an allowed option.`); continue; }
        v = f.options.find((o) => norm(o) === norm(s)); break;
      }
      case "multiselect": {
        const arr = (Array.isArray(v) ? v : String(v).split(",")).map((x) => cleanStr(x, 100)).filter(Boolean);
        const bad = arr.filter((x) => !f.options.some((o) => norm(o) === norm(x)));
        if (bad.length) { errors.push(`${f.label}: "${bad.join(", ")}" not allowed.`); continue; }
        v = arr.map((x) => f.options.find((o) => norm(o) === norm(x))); break;
      }
      case "email": {
        const s = cleanStr(v, 200);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) { errors.push(`${f.label} must be a valid email.`); continue; }
        v = s; break;
      }
      case "url": {
        const s = cleanStr(v, 500);
        if (!/^https?:\/\//i.test(s)) { errors.push(`${f.label} must start with http:// or https://`); continue; }
        v = s; break;
      }
      case "phone": {
        const s = cleanStr(v, 30);
        if (s.replace(/\D/g, "").length < 6) { errors.push(`${f.label} must be a valid phone number.`); continue; }
        v = s; break;
      }
      case "textarea": v = cleanStr(v, 5000); break;
      default: v = cleanStr(v, 500);
    }
    values[f.key] = v;
  }
  return { values, errors };
}

/** Map a lead-ish object's custom field values to {key: value} honoring employee visibility. */
function visibleCustomFields(c, lead, role) {
  const isEmployee = role === "employee" || role === "user";
  const fields = (c?.customFields || []).filter((f) => f.active && (!isEmployee || f.employeeVisible));
  const raw = lead && lead.customFields
    ? (lead.customFields instanceof Map ? Object.fromEntries(lead.customFields) : lead.customFields)
    : {};
  const out = {};
  for (const f of fields) if (raw[f.key] !== undefined) out[f.key] = raw[f.key];
  return out;
}

module.exports = {
  CustomizationError,
  SECTIONS,
  ARRAY_SECTIONS,
  MODULE_CATALOG,
  NAV_ONLY_MODULE_KEYS,
  PALETTE,
  STATUS_CATEGORIES,
  OUTCOME_BEHAVIOURS,
  FOLLOWUP_RULES,
  OUTCOME_GROUPS,
  CUSTOM_FIELD_TYPES,
  buildDefaults,
  resolveCustomization,
  validateSection,
  statusKeysByCategory,
  closedStatusKeys,
  defaultStatusKey,
  findStatus,
  statusCategory,
  findOutcome,
  findTemperature,
  isModuleOn,
  permission,
  buildScheduledFollowUps,
  companyClock,
  companyDateAt,
  companyDayStart,
  tzOffsetMinutes,
  hhmmToMinutes,
  fillTemplate,
  sanitizeCustomFieldValues,
  visibleCustomFields,
  coerceToShape,
};
