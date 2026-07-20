const { refreshAccessToken, getToken } = require("../auth");
const { getRoomDetails, getActivePublicRooms } = require("../api");
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
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", (data) => {
      socket.emit("addAdmin", targetUsername);
      setTimeout(finish, 1000);
    });

    socket.on("connect_error", (err) => finish());
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
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", () => {
      socket.emit("kickUser", {
        username: targetUsername,
        addOrRemove: isKick
      });
      setTimeout(finish, 1000);
    });

    socket.on("connect_error", (err) => finish());
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
      socket.emit("joinRoom", {
        roomUid,
        username: " ",
        name: " ",
        imageUrl: "",
        isBot: false
      });
    });

    socket.on("presenceUpdate", async () => {
      for (const username of kickedUsernames) {
        socket.emit("kickUser", {
          username,
          addOrRemove: false
        });
        await new Promise(r => setTimeout(r, 100));
      }
      setTimeout(finish, 1000);
    });

    socket.on("connect_error", (err) => finish());
    setTimeout(finish, 10000);
  });
}

async function run() {
  const action = process.argv[2];
  const validActions = ["kick", "unkick", "clear-kicks", "add-admin", "remove-admin", "list-rooms", "kick-all", "unkick-all"];

  if (!action || !validActions.includes(action.toLowerCase())) {
    console.error("Usage:\n" +
      "  node roomAction.js kick [roomUid] <username>\n" +
      "  node roomAction.js unkick [roomUid] <username>\n" +
      "  node roomAction.js clear-kicks [roomUid]\n" +
      "  node roomAction.js add-admin [roomUid] <username>\n" +
      "  node roomAction.js remove-admin [roomUid] <username>\n" +
      "  node roomAction.js list-rooms\n" +
      "  node roomAction.js kick-all <username>\n" +
      "  node roomAction.js unkick-all <username>\n"
    );
    process.exit(1);
  }

  let roomUid = null;
  let targetUsername = null;
  const arg3 = process.argv[3];

  if (["kick-all", "unkick-all"].includes(action.toLowerCase())) {
    targetUsername = arg3;
  } else if (["kick", "unkick", "add-admin", "remove-admin"].includes(action.toLowerCase())) {
    if (process.argv[4]) {
      roomUid = arg3;
      targetUsername = process.argv[4];
    } else {
      roomUid = loadRoomUid();
      targetUsername = arg3;
    }
  } else if (action.toLowerCase() !== "list-rooms") {
    roomUid = arg3 || loadRoomUid();
  }

  if (action.toLowerCase() !== "list-rooms" && action.toLowerCase() !== "kick-all" && action.toLowerCase() !== "unkick-all" && !roomUid) {
    console.error("Error: No roomUid found in room.json or specified in arguments");
    process.exit(1);
  }

  if (["kick", "unkick", "add-admin", "remove-admin", "kick-all", "unkick-all"].includes(action.toLowerCase()) && !targetUsername) {
    console.error(`Error: Action '${action}' requires a username.`);
    process.exit(1);
  }

  try {
    console.log(`Authenticating...`);
    await refreshAccessToken();

    if (action.toLowerCase() === "list-rooms") {
      const rooms = await getActivePublicRooms();
      console.log(`\nFound ${rooms.length} active public rooms:\n`);
      for (const room of rooms) {
        console.log(`${(room.roomName || "Unnamed").slice(0, 28).padEnd(30)} | UID: ${room.roomUid}`);
      }
    } else if (action.toLowerCase() === "kick-all" || action.toLowerCase() === "unkick-all") {
      const isKick = action.toLowerCase() === "kick-all";
      const rooms = await getActivePublicRooms();
      for (const room of rooms) {
        console.log(`Propagating to room ${room.roomUid}...`);
        await socketEmitKickUser(room.roomUid, targetUsername, isKick);
      }
    } else if (action.toLowerCase() === "kick" || action.toLowerCase() === "unkick") {
      const isKick = action.toLowerCase() === "kick";
      console.log(`Propagating ${isKick ? "kick" : "unkick"} via Socket to ${roomUid}...`);
      await socketEmitKickUser(roomUid, targetUsername, isKick);
      console.log("Completed successfully.");
    } else if (action.toLowerCase() === "clear-kicks") {
      const details = await getRoomDetails(roomUid);
      if (details && details.kicked && details.kicked.length > 0) {
        await socketEmitClearKicks(roomUid, details.kicked);
        console.log("Kicks cleared successfully.");
      }
    } else if (action.toLowerCase() === "add-admin" || action.toLowerCase() === "remove-admin") {
      const isAdmin = action.toLowerCase() === "add-admin";
      console.log(`Propagating admin update via Socket to ${roomUid}...`);
      await socketEmitAddAdmin(roomUid, targetUsername, isAdmin);
      console.log("Completed successfully.");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

module.exports = { run };
