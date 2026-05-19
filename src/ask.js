const axios = require("axios");
const { GROQ_API_KEY, GROQ_MODEL } = require("../config/env");
const { HttpsProxyAgent } = require("https-proxy-agent");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Setup Proxy Agent
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Helper to sleep/wait
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGroq(payload) {
  const maxRetries = 3;
  let delay = 2000;

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

      const res = await axios.post(GROQ_URL, payload, config);
      return res;
    } catch (err) {
      const status = err?.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status >= 500 && status < 600;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        await sleep(delay);
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

/**
 * Sends a generic prompt to Groq AI and returns the response.
 *
 * @param {string} question - The user's prompt
 * @returns {Promise<string|null>}
 */
async function askAi(question) {
  if (!GROQ_API_KEY) {
    console.log("[Ask] GROQ_API_KEY is not set");
    return null;
  }

  const prompt = [
    "You are a helpful, friendly, and knowledgeable AI assistant.",
    "The user will ask you a question or give you a prompt.",
    "Give a concise, helpful, and direct answer.",
    "Do not use markdown formatting (like ** or *) because this will be sent in a plain text chat room.",
    "Keep your answer short and concise to fit within chat box limits.",
    "",
    `User Question: ${question}`
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
      temperature: 0.7
    });

    const answer = res?.data?.choices?.[0]?.message?.content?.trim();
    return answer || null;
  } catch (err) {
    console.log("[Ask] Failed to fetch answer:", err.message);
    return null;
  }
}

module.exports = {
  askAi
};
