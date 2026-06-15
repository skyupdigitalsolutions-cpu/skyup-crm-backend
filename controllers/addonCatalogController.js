// controllers/addonCatalogController.js — NEW FILE
// Developer-only CRUD for the add-on price catalogue, plus a PUBLIC endpoint
// the upgrade page calls to render priced, buyable add-on cards.
//
//   GET  /api/developer/addon-catalog          (developer) — full catalogue
//   PUT  /api/developer/addon-catalog           (developer) — bulk upsert
//   PUT  /api/developer/addon-catalog/:addonType (developer) — single upsert
//   GET  /api/subscription/addons               (admin)     — public, plan-filtered

const AddonCatalog = require("../models/AddonCatalog");
const { ADDON_TYPES } = require("../models/CompanyAddon");

// Sensible starting catalogue. Used to seed an empty DB so the developer has
// rows to edit instead of a blank screen. Prices are placeholders (₹) — the
// developer overrides them in the panel. NOT public by default (isPublic:false)
// so nothing goes on sale until the developer explicitly enables it.
const DEFAULT_CATALOG = [
  // ── Resource add-ons ──────────────────────────────────────────────────────
  { addonType: "extra_admin",          name: "Extra Admin",            category: "resource", price: 299,  billingPeriod: "monthly", description: "+1 admin seat" },
  { addonType: "extra_users_5",        name: "5 Extra Users",          category: "resource", price: 499,  billingPeriod: "monthly", description: "+5 user seats" },
  { addonType: "extra_leads_5000",     name: "5,000 Extra Leads",      category: "resource", price: 399,  billingPeriod: "monthly", description: "+5,000 lead capacity" },
  { addonType: "extra_website",        name: "Extra Website",          category: "resource", price: 199,  billingPeriod: "monthly", description: "+1 tracked website" },
  { addonType: "extra_meta_campaign",  name: "Extra Meta Campaign",    category: "resource", price: 299,  billingPeriod: "monthly", description: "+1 Meta campaign" },
  { addonType: "extra_google_account", name: "Extra Google Account",   category: "resource", price: 299,  billingPeriod: "monthly", description: "+1 Google Ads account" },
  { addonType: "storage_1gb",          name: "1 GB Storage",           category: "resource", price: 99,   billingPeriod: "monthly", description: "+1 GB file storage" },
  { addonType: "storage_5gb",          name: "5 GB Storage",           category: "resource", price: 399,  billingPeriod: "monthly", description: "+5 GB file storage" },
  { addonType: "storage_10gb",         name: "10 GB Storage",          category: "resource", price: 699,  billingPeriod: "monthly", description: "+10 GB file storage" },
  // ── Feature add-ons ───────────────────────────────────────────────────────
  { addonType: "call_recording",       name: "Call Recording",         category: "feature",  price: 499,  billingPeriod: "monthly", description: "Store call recordings" },
  { addonType: "call_transcription",   name: "Call Transcription",     category: "feature",  price: 699,  billingPeriod: "monthly", description: "Speech-to-text on calls" },
  { addonType: "ai_summary",           name: "AI Summary",             category: "feature",  price: 699,  billingPeriod: "monthly", description: "AI call summaries" },
  { addonType: "whatsapp_automation",  name: "WhatsApp Automation",    category: "feature",  price: 599,  billingPeriod: "monthly", description: "Auto WhatsApp on new lead" },
  // ── AI credit packs (one-time) ──────────────────────────────────────────────
  { addonType: "transcriptions_100",   name: "100 Transcriptions",     category: "credit",   price: 299,  billingPeriod: "one_time", description: "+100 transcription credits" },
  { addonType: "transcriptions_500",   name: "500 Transcriptions",     category: "credit",   price: 1199, billingPeriod: "one_time", description: "+500 transcription credits" },
  { addonType: "summaries_100",        name: "100 AI Summaries",       category: "credit",   price: 299,  billingPeriod: "one_time", description: "+100 summary credits" },
  { addonType: "summaries_500",        name: "500 AI Summaries",       category: "credit",   price: 1199, billingPeriod: "one_time", description: "+500 summary credits" },
];

async function seedCatalogIfEmpty() {
  const count = await AddonCatalog.countDocuments();
  if (count > 0) return;
  const rows = DEFAULT_CATALOG.map((c, idx) => ({
    ...c,
    currency:     "INR",
    isPublic:     false,
    visiblePlans: [],
    maxQuantity:  c.category === "feature" ? 1 : 10,
    sortOrder:    idx,
    isActive:     true,
  }));
  await AddonCatalog.insertMany(rows, { ordered: false }).catch((e) => {
    // ordered:false still inserts the valid rows; log and continue.
    console.warn("[addonCatalog] seed partial:", e.message);
  });
  console.log("[addonCatalog] Seeded default add-on catalogue rows.");
}

// ── GET /api/developer/addon-catalog ──────────────────────────────────────────
const getCatalog = async (req, res) => {
  try {
    await seedCatalogIfEmpty();
    const items = await AddonCatalog.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({ success: true, items });
  } catch (err) {
    console.error("[getCatalog]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Whitelist of fields the developer may set — never trust the whole body.
const EDITABLE = [
  "name", "description", "category", "price", "currency", "billingPeriod",
  "isPublic", "visiblePlans", "maxQuantity", "sortOrder", "isActive",
];

function sanitize(cfg) {
  const out = {};
  for (const key of EDITABLE) {
    if (cfg[key] === undefined) continue;
    if (key === "price")        out.price        = Math.max(0, Number(cfg.price) || 0);
    else if (key === "maxQuantity") out.maxQuantity = Math.max(1, parseInt(cfg.maxQuantity, 10) || 1);
    else if (key === "sortOrder")   out.sortOrder   = Number(cfg.sortOrder) || 0;
    else if (key === "isPublic")    out.isPublic    = !!cfg.isPublic;
    else if (key === "isActive")    out.isActive    = !!cfg.isActive;
    else if (key === "currency")    out.currency    = (cfg.currency || "INR").toString().toUpperCase().trim() || "INR";
    else if (key === "visiblePlans")
      out.visiblePlans = Array.isArray(cfg.visiblePlans)
        ? cfg.visiblePlans.map(String).map(s => s.trim().toLowerCase()).filter(Boolean)
        : [];
    else out[key] = cfg[key];
  }
  return out;
}

// ── PUT /api/developer/addon-catalog/:addonType ───────────────────────────────
const upsertCatalogItem = async (req, res) => {
  try {
    const { addonType } = req.params;
    if (!ADDON_TYPES.includes(addonType)) {
      return res.status(400).json({ success: false, message: `Unknown addonType "${addonType}".` });
    }
    const update = sanitize(req.body || {});
    update.addonType = addonType;
    if (!update.name) update.name = addonType;

    const item = await AddonCatalog.findOneAndUpdate(
      { addonType },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, item });
  } catch (err) {
    console.error("[upsertCatalogItem]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/developer/addon-catalog (bulk) ───────────────────────────────────
// Body: { items: [{ addonType, ...fields }] }
const saveCatalog = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) {
      return res.status(400).json({ success: false, message: "Body must be { items: [...] }." });
    }

    let saved = 0;
    const skipped = [];
    const errors = [];

    for (const cfg of items) {
      if (!cfg || !cfg.addonType) { skipped.push("(missing addonType)"); continue; }
      if (!ADDON_TYPES.includes(cfg.addonType)) { skipped.push(cfg.addonType); continue; }
      try {
        const update = sanitize(cfg);
        update.addonType = cfg.addonType;
        if (!update.name) update.name = cfg.addonType;
        await AddonCatalog.findOneAndUpdate(
          { addonType: cfg.addonType },
          { $set: update },
          { upsert: true, setDefaultsOnInsert: true, runValidators: true }
        );
        saved++;
      } catch (e) {
        errors.push(`${cfg.addonType}: ${e.message}`);
      }
    }

    if (errors.length && saved === 0) {
      return res.status(400).json({ success: false, message: errors.join("; "), skipped });
    }
    res.json({ success: true, saved, skipped, errors });
  } catch (err) {
    console.error("[saveCatalog]", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/subscription/addons (PUBLIC to logged-in admins) ─────────────────
// Returns only public, active add-ons visible for the caller's current plan.
// Used by the upgrade page to render priced, buyable cards.
const getPublicAddons = async (req, res) => {
  try {
    await seedCatalogIfEmpty();

    // req.admin.company.plan is populated by protectAdmin middleware.
    const planKey = req.admin?.company?.plan || req.query.plan || null;

    const items = await AddonCatalog.find({ isPublic: true, isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const visible = items.filter(it =>
      !planKey ||
      !Array.isArray(it.visiblePlans) ||
      it.visiblePlans.length === 0 ||
      it.visiblePlans.includes(planKey)
    );

    // Strip internal fields; expose only what the card needs.
    const addons = visible.map(it => ({
      addonType:     it.addonType,
      name:          it.name,
      description:   it.description,
      category:      it.category,
      price:         it.price,
      currency:      it.currency,
      billingPeriod: it.billingPeriod,
      maxQuantity:   it.maxQuantity,
    }));

    res.json({ success: true, plan: planKey, addons });
  } catch (err) {
    console.error("[getPublicAddons]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getCatalog,
  upsertCatalogItem,
  saveCatalog,
  getPublicAddons,
  seedCatalogIfEmpty,
  DEFAULT_CATALOG,
};
