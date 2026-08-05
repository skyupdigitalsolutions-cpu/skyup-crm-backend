// middlewares/errorHandler.js
// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER  (ISO/IEC 27001:2022 — A.8.15 Logging, A.8.16 Monitoring)
//
// A single 4-argument Express error handler that:
//   1. Logs the full error (including stack) to the server console so it is
//      visible in Render logs and searchable in your monitoring system.
//   2. Sends the CLIENT a safe, generic message — never an internal error
//      message, stack trace, or DB schema detail. This closes the
//      "Information Leakage" risk (OWASP A05 / ISO A.8.26).
//   3. Translates known Mongoose/MongoDB error types into meaningful HTTP codes
//      so the frontend can still handle them (e.g. show "already exists").
//
// WIRE-UP (at the END of server.js, after all routes):
//   const { errorHandler } = require('./middlewares/errorHandler');
//   app.use(errorHandler);
//
// Once this is wired, replace the individual:
//   catch (err) { res.status(500).json({ message: err.message }) }
// patterns in controllers with:
//   catch (err) { next(err) }
// The handler covers all of them centrally.
// ─────────────────────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === "development";

/**
 * Map known error types to HTTP status codes and safe client messages.
 */
function classifyError(err) {
  // Mongoose validation error (e.g. required field missing, minlength)
  if (err.name === "ValidationError") {
    const fields = Object.keys(err.errors || {});
    return {
      status: 400,
      message: fields.length
        ? `Validation failed: ${fields.join(", ")}`
        : "Validation failed.",
      code: "VALIDATION_ERROR",
    };
  }

  // MongoDB duplicate key (e.g. unique email already registered)
  if (err.code === 11000 || err.code === 11001) {
    const field = Object.keys(err.keyPattern || {})[0] || "field";
    return {
      status: 409,
      message: `A record with this ${field} already exists.`,
      code: "DUPLICATE_KEY",
    };
  }

  // Mongoose cast error (e.g. invalid ObjectId — should be caught by
  // validateObjectId middleware first, but this is a safety net)
  if (err.name === "CastError") {
    return {
      status: 400,
      message: "Invalid identifier format.",
      code: "CAST_ERROR",
    };
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return { status: 401, message: "Invalid token.", code: "JWT_INVALID" };
  }
  if (err.name === "TokenExpiredError") {
    return { status: 401, message: "Token expired.", code: "JWT_EXPIRED" };
  }

  // Explicit HTTP errors thrown by controllers (err.status set)
  if (err.status && err.status < 500) {
    return {
      status: err.status,
      message: err.message || "Request error.",
      code: err.code || "REQUEST_ERROR",
    };
  }

  // Everything else → 500, no internal detail to client
  return {
    status: 500,
    message: "An internal server error occurred. Please try again later.",
    code: "INTERNAL_ERROR",
  };
}

/**
 * Express global error handler.
 * Must have exactly 4 arguments so Express recognises it as an error handler.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const { status, message, code } = classifyError(err);

  // Always log the full error server-side (visible in Render logs)
  const logPrefix = `[ErrorHandler] ${req.method} ${req.originalUrl} → ${status}`;
  if (status >= 500) {
    console.error(`${logPrefix}\n${err.stack || err.message || err}`);
  } else {
    // 4xx are expected; log at warn level without full stack
    console.warn(`${logPrefix} — ${err.message}`);
  }

  // In development, include the real message to speed up debugging.
  // In production, only the safe message is sent.
  const body = {
    success: false,
    message,
    code,
    ...(IS_DEV && status >= 500 ? { _dev_detail: err.message } : {}),
  };

  res.status(status).json(body);
}

module.exports = { errorHandler };