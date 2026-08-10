// controllers/sheetIntegrationController.js — NEW
// ─────────────────────────────────────────────────────────────────────────────
// Employee Excel / Google Sheet integration.
//
// COMPLETELY INDEPENDENT of Daily Reports, Telegram and campaign reporting.
//
// Reuses existing CRM patterns:
//   • Company isolation      — every query is scoped to req.sheetCompanyId
//                              (resolved + verified by sheetIntegrationAccess
//                              middleware) and, for employee ops, to
//                              req.sheetEmployeeId.
//   • Lead dedup             — same phone-normalisation + company-scoped
//                              normalizedPhone/normalizedSecondaryPhone lookup
//                              used by websiteWebhookController / leadController,
//                              PLUS a row-reference external id stored in the
//                              existing `leadgenId` field (company-scoped unique
//                              partial index) so re-syncing the same row is
//                              idempotent (Section 7).
//   • Encryption at rest     — the secret lives on SheetConnection.secretKey,
//                              encrypted by fieldCrypto (never returned raw).
//   • Entitlement cache      — admin toggle invalidates it so the derived
//                              ent.googleSheetIntegrationEnabled recomputes.
// ─────────────────────────────────────────────────────────────────────────────

const axios   = require("axios");
const Company = require("../models/Company");
const Lead    = require("../models/Leads");
const SheetConnection = require("../models/SheetConnection");
const { normalizePhone } = require("../utils/normalizePhone");
const { invalidateEntitlementCache } = require("../services/entitlementService");

// ── Mappable CRM fields (Section 6) — mirrors the CSV import field set ─────────
const CRM_FIELDS = [
  { key: "name",           label: "Full Name",       aliases: ["name", "full name", "fullname", "customer name", "lead name", "contact name"] },
  { key: "mobile",         label: "Phone Number",    aliases: ["mobile", "phone", "phone number", "primary number", "primary phone", "contact", "contact number", "whatsapp", "mobile number", "phonenumber"] },
  { key: "secondaryPhone", label: "Secondary Phone", aliases: ["secondary phone", "secondary number", "additional number", "alternate number", "alternate phone", "phone 2"] },
  { key: "email",          label: "Email",           aliases: ["email", "email id", "e-mail", "email address", "mail"] },
  { key: "status",         label: "Lead Status",     aliases: ["status", "lead status", "stage"] },
  { key: "campaign",       label: "Campaign",        aliases: ["campaign", "source campaign", "ad campaign"] },
  { key: "source",         label: "Source",          aliases: ["source", "lead source"] },
  { key: "remark",         label: "Remark / Notes",  aliases: ["remark", "remarks", "notes", "note", "message", "comment", "comments", "description"] },
  { key: "followUpDate",   label: "Follow-up Date",  aliases: ["follow-up date", "follow up date", "followup date", "next follow up", "followup"] },
];
const CRM_FIELD_KEYS = CRM_FIELDS.map((f) => f.key);

// Suggest a mapping by matching sheet headers to CRM field aliases.
function autoSuggestMapping(headers = []) {
  return headers
    .map((h) => {
      const norm = String(h || "").trim().toLowerCase();
      const match = CRM_FIELDS.find((f) => f.aliases.includes(norm));
      return match ? { sheetColumn: h, crmField: match.key } : null;
    })
    .filter(Boolean);
}

// ── Apps Script Web App client (the "pull" model, Section 5) ──────────────────
// The CRM calls the employee's deployed Apps Script Web App, passing the shared
// secret. The script reads the sheet and returns { ok, headers, rows, rowCount }.
// Tries POST(JSON) first (preferred), falls back to GET(query) for doGet-only
// deployments. Follows the 302 redirect to script.googleusercontent.com that
// Apps Script uses (axios follows redirects by default).
async function callAppsScript({ appsScriptUrl, secretKey, googleSheetId, sheetName, action }) {
  if (!appsScriptUrl || !/^https:\/\//i.test(appsScriptUrl)) {
    throw new Error("A valid https Apps Script Web App URL is required.");
  }
  const payload = { secret: secretKey, sheetId: googleSheetId || "", sheetName: sheetName || "", action };

  let data;
  try {
    const resp = await axios.post(appsScriptUrl, payload, {
      timeout: 25000,
      maxRedirects: 5,
      headers: { "Content-Type": "application/json" },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    data = resp.data;
  } catch (postErr) {
    // Fallback: GET with query params (doGet-only deployments)
    try {
      const resp = await axios.get(appsScriptUrl, {
        params: payload,
        timeout: 25000,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      data = resp.data;
    } catch (getErr) {
      const msg = getErr.response
        ? `Apps Script returned HTTP ${getErr.response.status}`
        : getErr.message;
      throw new Error(`Could not reach the Apps Script Web App. ${msg}`);
    }
  }

  // Apps Script sometimes returns a string (if ContentService wasn't used)
  if (typeof data === "string") {
    try { data = JSON.parse(data); }
    catch { throw new Error("Apps Script did not return JSON. Check the deployment returns ContentService JSON."); }
  }
  if (!data || typeof data !== "object") throw new Error("Empty response from Apps Script.");
  if (data.ok === false) throw new Error(data.error || "Apps Script reported an error (check the secret key).");

  return {
    sheetName: data.sheetName || sheetName || "",
    headers:   Array.isArray(data.headers) ? data.headers : [],
    rows:      Array.isArray(data.rows) ? data.rows : [],
    rowCount:  Number(data.rowCount) || (Array.isArray(data.rows) ? data.rows.length : 0),
  };
}

// Return a connection object safe to send to the client (never the raw secret).
function publicConnection(conn) {
  if (!conn) return null;
  const o = conn.toObject ? conn.toObject() : conn;
  return {
    _id:            o._id,
    sheetName:      o.sheetName,
    googleSheetId:  o.googleSheetId,
    appsScriptUrl:  o.appsScriptUrl,
    secretKeySet:   !!o.secretKey,          // whether a secret is stored — never the value
    columnMapping:  o.columnMapping || [],
    defaultStatus:  o.defaultStatus,
    defaultRemark:  o.defaultRemark,
    isActive:       o.isActive,
    lastSyncAt:     o.lastSyncAt,
    lastSyncStatus: o.lastSyncStatus,
    lastSyncMessage:o.lastSyncMessage,
    lastSyncStats:  o.lastSyncStats,
    lastTestedAt:   o.lastTestedAt,
    createdAt:      o.createdAt,
    updatedAt:      o.updatedAt,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// EMPLOYEE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/sheet-integration/status
// Soft endpoint (no hard gate) so the frontend can decide whether to show the
// panel option at all. Returns access flags + whether a connection exists.
const getStatus = async (req, res) => {
  try {
    const companyId  = req.user?.company?._id || req.user?.company || req.companyId;
    const employeeId = req.user?._id;
    if (!companyId || !employeeId) {
      return res.status(401).json({ success: false, message: "No context" });
    }

    const { getCompanyEntitlements } = require("../services/entitlementService");
    const ent = await getCompanyEntitlements(companyId);
    const company = await Company.findById(companyId).select("employeeSheetIntegration").lean();
    const cfg = company?.employeeSheetIntegration || {};

    const available = !!ent?.googleSheetIntegration;
    const enabled   = !!(available && cfg.enabled);

    const hasConnection = enabled
      ? !!(await SheetConnection.exists({ company: companyId, employee: employeeId }))
      : false;

    return res.json({
      success: true,
      available,
      enabled,
      permissions: {
        allowConnect:    cfg.allowConnect    !== false,
        allowEdit:       cfg.allowEdit       !== false,
        allowDisconnect: cfg.allowDisconnect !== false,
        allowManualSync: cfg.allowManualSync !== false,
      },
      hasConnection,
      crmFields: CRM_FIELDS.map(({ key, label }) => ({ key, label })),
    });
  } catch (err) {
    console.error("[sheet:getStatus]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/sheet-integration/me — this employee's connection (masked)
const getMyConnection = async (req, res) => {
  try {
    const conn = await SheetConnection.findOne({
      company:  req.sheetCompanyId,
      employee: req.sheetEmployeeId,
    });
    return res.json({
      success: true,
      connection: publicConnection(conn),
      permissions: req.sheetPermissions,
      crmFields: CRM_FIELDS.map(({ key, label }) => ({ key, label })),
    });
  } catch (err) {
    console.error("[sheet:getMyConnection]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/sheet-integration/test — Test Connection (does NOT persist)
// body: { sheetName?, googleSheetId, appsScriptUrl, secretKey? }
// If secretKey omitted and a connection exists, reuse the stored (decrypted) one.
const testConnection = async (req, res) => {
  try {
    const { sheetName = "", googleSheetId = "", appsScriptUrl = "" } = req.body || {};
    let secretKey = req.body?.secretKey || "";

    if (!secretKey) {
      const existing = await SheetConnection.findOne({
        company: req.sheetCompanyId, employee: req.sheetEmployeeId,
      });
      if (existing?.secretKey) secretKey = existing.secretKey; // decrypted on read
    }
    if (!appsScriptUrl) return res.status(400).json({ success: false, message: "Apps Script Web App URL is required." });
    if (!secretKey)     return res.status(400).json({ success: false, message: "Secret key is required." });

    const result = await callAppsScript({ appsScriptUrl, secretKey, googleSheetId, sheetName, action: "preview" });

    // Persist lastTestedAt only if a connection already exists (don't create one on test)
    await SheetConnection.updateOne(
      { company: req.sheetCompanyId, employee: req.sheetEmployeeId },
      { $set: { lastTestedAt: new Date() } }
    ).catch(() => {});

    return res.json({
      success: true,
      message: `Connected. Found ${result.headers.length} columns and ${result.rowCount} rows.`,
      sheetName:      result.sheetName,
      headers:        result.headers,
      sampleRows:     result.rows.slice(0, 5),
      rowCount:       result.rowCount,
      suggestedMapping: autoSuggestMapping(result.headers),
    });
  } catch (err) {
    console.error("[sheet:testConnection]", err.message);
    return res.status(400).json({ success: false, message: err.message });
  }
};

// POST /api/sheet-integration/connect (create) — allowConnect
// PUT  /api/sheet-integration/connection (edit) — allowEdit
// body: { sheetName, googleSheetId, appsScriptUrl, secretKey?, columnMapping?, defaultStatus?, defaultRemark? }
const saveConnection = async (req, res) => {
  try {
    const {
      sheetName = "", googleSheetId = "", appsScriptUrl = "",
      columnMapping, defaultStatus, defaultRemark,
    } = req.body || {};
    const secretKey = req.body?.secretKey || "";

    const existing = await SheetConnection.findOne({
      company: req.sheetCompanyId, employee: req.sheetEmployeeId,
    });

    if (!appsScriptUrl) return res.status(400).json({ success: false, message: "Apps Script Web App URL is required." });
    // On CREATE a secret is required; on EDIT an empty secret means "keep existing".
    if (!existing && !secretKey) {
      return res.status(400).json({ success: false, message: "Secret key is required to connect." });
    }

    const set = {
      company:  req.sheetCompanyId,
      employee: req.sheetEmployeeId,
      sheetName:     String(sheetName || "").trim(),
      googleSheetId: String(googleSheetId || "").trim(),
      appsScriptUrl: String(appsScriptUrl || "").trim(),
    };
    if (secretKey) set.secretKey = secretKey; // encrypted at rest by the plugin
    if (Array.isArray(columnMapping)) {
      set.columnMapping = columnMapping
        .filter((m) => m && m.sheetColumn && CRM_FIELD_KEYS.includes(m.crmField))
        .map((m) => ({ sheetColumn: String(m.sheetColumn), crmField: String(m.crmField) }));
    }
    if (defaultStatus !== undefined) set.defaultStatus = String(defaultStatus || "New");
    if (defaultRemark !== undefined) set.defaultRemark = String(defaultRemark || "Lead from Google Sheet");

    const conn = await SheetConnection.findOneAndUpdate(
      { company: req.sheetCompanyId, employee: req.sheetEmployeeId },
      { $set: set },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.json({
      success: true,
      message: existing ? "Connection updated." : "Google Sheet connected.",
      connection: publicConnection(conn),
    });
  } catch (err) {
    console.error("[sheet:saveConnection]", err.message);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "A connection already exists for this employee." });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/sheet-integration/mapping — save column mapping (allowEdit)
const saveMapping = async (req, res) => {
  try {
    const { columnMapping } = req.body || {};
    if (!Array.isArray(columnMapping)) {
      return res.status(400).json({ success: false, message: "columnMapping must be an array." });
    }
    const clean = columnMapping
      .filter((m) => m && m.sheetColumn && CRM_FIELD_KEYS.includes(m.crmField))
      .map((m) => ({ sheetColumn: String(m.sheetColumn), crmField: String(m.crmField) }));

    const conn = await SheetConnection.findOneAndUpdate(
      { company: req.sheetCompanyId, employee: req.sheetEmployeeId },
      { $set: { columnMapping: clean } },
      { new: true }
    );
    if (!conn) return res.status(404).json({ success: false, message: "No connection to update." });

    return res.json({ success: true, message: "Column mapping saved.", connection: publicConnection(conn) });
  } catch (err) {
    console.error("[sheet:saveMapping]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/sheet-integration/sync — Sync Now (allowManualSync)
const syncNow = async (req, res) => {
  try {
    const conn = await SheetConnection.findOne({
      company: req.sheetCompanyId, employee: req.sheetEmployeeId,
    });
    if (!conn)            return res.status(404).json({ success: false, message: "No connection found. Connect a sheet first." });
    if (!conn.secretKey)  return res.status(400).json({ success: false, message: "Connection is missing its secret key. Re-connect." });
    if (!conn.appsScriptUrl) return res.status(400).json({ success: false, message: "Connection is missing the Apps Script URL. Re-connect." });

    const mapping = (conn.columnMapping || []).reduce((acc, m) => {
      acc[m.sheetColumn] = m.crmField; return acc;
    }, {});
    if (Object.keys(mapping).length === 0) {
      return res.status(400).json({ success: false, message: "Map at least one column before syncing." });
    }

    const { rows } = await callAppsScript({
      appsScriptUrl: conn.appsScriptUrl,
      secretKey:     conn.secretKey,
      googleSheetId: conn.googleSheetId,
      sheetName:     conn.sheetName,
      action:        "rows",
    });

    const companyId  = req.sheetCompanyId;
    const employeeId = req.sheetEmployeeId;

    let created = 0, duplicates = 0, errors = 0;
    const errorDetails = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      // Stable row reference for idempotent re-sync (Section 7).
      const rowRef = row._row ?? row.__row ?? row.rowNumber ?? (i + 2); // +2: header row + 1-based
      const externalRecordId = `gsheet:${conn._id}:${rowRef}`;

      // Apply the mapping — pull values out of the row by mapped header.
      const mapped = {};
      for (const [sheetCol, crmField] of Object.entries(mapping)) {
        if (row[sheetCol] !== undefined && row[sheetCol] !== null && String(row[sheetCol]).trim() !== "") {
          mapped[crmField] = String(row[sheetCol]).trim();
        }
      }

      const normPrimary   = mapped.mobile ? normalizePhone(mapped.mobile) : null;
      const normSecondary = mapped.secondaryPhone ? normalizePhone(mapped.secondaryPhone) : null;

      // Lead schema REQUIRES mobile — a row without a usable phone can't create a lead.
      if (!normPrimary) {
        errors++;
        errorDetails.push({ row: rowRef, message: "No valid phone number — skipped" });
        continue;
      }

      // ── Dedup #1 — external row reference (idempotent re-sync) ──────────────
      const existingByRef = await Lead.findOne(
        { company: companyId, leadgenId: externalRecordId },
        { _id: 1 }
      ).lean();
      if (existingByRef) { duplicates++; continue; }

      // ── Dedup #2 — phone (same logic as website webhook / CSV import) ───────
      const phoneDupe = await Lead.findOne({
        company: companyId,
        $or: [
          { normalizedPhone:          normPrimary },
          { normalizedSecondaryPhone: normPrimary },
          ...(normSecondary ? [
            { normalizedPhone:          normSecondary },
            { normalizedSecondaryPhone: normSecondary },
          ] : []),
        ],
      }, { _id: 1 }).lean();
      if (phoneDupe) { duplicates++; continue; }

      // Optional follow-up date → scheduled follow-up call entry
      let scheduledCalls = [];
      if (mapped.followUpDate) {
        const d = new Date(mapped.followUpDate);
        if (!isNaN(d.getTime())) scheduledCalls = [{ type: "follow-up", scheduledAt: d }];
      }

      try {
        await Lead.create({
          name:   mapped.name || "Unknown",
          mobile: normPrimary,
          primaryPhone: normPrimary,
          normalizedPhone: normPrimary,
          secondaryPhone: normSecondary ? mapped.secondaryPhone : null,
          normalizedSecondaryPhone: (normSecondary && normSecondary !== normPrimary) ? normSecondary : null,
          email:  mapped.email || "",
          // Section 7 — track the external source explicitly.
          source: mapped.source || "Google Sheet",
          campaign: mapped.campaign || conn.sheetName || null,
          leadgenId: externalRecordId,          // reuses company_leadgenId_unique index
          importedViaCsv: true,                 // treat like an import (excludes "not answered" automation)
          status: mapped.status || conn.defaultStatus || "New",
          date:   new Date(),
          remark: mapped.remark || conn.defaultRemark || "Lead from Google Sheet",
          user:   employeeId,                   // assigned to the connecting employee (their accessible data)
          company: companyId,
          ...(scheduledCalls.length ? { scheduledCalls } : {}),
        });
        created++;
      } catch (createErr) {
        if (createErr.code === 11000) { duplicates++; continue; } // race / index dupe
        errors++;
        errorDetails.push({ row: rowRef, message: createErr.message });
      }
    }

    const stats = { totalRows: rows.length, created, duplicates, errors };
    await SheetConnection.updateOne(
      { _id: conn._id },
      { $set: {
          lastSyncAt: new Date(),
          lastSyncStatus: "success",
          lastSyncMessage: `${created} created, ${duplicates} duplicates, ${errors} errors`,
          lastSyncStats: stats,
      } }
    );

    return res.json({
      success: true,
      message: `Sync complete — ${created} new lead${created === 1 ? "" : "s"}, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped${errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}.`,
      stats,
      errorDetails: errorDetails.slice(0, 20),
    });
  } catch (err) {
    console.error("[sheet:syncNow]", err.message);
    await SheetConnection.updateOne(
      { company: req.sheetCompanyId, employee: req.sheetEmployeeId },
      { $set: { lastSyncAt: new Date(), lastSyncStatus: "error", lastSyncMessage: err.message } }
    ).catch(() => {});
    return res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /api/sheet-integration/connection — Disconnect (allowDisconnect)
const disconnect = async (req, res) => {
  try {
    const r = await SheetConnection.deleteOne({
      company: req.sheetCompanyId, employee: req.sheetEmployeeId,
    });
    if (r.deletedCount === 0) return res.status(404).json({ success: false, message: "No connection to disconnect." });
    return res.json({ success: true, message: "Disconnected. Synced leads are kept." });
  } catch (err) {
    console.error("[sheet:disconnect]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (company control — Section 9)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/sheet-integration/admin/settings
const getAdminSettings = async (req, res) => {
  try {
    const companyId = req.sheetCompanyId;
    const company = await Company.findById(companyId).select("employeeSheetIntegration").lean();
    const cfg = company?.employeeSheetIntegration || {};
    const connectedEmployees = await SheetConnection.countDocuments({ company: companyId });

    return res.json({
      success: true,
      settings: {
        enabled:         !!cfg.enabled,
        allowConnect:    cfg.allowConnect    !== false,
        allowEdit:       cfg.allowEdit       !== false,
        allowDisconnect: cfg.allowDisconnect !== false,
        allowManualSync: cfg.allowManualSync !== false,
      },
      connectedEmployees,
    });
  } catch (err) {
    console.error("[sheet:getAdminSettings]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/sheet-integration/admin/settings
// body: { enabled?, allowConnect?, allowEdit?, allowDisconnect?, allowManualSync? }
const updateAdminSettings = async (req, res) => {
  try {
    const companyId = req.sheetCompanyId;
    const body = req.body || {};
    const set = {};
    const BOOL_FIELDS = ["enabled", "allowConnect", "allowEdit", "allowDisconnect", "allowManualSync"];
    for (const f of BOOL_FIELDS) {
      if (body[f] !== undefined) set[`employeeSheetIntegration.${f}`] = Boolean(body[f]);
    }
    if (Object.keys(set).length === 0) {
      return res.status(400).json({ success: false, message: "No settings provided." });
    }

    await Company.findByIdAndUpdate(companyId, { $set: set });

    // The derived ent.googleSheetIntegrationEnabled depends on
    // employeeSheetIntegration.enabled — invalidate the cache so the sidebar /
    // route gate refreshes on the next request.
    await invalidateEntitlementCache(companyId);

    const company = await Company.findById(companyId).select("employeeSheetIntegration").lean();
    const cfg = company?.employeeSheetIntegration || {};
    return res.json({
      success: true,
      message: "Settings saved.",
      settings: {
        enabled:         !!cfg.enabled,
        allowConnect:    cfg.allowConnect    !== false,
        allowEdit:       cfg.allowEdit       !== false,
        allowDisconnect: cfg.allowDisconnect !== false,
        allowManualSync: cfg.allowManualSync !== false,
      },
    });
  } catch (err) {
    console.error("[sheet:updateAdminSettings]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/sheet-integration/admin/connections — oversight list (company-scoped)
const adminListConnections = async (req, res) => {
  try {
    const companyId = req.sheetCompanyId;
    const conns = await SheetConnection.find({ company: companyId })
      .populate("employee", "name email")
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({
      success: true,
      connections: conns.map((c) => ({
        _id:          c._id,
        employee:     c.employee ? { _id: c.employee._id, name: c.employee.name, email: c.employee.email } : null,
        sheetName:    c.sheetName,
        googleSheetId:c.googleSheetId,
        isActive:     c.isActive,
        secretKeySet: !!c.secretKey,
        lastSyncAt:   c.lastSyncAt,
        lastSyncStatus: c.lastSyncStatus,
        lastSyncStats:  c.lastSyncStats,
        mappedColumns:  (c.columnMapping || []).length,
        updatedAt:    c.updatedAt,
      })),
    });
  } catch (err) {
    console.error("[sheet:adminListConnections]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  // employee
  getStatus,
  getMyConnection,
  testConnection,
  saveConnection,
  saveMapping,
  syncNow,
  disconnect,
  // admin
  getAdminSettings,
  updateAdminSettings,
  adminListConnections,
  // exported for tests / reuse
  CRM_FIELDS,
  autoSuggestMapping,
};
