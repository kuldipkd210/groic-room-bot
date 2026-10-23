const fs = require("fs");
const path = require("path");
const ytSearch = require("yt-search");

const CACHE_FILE = path.join(__dirname, "../../.track_cache.json");

// In-memory cache + persistent disk cache
const trackCache = new Map();

function loadTrackCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      for (const [k, v] of Object.entries(data)) {
        trackCache.set(k, v);
      }
      console.log(`[YouTube] Loaded ${trackCache.size} cached tracks from disk.`);
    }
  } catch (e) {
    // ignore
  }
}

// Initial load on startup
loadTrackCache();

let saveCacheTimer = null;
function persistTrackCache() {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      const obj = Object.fromEntries(trackCache);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (e) {
      // ignore
    }
  }, 2000);
}

/**
 * Cleans Spotify titles and artists (removes non-breaking spaces, quotes,
 * extra movie clauses like 'From "..."') to guarantee fast, error-free YouTube searches.
 */
function cleanQueryString(title, artist) {
  let cleanTitle = (title || "").replace(/\u00a0/g, " ").replace(/["']/g, "").trim();
  let cleanArtist = (artist || "").replace(/\u00a0/g, " ").replace(/["']/g, "").trim();

  // Strip movie tags like '- From "..."' or '(From "...")'
  cleanTitle = cleanTitle.replace(/\s*[-–(]\s*From\s+[^)]+\)?/gi, "").trim();

  // Pick top 2 primary artists to keep query concise
  const artistParts = cleanArtist.split(/[,&]/).map((a) => a.trim()).filter(Boolean);
  const primaryArtists = artistParts.slice(0, 2).join(" ");

  return `${cleanTitle} ${primaryArtists}`.trim();
}

/**
 * Scores a YouTube video result to ensure it is embed-safe, avoids copyright-restricted
 * official movie/music videos (e.g. YRF, T-Series, VEVO, Sony Music, Zee Music),
 * and matches the track duration.
 */
function scoreCandidateVideo(v, expectedSec = 0) {
  let score = 0;
  const titleLower = (v.title || "").toLowerCase();
  const authorLower = (v.author?.name || "").toLowerCase();

  // Reject teasers, trailers, promos, or extremely short snippets
  if (
    (v.seconds && v.seconds < 45) ||
    titleLower.includes("teaser") ||
    titleLower.includes("trailer") ||
    titleLower.includes("promo") ||
    titleLower.includes("ringtone")
  ) {
    return -100;
  }

  // Major record labels that routinely disable third-party embedding on official music videos
  const isOfficialLabelChannel =
    authorLower.includes("vevo") ||
    authorLower.includes("yrf") ||
    authorLower.includes("t-series") ||
    authorLower.includes("zee music") ||
    authorLower.includes("sony music") ||
    authorLower.includes("warner") ||
    authorLower.includes("universal music") ||
    authorLower.includes("speed records") ||
    authorLower.includes("tips official") ||
    authorLower.includes("saregama");

  const isOfficialMovieClip =
    titleLower.includes("official video") ||
    titleLower.includes("music video") ||
    titleLower.includes("full video") ||
    titleLower.includes("video song");

  // Heavy penalty for official movie/music videos from known embed-restricting labels
  if (isOfficialLabelChannel && isOfficialMovieClip) {
    score -= 60; // Skip the restricted official song in favor of alternative uploads!
  }

  // Heavily reward alternative lyric videos and non-official uploads
  if (
    titleLower.includes("lyrics") ||
    titleLower.includes("lyrical") ||
    titleLower.includes("lyric video")
  ) {
    score += 55;
  } else if (titleLower.includes("audio") || authorLower.includes("topic") || authorLower.includes("- topic")) {
    score += 40;
  }

  // Bonus for community/lyric channels (unrestricted embeds)
  if (
    authorLower.includes("lyrics") ||
    authorLower.includes("lyrical") ||
    authorLower.includes("7clouds") ||
    authorLower.includes("cloudkid") ||
    authorLower.includes("cassiopeia") ||
    authorLower.includes("dopelyrics") ||
    authorLower.includes("taz network")
  ) {
    score += 30;
  }

  // Check duration proximity if expected duration from Spotify is provided
  if (expectedSec > 0 && v.seconds > 0) {
    const diff = Math.abs(v.seconds - expectedSec);
    if (diff <= 15) score += 25;
    else if (diff <= 35) score += 15;
    else if (diff > 120) score -= 30;
  }

  return score;
}

/**
 * Searches YouTube for an alternative, embed-safe video given a freeform query or { title, artist, durationSec }.
 * Automatically selects alternative lyric or community audio versions to bypass record label restrictions.
 * Returns a Groic-compatible song object.
 */
async function resolveTrackToYouTube(trackOrQuery) {
  let originalTitle = "";
  let originalArtist = "";
  let expectedSec = 0;
  let rawQuery = "";

  if (typeof trackOrQuery === "string") {
    rawQuery = trackOrQuery.trim();
    originalTitle = rawQuery;
    originalArtist = "";
  } else if (trackOrQuery && typeof trackOrQuery === "object") {
    originalTitle = trackOrQuery.title || "";
    originalArtist = trackOrQuery.artist || "";
    expectedSec = trackOrQuery.durationSec || 0;
    rawQuery = `${originalTitle} ${originalArtist}`.trim();
  }

  if (!rawQuery) {
    throw new Error("No track query provided for YouTube search");
  }

  // Cache key based on cleaned title and artist
  const cleanSearchQuery = cleanQueryString(originalTitle, originalArtist) || rawQuery;
  const cacheKey = `${cleanSearchQuery.toLowerCase()}_${expectedSec}`;

  if (trackCache.has(cacheKey)) {
    return trackCache.get(cacheKey);
  }

  try {
    let res;
    try {
      res = await ytSearch(cleanSearchQuery);
    } catch (searchErr) {
      // Fallback with just the title if composite query fails
      res = await ytSearch(originalTitle || rawQuery);
    }

    const videos = (res?.videos || []).filter((v) => v.seconds >= 40);

    if (videos.length === 0) {
      console.warn(`[YouTube] No video found for query: "${cleanSearchQuery}"`);
      return null;
    }

    // Rank candidate videos to pick the most embed-safe alternative
    const scoredCandidates = videos
      .map((v) => ({ v, score: scoreCandidateVideo(v, expectedSec) }))
      .sort((a, b) => b.score - a.score);

    const best = scoredCandidates[0]?.v || videos[0];

    const resolved = {
      songurl: best.videoId,
      title: originalTitle || best.title,
      artist: originalArtist || best.author?.name || "YouTube",
      imageurl: best.thumbnail || `https://i.ytimg.com/vi/${best.videoId}/hqdefault.jpg`,
      imageurlhigh: best.thumbnail || `https://i.ytimg.com/vi/${best.videoId}/hq720.jpg`,
      duration: best.seconds || 0,
      durationFormatted:
        best.timestamp ||
        `${Math.floor((best.seconds || 0) / 60)}:${((best.seconds || 0) % 60).toString().padStart(2, "0")}`,
      youtubePlayer: true,
      action: 1
    };

    trackCache.set(cacheKey, resolved);
    persistTrackCache();
    return resolved;
  } catch (err) {
    console.error(`[YouTube] Search error for "${cleanSearchQuery}":`, err ? err.message || err : "unknown error");
    return null;
  }
}

/**
 * Converts a Groic song object to the format required by Groic's sendPlaylist event:
 * { songurl, artist, title, imageurl, isPlaying }
 */
function toGroicPlaylistItem(song, isPlaying = false) {
  return {
    songurl: song.songurl,
    artist: song.artist,
    title: song.title,
    imageurl: song.imageurl || song.imageurlhigh || "",
    isPlaying: !!isPlaying
  };
}

module.exports = {
  resolveTrackToYouTube,
  toGroicPlaylistItem
};
