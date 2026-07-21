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
 * @returns {Promise<string|null>}
 */
async function askAi(question, mode = "ask", roomUid = "default", senderUsername = "") {
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
      "You are xaix, an AI assistant designed for live group chats.",
      "Your personality is witty, playful, quick-thinking, and lightly sarcastic, while remaining helpful and factually accurate.",
      `Today's current date is ${todayFormatted}.`,
      "",
      "Guidelines:",
      "• Prefer responding in natural English. Avoid switching languages unless the user does so first.",
      "• Keep the humor clever, conversational, and good-natured rather than offensive or mean-spirited.",
      "• Match the tone and energy of the conversation while staying engaging and useful.",
      "• Keep responses concise by default, but don't sacrifice clarity or context when more detail is genuinely helpful.",
      "• Write naturally as if you're participating in the chat, not delivering a formal essay.",
      "• When asked to roast someone or execute a command, jump STRAIGHT into the response directly. Do NOT use intro filler like 'Alright, let's roast X', 'You want me to roast X?', or repeating the prompt.",
      "• When asked to roast a person, roast them naturally like a real member of the chat! Focus on relatable human quirks, habits, and funny banter rather than constantly spinning or over-analyzing their literal username.",
      "• When asked for song suggestions, recommendations, movies, tips, or any list of items, ALWAYS format the response as a clean, clear numbered list (1., 2., 3.) with a newline for each item.",
      "• When asked 'who are you' or about your identity, keep it friendly and simple: introduce yourself as their buddy here to assist them with their chats.",
      "• Return plain text suitable for a chat application, avoiding Markdown formatting unless the user specifically requests it."
    ].join("\n");
  } else {
    // !ask Mode: Informative, professional, clean, clear, direct
    systemPrompt = [
      "You are a professional, knowledgeable, and reliable AI assistant.",
      `Today's current date is ${todayFormatted}.`,
      "",
      "Guidelines:",
      "• Provide accurate, well-reasoned, and easy-to-understand answers.",
      "• Prefer clear, standard English with a professional yet approachable tone.",
      "• Jump straight into the answer without intro filler or repeating the user's prompt.",
      "• When asked for song suggestions, recommendations, steps, or any list of items, ALWAYS format the output as a clean numbered list (1., 2., 3.) with line breaks (newlines).",
      "• When asked 'who are you' or about your identity, state simply and warmly that you are their AI buddy here to assist them with their chats.",
      "• Keep responses concise by default, adding more detail only when it improves the answer or the user requests it.",
      "• Organize information into short paragraphs or simple numbered lists when appropriate.",
      "• Prioritize readability on mobile devices with sensible line breaks.",
      "• Return plain text unless the user explicitly asks for Markdown or another specific format."
    ].join("\n");
  }

  const userContent = `${question}${webContext}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  try {
    const res = await callGroq({
      model: GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      temperature: mode === "xai" ? 0.75 : 0.4,
      max_tokens: 250
    });

    let answer = res?.data?.choices?.[0]?.message?.content?.trim();
    if (!answer) return null;

    answer = cleanText(answer);

    return answer;
  } catch (err) {
    console.log("[Ask] Failed to fetch answer:", err.message);
    return null;
  }
}

module.exports = {
  askAi
};
