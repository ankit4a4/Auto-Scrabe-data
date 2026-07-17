const express = require("express");
const cookieParser = require("cookie-parser");
const config = require("./src/config");
const scrapeRoutes = require("./src/routes/scrape");
const authRoutes = require("./src/routes/auth");
const { closeBrowser } = require("./src/services/browserManager");
const { sessionAuth } = require("./src/middleware/sessionAuth");

const app = express();
app.use(express.json());
app.use(cookieParser());

// Login endpoints must stay reachable without a session
app.use("/api", authRoutes);

// Login required for everything below this line - nothing (admin panel or
// API) is accessible without a valid session (created by logging in
// with the correct ADMIN_USERNAME/ADMIN_PASSWORD on the login page)
app.use(sessionAuth);

// Admin panel (testing dashboard) - public/index.html + public/login.html
app.use(express.static("public"));

app.use("/api", scrapeRoutes);

const server = app.listen(config.port, () => {
  console.log(`Server is running: http://localhost:${config.port}`);
});

// Graceful shutdown - properly close the Playwright browser
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await closeBrowser();
  server.close(() => process.exit(0));
});
