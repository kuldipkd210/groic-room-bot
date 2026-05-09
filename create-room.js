require("dotenv").config();

const fs = require("fs");
const axios = require("axios");
const { io } = require("socket.io-client");

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

// Song data
const SONG = {
  songurl: "QNYT9wVwQ8A",
  action: 1,
  artist: "Miki Matsubara",
  imageurl: "https://i.ytimg.com/vi/QNYT9wVwQ8A/hqdefault.jpg",
  imageurlHigh: "https://i.ytimg.com/vi/QNYT9wVwQ8A/hqdefault.jpg",
  title: "Stay With Me",
  youtubePlayer: true
};

let TOKEN = "";
let socket = null;
let currentRoomUid = null;

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

function getGroicHeaders() {
  return {
    accept: "*/*",
    authorization: TOKEN,
    "content-type": "application/json",
    origin: "https://groic.in",
    referer: "https://groic.in/",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "x-device-type": "android"
  };
}

async function refreshAccessToken() {
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", REFRESH_TOKEN);

  const res = await axios.post(url, params.toString(), {
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
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
    headers: getGroicHeaders()
  });

  return res.data.data.roomUid;
}

async function getRoomDetails(roomUid) {
  try {
    const res = await axios.get(`https://api.groic.in/api/room/${roomUid}`, {
      headers: getGroicHeaders()
    });

    // Debug logs. Uncomment when needed.
    // console.log("ROOM DETAILS:");
    // console.log(JSON.stringify(res.data, null, 2));

    return res.data.data;
  } catch (err) {
    console.log("Could not fetch room details");

    if (err.response) {
      console.log("Status:", err.response.status);
      // console.log("Response:", err.response.data);
    } else {
      console.log(err.message);
    }

    return null;
  }
}

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
    message: message
  });

  // Debug log. Uncomment when needed.
  // console.log("sendChat emitted:", message);
}

function isBotUser(user) {
  const username = user.username || "";
  const name = user.name || "";
  const imageUrl = user.imageUrl || null;

  return username === BOT_USERNAME && name === BOT_NAME && imageUrl === null;
}

function startUserJoinWatcher(roomUid) {
  const knownUsers = new Set();
  let firstScan = true;

  console.log("User watcher started");

  setInterval(async () => {
    try {
      const room = await getRoomDetails(roomUid);

      if (!room) {
        console.log("Room not found while watching users");
        return;
      }

      const activeUsers = room.activeUsers || [];

      // Debug log. Uncomment when needed.
      // console.log(
      //   "Active users:",
      //   activeUsers.map((u) => ({
      //     username: u.username,
      //     name: u.name,
      //     imageUrl: u.imageUrl
      //   }))
      // );

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

            sendChatMessage(
              `KD : Welcome ${cleanUsername}! Enjoy the music 🎶`
            );
          }
        }
      }

      firstScan = false;
    } catch (err) {
      console.log("User watcher error:", err.message);
    }
  }, 10000);
}

function joinRoom(roomUid) {
  let watcherStarted = false;

  socket = io("https://socket-v2.groic.in", {
    transports: ["websocket"],

    auth: {
      Authorization: TOKEN
    },

    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000
  });

  socket.on("connect", () => {
    console.log("Socket connected:", socket.id);

    socket.emit("joinRoom", {
      roomUid: roomUid,
      username: BOT_USERNAME,
      name: BOT_NAME
    });

    console.log("BOT JOINED ROOM:", roomUid);

    // Debug room check after joining. Uncomment when needed.
    // setTimeout(async () => {
    //   await getRoomDetails(roomUid);
    // }, 10000);

    if (!watcherStarted) {
      startUserJoinWatcher(roomUid);
      watcherStarted = true;
    }

    autoPlaySong();
  });

  socket.on("roomState", () => {
    // Debug log. Uncomment when needed.
    // console.log("ROOM STATE RECEIVED");
  });

  socket.on("chat", (data) => {
    // Debug log. Uncomment when needed.
    // console.log("CHAT RECEIVED FROM SERVER:");
    // console.log(JSON.stringify(data, null, 2));
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.log("Socket error:", err.message);
  });

  setInterval(() => {
    if (socket && socket.connected) {
      socket.emit("requestSync", {
        roomUid: roomUid
      });

      // Debug log. Uncomment when needed.
      // console.log("Keepalive sent");
    }
  }, 30000);
}

async function startBot() {
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
      console.log("Saved room not found on Groic. Creating new room...");

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

  console.log("Bot is running. Do not close this terminal.");
}

function refreshTokenLoop() {
  setInterval(async () => {
    try {
      await refreshAccessToken();
      console.log("Token refreshed successfully");
    } catch (err) {
      console.log("Token refresh failed:", err.message);
    }
  }, 50 * 60 * 1000);
}

startBot()
  .then(() => {
    refreshTokenLoop();
  })
  .catch((err) => {
    console.log("BOT FAILED");

    if (err.response) {
      console.log("Status:", err.response.status);
      console.log("Response:", err.response.data);
    } else {
      console.log(err.message);
    }
  });
