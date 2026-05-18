const axios = require("axios");
const { GEMINI_API_KEY } = require("../config/env");
const { HttpsProxyAgent } = require("https-proxy-agent");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// Setup Proxy Agent matching api.js and socket.js
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Helper to sleep/wait
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generic helper to post to Gemini API with exponential backoff retries and optional proxy.
 *
 * @param {object} payload - The request body
 * @returns {Promise<object>} - Axios response
 */
async function callGemini(payload) {
  const maxRetries = 3;
  let delay = 2000; // Start with 2 seconds delay

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const config = {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
        ...(httpsAgent ? { httpsAgent } : {})
      };

      const res = await axios.post(
        `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
        payload,
        config
      );

      return res;
    } catch (err) {
      const status = err?.response?.status;
      const errorMsg = err?.response?.data?.error?.message || err.message;
      const errorCode = err?.response?.data?.error?.status || "UNKNOWN";

      console.log(
        `[Translate] Gemini API attempt ${attempt} failed (Status: ${status || "No Response"}, Error: ${errorMsg}, Code: ${errorCode})`
      );

      // Only retry on rate limits (429) or transient server errors (5xx)
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        console.log(`[Translate] Retrying in ${delay}ms...`);
        await sleep(delay);
        delay *= 2; // Exponential backoff
      } else {
        // Log detailed payload if it's a permanent failure
        if (err.response && err.response.data) {
          console.log("[Translate] Detailed API Error Response:", JSON.stringify(err.response.data, null, 2));
        }
        throw err;
      }
    }
  }
}

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
    const res = await callGemini({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ]
    });

    const translated =
      res?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    return translated || null;
  } catch (err) {
    // Already logged in callGemini helper
    return null;
  }
}

/**
 * Translates an array of chat messages to English in a single API call using Gemini JSON mode.
 *
 * @param {string[]} texts - Array of texts to translate
 * @returns {Promise<string[]|null>} - Array of translated texts in the exact same order
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
    const res = await callGemini({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

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
    // Already logged in callGemini helper
    return null;
  }
}

module.exports = {
  translateToEnglish,
  translateArrayOfTexts
};
