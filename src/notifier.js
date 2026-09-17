const axios = require("axios");
const { NTFY_TOPIC } = require("../config/env");
const { NOTIFY_COOLDOWN_MS } = require("../config/constants");

const lastNotificationTimes = {};

const roomNameCache = {};

function setCachedRoomName(roomUid, name) {
  if (roomUid && name) {
    roomNameCache[roomUid] = name;
  }
}

/**
 * Sends a mobile notification via Ntfy.sh to a specific topic.
 * @param {Object} options
 * @param {string} options.topic - Ntfy topic to publish to
 * @param {string} [options.targetName="user"] - Name/role of target recipient (for logs)
 * @param {string} options.senderUsername - Username of the person calling/mentioning
 * @param {string} options.messageText - The message text containing the mention/call
 * @param {string} options.roomUid - Current Groic room UID
 * @param {string} [options.roomName=""] - Current Groic room Name
 * @param {boolean} [options.isExplicitCall=false] - True if explicit call command
 * @param {boolean} [options.isSelfTest=false] - True if self-test call
 * @returns {Promise<Object>} Status object with success flag and details
 */
async function sendNtfyNotification({ topic, targetName = "user", senderUsername, messageText, roomUid, roomName, isExplicitCall = false, isSelfTest = false }) {
  if (!topic) return { success: false, reason: "no_topic" };

  const now = Date.now();
  const cooldown = NOTIFY_COOLDOWN_MS || 60000;
  const lastTime = lastNotificationTimes[topic] || 0;

  // Check rate limiting / cooldown per topic
  if (now - lastTime < cooldown) {
    const remainingSec = Math.ceil((cooldown - (now - lastTime)) / 1000);
    console.log(`[Notifier] Notification for topic '${topic}' rate-limited. Cooldown active for ${remainingSec}s.`);
    return { success: false, reason: "cooldown", remainingSec };
  }

  const roomLink = roomUid ? `https://groic.in/room/${roomUid}?autoJoin=true` : "https://groic.in";
  const effectiveRoomName = roomName || roomNameCache[roomUid] || "";
  const roomDisplay = effectiveRoomName
    ? `room "${roomUid}" (${effectiveRoomName})`
    : (roomUid ? `room "${roomUid}"` : "your room");

  const bodyText = isSelfTest
    ? `[Self-Test] You triggered a test call in ${roomDisplay}:\n"${messageText}"`
    : isExplicitCall
      ? `@${senderUsername} called you in ${roomDisplay}:\n"${messageText}"`
      : `@${senderUsername} mentioned you in ${roomDisplay}:\n"${messageText}"`;

  const priority = isExplicitCall ? "high" : "min";
  const title = isSelfTest
    ? `Groic Call Test: @${senderUsername}`
    : isExplicitCall
      ? `@${senderUsername} called you in ${effectiveRoomName || roomUid || "Groic"}`
      : `@${senderUsername} mentioned you in ${effectiveRoomName || roomUid || "Groic"}`;

  try {
    const headers = {
      Title: title,
      Priority: priority,
      Click: roomLink,
      Actions: `view, Join Room, ${roomLink}`
    };

    const response = await axios.post(
      `https://ntfy.sh/${topic}`,
      bodyText,
      {
        headers,
        timeout: 5000
      }
    );

    if (response.status === 200) {
      lastNotificationTimes[topic] = now;
      console.log(`[Notifier] Notification (${isExplicitCall ? "HIGH priority call" : "SILENT mention"}) sent to ntfy topic '${topic}' (${targetName}) for @${senderUsername}`);
      return { success: true };
    }
  } catch (err) {
    console.error(`[Notifier] Failed to send ntfy notification to topic '${topic}':`, err.message);
    return { success: false, reason: "error", error: err.message };
  }

  return { success: false, reason: "unknown" };
}

/**
 * Sends a mobile notification to the owner via Ntfy.sh.
 */
async function sendOwnerNotification(options) {
  const topic = NTFY_TOPIC || "groic_bot_alerts_kd";
  return sendNtfyNotification({ ...options, topic, targetName: "owner" });
}

/**
 * Sends a mobile notification to a specific user/friend via Ntfy.sh.
 */
async function sendUserNotification(options) {
  return sendNtfyNotification(options);
}

module.exports = {
  sendOwnerNotification,
  sendUserNotification,
  sendNtfyNotification,
  setCachedRoomName
};
