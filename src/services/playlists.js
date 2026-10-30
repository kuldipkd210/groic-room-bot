const fs = require("fs");
const path = require("path");

const PLAYLISTS_FILE = path.join(__dirname, "../../playlists.json");

let playlistsCache = null;

/**
 * Normalizes input so each playlist is: { "name": { "url": "...", "addedBy": "..." } }
 */
function normalizePlaylists(data) {
  if (!data || typeof data !== "object") return {};
  const normalized = {};

  for (const [key, val] of Object.entries(data)) {
    const cleanName = key.toLowerCase().trim();
    if (typeof val === "string") {
      normalized[cleanName] = {
        url: val.trim(),
        addedBy: null
      };
    } else if (val && typeof val === "object" && val.url) {
      normalized[cleanName] = {
        url: val.url.trim(),
        addedBy: val.addedBy ? String(val.addedBy).replace(/^@/, "").trim() : null
      };
    }
  }
  return normalized;
}

/**
 * Loads playlists from playlists.json without forcing default playlists.
 */
function loadPlaylists() {
  if (playlistsCache) return playlistsCache;

  if (!fs.existsSync(PLAYLISTS_FILE)) {
    try {
      fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify({}, null, 2), "utf8");
    } catch (err) {
      console.error("[Playlists] Failed to create playlists.json:", err.message);
    }
    playlistsCache = {};
    return playlistsCache;
  }

  try {
    const raw = fs.readFileSync(PLAYLISTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    playlistsCache = normalizePlaylists(parsed);
    return playlistsCache;
  } catch (err) {
    console.error("[Playlists] Failed to read playlists.json:", err.message);
    playlistsCache = {};
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

const { getBasket, setBasket } = require("./pantry");

/**
 * Syncs playlists from Pantry cloud storage on startup or room join.
 */
async function syncPlaylistsFromCloud() {
  console.log("[Playlists] Syncing playlists from Pantry cloud basket: 'playlists'");
  const cloudData = await getBasket("playlists");

  if (cloudData && typeof cloudData === "object") {
    const fromCloud = normalizePlaylists(cloudData);
    savePlaylistsLocally(fromCloud);
    console.log(`[Playlists] Successfully synced ${Object.keys(fromCloud).length} playlists from Pantry.`);
    return;
  }

  // If basket doesn't exist on Pantry, initialize it as empty {}
  console.log("[Playlists] Initializing empty 'playlists' basket in Pantry...");
  await setBasket("playlists", {});
  loadPlaylists();
}

/**
 * Saves locally and syncs to Pantry cloud storage.
 */
async function savePlaylistsAndSync(data) {
  savePlaylistsLocally(data);
  console.log("[Playlists] Uploading playlists to Pantry cloud basket: 'playlists'");
  const syncResult = await setBasket("playlists", data);
  return syncResult;
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
    const item = playlists[q];
    const url = typeof item === "string" ? item : item.url;
    const addedBy = typeof item === "object" ? item.addedBy : null;
    return { name: q, url, addedBy };
  }

  return null;
}

/**
 * Formats all saved playlists for !pl list output with recorder credit:
 * │ • playlist_1 • [username]
 */
function formatPlaylistList() {
  const playlists = loadPlaylists();
  const names = Object.keys(playlists);

  let lines = [
    "╭─── 🎧 SAVED PLAYLISTS ────╮",
    " "
  ];

  if (names.length === 0) {
    lines.push("  (No saved playlists found)");
  } else {
    names.forEach((name) => {
      const item = playlists[name];
      const addedBy = typeof item === "object" && item?.addedBy ? item.addedBy : null;
      if (addedBy) {
        lines.push(`  • ${name} • [${addedBy}]`);
      } else {
        lines.push(`  • ${name}`);
      }
    });
    lines.push(" ");
    lines.push("├──────────────────────┤");
    lines.push("  • !pl play [name] • play");
  }

  lines.push("╰──────────────────────╯");
  return lines.join("\n");
}

/**
 * Adds a new playlist by single name and records who added it.
 */
async function addSavedPlaylist(name, url, addedBy = null) {
  const playlists = { ...loadPlaylists() };
  const cleanName = name.toLowerCase().trim().replace(/\s+/g, "_");
  const cleanUser = addedBy ? String(addedBy).replace(/^@/, "").trim() : null;

  playlists[cleanName] = {
    url: url.trim(),
    addedBy: cleanUser
  };

  const syncResult = await savePlaylistsAndSync(playlists);
  return {
    name: cleanName,
    url: url.trim(),
    addedBy: cleanUser,
    cloudSynced: syncResult?.success ?? false,
    cloudError: syncResult?.error || null
  };
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

  const item = playlists[cleanName];
  const url = typeof item === "string" ? item : item.url;
  delete playlists[cleanName];
  const syncResult = await savePlaylistsAndSync(playlists);
  return {
    name: cleanName,
    url,
    cloudSynced: syncResult?.success ?? false,
    cloudError: syncResult?.error || null
  };
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
