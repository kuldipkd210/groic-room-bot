const { runForever, cleanupRuntime, getBotState } = require("./src/botLogic");
const { createHealthServer } = require("./src/health");
const { spawnGhosts } = require("./src/ghosts");
const { GHOST_ROOMS } = require("./config/constants");

// Start health server
createHealthServer(getBotState);

// Start bot
runForever();

// Start permanent ghosts
if (GHOST_ROOMS && GHOST_ROOMS.length > 0) {
  spawnGhosts(GHOST_ROOMS);
}

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
