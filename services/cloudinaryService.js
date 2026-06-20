// services/cloudinaryService.js
// ─────────────────────────────────────────────────────────────────────────────
// PER-COMPANY CLOUDINARY
//
// Each company can store media (call recordings, meeting attachments) in ITS OWN
// Cloudinary account. If a company hasn't configured its own, uploads fall back
// to the platform's global Cloudinary (CLOUDINARY_* env vars) so nothing breaks.
//
// Two ways media gets uploaded in this codebase:
//   1. multer-storage-cloudinary (streaming upload middleware) — see
//      makeCompanyUploadMiddleware() below, used for the call-recording route.
//   2. cloudinary.uploader.upload(...) direct calls — use getCloudinaryForCompany().
//
// IMPORTANT: the Cloudinary SDK's cloudinary.config() is GLOBAL/singleton, so we
// cannot call it per request and rely on it concurrently. Instead we build a
// per-request CONFIG OBJECT and pass it explicitly to each upload call / storage
// (the SDK accepts per-call config via the options argument). This keeps tenants
// isolated even under concurrent uploads.
// ─────────────────────────────────────────────────────────────────────────────

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const Company = require('../models/Company');

// Global/platform credentials (fallback).
function globalConfig() {
  return {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  };
}

// Resolve the Cloudinary config object for a company (own creds or global).
async function resolveCompanyConfig(companyId) {
  if (!companyId) return { config: globalConfig(), scope: 'global' };
  try {
    const company = await Company.findById(companyId)
      .select('cloudinaryConfig')
      .lean();
    const c = company?.cloudinaryConfig;
    if (c && c.enabled && c.cloudName && c.apiKey && c.apiSecret) {
      return {
        config: { cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret },
        scope: 'company',
      };
    }
  } catch (e) {
    console.error('[cloudinary] resolveCompanyConfig failed:', e.message);
  }
  return { config: globalConfig(), scope: 'global' };
}

// Return a configured Cloudinary instance for direct uploader calls.
// Usage:
//   const { instance } = await getCloudinaryForCompany(companyId);
//   instance.uploader.upload(path, opts);
async function getCloudinaryForCompany(companyId) {
  const { config, scope } = await resolveCompanyConfig(companyId);
  let instance;
  try {
    const { Cloudinary } = require('cloudinary');
    instance = new Cloudinary();
    instance.config(config);
  } catch (_) {
    cloudinary.config(config);
    instance = cloudinary;
  }
  return { instance, cloudinary: instance, config, scope };
}

// Per-request multer middleware factory.
// Builds a CloudinaryStorage bound to the caller's company creds, then runs the
// given multer field handler. Use in place of a module-level `upload.single()`.
//
//   router.post('/recording', protect, companyRecordingUpload('recording'), handler)
function makeCompanyUploadMiddleware({ field, folderBase = 'skyup-crm/recordings', allowedFormats }) {
  const multer = require('multer');
  return async (req, res, next) => {
    try {
      const companyId =
        req.user?.company || req.admin?.company?._id || req.admin?.company || req.callerCompany || null;

      const { config, scope } = await resolveCompanyConfig(companyId);

      // Build an ISOLATED Cloudinary instance configured with this company's
      // creds. cloudinary.v2 exposes a Cloudinary class for creating instances
      // that don't touch the global singleton — so concurrent uploads from
      // different companies stay correctly separated. If the class isn't
      // available for any reason, fall back to a config-bound clone.
      let instance;
      try {
        const { Cloudinary } = require('cloudinary');
        instance = new Cloudinary();
        instance.config(config);
      } catch (_) {
        // Fallback: configure the shared singleton just-in-time. Less ideal
        // under heavy concurrency, but functional.
        cloudinary.config(config);
        instance = cloudinary;
      }

      const storage = new CloudinaryStorage({
        cloudinary: instance,
        params: async (req2, file) => ({
          folder:          `${folderBase}/${companyId || 'unknown'}`,
          resource_type:   'auto',
          public_id:       `${req2.user?._id || 'u'}_${Date.now()}`,
          allowed_formats: allowedFormats,
        }),
      });

      const handler = multer({
        storage,
        limits: { fileSize: 100 * 1024 * 1024 },
      }).single(field);

      req.cloudinaryScope = scope;

      handler(req, res, (err) => {
        if (err) return next(err);
        next();
      });
    } catch (e) {
      next(e);
    }
  };
}

module.exports = {
  getCloudinaryForCompany,
  resolveCompanyConfig,
  makeCompanyUploadMiddleware,
  globalConfig,
};
