const axios = require("axios");
const { NTFY_TOPIC } = require("../config/env");
const { NOTIFY_COOLDOWN_MS } = require("../config/constants");

const lastNotificationTimes = {};

/**
 * Sends a mobile notification via Ntfy.sh to a specific topic.
 * @param {Object} options
 * @param {string} options.topic - Ntfy topic to publish to
 * @param {string} [options.targetName="user"] - Name/role of target recipient (for logs)
 * @param {string} options.senderUsername - Username of the person calling/mentioning
 * @param {string} options.messageText - The message text containing the mention/call
 * @param {string} options.roomUid - Current Groic room UID
 * @param {boolean} [options.isExplicitCall=false] - True if explicit call command
 * @returns {Promise<boolean>} True if notification was sent, false if rate limited or failed
 */
async function sendNtfyNotification({ topic, targetName = "user", senderUsername, messageText, roomUid, isExplicitCall = false }) {
  if (!topic) return false;

  const now = Date.now();
  const cooldown = NOTIFY_COOLDOWN_MS || 60000;
  const lastTime = lastNotificationTimes[topic] || 0;

  // Check rate limiting / cooldown per topic
  if (now - lastTime < cooldown) {
    const remainingSec = Math.ceil((cooldown - (now - lastTime)) / 1000);
    console.log(`[Notifier] Notification for topic '${topic}' rate-limited. Cooldown active for ${remainingSec}s.`);
    return false;
  }

  const roomLink = roomUid ? `https://groic.in/room/${roomUid}?autoJoin=true` : "https://groic.in";

  const bodyText = isExplicitCall
    ? `@${senderUsername} called you in kd's room:\n"${messageText}"`
    : `@${senderUsername} mentioned you in chat:\n"${messageText}"`;

  const priority = isExplicitCall ? "high" : "low";
  const title = isExplicitCall ? `Groic Room Call: @${senderUsername}` : `Groic Mention: @${senderUsername}`;

  try {
    const response = await axios.post(
      `https://ntfy.sh/${topic}`,
      bodyText,
      {
        headers: {
          Title: title,
          Priority: priority,
          Click: roomLink
        },
        timeout: 5000
      }
    );

    if (response.status === 200) {
      lastNotificationTimes[topic] = now;
      console.log(`[Notifier] Notification (${isExplicitCall ? "HIGH priority call" : "SILENT mention"}) sent to ntfy topic '${topic}' (${targetName}) for @${senderUsername}`);
      return true;
    }
  } catch (err) {
    console.error(`[Notifier] Failed to send ntfy notification to topic '${topic}':`, err.message);
  }

  return false;
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
async function sendUserNotification({ topic, targetName, senderUsername, messageText, roomUid, isExplicitCall = false }) {
  return sendNtfyNotification({ topic, targetName, senderUsername, messageText, roomUid, isExplicitCall });
}

module.exports = {
  sendOwnerNotification,
  sendUserNotification,
  sendNtfyNotification
};
