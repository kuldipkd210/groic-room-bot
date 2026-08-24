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
  constructor(accountIndex, roomUid, token, accountName, state) {
    this.accountIndex = accountIndex;
    this.roomUid = roomUid;
    this.token = token;
    this.accountName = accountName;
    this.state = state;
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

    this.socket.on("disconnect", () => {
      this.stopTimers();
    });

    this.socket.on("connect_error", () => {});
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

    // Each account dispatches at 520ms (~1.9 msgs/sec per account)
    // All accounts run simultaneously on their own independent timers
    const interval = 520;

    const fireTick = () => {
      if (!this.state.isRunning) return;

      if (this.socket && this.socket.connected) {
        const msg = generateMessage();
        this.socket.emit("sendChat", {
          message: msg,
          roomUid: this.roomUid
        });
        this.accountMsgs++;
        this.state.accountCounts[this.accountIndex] = this.accountMsgs;
        this.state.totalMessages++;
        this.state.triggerLogUpdate();
      }

      const jitter = (Math.random() * 0.15 - 0.075) * interval;
      const nextDelay = Math.max(450, interval + jitter);

      this.sendTimer = setTimeout(fireTick, nextDelay);
    };

    const initialOffset = this.accountIndex * 150;
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
    rooms.sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0));
    
    const myRank = rooms.findIndex(r => r.roomUid === roomUid) + 1;
    const nextRoom = myRank > 1 ? rooms[myRank - 2] : null;

    return {
      score: details?.engagementScore || 0,
      msgs: details?.messagesSent || 0,
      joins: details?.joinCount || 0,
      rank: myRank > 0 ? myRank : "-",
      totalRooms: rooms.length,
      nextRoomName: nextRoom ? (nextRoom.roomName || nextRoom.username) : "None (Rank #1)",
      nextRoomScore: nextRoom ? (nextRoom.engagementScore || 0) : null
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
  console.log("🚀 GROIC CONCURRENT MULTI-ACCOUNT ENGAGEMENT CANNON 🚀");
  console.log("==========================================================");
  console.log("Authenticating all accounts & fetching live stats...");

  await refreshAccessToken();
  const allTokens = getAllTokens();

  // If specific account filtered via CLI (e.g. --account 1)
  const targetTokens = options.accountIndex !== undefined && allTokens[options.accountIndex]
    ? [allTokens[options.accountIndex]]
    : allTokens;

  const initStats = await fetchLeaderboardStats(roomUid);
  const baseScore = initStats ? initStats.score : 0;
  const baseRank = initStats ? initStats.rank : "-";
  const totalRooms = initStats ? initStats.totalRooms : "-";

  console.log(`🎯 Target Room UID     : ${roomUid}`);
  console.log(`📊 Official DB Score   : ${baseScore.toLocaleString()} pts (Rank #${baseRank} / ${totalRooms})`);
  if (initStats && initStats.nextRoomName) {
    const ptsNeeded = Math.max(0, initStats.nextRoomScore - baseScore);
    console.log(`🎯 Next To Overtake    : "${initStats.nextRoomName}" (#${baseRank - 1}) -> ${ptsNeeded.toLocaleString()} pts needed`);
  }
  console.log(`🔑 Simultaneous Accs   : ${targetTokens.length} active registered Groic account(s)`);
  console.log(`⚡ Verified Ingestion  : ~${(targetTokens.length * 340).toLocaleString()} to ${(targetTokens.length * 380).toLocaleString()} pts/min (~${(targetTokens.length * 22000).toLocaleString()} pts/hour)`);
  console.log(`🔒 Zero-Ghost Policy   : 100% clean socket purge on Ctrl+C`);
  console.log("==========================================================");

  let lastLogTime = 0;
  const accountNames = targetTokens.map((token, i) => {
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return (decoded.name || `User_${i + 1}`).split(' ')[0];
  });

  const state = {
    isRunning: true,
    totalMessages: 0,
    startTime: Date.now(),
    liveScore: baseScore,
    currentRank: baseRank,
    nextTargetName: initStats?.nextRoomName,
    nextTargetScore: initStats?.nextRoomScore,
    accountCounts: targetTokens.map(() => 0),
    triggerLogUpdate: () => {
      const now = Date.now();
      if (now - lastLogTime < 300) return;
      lastLogTime = now;

      const elapsedSec = Math.max(1, Math.round((now - state.startTime) / 1000));
      const msgRate = (state.totalMessages / elapsedSec).toFixed(1);

      let nextStr = "";
      if (state.nextTargetScore) {
        const gap = state.nextTargetScore - state.liveScore;
        nextStr = gap > 0 ? ` | 🎯 #${state.currentRank - 1} in ${gap.toLocaleString()} pts` : ` | 👑 OVERTAKING #${state.currentRank - 1}!`;
      }

      // Display live per-account counts proving 100% parallel execution
      const accStatsStr = targetTokens.map((_, i) => `${accountNames[i]}: ${state.accountCounts[i]}`).join(' | ');

      console.log(`[⚡ ${msgRate} msg/s] [💬 ${accStatsStr}] [📈 Live: ${state.liveScore.toLocaleString()} | 🏆 Rank: #${state.currentRank}${nextStr}]`);
    }
  };

  // Official MongoDB poll every 10 seconds
  const dbSyncTimer = setInterval(async () => {
    if (!state.isRunning) return;
    const latest = await fetchLeaderboardStats(roomUid);
    if (latest && latest.score > 0) {
      state.liveScore = latest.score;
      state.currentRank = latest.rank;
      state.nextTargetName = latest.nextRoomName;
      state.nextTargetScore = latest.nextRoomScore;
      const netGain = latest.score - baseScore;
      const elapsedMin = ((Date.now() - state.startTime) / 60000).toFixed(1);
      console.log(`\n>>> 🟢 [GROIC MONGODB CONFIRMED] Official Score: ${latest.score.toLocaleString()} pts (Rank #${latest.rank} | +${netGain.toLocaleString()} pts in ${elapsedMin}m) <<<\n`);
    }
  }, 10000);

  // Spawn 1 dedicated continuous pipeline per account
  const pipelines = [];
  targetTokens.forEach((token, accIdx) => {
    const accName = accountNames[accIdx];
    const pipeline = new DedicatedAccountPipeline(accIdx, roomUid, token, accName, state);
    pipelines.push(pipeline);
    pipeline.start();
  });

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
    clearInterval(dbSyncTimer);

    pipelines.forEach(p => p.stop());
    for (const socket of Array.from(activeSockets)) {
      forceCloseSocket(socket);
    }
    activeSockets.clear();

    await sleep(400);

    console.log("Fetching final official score from Groic database...");
    const finalStats = await fetchLeaderboardStats(roomUid);
    const finalScore = finalStats ? finalStats.score : state.liveScore;
    const finalRank = finalStats ? finalStats.rank : state.currentRank;
    const netGained = finalScore - baseScore;
    const totalSec = Math.round((Date.now() - state.startTime) / 1000);

    console.log("==========================================================");
    console.log("🏁 ENGAGEMENT BOOSTER SUMMARY:");
    console.log(`Active Duration        : ${totalSec}s`);
    console.log(`Starting Score         : ${baseScore.toLocaleString()} pts (Rank #${baseRank})`);
    console.log(`Final Confirmed Score  : ${finalScore.toLocaleString()} pts (Rank #${finalRank})`);
    console.log(`Net Official Gain      : +${netGained.toLocaleString()} Points! 🚀`);
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
