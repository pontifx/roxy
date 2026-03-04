/**
 * session-manager/src/middleware/auth.js
 *
 * JWT Authentication Middleware
 *
 * Provides:
 *   requireAuth      — Verifies any valid JWT (host or buyer)
 *   requireRole(role) — Factory for role-specific middleware (host or buyer)
 *
 * JWT Payload shape (set at login):
 *   { id, email, role: 'host'|'buyer', iat, exp }
 *
 * Usage in routes:
 *   router.get('/earnings', requireAuth, requireRole('host'), handler)
 *   router.post('/claim', requireAuth, requireRole('buyer'), handler)
 */

'use strict';

const jwt = require('jsonwebtoken');

// Fall back to a hard-coded dev secret so the service starts without
// configuration. CRITICAL: Set JWT_SECRET in production — this default
// is public and provides zero security.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const JWT_TTL = parseInt(process.env.JWT_TTL || '900', 10);  // 15 minutes default

/**
 * Issue a signed JWT for a user.
 * Called from auth.js route after successful login.
 *
 * @param {{ id: string, email: string, role: 'host'|'buyer' }} payload
 * @returns {string} signed JWT
 */
function signToken(payload) {
  return jwt.sign(
    { id: payload.id, email: payload.email, role: payload.role },
    JWT_SECRET,
    { expiresIn: JWT_TTL }
  );
}

/**
 * Verify a JWT string and return the decoded payload.
 * Returns null if the token is invalid or expired.
 *
 * @param {string} token
 * @returns {object|null}
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * requireAuth middleware
 *
 * Extracts Bearer token from the Authorization header, verifies it,
 * and attaches the decoded payload to req.user.
 *
 * On failure, responds with 401 — does NOT call next() so subsequent
 * route handlers never run.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header with Bearer token required',
    });
  }

  const token = authHeader.slice(7);  // Remove "Bearer " prefix
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  }

  // Attach user to request so downstream handlers don't need to re-decode
  req.user = decoded;
  next();
}

/**
 * requireRole(role) — Role-specific middleware factory
 *
 * Must be used AFTER requireAuth (depends on req.user being set).
 *
 * @param {'host'|'buyer'} role
 * @returns {function} Express middleware
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      // Defensive: requireRole used without requireAuth before it
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    if (req.user.role !== role) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `This endpoint requires ${role} role. Your account is: ${req.user.role}`,
      });
    }

    next();
  };
}

module.exports = { requireAuth, requireRole, signToken, verifyToken };
