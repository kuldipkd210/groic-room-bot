const express = require("express");
const { PORT } = require("../config/env");

function createHealthServer(getState) {
  const app = express();

  app.get("/", (req, res) => {
    res.status(200).send("Groic bot is running");
  });

  app.get("/health", (req, res) => {
    const state = getState();
    res.status(200).json({
      status: "ok",
      botRunning: state.botRunning,
      roomUid: state.roomUid || null
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server running on port ${PORT}`);
  });

  return app;
}

module.exports = {
  createHealthServer
};
