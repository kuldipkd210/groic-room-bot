const axios = require("axios");
const { askAi } = require("./ask");
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

/**
 * Fetches official lyrics from JioSaavn API (saavn.dev)
 */
async function fetchJioSaavnLyrics(songQuery) {
  try {
    const searchUrl = `https://saavn.dev/api/search/songs?query=${encodeURIComponent(songQuery)}&limit=1`;
    const res = await axios.get(searchUrl, {
      timeout: 8000,
      ...(httpsAgent ? { httpsAgent } : {})
    });

    const results = res.data?.data?.results || res.data?.results;
    if (!results || results.length === 0) return null;

    const song = results[0];
    const songId = song.id;
    const songName = song.name || songQuery;
    const primaryArtists = song.primaryArtists || song.artist || "";

    // Fetch lyrics by song ID
    const lyricsUrl = `https://saavn.dev/api/songs/${songId}/lyrics`;
    const lyricsRes = await axios.get(lyricsUrl, {
      timeout: 8000,
      ...(httpsAgent ? { httpsAgent } : {})
    });

    const rawLyrics = lyricsRes.data?.data?.lyrics || lyricsRes.data?.lyrics;
    if (!rawLyrics) return null;

    // Clean up HTML tags (e.g. <br>)
    const cleanLyrics = rawLyrics.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();

    return {
      title: songName,
      artist: primaryArtists,
      lyrics: cleanLyrics
    };
  } catch (err) {
    console.log("[Lyrics] JioSaavn lookup failed:", err.message);
    return null;
  }
}

/**
 * Fallback: Fetches official lyrics from LRCLIB API (lrclib.net)
 */
async function fetchLrclibLyrics(songQuery) {
  try {
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(songQuery)}`;
    const res = await axios.get(searchUrl, {
      timeout: 8000,
      ...(httpsAgent ? { httpsAgent } : {})
    });

    const items = res.data;
    if (!Array.isArray(items) || items.length === 0) return null;

    const match = items.find((item) => item.plainLyrics) || items[0];
    if (!match || !match.plainLyrics) return null;

    return {
      title: match.trackName || songQuery,
      artist: match.artistName || "",
      lyrics: match.plainLyrics.trim()
    };
  } catch (err) {
    console.log("[Lyrics] LRCLIB lookup failed:", err.message);
    return null;
  }
}

/**
 * Gets lyrics and line-by-line English translation using Hybrid approach
 */
async function getLyricsAndTranslation(songQuery) {
  if (!songQuery) return null;

  // 1. Try JioSaavn first (Best for Hindi, Tamil, Telugu, South Indian & Indian English songs)
  let result = await fetchJioSaavnLyrics(songQuery);

  // 2. Fallback to LRCLIB (Best for Global / Western English songs)
  if (!result || !result.lyrics) {
    result = await fetchLrclibLyrics(songQuery);
  }

  let prompt = "";

  if (result && result.lyrics) {
    // Provide full lyrics snippet for AI context
    const snippet = result.lyrics.slice(0, 3000);
    prompt = [
      `Song Title: "${result.title}" by ${result.artist}`,
      `Official Lyrics:`,
      snippet,
      ``,
      `Task:`,
      `1. Provide the complete lyrics of this song in Romanized English script (if native script).`,
      `2. Provide the line-by-line English translation directly under each line.`,
      `3. Put an empty blank line after each translation line so each lyric-translation pair is separated comfortably.`,
      `4. CRITICAL: Do NOT put line numbers (e.g. 1., 2., 3.) or bullet points before the lines. Write plain lines.`,
      `5. Do NOT truncate or add disclaimers about length.`
    ].join("\n");
  } else {
    // 3. Fallback direct AI generation if official lyrics database had no match
    prompt = [
      `Song: "${songQuery}"`,
      `Task:`,
      `1. Provide the full main lyrics of this song in Romanized English script.`,
      `2. Provide the line-by-line English translation directly under each line.`,
      `3. Put an empty blank line after each translation line so each lyric-translation pair is separated comfortably.`,
      `4. CRITICAL: Do NOT put line numbers (e.g. 1., 2., 3.) or bullet points before the lines. Write plain lines.`,
      `5. Do NOT truncate or add disclaimers about length.`
    ].join("\n");
  }

  try {
    // Request up to 1200 tokens for full lyrics & translation
    let formatted = await askAi(prompt, "ask", "default", "", 1200);
    if (!formatted) {
      if (result && result.lyrics) {
        return `🎵 **${result.title}** - ${result.artist}\n\n${result.lyrics}`;
      }
      return null;
    }
    // Remove any accidental line numbers (e.g. "1. ", "12. ") from the AI response
    formatted = formatted.replace(/^\s*\d+\.\s*/gm, "").trim();

    // Ensure empty line spacing between lyric-translation pairs if not present
    if (!formatted.includes("\n\n")) {
      const rawLines = formatted.split("\n").map(l => l.trim()).filter(Boolean);
      const paired = [];
      for (let i = 0; i < rawLines.length; i += 2) {
        if (i + 1 < rawLines.length) {
          paired.push(rawLines[i] + "\n" + rawLines[i + 1]);
        } else {
          paired.push(rawLines[i]);
        }
      }
      formatted = paired.join("\n\n");
    }

    formatted = "⚠️ Note: Translated by AI, it may be incorrect.\n\n" + formatted;
    return formatted;
  } catch (err) {
    console.log("[Lyrics] AI translation failed:", err.message);
    if (result && result.lyrics) {
      return `🎵 **${result.title}** - ${result.artist}\n\n${result.lyrics}`;
    }
    return null;
  }
}

module.exports = {
  getLyricsAndTranslation,
  fetchJioSaavnLyrics,
  fetchLrclibLyrics
};
