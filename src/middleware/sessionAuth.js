const crypto = require("crypto");
const config = require("../config");

// In-memory session store: token -> expiry timestamp.
// Simple and sufficient for a single-admin internal tool - sessions reset
// on server restart, which is an acceptable trade-off for the simplicity
// it buys us (no external session-store dependency needed).
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// Constant-time string comparison, to avoid leaking info via timing attacks
function safeCompare(a, b) {
  const bufA = Buffer.from(a || "");
  const bufB = Buffer.from(b || "");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkCredentials(username, password) {
  const { adminUsername, adminPassword } = config;
  if (!adminUsername || !adminPassword) return false;
  return safeCompare(username, adminUsername) && safeCompare(password, adminPassword);
}

// Paths that must remain accessible WITHOUT being logged in
// (the login page itself, and the login/status API it calls)
const PUBLIC_PATHS = new Set(["/login.html", "/api/login"]);

/**
 * Protects everything except the login page + login endpoint. Nothing
 * (admin panel or API) is usable until a valid session cookie is present -
 * that cookie is only ever set after a correct username/password is
 * submitted on the login page.
 */
function sessionAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }

  const token = req.cookies && req.cookies.session_token;

  if (isValidSession(token)) {
    return next();
  }

  // API requests get a clean JSON 401 (so the frontend can react to it);
  // regular page requests get redirected to the login page.
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not logged in." });
  }

  return res.redirect("/login.html");
}

module.exports = { sessionAuth, createSession, destroySession, checkCredentials };
