/**
 * middlewares/phoneNormalizer.js
 *
 * Optional drop-in Express middleware.
 * Normalizes req.body.mobile (and req.body.phone) to last-10-digit form
 * before the request reaches any controller.
 *
 * USAGE — add to any route that accepts a phone number:
 *
 *   const { normalizePhoneMiddleware } = require('../middlewares/phoneNormalizer');
 *
 *   // On a single route:
 *   router.post('/leads', protect, normalizePhoneMiddleware, createLead);
 *
 *   // Or globally in server.js (not recommended — too broad):
 *   app.use(normalizePhoneMiddleware);
 *
 * NOTE: This middleware is OPTIONAL because the Lead model's pre-validate
 * hook already normalizes the phone before saving, and every controller
 * already calls findDuplicateLead() which uses normalizePhone internally.
 * Use this only if you want to ensure req.body itself is clean (e.g. for
 * logging or other middleware that reads req.body.mobile before the controller).
 */

const { normalizePhone } = require('../utils/normalizePhone');

function normalizePhoneMiddleware(req, res, next) {
  const fields = ['mobile', 'phone', 'phoneNumber'];
  for (const field of fields) {
    if (req.body && req.body[field]) {
      const norm = normalizePhone(req.body[field]);
      if (norm) req.body[field] = norm;
      // If norm is null (invalid number), leave as-is — controller will handle it
    }
  }
  next();
}

module.exports = { normalizePhoneMiddleware };
