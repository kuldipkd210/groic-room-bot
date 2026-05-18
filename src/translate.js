const axios = require("axios");
const { GEMINI_API_KEY } = require("../config/env");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

/**
 * Translates the given text to English using Gemini AI.
 * Handles mixed-language inputs like Tanglish (Tamil+English), Tenglish, etc.
 * Returns the translated English string, or null on failure.
 *
 * @param {string} text - The message to translate
 * @returns {Promise<string|null>}
 */
async function translateToEnglish(text) {
  if (!GEMINI_API_KEY) {
    console.log("[Translate] GEMINI_API_KEY is not set in .env");
    return null;
  }

  const prompt = [
    "You are a translator bot. The user will give you a chat message that may be in any language",
    "or a mix of languages (e.g. Tanglish = Tamil + English, Hinglish = Hindi + English, etc.).",
    "Translate the ENTIRE message into clear, natural English.",
    "Only return the translated text — no explanations, no extra text, no quotation marks.",
    "",
    `Message: ${text}`
  ].join("\n");

  try {
    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      }
    );

    const translated =
      res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    return translated || null;
  } catch (err) {
    console.log("[Translate] Gemini API error:", err?.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * Translates an array of chat messages to English in a single API call using Gemini JSON mode.
 *
 * @param {string[]} texts - Array of texts to translate
 * @returns {Promise<string[]|null>} - Array of translated texts in the same order
 */
async function translateArrayOfTexts(texts) {
  if (!GEMINI_API_KEY) {
    console.log("[Translate] GEMINI_API_KEY is not set in .env");
    return null;
  }

  const prompt = [
    "You are a translator bot. The user will provide a JSON array of chat messages.",
    "Translate each message into clear, natural English.",
    "Return the result strictly as a valid JSON array of translated strings in the exact same order.",
    "Do not include any markdown block markers, code blocks (like ```json), explanations, or extra text.",
    "",
    `Messages: ${JSON.stringify(texts)}`
  ].join("\n");

  try {
    const res = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000
      }
    );

    let responseText = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch (err) {
    console.log("[Translate] Array translation error:", err?.response?.data?.error?.message || err.message);
    return null;
  }
}

module.exports = {
  translateToEnglish,
  translateArrayOfTexts
};
