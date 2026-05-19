const axios = require("axios");
const { GROQ_API_KEY, GROQ_MODEL } = require("../config/env");
const { HttpsProxyAgent } = require("https-proxy-agent");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Setup Proxy Agent matching api.js and socket.js
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Helper to sleep/wait
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generic helper to post to Groq API with exponential backoff retries and optional proxy.
 *
 * @param {object} payload - The request body
 * @returns {Promise<object>} - Axios response
 */
async function callGroq(payload) {
  const maxRetries = 3;
  let delay = 2000; // Start with 2 seconds delay

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const config = {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        timeout: 15000,
        ...(httpsAgent ? { httpsAgent } : {})
      };

      const res = await axios.post(
        GROQ_URL,
        payload,
        config
      );

      return res;
    } catch (err) {
      const status = err?.response?.status;
      const errorMsg = err?.response?.data?.error?.message || err.message;
      const errorCode = err?.response?.data?.error?.code || "UNKNOWN";

      console.log(
        `[Translate] Groq API attempt ${attempt} failed (Status: ${status || "No Response"}, Error: ${errorMsg}, Code: ${errorCode})`
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
 * Translates the given text to English using Groq AI.
 * Handles mixed-language inputs like Tanglish (Tamil+English), Tenglish, etc.
 * Returns the translated English string, or null on failure.
 *
 * @param {string} text - The message to translate
 * @returns {Promise<string|null>}
 */
async function translateToEnglish(text) {
  if (!GROQ_API_KEY) {
    console.log("[Translate] GROQ_API_KEY is not set in .env");
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
    const res = await callGroq({
      model: GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.1
    });

    const translated =
      res?.data?.choices?.[0]?.message?.content?.trim();

    return translated || null;
  } catch (err) {
    // Already logged in callGroq helper
    return null;
  }
}

/**
 * Translates an array of chat messages to English in a single API call using Groq JSON mode.
 *
 * @param {string[]} texts - Array of texts to translate
 * @returns {Promise<string[]|null>} - Array of translated texts in the exact same order
 */
async function translateArrayOfTexts(texts) {
  if (!GROQ_API_KEY) {
    console.log("[Translate] GROQ_API_KEY is not set in .env");
    return null;
  }

  const prompt = [
    "You are a translator bot. The user will provide a JSON array of chat messages.",
    "Translate each message into clear, natural English.",
    "Return the result strictly as a valid JSON object with a single key 'translations' whose value is a JSON array of translated strings in the exact same order.",
    "Example format:",
    "{\"translations\": [\"translation1\", \"translation2\"]}",
    "",
    `Messages: ${JSON.stringify(texts)}`
  ].join("\n");

  try {
    const res = await callGroq({
      model: GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    let responseText = res?.data?.choices?.[0]?.message?.content?.trim() || "";

    if (responseText.startsWith("```")) {
      responseText = responseText.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }

    const parsed = JSON.parse(responseText);

    if (parsed && Array.isArray(parsed.translations)) {
      return parsed.translations;
    }

    // In case the model returned a plain array despite prompt instructions (fallback check)
    if (Array.isArray(parsed)) {
      return parsed;
    }

    // Try to find any array property in the parsed object (additional resilience fallback)
    for (const key in parsed) {
      if (Array.isArray(parsed[key])) {
        return parsed[key];
      }
    }

    return null;
  } catch (err) {
    // Already logged in callGroq helper
    return null;
  }
}

module.exports = {
  translateToEnglish,
  translateArrayOfTexts
};
