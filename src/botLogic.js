const { refreshAccessToken } = require("./auth");
const { createRoom, getRoomDetails } = require("./api");
const { connectSocket, getSocket, updateSocketAuth } = require("./socket");
const { loadRoomUid, saveRoomUid } = require("./storage");
const { sleep, isCloudflareChallenge } = require("./helpers");
const { BOT_USERNAME, BOT_NAME } = require("../config/constants");
const { ROOM_UID: ENV_ROOM_UID } = require("../config/env");
const { autoPlaySong, startUserJoinWatcher, startKeepAlive, stopHandlers, setupChatHandler } = require("./handlers");

let currentRoomUid = null;
let botStarted = false;
let isStarting = false;
let tokenRefreshInterval = null;

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

    // If ROOM_UID is set in env (e.g. on Render), skip all HTTP calls to api.groic.in
    // This bypasses Cloudflare which blocks data center IPs like Render's
    if (ENV_ROOM_UID) {
      currentRoomUid = ENV_ROOM_UID;
      console.log("Using ROOM_UID from environment:", currentRoomUid);
    } else {
      const savedRoomUid = currentRoomUid || loadRoomUid();
      if (savedRoomUid) {
        currentRoomUid = savedRoomUid;
        console.log("USING EXISTING ROOM:", currentRoomUid);

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
        console.log("No saved room found. Creating new...");
        currentRoomUid = await createRoom();
        saveRoomUid(currentRoomUid);
      }
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
        autoPlaySong();
      },
      (reason) => {
        console.log("Socket disconnected:", reason);
        botStarted = false; // Allow runForever to detect failure
      },
      (err) => console.log("Socket error:", err.message)
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

      if (!isConnected && !isReconnecting) {
        // Only force a full restart if socket.io is NOT already trying to reconnect
        console.log("Bot not running and not reconnecting. Attempting full restart...");
        await startBot();
      } else if (isReconnecting) {
        console.log("Socket is reconnecting... letting socket.io handle it.");
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
