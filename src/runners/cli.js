const { refreshAccessToken, getToken } = require("../auth");
const { 
  getRoomDetails, 
  updateRoomVisibility, 
  updateRoomEngagement, 
  updateRoomKickList, 
  updateRoomAdminList,
  clearRoomKickList,
  clearRoomGhosts
} = require("../api");
const { loadRoomUid } = require("../storage");
const { createSocketInstance } = require("../socket");

async function socketEmitAddAdmin(roomUid, targetUsername, targetIsAdmin) {
  return new Promise((resolve) => {
    const token = getToken();
    const socket = createSocketInstance("https://socket-v2.groic.in", token);

    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        socket.disconnect();
        resolve();
      }
    };

    socket.on("connect", () => {
      console.log(`[Socket CLI] Connected. Joining room ${roomUid}...`);
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", (data) => {
      const activeAdmins = data?.admins || [];
      const isCurrentlySocketAdmin = activeAdmins.includes(targetUsername);

      console.log(`[Socket CLI] Presence Update. Active Admins on socket:`, activeAdmins);

      if (targetIsAdmin !== isCurrentlySocketAdmin) {
        console.log(`[Socket CLI] Emitting addAdmin event to sync user ${targetUsername} to ${targetIsAdmin ? "ADMIN" : "NON-ADMIN"}`);
        socket.emit("addAdmin", targetUsername);
        
        setTimeout(finish, 1000);
      } else {
        console.log(`[Socket CLI] Socket state is already in sync. No emit needed.`);
        finish();
      }
    });

    socket.on("connect_error", (err) => {
      console.error("[Socket CLI] Connection error:", err.message);
      finish();
    });

    setTimeout(finish, 6000);
  });
}

async function socketEmitKickUser(roomUid, targetUsername, isKick) {
  return new Promise((resolve) => {
    const token = getToken();
    const socket = createSocketInstance("https://socket-v2.groic.in", token);

    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        socket.disconnect();
        resolve();
      }
    };

    socket.on("connect", () => {
      console.log(`[Socket CLI] Connected. Joining room ${roomUid}...`);
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", () => {
      console.log(`[Socket CLI] Presence Update. Emitting kickUser event for ${targetUsername} (${isKick ? "KICK" : "UNKICK"})...`);
      socket.emit("kickUser", {
        username: targetUsername,
        addOrRemove: isKick
      });
      setTimeout(finish, 1000);
    });

    socket.on("connect_error", (err) => {
      console.error("[Socket CLI] Connection error:", err.message);
      finish();
    });

    setTimeout(finish, 6000);
  });
}

async function socketEmitClearKicks(roomUid, kickedUsernames) {
  if (!kickedUsernames || kickedUsernames.length === 0) return;

  return new Promise((resolve) => {
    const token = getToken();
    const socket = createSocketInstance("https://socket-v2.groic.in", token);

    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        socket.disconnect();
        resolve();
      }
    };

    socket.on("connect", () => {
      console.log(`[Socket CLI] Connected. Joining room ${roomUid}...`);
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", async () => {
      console.log(`[Socket CLI] Presence Update. Emitting unkick events for ${kickedUsernames.length} users...`);
      for (const username of kickedUsernames) {
        console.log(`[Socket CLI] Emitting kickUser (unkick) event for user: ${username}`);
        socket.emit("kickUser", {
          username,
          addOrRemove: false
        });
        await new Promise(r => setTimeout(r, 100));
      }
      setTimeout(finish, 1000);
    });

    socket.on("connect_error", (err) => {
      console.error("[Socket CLI] Connection error:", err.message);
      finish();
    });

    setTimeout(finish, 10000);
  });
}

async function run() {
  const action = process.argv[2];
  if (!action || !["private", "public", "status", "engagement", "kick", "unkick", "clear-kicks", "add-admin", "remove-admin", "clear-ghosts"].includes(action.toLowerCase())) {
    console.error("Usage:\n" +
      "  node roomAction.js status [roomUid]\n" +
      "  node roomAction.js public [roomUid]\n" +
      "  node roomAction.js private [roomUid]\n" +
      "  node roomAction.js engagement [roomUid] [score] [joins] [messages]\n" +
      "  node roomAction.js kick [roomUid] <username>\n" +
      "  node roomAction.js unkick [roomUid] <username>\n" +
      "  node roomAction.js clear-kicks [roomUid]\n" +
      "  node roomAction.js add-admin [roomUid] <username>\n" +
      "  node roomAction.js remove-admin [roomUid] <username>\n" +
      "  node roomAction.js clear-ghosts [roomUid]\n"
    );
    process.exit(1);
  }

  let roomUid = null;
  let targetUsername = null;
  let score = 999999;
  let joins = 10000;
  let messages = 50000;

  const arg3 = process.argv[3];

  if (action.toLowerCase() === "engagement") {
    if (arg3 && !isNaN(arg3)) {
      roomUid = loadRoomUid();
      score = parseInt(arg3) || 999999;
      joins = parseInt(process.argv[4]) || 10000;
      messages = parseInt(process.argv[5]) || 50000;
    } else {
      roomUid = arg3 || loadRoomUid();
      score = parseInt(process.argv[4]) || 999999;
      joins = parseInt(process.argv[5]) || 10000;
      messages = parseInt(process.argv[6]) || 50000;
    }
  } else if (["kick", "unkick", "add-admin", "remove-admin"].includes(action.toLowerCase())) {
    if (process.argv[4]) {
      roomUid = process.argv[3];
      targetUsername = process.argv[4];
    } else {
      roomUid = loadRoomUid();
      targetUsername = process.argv[3];
    }
  } else {
    roomUid = arg3 || loadRoomUid();
  }

  if (!roomUid) {
    console.error("Error: No roomUid found in room.json or specified in arguments");
    process.exit(1);
  }

  if (["kick", "unkick", "add-admin", "remove-admin"].includes(action.toLowerCase()) && !targetUsername) {
    console.error(`Error: Action '${action}' requires a username.`);
    process.exit(1);
  }

  try {
    console.log(`Authenticating...`);
    await refreshAccessToken();

    if (action.toLowerCase() === "status") {
      console.log(`Fetching details for room: ${roomUid}...`);
      const details = await getRoomDetails(roomUid);
      if (!details) {
        console.error(`Error: Could not retrieve room details for ${roomUid}`);
        process.exit(1);
      }

      console.log("\n================ ROOM STATUS ================");
      console.log(`Room UID:    ${details.roomUid}`);
      console.log(`Room Name:   ${details.roomName}`);
      console.log(`Description: ${details.roomDesc || "(no description)"}`);
      console.log(`Genre:       ${details.roomGenre.join(", ")}`);
      console.log(`Visibility:  ${details.isPublicRoom ? "PUBLIC 🟢 (Visible in lobby)" : "PRIVATE 🔴 (Hidden from lobby)"}`);
      console.log(`Active Users:${details.activeUsers ? details.activeUsers.length : 0}`);
      console.log(`Admins:      ${details.admins ? details.admins.filter(Boolean).join(", ") : ""}`);
      console.log(`Kicked Users: ${details.kicked ? details.kicked.filter(Boolean).join(", ") : ""}`);
      console.log(`Engagement:  Score: ${details.engagementScore || 0} | Joins: ${details.joinCount || 0} | Messages: ${details.messagesSent || 0}`);
      console.log("=============================================\n");

    } else if (action.toLowerCase() === "engagement") {
      console.log(`Updating room ${roomUid} engagement stats to Score: ${score}, Joins: ${joins}, Messages: ${messages}...`);
      const res = await updateRoomEngagement(roomUid, score, joins, messages);
      if (res && !res.error) {
        console.log(`\nSUCCESS: Room engagement stats updated! (Score: ${score}, Joins: ${joins}, Messages: ${messages})\n`);
      } else {
        console.error("\nFAILED: Could not update room engagement.\n");
      }

    } else if (action.toLowerCase() === "kick" || action.toLowerCase() === "unkick") {
      const isKick = action.toLowerCase() === "kick";
      console.log(`Updating room ${roomUid} kick list: ${isKick ? "Kicking" : "Unkicking"} ${targetUsername}...`);

      const details = await getRoomDetails(roomUid);
      if (!details) {
        console.error(`Error: Could not retrieve room details for ${roomUid}`);
        process.exit(1);
      }
      const kickedList = details.kicked || [];
      const isAlreadyKicked = kickedList.includes(targetUsername);

      if (isKick === isAlreadyKicked) {
        console.log(`User ${targetUsername} is already ${isKick ? "kicked" : "not kicked"} in room ${roomUid}. No action needed.`);
      } else {
        const res = await updateRoomKickList(roomUid, targetUsername, isKick);
        if (res && !res.error) {
          console.log(`\nSUCCESS: User ${targetUsername} has been ${isKick ? "added to" : "removed from"} the room's kick list!\n`);
          try {
            console.log(`Propagating ${isKick ? "kick" : "unkick"} update via Socket...`);
            await socketEmitKickUser(roomUid, targetUsername, isKick);
            console.log("Socket propagation completed successfully.");
          } catch (socketErr) {
            console.error("Warning: Failed to propagate kick/unkick update via socket:", socketErr.message);
          }
        } else {
          console.error(`\nFAILED: Could not update kick list for user ${targetUsername}.\n`);
        }
      }

    } else if (action.toLowerCase() === "clear-kicks") {
      console.log(`Clearing kick list for room ${roomUid}...`);

      const details = await getRoomDetails(roomUid);
      if (!details) {
        console.error(`Error: Could not retrieve room details for ${roomUid}`);
        process.exit(1);
      }
      const kickedList = details.kicked || [];

      if (kickedList.length === 0) {
        console.log(`Kick list is already empty. No action needed.`);
      } else {
        const res = await clearRoomKickList(roomUid);
        if (res && !res.error) {
          console.log(`\nSUCCESS: Kick list has been cleared for room ${roomUid}!\n`);
          try {
            console.log("Propagating clear-kicks update via Socket...");
            await socketEmitClearKicks(roomUid, kickedList);
            console.log("Socket propagation completed successfully.");
          } catch (socketErr) {
            console.error("Warning: Failed to propagate clear-kicks via socket:", socketErr.message);
          }
        } else {
          console.error(`\nFAILED: Could not clear kick list for room ${roomUid}.\n`);
        }
      }

    } else if (action.toLowerCase() === "add-admin" || action.toLowerCase() === "remove-admin") {
      const isAdmin = action.toLowerCase() === "add-admin";
      console.log(`Updating room ${roomUid} admin list: ${isAdmin ? "Adding" : "Removing"} admin ${targetUsername}...`);

      const details = await getRoomDetails(roomUid);
      if (!details) {
        console.error(`Error: Could not retrieve room details for ${roomUid}`);
        process.exit(1);
      }
      const adminsList = details.admins || [];
      const isAlreadyAdmin = adminsList.includes(targetUsername);

      if (isAdmin === isAlreadyAdmin) {
        console.log(`User ${targetUsername} is already ${isAdmin ? "an admin" : "not an admin"} in room ${roomUid}. No action needed.`);
      } else {
        const res = await updateRoomAdminList(roomUid, targetUsername, isAdmin);
        if (res && !res.error) {
          console.log(`\nSUCCESS: User ${targetUsername} has been ${isAdmin ? "added to" : "removed from"} the room's admin list!\n`);
          try {
            console.log("Propagating admin update via Socket...");
            await socketEmitAddAdmin(roomUid, targetUsername, isAdmin);
            console.log("Socket propagation completed successfully.");
          } catch (socketErr) {
            console.error("Warning: Failed to propagate admin change via socket:", socketErr.message);
          }
        } else {
          console.error(`\nFAILED: Could not update admin list for user ${targetUsername}.\n`);
        }
      }

    } else if (action.toLowerCase() === "clear-ghosts") {
      console.log(`Clearing ghost users for room ${roomUid}...`);
      const res = await clearRoomGhosts(roomUid);
      if (res && !res.error) {
        console.log(`\nSUCCESS: ${res.ghostCount} ghost user(s) removed from room ${roomUid}!\n`);
      } else {
        console.error(`\nFAILED: ${res ? res.message : "Could not clear ghosts."}\n`);
      }

    } else {
      const isPublic = action.toLowerCase() === "public";
      console.log(`Updating room ${roomUid} visibility to ${isPublic ? "PUBLIC" : "PRIVATE"}...`);
      const res = await updateRoomVisibility(roomUid, isPublic);
      if (res && !res.error) {
        console.log(`\nSUCCESS: Room is now ${isPublic ? "PUBLIC 🟢 (Visible in lobby)" : "PRIVATE 🔴 (Hidden from lobby)"}\n`);
      } else {
        console.error("\nFAILED: Could not update room visibility.\n");
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

module.exports = {
  run
};
