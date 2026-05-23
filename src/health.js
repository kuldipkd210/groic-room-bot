const express = require("express");
const axios = require("axios");
const { PORT } = require("../config/env");

function startSelfPing() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log("RENDER_EXTERNAL_URL not set. Skipping self-ping loop.");
    return;
  }

  console.log(`Self-ping loop started for: ${externalUrl}`);
  // Ping every 10 minutes to prevent Render free tier from sleeping (sleeps after 15 mins of inactivity)
  setInterval(async () => {
    try {
      await axios.get(externalUrl, { timeout: 10000, proxy: false });
      console.log(`[Self-Ping] Pinged ${externalUrl} successfully to stay awake.`);
    } catch (err) {
      console.log(`[Self-Ping] Warning: ping to ${externalUrl} failed:`, err.message);
    }
  }, 10 * 60 * 1000);
}

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
    startSelfPing();
  });

  return app;
}

module.exports = {
  createHealthServer
};
