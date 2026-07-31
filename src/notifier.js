const axios = require("axios");
const { NTFY_TOPIC } = require("../config/env");
const { NOTIFY_COOLDOWN_MS } = require("../config/constants");

let lastNotificationTime = 0;

/**
 * Sends a mobile notification via Ntfy.sh when the owner is mentioned or called.
 * @param {Object} options
 * @param {string} options.senderUsername - Username of the person calling the owner
 * @param {string} options.messageText - The message text containing the mention/call
 * @param {string} options.roomUid - Current Groic room UID
 * @param {boolean} [options.isExplicitCall=false] - True if explicit call command (!callkd, !kd, !callowner)
 * @returns {Promise<boolean>} True if notification was sent, false if rate limited or failed
 */
async function sendOwnerNotification({ senderUsername, messageText, roomUid, isExplicitCall = false }) {
  const topic = NTFY_TOPIC || "groic_bot_alerts_kd";
  const now = Date.now();
  const cooldown = NOTIFY_COOLDOWN_MS || 120000;

  // Check rate limiting / cooldown
  if (now - lastNotificationTime < cooldown) {
    const remainingSec = Math.ceil((cooldown - (now - lastNotificationTime)) / 1000);
    console.log(`[Notifier] Notification rate-limited. Cooldown active for ${remainingSec}s.`);
    return false;
  }

  const roomLink = roomUid ? `https://groic.in/room/${roomUid}?autoJoin=true` : "https://groic.in";

  const bodyText = isExplicitCall
    ? `@${senderUsername} called you in room:\n"${messageText}"`
    : `@${senderUsername} mention you in chat:\n"${messageText}"`;

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
      lastNotificationTime = now;
      console.log(`[Notifier] Notification (${isExplicitCall ? "HIGH priority call" : "SILENT mention"}) sent to ntfy topic '${topic}' for @${senderUsername}`);
      return true;
    }
  } catch (err) {
    console.error(`[Notifier] Failed to send ntfy notification:`, err.message);
  }

  return false;
}

module.exports = {
  sendOwnerNotification
};
