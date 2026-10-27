const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { DEFAULT_PLAYLISTS } = require("../../config/constants");

const PLAYLISTS_FILE = path.join(__dirname, "../../playlists.json");

let playlistsCache = null;

/**
 * Normalizes input so each playlist is simply: { "name": "url" }
 */
function normalizePlaylists(data) {
  if (!data || typeof data !== "object") return {};
  const normalized = {};

  for (const [key, val] of Object.entries(data)) {
    const cleanName = key.toLowerCase().trim();
    if (typeof val === "string") {
      normalized[cleanName] = val.trim();
    } else if (val && typeof val === "object" && val.url) {
      normalized[cleanName] = val.url.trim();
    }
  }
  return normalized;
}

/**
 * Loads playlists from playlists.json, falling back to DEFAULT_PLAYLISTS if missing or empty.
 */
function loadPlaylists() {
  if (playlistsCache) return playlistsCache;

  if (!fs.existsSync(PLAYLISTS_FILE)) {
    try {
      fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(DEFAULT_PLAYLISTS, null, 2), "utf8");
    } catch (err) {
      console.error("[Playlists] Failed to create playlists.json, using defaults:", err.message);
    }
    playlistsCache = normalizePlaylists(DEFAULT_PLAYLISTS);
    return playlistsCache;
  }

  try {
    const raw = fs.readFileSync(PLAYLISTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizePlaylists(parsed);
    if (Object.keys(normalized).length === 0) {
      playlistsCache = normalizePlaylists(DEFAULT_PLAYLISTS);
    } else {
      playlistsCache = normalized;
    }
    return playlistsCache;
  } catch (err) {
    console.error("[Playlists] Failed to read playlists.json, using defaults:", err.message);
    playlistsCache = normalizePlaylists(DEFAULT_PLAYLISTS);
    return playlistsCache;
  }
}

/**
 * Saves playlists to local playlists.json.
 */
function savePlaylistsLocally(data) {
  playlistsCache = normalizePlaylists(data);
  try {
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlistsCache, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[Playlists] Failed to save playlists.json:", err.message);
    return false;
  }
}

/**
 * Syncs playlists from JSONBlob cloud storage on startup or room join.
 */
async function syncPlaylistsFromCloud() {
  const blobId = process.env.PLAYLISTS_BLOB_ID || process.env.PLAYLIST_BLOB_ID;
  if (!blobId) {
    console.log("[Playlists] No PLAYLISTS_BLOB_ID configured. Using local playlists.json.");
    loadPlaylists();
    return;
  }

  console.log(`[Playlists] Syncing playlists from cloud JSONBlob: ${blobId}`);
  try {
    const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${blobId}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });

    if (res.data && typeof res.data === "object") {
      const fromCloud = normalizePlaylists(res.data);
      if (Object.keys(fromCloud).length > 0) {
        savePlaylistsLocally(fromCloud);
        console.log(`[Playlists] Successfully synced ${Object.keys(fromCloud).length} playlists from cloud JSONBlob.`);
        return;
      }
    }
  } catch (err) {
    console.error(`[Playlists] Failed to read cloud JSONBlob ${blobId}:`, err.message);
  }

  loadPlaylists();
}

/**
 * Saves locally and syncs to JSONBlob cloud storage.
 */
async function savePlaylistsAndSync(data) {
  savePlaylistsLocally(data);

  const blobId = process.env.PLAYLISTS_BLOB_ID || process.env.PLAYLIST_BLOB_ID;
  if (!blobId) {
    return;
  }

  console.log(`[Playlists] Uploading playlists to cloud JSONBlob: ${blobId}`);
  try {
    await axios.put(`https://jsonblob.com/api/jsonBlob/${blobId}`, data, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      timeout: 10000
    });
    console.log(`[Playlists] Successfully updated cloud JSONBlob ${blobId}.`);
  } catch (err) {
    console.error(`[Playlists] Failed to update cloud JSONBlob ${blobId}:`, err.message);
  }
}

/**
 * Finds a saved playlist by its single name.
 */
function findPlaylist(name) {
  if (!name || typeof name !== "string") return null;
  const trimmed = name.trim();

  if (/^(https?:\/\/|spotify:)/i.test(trimmed)) {
    return { isUrl: true, url: trimmed };
  }

  const playlists = loadPlaylists();
  const q = trimmed.toLowerCase();

  if (playlists[q]) {
    return { name: q, url: playlists[q] };
  }

  return null;
}

/**
 * Formats all saved playlists for !lists output with exactly one name per playlist.
 */
function formatPlaylistList() {
  const playlists = loadPlaylists();
  const names = Object.keys(playlists);

  if (names.length === 0) {
    return "No saved playlists found.\nAdd one using: !addlist <name> <url>";
  }

  let text = "Saved Playlists:\n";
  names.forEach((name) => {
    text += `\n• ${name}`;
  });

  text += `\n\nPlay : !load <name>`;
  text += `\nAdd : !addlist <name> <spotify playlist url>`;
  text += `\nDelete : !delist <name>`;
  return text;
}

/**
 * Adds a new playlist by single name.
 */
async function addSavedPlaylist(name, url) {
  const playlists = { ...loadPlaylists() };
  const cleanName = name.toLowerCase().trim().replace(/\s+/g, "_");

  playlists[cleanName] = url.trim();

  await savePlaylistsAndSync(playlists);
  return { name: cleanName, url: url.trim() };
}

/**
 * Deletes a saved playlist by single name.
 */
async function removeSavedPlaylist(name) {
  const playlists = { ...loadPlaylists() };
  const cleanName = name.toLowerCase().trim();

  if (!playlists[cleanName]) {
    return null;
  }

  const url = playlists[cleanName];
  delete playlists[cleanName];
  await savePlaylistsAndSync(playlists);
  return { name: cleanName, url };
}

module.exports = {
  loadPlaylists,
  savePlaylistsLocally,
  syncPlaylistsFromCloud,
  savePlaylistsAndSync,
  findPlaylist,
  formatPlaylistList,
  addSavedPlaylist,
  removeSavedPlaylist
};
