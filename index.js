const { runForever, cleanupRuntime, getBotState } = require("./src/botLogic");
const { createHealthServer } = require("./src/health");

// Start health server
createHealthServer(getBotState);

// Start bot
runForever();

// Handle termination
const shutdown = () => {
  console.log("Shutting down...");
  cleanupRuntime();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => console.log("Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.log("Uncaught exception:", err.message));
