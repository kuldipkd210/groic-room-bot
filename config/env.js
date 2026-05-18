require("dotenv").config({ override: true });

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const PORT = process.env.PORT || 10000;
const ROOM_UID = process.env.ROOM_UID || null; // Set this on Render to skip HTTP room creation

if (!FIREBASE_API_KEY || !REFRESH_TOKEN) {
  console.error("Missing FIREBASE_API_KEY or REFRESH_TOKEN environment variable");
  process.exit(1);
}

module.exports = {
  FIREBASE_API_KEY,
  REFRESH_TOKEN,
  GEMINI_API_KEY,
  PORT,
  ROOM_UID
};
