require("dotenv").config({ override: true });

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const PORT = process.env.PORT || 10000;
const ROOM_UID = process.env.ROOM_UID || null; // Set this on Render to skip HTTP room creation
const NTFY_TOPIC = process.env.NTFY_TOPIC || "groic_bot_alerts_kd";
const EXTRA_REFRESH_TOKENS = process.env.EXTRA_REFRESH_TOKENS ? process.env.EXTRA_REFRESH_TOKENS.split(",").map(t => t.trim()).filter(Boolean) : [];
const SPOTIFY_PLAYLIST_URL = process.env.SPOTIFY_PLAYLIST_URL || "";
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const PLAYLISTS_BLOB_ID = process.env.PLAYLISTS_BLOB_ID || "";

if (!FIREBASE_API_KEY || !REFRESH_TOKEN) {
  console.error("Missing FIREBASE_API_KEY or REFRESH_TOKEN environment variable");
  process.exit(1);
}

module.exports = {
  FIREBASE_API_KEY,
  REFRESH_TOKEN,
  GROQ_API_KEY,
  GROQ_MODEL,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  PORT,
  ROOM_UID,
  NTFY_TOPIC,
  EXTRA_REFRESH_TOKENS,
  SPOTIFY_PLAYLIST_URL,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  PLAYLISTS_BLOB_ID
};
