const axios = require("axios");
const { GROQ_API_KEY, GROQ_MODEL } = require("../config/env");
const { HttpsProxyAgent } = require("https-proxy-agent");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Setup Proxy Agent
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Room conversation memory: Map<roomUid, Array<{ role: 'user'|'assistant', content: string }>>
// Stores up to 10 messages (5 Q&A turns) per room to keep memory lightweight.
const roomMemory = new Map();
const MAX_MEMORY_MESSAGES = 10;

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
 * Checks if a question requires live web search context.
 */
function needsWebSearch(query) {
  const q = query.toLowerCase();
  const keywords = [
    "news", "today", "latest", "current", "recent", "price", "score",
    "weather", "date", "who is", "what is happening", "2024", "2025", "2026", "stock", "update"
  ];
  return keywords.some((kw) => q.includes(kw));
}

/**
 * Performs lightweight live web search via DuckDuckGo.
 */
async function searchWeb(query) {
  try {
    const res = await axios.get("https://duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      },
      timeout: 4000,
      ...(httpsAgent ? { httpsAgent } : {})
    });
    const html = res.data;
    const snippets = [];
    const regex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = regex.exec(html)) !== null && snippets.length < 3) {
      const text = m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
      if (text) snippets.push(text);
    }
    return snippets;
  } catch (err) {
    console.log("[Ask] Web search failed:", err.message);
    return [];
  }
}

/**
 * Cleans text from raw markdown stars or formatting symbols.
 */
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/#/g, "")
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * Sends prompt to Groq AI with room memory, tone detection, and smart web search.
 *
 * @param {string} question - The user's prompt
 * @param {string} [roomUid] - Room identifier for context memory
 * @param {string} [senderUsername] - Username of the sender
 * @returns {Promise<string|null>}
 */
async function askAi(question, roomUid = "default", senderUsername = "") {
  if (!GROQ_API_KEY) {
    console.log("[Ask] GROQ_API_KEY is not set");
    return null;
  }

  // Get existing room history
  const history = roomMemory.get(roomUid) || [];

  // Check if web search is needed for real-time information
  let webContext = "";
  if (needsWebSearch(question)) {
    const snippets = await searchWeb(question);
    if (snippets.length > 0) {
      webContext = `\nReal-Time Web Context:\n${snippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    }
  }

  const systemPrompt = [
    "You are KD, an intelligent, quick-witted, and accurate AI assistant in a live group chat.",
    "Understand group chat dynamics: recognize sarcasm, jokes, or funny prompts and respond with matching humor and clever wit, while remaining accurate.",
    "Keep answers extremely concise: STRICT MAXIMUM OF 200 CHARACTERS TOTAL.",
    "Do NOT use markdown symbols like **, *, `, or # as responses are rendered in plain text.",
    "Be direct, accurate, and engaging."
  ].join(" ");

  const userContent = senderUsername
    ? `@${senderUsername} asked: ${question}${webContext}`
    : `${question}${webContext}`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userContent }
  ];

  try {
    const res = await callGroq({
      model: GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      temperature: 0.75,
      max_tokens: 150
    });

    let answer = res?.data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return null;

    answer = cleanText(answer);

    // Enforce strict 200 character limit
    if (answer.length > 200) {
      answer = answer.slice(0, 197) + "...";
    }

    // Save to room memory (up to 10 messages / 5 turns max)
    history.push({ role: "user", content: userContent });
    history.push({ role: "assistant", content: answer });
    while (history.length > MAX_MEMORY_MESSAGES) {
      history.shift();
    }
    roomMemory.set(roomUid, history);

    return answer;
  } catch (err) {
    console.log("[Ask] Failed to fetch answer:", err.message);
    return null;
  }
}

module.exports = {
  askAi
};

