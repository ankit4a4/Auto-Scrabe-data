const express = require("express");
const { createSession, destroySession, checkCredentials } = require("../middleware/sessionAuth");

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours, matches SESSION_TTL_MS in sessionAuth.js
};

// POST /api/login  { username, password }
router.post("/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are both required." });
  }

  if (!checkCredentials(username, password)) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  const token = createSession();
  res.cookie("session_token", token, COOKIE_OPTIONS);
  res.json({ success: true });
});

// POST /api/logout
router.post("/logout", (req, res) => {
  const token = req.cookies && req.cookies.session_token;
  destroySession(token);
  res.clearCookie("session_token");
  res.json({ success: true });
});

module.exports = router;
