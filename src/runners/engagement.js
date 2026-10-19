const { refreshAccessToken, getToken, getAllTokens } = require("../auth");
const { createSocketInstance } = require("../socket");
const { getRoomDetails, getActivePublicRooms } = require("../api");
const { loadRoomUid } = require("../storage");
const { sleep } = require("../helpers");
const { BOT_NAME, BOT_IMAGE_URL } = require("../../config/constants");

// Diverse, high-energy engaging message pool
const PHRASES = [
  "Vibing with the tunes in here! 🎵✨",
  "This playlist is pure fire 🔥🎧",
  "Who else is enjoying this track? 🎶🙌",
  "Love the energy in this room! ⚡💫",
  "Groove mode: ON! 🕺🔊",
  "Such a chill lounge to hang out in ☕🛋️",
  "Drop your favorite track recommendations! 🎼👇",
  "Great rhythm, feeling this vibe so much 🌟🎹",
  "Turn the volume up! 🔊🎶",
  "Music makes everything better ❤️🎵",
  "Loving the atmosphere here today! 🌸🎧",
  "Bass check! 🎛️💥",
  "Vibe check passed! 💯✨",
  "Anyone else got goosebumps from this song? 🤩🎶",
  "Endless good vibes in this room! 🌈🚀",
  "Keep the music playing! 📻🎶",
  "Top tier music selection 👌🔥",
  "Chat is alive and the music is banging! 🥳💫",
  "Let's get that room engagement to the moon! 🚀📈",
  "Smooth transitions and great beats 🎷🎧",
  "Best room on Groic right now! 👑🎵",
  "Sending good vibes to everyone in the room! ✨❤️",
  "Can never get tired of this playlist! 🎧🔥",
  "Dancing in my seat right now haha 💃🎶",
  "What a masterpiece track! 🎼✨",
  "The acoustic perfection in this room is unmatched 🎸🌟",
  "Chilling and listening with everyone! ☕✨",
  "Soundtrack of the day right here! 🎧🎶",
  "Big shoutout to the room owner for this vibe! 🙌🔥",
  "Every beat hits just right 🥁💥"
];

const EMOJIS = ["🔥", "⚡", "🎵", "🎧", "✨", "🎶", "💫", "🚀", "🕺", "💃", "🙌", "👑", "🌟", "🎼"];

function generateMessage() {
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  const hash = Math.random().toString(36).substring(2, 6);
  return `${phrase} ${emoji} #${hash}`;
}

const activeSockets = new Set();

function forceCloseSocket(socket) {
  if (!socket) return;
  try {
    socket.removeAllListeners();
    if (socket.connected) socket.disconnect();
    if (typeof socket.close === "function") socket.close();
  } catch (_) {}
  activeSockets.delete(socket);
}

class DedicatedAccountPipeline {
  constructor(pipelineIndex, totalPipelines, roomUid, token, accountName, state, interval = 120) {
    this.pipelineIndex = pipelineIndex;
    this.totalPipelines = totalPipelines;
    this.roomUid = roomUid;
    this.token = token;
    this.accountName = accountName;
    this.state = state;
    this.interval = interval;
    this.socket = null;
    this.sendTimer = null;
    this.syncTimer = null;
    this.accountMsgs = 0;
  }

  start() {
    this.socket = createSocketInstance("https://socket-v2.groic.in", this.token);
    activeSockets.add(this.socket);

    this.socket.on("connect", () => {
      this.socket.emit("joinRoom", {
        roomUid: this.roomUid,
        name: this.accountName,
        imageUrl: BOT_IMAGE_URL,
        isBot: false
      });

      this.startContinuousLoop();
      this.startSync();
    });

    this.socket.on("disconnect", (reason) => {
      this.stopTimers();
      // Socket.IO does not auto-reconnect on server disconnect
      if (reason === "io server disconnect") {
        setTimeout(() => {
          if (this.state.isRunning && this.socket) this.socket.connect();
        }, 1000);
      }
    });

    this.socket.on("connect_error", () => {
      // Automatic reconnection will handle retry
    });
  }

  startSync() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => {
      if (this.socket && this.socket.connected && this.state.isRunning) {
        this.socket.emit("requestSync", { roomUid: this.roomUid });
      }
    }, 20000);
  }

  startContinuousLoop() {
    if (this.sendTimer) clearTimeout(this.sendTimer);

    const interval = this.interval;

    const fireTick = () => {
      if (!this.state.isRunning) return;

      if (this.socket && this.socket.connected) {
        const msg = generateMessage();
        this.socket.emit("sendChat", {
          message: msg,
          roomUid: this.roomUid
        });
        this.accountMsgs++;
        this.state.accountCounts[this.pipelineIndex] = this.accountMsgs;
        this.state.totalMessages++;
        this.state.triggerLogUpdate();
      }

      const jitter = (Math.random() * 0.1 - 0.05) * interval;
      const nextDelay = Math.max(20, Math.round(interval + jitter));

      this.sendTimer = setTimeout(fireTick, nextDelay);
    };

    const initialOffset = Math.round((this.pipelineIndex * interval) / Math.max(1, this.totalPipelines));
    this.sendTimer = setTimeout(fireTick, initialOffset);
  }

  stopTimers() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.sendTimer = null;
    this.syncTimer = null;
  }

  stop() {
    this.stopTimers();
    forceCloseSocket(this.socket);
    this.socket = null;
  }
}

async function fetchLeaderboardStats(roomUid) {
  try {
    const details = await getRoomDetails(roomUid);
    const rooms = await getActivePublicRooms();
    const myPos = rooms.findIndex(r => r.roomUid === roomUid) + 1;

    return {
      roomName: details?.roomName || "Current Room",
      activeUsersCount: details?.activeUsers?.length || 0,
      activeUsers: details?.activeUsers || [],
      position: myPos > 0 ? myPos : "-",
      totalRooms: rooms.length
    };
  } catch (err) {
    return null;
  }
}

async function startEngagementBooster(options = {}) {
  const roomUid = options.roomUid || loadRoomUid();
  if (!roomUid) {
    console.error("Error: No roomUid specified or found in room.json");
    process.exit(1);
  }

  console.log("==========================================================");
  console.log("🚀 GROIC HIGH-SPEED MULTI-ACCOUNT ENGAGEMENT CANNON 🚀");
  console.log("==========================================================");
  console.log("Authenticating all accounts & connecting to room...");

  await refreshAccessToken();
  const allTokens = getAllTokens();

  // If specific account filtered via CLI (e.g. --account 1)
  const targetTokens = options.accountIndex !== undefined && allTokens[options.accountIndex]
    ? [allTokens[options.accountIndex]]
    : allTokens;

  const initStats = await fetchLeaderboardStats(roomUid);
  const roomTitle = initStats?.roomName || "Groic Room";
  const initialUsers = initStats?.activeUsersCount || 0;

  const targetRate = options.targetRate || (options.interval ? Math.round(1000 / options.interval * targetTokens.length) : 22);
  const channelsPerAccount = Math.max(1, parseInt(options.channels || options.clients || 1, 10));
  const totalPipelines = targetTokens.length * channelsPerAccount;

  let effectiveInterval = Math.max(25, Math.round((1000 * totalPipelines) / targetRate));
  if (options.interval && !options.targetRate) {
    effectiveInterval = Math.max(25, options.interval);
  }

  const estRate = ((1000 / effectiveInterval) * totalPipelines).toFixed(1);

  console.log(`🎯 Target Room UID     : ${roomUid} ("${roomTitle}")`);
  console.log(`👥 Active In Room      : ${initialUsers} user(s) currently connected`);
  console.log(`🔑 Active Accounts     : ${targetTokens.length} registered Groic account(s)`);
  console.log(`📡 Socket Pipelines    : ${totalPipelines} active parallel stream(s)`);
  console.log(`⚡ Target Fire Rate    : ~${estRate} msgs/sec (~${Math.round(estRate * 60).toLocaleString()} msgs/min)`);
  console.log(`🔒 Zero-Ghost Policy   : 100% clean socket purge on Ctrl+C`);
  console.log("==========================================================");

  let lastLogTime = 0;
  const accountNames = targetTokens.map((token, i) => {
    try {
      const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      return (decoded.name || `User_${i + 1}`).split(' ')[0];
    } catch (_) {
      return `User_${i + 1}`;
    }
  });

  const state = {
    isRunning: true,
    totalMessages: 0,
    startTime: Date.now(),
    liveUsers: initialUsers,
    accountCounts: new Array(totalPipelines).fill(0),
    triggerLogUpdate: () => {
      const now = Date.now();
      if (now - lastLogTime < 180) return;
      lastLogTime = now;

      const elapsedSec = Math.max(1, Math.round((now - state.startTime) / 1000));
      const msgRate = (state.totalMessages / elapsedSec).toFixed(1);

      // Aggregate counts by account name
      const perAccCounts = {};
      accountNames.forEach(name => { perAccCounts[name] = 0; });
      for (let p = 0; p < totalPipelines; p++) {
        const accIdx = p % targetTokens.length;
        const name = accountNames[accIdx];
        perAccCounts[name] = (perAccCounts[name] || 0) + state.accountCounts[p];
      }

      const accStatsStr = Object.entries(perAccCounts).map(([name, count]) => `${name}: ${count}`).join(' | ');
      console.log(`[⚡ ${msgRate} msg/s] [💬 ${accStatsStr}] [👥 In Room: ${state.liveUsers} | 📨 Total: ${state.totalMessages.toLocaleString()}]`);
    }
  };

  // Poll room active users periodically
  const roomSyncTimer = setInterval(async () => {
    if (!state.isRunning) return;
    const latest = await fetchLeaderboardStats(roomUid);
    if (latest) {
      state.liveUsers = latest.activeUsersCount;
    }
  }, 12000);

  // Spawn dedicated continuous pipelines
  const pipelines = [];
  let pipelineIdx = 0;
  for (let ch = 0; ch < channelsPerAccount; ch++) {
    for (let accIdx = 0; accIdx < targetTokens.length; accIdx++) {
      const token = targetTokens[accIdx];
      const accName = accountNames[accIdx];
      const pipeline = new DedicatedAccountPipeline(pipelineIdx, totalPipelines, roomUid, token, accName, state, effectiveInterval);
      pipelines.push(pipeline);
      pipeline.start();
      pipelineIdx++;
    }
  }

  // Background token refresh loop every 45 mins
  const tokenRefreshTimer = setInterval(async () => {
    try {
      await refreshAccessToken();
    } catch (err) {}
  }, 45 * 60 * 1000);

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log("\n[Cleanup] Stopping Booster and purging all socket channels...");
    state.isRunning = false;
    clearInterval(tokenRefreshTimer);
    clearInterval(roomSyncTimer);

    pipelines.forEach(p => p.stop());
    for (const socket of Array.from(activeSockets)) {
      forceCloseSocket(socket);
    }
    activeSockets.clear();

    await sleep(400);

    const totalSec = Math.max(1, Math.round((Date.now() - state.startTime) / 1000));
    const finalRate = (state.totalMessages / totalSec).toFixed(1);

    const perAccCounts = {};
    accountNames.forEach(name => { perAccCounts[name] = 0; });
    for (let p = 0; p < totalPipelines; p++) {
      const accIdx = p % targetTokens.length;
      const name = accountNames[accIdx];
      perAccCounts[name] = (perAccCounts[name] || 0) + state.accountCounts[p];
    }

    console.log("==========================================================");
    console.log("🏁 ENGAGEMENT BOOSTER SUMMARY:");
    console.log(`Active Duration        : ${totalSec}s`);
    console.log(`Total Messages Blasted : ${state.totalMessages.toLocaleString()} msgs`);
    console.log(`Average Fire Rate      : ${finalRate} msgs/sec 🚀`);
    console.log("----------------------------------------------------------");
    Object.entries(perAccCounts).forEach(([name, count]) => {
      console.log(`  • ${name.padEnd(20)} : ${count.toLocaleString()} msgs`);
    });
    console.log("----------------------------------------------------------");
    console.log(`Ghost Connections Left : 0 (Cleaned up completely)`);
    console.log("==========================================================");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    for (const socket of Array.from(activeSockets)) {
      forceCloseSocket(socket);
    }
  });
}

module.exports = {
  startEngagementBooster
};
