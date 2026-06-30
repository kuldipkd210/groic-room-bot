const { createSocketInstance } = require("./socket");
const { getToken } = require("./auth");
const { getRoomDetails } = require("./api");

const activeGhosts = new Map();

async function startGhostConnection(roomConfig) {
  const roomUid = typeof roomConfig === "string" ? roomConfig.trim() : roomConfig.uid;
  if (!roomUid) return;

  if (activeGhosts.has(roomUid)) {
    console.log(`[Ghost] Already running for ${roomUid}`);
    return;
  }

  const token = getToken();
  if (!token) {
    console.error("[Ghost] Cannot start ghost connection without token. Retrying in 10s...");
    setTimeout(() => startGhostConnection(roomConfig), 10000);
    return;
  }

  let ghostImageUrl = typeof roomConfig === "object" && roomConfig.imageUrl ? roomConfig.imageUrl : "";

  // Attempt to copy avatar from an existing user in the room
  if (typeof roomConfig === "object" && roomConfig.copyAvatarFrom) {
    console.log(`[Ghost] Attempting to copy avatar from ${roomConfig.copyAvatarFrom} in room ${roomUid}...`);
    try {
      const details = await getRoomDetails(roomUid);
      if (details && details.activeUsers) {
        const targetUser = details.activeUsers.find(u => u.username && u.username.toLowerCase() === roomConfig.copyAvatarFrom.toLowerCase());
        if (targetUser && targetUser.imageUrl) {
          ghostImageUrl = targetUser.imageUrl;
          console.log(`[Ghost] Successfully copied avatar: ${ghostImageUrl}`);
        } else {
          console.log(`[Ghost] Could not find user ${roomConfig.copyAvatarFrom} or they have no avatar.`);
        }
      }
    } catch (err) {
      console.error(`[Ghost] Failed to fetch room details to copy avatar: ${err.message}`);
    }
  }

  console.log(`[Ghost] Spawning invisible ghost connection for room: ${roomUid}`);
  
  // Use a completely independent socket connection for the ghost
  const socket = createSocketInstance("https://socket-v2.groic.in", token);
  activeGhosts.set(roomUid, socket);

  socket.on("connect", () => {
    console.log(`[Ghost] Connected to Socket server. Joining ${roomUid} as invisible...`);
    socket.emit("joinRoom", {
      roomUid,
      imageUrl: ghostImageUrl,
      isBot: false
    });
  });

  socket.on("disconnect", () => {
    console.log(`[Ghost] Disconnected from ${roomUid}. Will attempt reconnect...`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[Ghost] Connection error for ${roomUid}: ${err.message}`);
  });
}

function spawnGhosts(ghostConfigs) {
  if (!Array.isArray(ghostConfigs)) return;
  for (const config of ghostConfigs) {
    if (config) {
      startGhostConnection(config);
    }
  }
}

module.exports = { spawnGhosts };
