require("dotenv").config();

const express = require("express");
const fs = require("fs");
const axios = require("axios");
const { io } = require("socket.io-client");

// =======================
// Health Server
// Required for Render/Replit Web Service
// =======================

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.status(200).send("Groic bot is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    botRunning: Boolean(socket && socket.connected),
    roomUid: currentRoomUid || null
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server running on port ${PORT}`);
});

// =======================
// Config
// =======================

const ROOM_FILE = "room.json";

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

if (!FIREBASE_API_KEY || !REFRESH_TOKEN) {
  console.error("Missing FIREBASE_API_KEY or REFRESH_TOKEN environment variable");
  process.exit(1);
}

const USER_ID = "ZD8n4XeV1Ad3R9EgyRa5ASa8S8s1";
const OWNER_USERNAME = "kd_zoro";

// Blank-looking bot identity
const BOT_USERNAME = " ";
const BOT_NAME = " ";

const ROOM_NAME = "01001011 01000100";
const ROOM_DESC =
  "There are 10 types of people: Those who get it and those who don't.";
const ROOM_GENRE = ["KD-Special"];
const MAX_PARTICIPANTS = 50;

const SONG = {
  songurl: "QNYT9wVwQ8A",
  action: 1,
  artist: "Miki Matsubara",
  imageurl: "https://i.ytimg.com/vi/QNYT9wVwQ8A/hqdefault.jpg",
  imageurlHigh: "https://i.ytimg.com/vi/QNYT9wVwQ8A/hqdefault.jpg",
  title: "Stay With Me",
  youtubePlayer: true
};

// =======================
// Global State
// =======================

let TOKEN = "";
let socket = null;
let currentRoomUid = null;

let tokenRefreshInterval = null;
let userWatcherInterval = null;
let keepAliveInterval = null;

let botStarted = false;
let isStarting = false;

// =======================
// Helpers
// =======================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveRoomUid(roomUid) {
  fs.writeFileSync(ROOM_FILE, JSON.stringify({ roomUid }, null, 2));
}

function loadRoomUid() {
  if (!fs.existsSync(ROOM_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(ROOM_FILE, "utf8"));
    return data.roomUid || null;
  } catch {
    return null;
  }
}

function isCloudflareChallenge(data) {
  if (typeof data !== "string") return false;

  return (
    data.includes("Just a moment") ||
    data.includes("challenges.cloudflare.com") ||
    data.includes("__cf_chl") ||
    data.includes("Enable JavaScript and cookies")
  );
}

function logAxiosError(err, label = "Request failed") {
  console.log(label);

  if (err.response) {
    console.log("Status:", err.response.status);

    const data = err.response.data;

    if (isCloudflareChallenge(data)) {
      console.log("Cloudflare challenge detected. Server IP is likely blocked/challenged.");
      return;
    }

    if (typeof data === "string") {
      console.log("Response:", data.slice(0, 500));
    } else {
      console.log("Response:", JSON.stringify(data, null, 2));
    }
  } else {
    console.log("Error:", err.message);
  }
}

function cleanupRuntime() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  if (userWatcherInterval) {
    clearInterval(userWatcherInterval);
    userWatcherInterval = null;
  }

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  botStarted = false;
}

function getGroicHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    authorization: TOKEN,
    "content-type": "application/json",
    origin: "https://groic.in",
    referer: "https://groic.in/",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "x-device-type": "android"
  };
}

// =======================
// Firebase Token
// =======================

async function refreshAccessToken() {
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", REFRESH_TOKEN);

  const res = await axios.post(url, params.toString(), {
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    timeout: 20000
  });

  TOKEN = res.data.id_token || res.data.access_token;

  if (!TOKEN) {
    throw new Error("No token received from Firebase refresh API");
  }

  if (socket) {
    socket.auth = {
      Authorization: TOKEN
    };
  }

  console.log("Fresh token generated");

  return TOKEN;
}

function startTokenRefreshLoop() {
  if (tokenRefreshInterval) {
    return;
  }

  tokenRefreshInterval = setInterval(async () => {
    try {
      await refreshAccessToken();
      console.log("Token refreshed successfully");
    } catch (err) {
      console.log("Token refresh failed:", err.message);
    }
  }, 50 * 60 * 1000);
}

// =======================
// Groic API
// =======================

async function createRoom() {
  const payload = {
    roomOwner: USER_ID,
    username: OWNER_USERNAME,
    roomName: ROOM_NAME,
    roomDesc: ROOM_DESC,
    roomGenre: ROOM_GENRE,
    roomCountry: "IN",
    maxParticipants: MAX_PARTICIPANTS,
    isPublicRoom: true
  };

  const res = await axios.post("https://api.groic.in/api/room/", payload, {
    headers: getGroicHeaders(),
    timeout: 30000
  });

  const roomUid = res?.data?.data?.roomUid;

  if (!roomUid) {
    throw new Error("Room created but roomUid not found in response");
  }

  return roomUid;
}

async function getRoomDetails(roomUid) {
  try {
    const res = await axios.get(`https://api.groic.in/api/room/${roomUid}`, {
      headers: getGroicHeaders(),
      timeout: 30000
    });

    return res.data.data;
  } catch (err) {
    logAxiosError(err, "Could not fetch room details");
    return null;
  }
}

// =======================
// Bot Actions
// =======================

function autoPlaySong() {
  setTimeout(() => {
    if (!socket || !socket.connected) {
      console.log("Cannot autoplay: socket not connected");
      return;
    }

    socket.emit("playSong", SONG);
    console.log("Auto playSong sent:", SONG.title);
  }, 8000);
}

function sendChatMessage(message) {
  if (!socket || !socket.connected) {
    console.log("Cannot send chat: socket not connected");
    return;
  }

  socket.emit("sendChat", {
    message
  });
}

function isBotUser(user) {
  const username = user.username || "";
  const name = user.name || "";
  const imageUrl = user.imageUrl || null;

  return username === BOT_USERNAME && name === BOT_NAME && imageUrl === null;
}

function startUserJoinWatcher(roomUid) {
  if (userWatcherInterval) {
    clearInterval(userWatcherInterval);
    userWatcherInterval = null;
  }

  const knownUsers = new Set();
  let firstScan = true;

  console.log("User watcher started");

  userWatcherInterval = setInterval(async () => {
    try {
      const room = await getRoomDetails(roomUid);

      if (!room) {
        console.log("Room not found while watching users");
        return;
      }

      const activeUsers = room.activeUsers || [];

      for (const user of activeUsers) {
        const username = user.username || "";
        const name = user.name || "";
        const imageUrl = user.imageUrl || null;

        const userKey = user._id || `${username}-${name}-${imageUrl}`;

        if (isBotUser(user)) {
          knownUsers.add(userKey);
          continue;
        }

        if (!knownUsers.has(userKey)) {
          knownUsers.add(userKey);

          if (!firstScan) {
            const cleanUsername = username.trim() || "user";

            sendChatMessage(`KD : Welcome ${cleanUsername}! Enjoy the music 🎶`);
          }
        }
      }

      firstScan = false;
    } catch (err) {
      console.log("User watcher error:", err.message);
    }
  }, 10000);
}

function startKeepAlive(roomUid) {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }

  keepAliveInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit("requestSync", {
        roomUid
      });
    }
  }, 30000);
}

function joinRoom(roomUid) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socket = io("https://socket-v2.groic.in", {
    transports: ["websocket"],
    auth: {
      Authorization: TOKEN
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 30000
  });

  socket.on("connect", () => {
    console.log("Socket connected:", socket.id);

    socket.emit("joinRoom", {
      roomUid,
      username: BOT_USERNAME,
      name: BOT_NAME
    });

    console.log("BOT JOINED ROOM:", roomUid);

    startUserJoinWatcher(roomUid);
    startKeepAlive(roomUid);
    autoPlaySong();
  });

  socket.on("roomState", () => {
    // console.log("ROOM STATE RECEIVED");
  });

  socket.on("chat", () => {
    // console.log("CHAT RECEIVED");
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.log("Socket error:", err.message);
  });
}

// =======================
// Main Bot Startup
// =======================

async function startBot() {
  if (isStarting) {
    console.log("Bot startup already in progress");
    return;
  }

  if (botStarted) {
    console.log("Bot already started");
    return;
  }

  isStarting = true;

  try {
    cleanupRuntime();

    await refreshAccessToken();

    const savedRoomUid = loadRoomUid();

    if (savedRoomUid) {
      console.log("FOUND SAVED ROOM");
      console.log("Room UID:", savedRoomUid);

      const roomDetails = await getRoomDetails(savedRoomUid);

      if (roomDetails) {
        currentRoomUid = savedRoomUid;

        console.log("USING SAVED ROOM");
        console.log("Room UID:", currentRoomUid);
        console.log(
          "Room Link:",
          `https://groic.in/room/${currentRoomUid}?autoJoin=true`
        );
      } else {
        console.log("Saved room not found or blocked. Creating new room...");

        currentRoomUid = await createRoom();
        saveRoomUid(currentRoomUid);

        console.log("NEW PUBLIC ROOM CREATED");
        console.log("Room UID:", currentRoomUid);
        console.log(
          "Room Link:",
          `https://groic.in/room/${currentRoomUid}?autoJoin=true`
        );
      }
    } else {
      currentRoomUid = await createRoom();
      saveRoomUid(currentRoomUid);

      console.log("PUBLIC ROOM CREATED");
      console.log("Room UID:", currentRoomUid);
      console.log(
        "Room Link:",
        `https://groic.in/room/${currentRoomUid}?autoJoin=true`
      );
    }

    joinRoom(currentRoomUid);

    startTokenRefreshLoop();

    botStarted = true;

    console.log("Bot is running. Do not close this terminal.");
  } finally {
    isStarting = false;
  }
}

// =======================
// Run Forever
// =======================

async function runForever() {
  while (true) {
    try {
      await startBot();

      // If startBot succeeds, keep process alive.
      // Socket reconnect logic handles normal disconnects.
      break;
    } catch (err) {
      cleanupRuntime();

      console.log("BOT FAILED");

      if (err.response) {
        console.log("Status:", err.response.status);

        if (isCloudflareChallenge(err.response.data)) {
          console.log("Cloudflare challenge detected. This host/IP may be blocked.");
        } else if (typeof err.response.data === "string") {
          console.log("Response:", err.response.data.slice(0, 500));
        } else {
          console.log("Response:", JSON.stringify(err.response.data, null, 2));
        }
      } else {
        console.log("Error:", err.message);
      }

      console.log("Retrying in 5 minutes...");
      await sleep(5 * 60 * 1000);
    }
  }
}

process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down...");
  cleanupRuntime();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");
  cleanupRuntime();
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  console.log("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.log("Uncaught exception:", err.message);
});

runForever();
