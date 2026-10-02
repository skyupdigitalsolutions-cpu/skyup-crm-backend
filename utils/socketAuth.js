// utils/socketAuth.js
// ─────────────────────────────────────────────────────────────────────────────
// Socket.IO authentication.
//
// Before: any socket could connect with no token and join ANY room just by
// naming it ("wa_company_<otherCompanyId>", "agent:<someoneElse>", …) and the
// global "wa_admin" room received WhatsApp traffic of EVERY company.
//
// Now: the JWT sent by the client (handshake.auth.token, ?token= or an
// Authorization header) is verified once on connect and the identity is
// stored on socket.data.auth. Every join handler uses THAT identity — ids sent
// in the event payload are ignored — so a socket can only ever join its own
// rooms inside its own company.
//
// Connections without a valid token are still accepted (so an old client
// never gets stuck in a reconnect loop), but they cannot join any room and
// therefore receive nothing.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { loadUser, loadAdminWithCompany } = require('../middlewares/authMiddleware');

let _isBlacklisted = null;
function isBlacklisted(token) {
  try {
    if (!_isBlacklisted) _isBlacklisted = require('../middlewares/rateLimiter').isTokenBlacklisted;
    return _isBlacklisted ? _isBlacklisted(token) : false;
  } catch { return false; }
}

const idStr = (v) => (v == null ? null : String(v._id || v));

function tokenFromHandshake(hs = {}) {
  const fromAuth = hs.auth && typeof hs.auth.token === 'string' ? hs.auth.token : null;
  const fromQuery = hs.query && typeof hs.query.token === 'string' ? hs.query.token : null;
  const h = hs.headers && hs.headers.authorization;
  const fromHeader = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
  const t = (fromAuth || fromQuery || fromHeader || '').replace(/^Bearer\s+/i, '').trim();
  return t || null;
}

/**
 * Turn a raw JWT into a socket identity, or null.
 *   { kind: 'employee', id, company, adminId, name }
 *   { kind: 'admin', role: 'admin'|'super_admin'|'marketing_user', id, company, name }
 *   { kind: 'platform', role, id }   // legacy SuperAdmin / developer (no company)
 */
async function resolveIdentity(token) {
  if (!token) return null;
  if (await isBlacklisted(token)) return null;

  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
  if (!decoded || !decoded.id || decoded.t) return null; // OAuth state tokens etc.

  const role = decoded.role === 'superadmin' ? 'super_admin' : decoded.role;

  if (!role || role === 'user' || role === 'employee') {
    const u = await loadUser(decoded.id);
    if (!u) return null;
    return {
      kind: 'employee',
      role: 'employee',
      id: idStr(u._id),
      company: idStr(u.company),
      adminId: idStr(u.createdBy),
      name: u.name || '',
    };
  }

  if (role === 'admin' || role === 'super_admin' || role === 'marketing_user') {
    const a = await loadAdminWithCompany(decoded.id);
    if (a) {
      return {
        kind: 'admin',
        role: a.role === 'superadmin' ? 'super_admin' : (a.role || role),
        id: idStr(a._id),
        company: idStr(a.company),
        name: a.name || '',
      };
    }
    // Legacy platform-level SuperAdmin (no company of its own)
    if (role === 'super_admin') {
      try {
        const SuperAdmin = require('../models/SuperAdmin');
        const sa = await SuperAdmin.findById(decoded.id).select('_id name').lean();
        if (sa) return { kind: 'platform', role: 'super_admin', id: idStr(sa._id), company: null, name: sa.name || '' };
      } catch { /* ignore */ }
    }
    return null;
  }

  if (role === 'developer') return { kind: 'platform', role: 'developer', id: idStr(decoded.id), company: null, name: '' };
  return null;
}

/** io.use() middleware — never rejects, just attaches socket.data.auth. */
function socketAuthMiddleware(socket, next) {
  const token = tokenFromHandshake(socket.handshake);
  resolveIdentity(token)
    .then((ident) => { socket.data.auth = ident || null; next(); })
    .catch(() => { socket.data.auth = null; next(); });
}

module.exports = { socketAuthMiddleware, resolveIdentity, tokenFromHandshake };
