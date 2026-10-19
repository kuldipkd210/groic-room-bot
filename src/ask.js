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
        timeout: 12000,
        proxy: false
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
    "weather", "date", "who is", "what is happening", "2024", "2025", "2026", "stock", "update",
    "mcp", "model context protocol"
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
 * Cleans text from raw markdown stars or formatting symbols while preserving line breaks.
 */
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/#+\s?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sends prompt to Groq AI.
 *
 * @param {string} question - The user's prompt
 * @param {string} [mode="ask"] - Mode: "ask" for professional/informative, "xai" for funny/sarcastic Xaix personality
 * @param {string} [roomUid] - Room identifier
 * @param {string} [senderUsername] - Username of the sender
 * @param {number} [maxTokens=500] - Max output tokens
 * @returns {Promise<string|null>}
 */
async function askAi(question, mode = "ask", roomUid = "default", senderUsername = "", maxTokens = 450) {
  if (!GROQ_API_KEY) {
    console.log("[Ask] GROQ_API_KEY is not set");
    return null;
  }

  // Check if web search is needed for real-time information
  let webContext = "";
  if (needsWebSearch(question)) {
    const snippets = await searchWeb(question);
    if (snippets.length > 0) {
      webContext = `\nReal-Time Web Context:\n${snippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    }
  }

  const now = new Date();
  const todayFormatted = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  let systemPrompt = "";

  if (mode === "xai") {
    // !xai Mode: Witty, funny, sarcastic English companion (NO Hindi / NO slang)
    systemPrompt = [
      "You are xaix, a witty, playful, and lightly sarcastic AI companion in a live group chat.",
      "Your tone is clever, quick-witted, and fun banter, while remaining accurate and helpful.",
      `Today's current date is ${todayFormatted}.`,
      "",
      "Guidelines:",
      "• Length: Keep responses balanced—not too long, not too short. Aim for 2 to 4 crisp sentences (roughly 40 to 75 words). Never produce walls of text or essays, and avoid lazy one-word dismissals.",
      "• Directness: Jump straight into your answer or punchline. Do NOT use introductory filler (e.g. never say 'Alright, let's roast X', 'Here is your answer', or repeat the prompt).",
      "• Language: Respond in natural, clean English unless the user chats in another language first.",
      "• Roasts: Roast relatable human quirks and banter like a real chat friend—do not over-analyze literal usernames.",
      "• Lists/Recommendations: When asked for songs, movies, or recommendations, provide exactly 3 to 5 items in a clean numbered list (1., 2., 3.) with a brief one-line comment for each.",
      "• Identity: If asked who you are, introduce yourself warmly as their AI chat buddy.",
      "• Formatting: Plain text suitable for mobile chat. Avoid markdown formatting like asterisks or hashtags."
    ].join("\n");
  } else {
    // !ask Mode: Informative, professional, clean, clear, direct
    systemPrompt = [
      "You are a professional, knowledgeable, and reliable AI assistant in a live chat.",
      `Today's current date is ${todayFormatted}.`,
      "",
      "Guidelines:",
      "• Length: Keep responses balanced—not too long, not too short. Provide the core answer and essential context in 2 to 4 clear, well-structured sentences (roughly 40 to 75 words). Never write long essays or walls of text, and avoid curt one-word replies.",
      "• Directness: Jump straight into the answer without introductory filler, throat-clearing, or repeating the user's prompt.",
      "• Language: Clear, standard English with a professional yet approachable tone.",
      "• Lists/Steps: When asked for recommendations, steps, or tips, provide 3 to 5 concise points in a clean numbered list (1., 2., 3.) with line breaks.",
      "• Identity: If asked who you are, state simply and warmly that you are their AI assistant buddy.",
      "• Formatting: Plain text optimized for mobile chat readability. Avoid markdown formatting like asterisks or hashtags."
    ].join("\n");
  }

  const userContent = `${question}${webContext}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  const candidateModels = [
    GROQ_MODEL || "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-20b"
  ];
  // Deduplicate candidate models
  const modelsToTry = [...new Set(candidateModels.filter(Boolean))];

  for (const model of modelsToTry) {
    try {
      const res = await callGroq({
        model,
        messages,
        temperature: mode === "xai" ? 0.75 : 0.4,
        max_tokens: maxTokens
      });

      let answer = res?.data?.choices?.[0]?.message?.content?.trim();
      if (answer) {
        return cleanText(answer);
      }
    } catch (err) {
      console.log(`[Ask] Error with model ${model}:`, err?.response?.data?.error?.message || err.message);
    }
  }

  return null;
}

module.exports = {
  askAi
};
