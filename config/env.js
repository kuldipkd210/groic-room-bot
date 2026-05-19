require("dotenv").config({ override: true });

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const PORT = process.env.PORT || 10000;
const ROOM_UID = process.env.ROOM_UID || null; // Set this on Render to skip HTTP room creation

if (!FIREBASE_API_KEY || !REFRESH_TOKEN) {
  console.error("Missing FIREBASE_API_KEY or REFRESH_TOKEN environment variable");
  process.exit(1);
}

module.exports = {
  FIREBASE_API_KEY,
  REFRESH_TOKEN,
  GROQ_API_KEY,
  GROQ_MODEL,
  PORT,
  ROOM_UID
};
