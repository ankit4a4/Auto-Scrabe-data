const express = require("express");
const config = require("./src/config");
const scrapeRoutes = require("./src/routes/scrape");
const { closeBrowser } = require("./src/services/browserManager");

const app = express();
app.use(express.json());

// Admin panel (testing dashboard) - public/index.html
app.use(express.static("public"));

app.use("/api", scrapeRoutes);

const server = app.listen(config.port, () => {
  console.log(`Server chal raha hai: http://localhost:${config.port}`);
});

// Graceful shutdown - Playwright browser ko properly close karo
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await closeBrowser();
  server.close(() => process.exit(0));
});
