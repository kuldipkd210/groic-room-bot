const https = require("https");
const axios = require("axios");

let cachedSpotifyToken = null;
let spotifyTokenExpiry = 0;

/**
 * Parses any Spotify URL, URI, or ID.
 * Returns { type: 'playlist' | 'album' | 'track', id: string } or null.
 */
function parseSpotifyUrl(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();

  // Match spotify:playlist:ID, https://open.spotify.com/playlist/ID, etc.
  const match = trimmed.match(
    /(?:spotify:|(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z]+\/)?)(playlist|album|track)[/:]([a-zA-Z0-9]+)/
  );

  if (match) {
    return { type: match[1], id: match[2] };
  }

  // Raw 22-char alphanumeric ID assumes playlist
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return { type: "playlist", id: trimmed };
  }

  return null;
}

/**
 * Fetches HTML from a given URL using Node https.
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        },
        timeout: 15000
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchHtml(res.headers.location).then(resolve).catch(reject);
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }
    ).on("error", reject);
  });
}

/**
 * Zero-config embed scraper: Extracts playlist/album/track metadata and track list
 * without needing any Spotify API key.
 */
async function fetchFromEmbed(type, id) {
  const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
  const html = await fetchHtml(embedUrl);

  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!match) {
    throw new Error(`Could not parse Spotify embed data for ${type} ${id}. Ensure the playlist is public.`);
  }

  const json = JSON.parse(match[1]);
  const entity = json.props?.pageProps?.state?.data?.entity;
  if (!entity) {
    throw new Error(`Spotify metadata entity not found for ${type} ${id}.`);
  }

  const name = entity.name || entity.title || "Spotify Playlist";
  let rawTracks = [];

  if (type === "track") {
    rawTracks = [entity];
  } else if (entity.trackList && Array.isArray(entity.trackList)) {
    rawTracks = entity.trackList;
  }

  const tracks = rawTracks
    .map((t) => {
      const artist =
        t.subtitle ||
        (t.artists && t.artists.map((a) => a.name).join(", ")) ||
        "Unknown Artist";

      return {
        title: (t.title || t.name || "").trim(),
        artist: artist.trim(),
        durationMs: t.duration || 0,
        durationSec: Math.round((t.duration || 0) / 1000),
        uri: t.uri || ""
      };
    })
    .filter((t) => t.title && t.title !== "Unknown Track" && t.durationSec > 10);

  return {
    name,
    type,
    id,
    trackCount: tracks.length,
    tracks
  };
}

/**
 * Gets an official Spotify API Client Credentials access token if credentials are provided.
 */
async function getSpotifyApiToken(clientId, clientSecret) {
  if (cachedSpotifyToken && Date.now() < spotifyTokenExpiry) {
    return cachedSpotifyToken;
  }

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 10000
    }
  );

  cachedSpotifyToken = res.data.access_token;
  // Expire 60s before real expiry
  spotifyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedSpotifyToken;
}

/**
 * Fetches tracks using the official Spotify Web API with pagination.
 */
async function fetchFromWebApi(type, id, clientId, clientSecret) {
  const token = await getSpotifyApiToken(clientId, clientSecret);
  const headers = { Authorization: `Bearer ${token}` };

  if (type === "track") {
    const res = await axios.get(`https://api.spotify.com/v1/tracks/${id}`, { headers, timeout: 10000 });
    const t = res.data;
    return {
      name: t.name,
      type,
      id,
      trackCount: 1,
      tracks: [
        {
          title: t.name,
          artist: (t.artists || []).map((a) => a.name).join(", "),
          durationMs: t.duration_ms,
          durationSec: Math.round(t.duration_ms / 1000),
          uri: t.uri
        }
      ]
    };
  }

  if (type === "album") {
    const res = await axios.get(`https://api.spotify.com/v1/albums/${id}`, { headers, timeout: 10000 });
    const album = res.data;
    const tracks = (album.tracks?.items || []).map((t) => ({
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(", ") || (album.artists || []).map((a) => a.name).join(", "),
      durationMs: t.duration_ms,
      durationSec: Math.round(t.duration_ms / 1000),
      uri: t.uri
    }));
    return {
      name: album.name,
      type,
      id,
      trackCount: tracks.length,
      tracks
    };
  }

  // Playlist with pagination
  const playlistRes = await axios.get(`https://api.spotify.com/v1/playlists/${id}`, { headers, timeout: 10000 });
  const playlistName = playlistRes.data.name;
  let allTracks = [];
  let nextUrl = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`;

  while (nextUrl && allTracks.length < 500) {
    const pageRes = await axios.get(nextUrl, { headers, timeout: 10000 });
    const items = pageRes.data.items || [];
    for (const item of items) {
      const t = item.track;
      if (!t || !t.name) continue;
      allTracks.push({
        title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(", "),
        durationMs: t.duration_ms,
        durationSec: Math.round(t.duration_ms / 1000),
        uri: t.uri
      });
    }
    nextUrl = pageRes.data.next;
  }

  return {
    name: playlistName,
    type,
    id,
    trackCount: allTracks.length,
    tracks: allTracks
  };
}

/**
 * Main export: fetches playlist/album/track by URL or ID.
 * Automatically uses Spotify Web API if client credentials exist in env,
 * otherwise falls back seamlessly to the Embed parser.
 */
async function getSpotifyTracks(input, options = {}) {
  const parsed = parseSpotifyUrl(input);
  if (!parsed) {
    throw new Error("Invalid Spotify link or ID. Format: https://open.spotify.com/playlist/<id>");
  }

  const clientId = options.clientId || process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = options.clientSecret || process.env.SPOTIFY_CLIENT_SECRET;

  if (clientId && clientSecret) {
    try {
      return await fetchFromWebApi(parsed.type, parsed.id, clientId, clientSecret);
    } catch (apiErr) {
      console.warn("Spotify Web API failed, falling back to embed scraper:", apiErr.message);
    }
  }

  return await fetchFromEmbed(parsed.type, parsed.id);
}

module.exports = {
  parseSpotifyUrl,
  getSpotifyTracks
};
