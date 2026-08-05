// middlewares/validateObjectId.js
// ─────────────────────────────────────────────────────────────────────────────
// Validates that named route parameters are valid MongoDB ObjectIds before any
// controller runs. Closes two attack vectors:
//
// 1. API ENUMERATION — without this, a request like GET /api/lead/1 or
//    /api/lead/../../etc makes Mongoose throw a CastError that leaks schema
//    information (collection names, field types) in the error message.
//
// 2. IDOR — while your controllers already scope by company, a malformed ID
//    that happens to cast to a valid ObjectId could match an unintended
//    document. Rejecting non-ObjectIds early eliminates that surface.
//
// Usage — single param:
//   router.get("/:id", validateObjectId("id"), getLeadById);
//
// Usage — multiple params:
//   router.delete("/:companyId/user/:userId",
//     validateObjectId("companyId", "userId"), deleteUser);
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

/**
 * Returns Express middleware that validates one or more named route params.
 * Responds 400 with a generic message on failure — no schema details leaked.
 *
 * @param {...string} paramNames - Names of req.params keys to validate.
 */
function validateObjectId(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (value !== undefined && !mongoose.Types.ObjectId.isValid(value)) {
        return res.status(400).json({
          success: false,
          message: `Invalid request — malformed identifier.`,
          // Deliberately no field name or value in the response to avoid
          // leaking schema structure to an enumerating attacker.
        });
      }
    }
    next();
  };
}

module.exports = { validateObjectId };