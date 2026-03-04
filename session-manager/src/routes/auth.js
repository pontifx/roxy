/**
 * session-manager/src/routes/auth.js
 *
 * Authentication Routes
 *
 * POST /api/auth/register  — Register a new host or buyer account
 * POST /api/auth/login     — Authenticate and receive a JWT
 *
 * Both hosts and buyers use the same login endpoint. The role is embedded
 * in the JWT payload and enforced by downstream middleware.
 *
 * Password hashing uses bcryptjs with 12 rounds — slightly slower than
 * 10 rounds but meaningfully harder to brute-force. At 12 rounds, hashing
 * takes ~300ms on modern hardware, which is acceptable for a login endpoint
 * but would be too slow for a per-request auth check (hence JWTs).
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getUserByEmail, createUser } = require('../db/store');
const { signToken } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// ─── POST /api/auth/register ───────────────────────────────────────────────
/**
 * Register a new account.
 *
 * Request body:
 *   { email: string, password: string, role: 'host'|'buyer' }
 *
 * Response 201:
 *   { id, email, role, token }
 *
 * The token is returned immediately after registration so the client can
 * start using the API without a separate login step.
 */
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, role } = req.body;

    // ── Input validation ──────────────────────────────────────────────
    if (!email || !password || !role) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'email, password, and role are required',
      });
    }

    if (!['host', 'buyer'].includes(role)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'role must be "host" or "buyer"',
      });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Bad Request', message: 'Invalid email address' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Password must be at least 8 characters',
      });
    }

    // ── Check for duplicate email ──────────────────────────────────────
    const existing = getUserByEmail(email.toLowerCase(), role);
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'An account with this email already exists',
      });
    }

    // ── Hash password and create user ──────────────────────────────────
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = uuidv4();

    createUser(
      { id, email: email.toLowerCase(), password_hash: passwordHash },
      role
    );

    // ── Issue JWT ──────────────────────────────────────────────────────
    const token = signToken({ id, email: email.toLowerCase(), role });

    return res.status(201).json({
      id,
      email: email.toLowerCase(),
      role,
      token,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/login ──────────────────────────────────────────────────
/**
 * Login with email + password.
 *
 * Request body:
 *   { email: string, password: string, role: 'host'|'buyer' }
 *
 * Response 200:
 *   { token, user: { id, email, role } }
 *
 * We require the role in the login request so we look in the correct table.
 * This also means a host account and buyer account can share an email address
 * (uncommon but valid — a power user who does both).
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'email, password, and role are required',
      });
    }

    if (!['host', 'buyer'].includes(role)) {
      return res.status(400).json({ error: 'Bad Request', message: 'role must be "host" or "buyer"' });
    }

    // ── Lookup user ────────────────────────────────────────────────────
    const user = getUserByEmail(email.toLowerCase(), role);

    // Use a constant-time comparison even for "user not found" — this
    // prevents timing attacks that could enumerate valid email addresses.
    const passwordMatch = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, '$2a$12$invalidhashplaceholderXXXXXXXXXXXXXXXXXXXXXX');

    if (!user || !passwordMatch) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid email or password',
      });
    }

    // ── Issue JWT ──────────────────────────────────────────────────────
    const token = signToken({ id: user.id, email: user.email, role });

    return res.json({
      token,
      user: { id: user.id, email: user.email, role },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
