// utils/festivalTemplateCatalog.js
//
// Static catalog of pre-approved WhatsApp "festival greeting" templates,
// sourced from festival_templates_with_dates.xlsx. Each entry is a
// ready-to-use WhatsApp template name (must already be approved in the
// company's MSG91/Meta WhatsApp Business account) paired with the calendar
// date the festival falls on.
//
// This is intentionally a plain in-code list rather than a DB collection —
// it's shared reference data (not per-company config), rarely changes, and
// needs zero migration/seeding to ship. If templates are added/changed in
// future, just edit this array and redeploy.
//
// `key` is a stable slug used by the frontend/API to reference a catalog
// entry without depending on array order.

"use strict";

const FESTIVAL_TEMPLATE_CATALOG = [
  { key: "ganesh_chaturthi",     templateName: "happy_ganesha_chaturthi",         festivalName: "Ganesh Chaturthi",     date: "2026-09-14" },
  { key: "gandhi_jayanti",       templateName: "skyup_happy_gandhi_jayanti",      festivalName: "Gandhi Jayanti",        date: "2026-10-02" },
  { key: "navratri",             templateName: "skyup_happy_navratri",            festivalName: "Navratri",              date: "2026-10-11" },
  { key: "dussehra",             templateName: "skyup_happy_dussehra",            festivalName: "Dussehra",              date: "2026-10-20" },
  { key: "karwa_chauth",         templateName: "skyup_happy_karwa_chauth",        festivalName: "Karwa Chauth",          date: "2026-10-29" },
  { key: "halloween",            templateName: "skyup_happy_halloween",           festivalName: "Halloween",             date: "2026-10-31" },
  { key: "kannada_rajyotsava",   templateName: "skyup_happy_kannada_rajyotsava",  festivalName: "Kannada Rajyotsava",    date: "2026-11-01" },
  { key: "narak_chaturdashi",    templateName: "skyup_happy_narak_chaturdashi",   festivalName: "Narak Chaturdashi",     date: "2026-11-07" },
  { key: "diwali",               templateName: "skyup_happy_diwali",              festivalName: "Diwali",                date: "2026-11-08" },
  { key: "childrens_day",        templateName: "skyup_happy_childrens_day",       festivalName: "Children's Day",        date: "2026-11-14" },
  { key: "chhath_puja",          templateName: "skyup_happy_chhath_puja",         festivalName: "Chhath Puja",           date: "2026-11-15" },
  { key: "guru_nanak_jayanti",   templateName: "skyup_happy_guru_nanak_jayanti",  festivalName: "Guru Nanak Jayanti",    date: "2026-11-24" },
  { key: "christmas",            templateName: "skyup_merry_christmas",           festivalName: "Christmas",             date: "2026-12-25" },
  { key: "new_year_eve",         templateName: "skyup_happy_new_year_eve",        festivalName: "New Year Eve",          date: "2026-12-31" },
  { key: "new_year_2027",        templateName: "skyup_happy_new_year_2027",       festivalName: "New Year 2027",         date: "2027-01-01" },
];

function getFestivalCatalog() {
  return FESTIVAL_TEMPLATE_CATALOG;
}

function getFestivalCatalogEntry(key) {
  return FESTIVAL_TEMPLATE_CATALOG.find((f) => f.key === key) || null;
}

module.exports = { FESTIVAL_TEMPLATE_CATALOG, getFestivalCatalog, getFestivalCatalogEntry };
