const { refreshAccessToken } = require("./auth");
const { createRoom, getRoomDetails } = require("./api");
const { connectSocket, getSocket, updateSocketAuth } = require("./socket");
const { loadRoomUid, saveRoomUid } = require("./storage");
const { sleep } = require("./helpers");
const { BOT_USERNAME, BOT_NAME } = require("../config/constants");
const { ROOM_UID: ENV_ROOM_UID } = require("../config/env");
const { startUserJoinWatcher, startKeepAlive, stopHandlers, setupChatHandler } = require("./handlers");

let currentRoomUid = null;
let botStarted = false;
let isStarting = false;
let tokenRefreshInterval = null;
let reconnectingChecks = 0;

function cleanupRuntime() {
  const socket = getSocket();
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  stopHandlers();
  botStarted = false;
}

function startTokenRefreshLoop() {
  if (tokenRefreshInterval) return;
  tokenRefreshInterval = setInterval(async () => {
    try {
      const newToken = await refreshAccessToken();
      updateSocketAuth(newToken);
      // console.log("Token refreshed successfully and socket auth updated");
    } catch (err) {
      console.log("Token refresh failed:", err.message);
    }
  }, 50 * 60 * 1000);
}

async function startBot() {
  if (isStarting || botStarted) return;
  isStarting = true;

  try {
    cleanupRuntime();
    await refreshAccessToken();

    const isRender = !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL;
    const savedRoomUid = isRender
      ? (currentRoomUid || ENV_ROOM_UID || loadRoomUid())
      : (currentRoomUid || loadRoomUid() || ENV_ROOM_UID);

    if (savedRoomUid) {
      currentRoomUid = savedRoomUid;
      console.log(isRender ? `[Render] USING EXISTING ROOM: ${currentRoomUid}` : `[Local] USING EXISTING ROOM: ${currentRoomUid}`);

      try {
        const roomDetails = await getRoomDetails(currentRoomUid);
        if (!roomDetails) {
          console.log("Room no longer exists. Creating a fresh one...");
          currentRoomUid = await createRoom();
          saveRoomUid(currentRoomUid);
        } else {
          console.log("Room verified and active.");
        }
      } catch (err) {
        console.log("Network error while verifying room. Will attempt to join existing UID anyway.");
      }
    } else {
      console.log("No saved room or environment ROOM_UID found. Creating new...");
      currentRoomUid = await createRoom();
      saveRoomUid(currentRoomUid);
    }

    console.log("Room Link:", `https://groic.in/room/${currentRoomUid}?autoJoin=true`);

    connectSocket(
      "https://socket-v2.groic.in",
      (socket) => {
        console.log("Socket connected:", socket.id);

        // Bot always joins with its default (blank) identity
        socket.emit("joinRoom", {
          roomUid: currentRoomUid,
          username: BOT_USERNAME,
          name: BOT_NAME,
          imageUrl: "",
          isBot: true
        });

        // console.log("BOT JOINED ROOM (EMPTY IDENTITY)");
        setupChatHandler(currentRoomUid);
        startUserJoinWatcher(currentRoomUid);
        startKeepAlive(currentRoomUid);
      },
      (reason) => {
        console.log("Socket disconnected:", reason);
        botStarted = false; // Allow runForever to detect failure
      },
      async (err) => {
        console.log("Socket error:", err.message);
        if (err.message && (err.message.toLowerCase().includes("auth") || err.message.toLowerCase().includes("token") || err.message.toLowerCase().includes("unauthorized"))) {
          console.log("Auth error detected, attempting to refresh token...");
          try {
            const newToken = await refreshAccessToken();
            updateSocketAuth(newToken);
          } catch (refreshErr) {
            console.log("Failed to refresh token on socket error:", refreshErr.message);
          }
        }
      }
    );

    startTokenRefreshLoop();
    botStarted = true;
    // console.log("Bot is running.");
  } finally {
    isStarting = false;
  }
}

async function runForever() {
  // console.log("Starting persistence loop...");
  while (true) {
    try {
      const socket = getSocket();
      const isConnected = socket && socket.connected;
      const isReconnecting = socket && !socket.connected && socket.active;

      if (isConnected) {
        reconnectingChecks = 0;
      }

      if (!isConnected && !isReconnecting) {
        // Only force a full restart if socket.io is NOT already trying to reconnect
        console.log("Bot not running and not reconnecting. Attempting full restart...");
        reconnectingChecks = 0;
        await startBot();
      } else if (isReconnecting) {
        reconnectingChecks++;
        console.log(`Socket is reconnecting (consecutive checks: ${reconnectingChecks})...`);
        if (reconnectingChecks >= 3) {
          console.log("Socket stuck in reconnecting state for too long. Forcing full restart...");
          reconnectingChecks = 0;
          await startBot();
        }
      }
    } catch (err) {
      console.log("Error in runForever loop:", err.message);
      botStarted = false;
    }
    await sleep(30000); // Check status every 30 seconds
  }
}

function getBotState() {
  const socket = getSocket();
  return {
    botRunning: Boolean(socket && socket.connected),
    roomUid: currentRoomUid
  };
}

module.exports = {
  startBot,
  runForever,
  cleanupRuntime,
  getBotState
};
