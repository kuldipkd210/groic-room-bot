const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

function getPantryId() {
  return process.env.PANTRY_ID || "6f0b6e37-5c48-4501-b1c7-37571b142056";
}

function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global promise queue to strictly enforce Pantry rate limits (2500ms between calls)
let requestQueue = Promise.resolve();
const DELAY_BETWEEN_REQUESTS_MS = 2500;

function enqueue(fn) {
  const run = requestQueue.then(async () => {
    try {
      return await fn();
    } finally {
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
  });
  // Prevent unhandled rejections from breaking the queue chain
  requestQueue = run.catch(() => {});
  return run;
}

/**
 * Executes an HTTP operation with retry and exponential backoff on HTTP 429 (Too Many Requests).
 */
async function executeWithRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response ? err.response.status : null;
      if (status === 429 && attempt < maxRetries) {
        const waitTime = (attempt + 1) * 3000;
        console.warn(`[Pantry] Rate limit reached (429). Waiting ${waitTime}ms before retry ${attempt + 1}...`);
        await sleep(waitTime);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Reads a basket from Pantry.
 * Returns the parsed JSON data, or null if not found (status 400 or 404).
 */
async function getBasket(basketName) {
  const pantryId = getPantryId();
  if (!pantryId) return null;

  return enqueue(async () => {
    const url = `https://getpantry.cloud/apiv1/pantry/${pantryId}/basket/${basketName}`;
    const headers = {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };

    return executeWithRetry(async () => {
      try {
        const res = await axios.get(url, { headers, timeout: 10000 });
        return res.data;
      } catch (err) {
        // Pantry returns 400 or 404 when a basket does not exist
        if (err.response && (err.response.status === 400 || err.response.status === 404)) {
          return null;
        }

        // For genuine network errors, try proxy if configured
        const agent = getProxyAgent();
        if (agent && !err.response) {
          try {
            const res = await axios.get(url, { headers, httpsAgent: agent, timeout: 10000 });
            return res.data;
          } catch (proxyErr) {
            if (proxyErr.response && (proxyErr.response.status === 400 || proxyErr.response.status === 404)) {
              return null;
            }
            throw proxyErr;
          }
        }
        throw err;
      }
    }).catch((err) => {
      if (err.response && (err.response.status === 400 || err.response.status === 404)) {
        return null;
      }
      console.error(`[Pantry] Failed to fetch basket '${basketName}':`, err.message);
      return null;
    });
  });
}

/**
 * Saves/replaces a basket in Pantry using POST.
 * Pantry expects a JSON Object { ... }.
 */
async function setBasket(basketName, data) {
  const pantryId = getPantryId();
  if (!pantryId) return { success: false, error: "No PANTRY_ID configured" };

  return enqueue(async () => {
    const url = `https://getpantry.cloud/apiv1/pantry/${pantryId}/basket/${basketName}`;
    const payload = data && typeof data === "object" ? data : {};
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };

    return executeWithRetry(async () => {
      try {
        await axios.post(url, body, { headers, timeout: 10000 });
        console.log(`[Pantry] Successfully synced basket '${basketName}'.`);
        return { success: true };
      } catch (err) {
        const agent = getProxyAgent();
        // If network error (no response), try proxy if configured
        if (agent && !err.response) {
          await axios.post(url, body, { headers, httpsAgent: agent, timeout: 10000 });
          console.log(`[Pantry] Successfully synced basket '${basketName}' (via proxy).`);
          return { success: true };
        }
        throw err;
      }
    }).catch((err) => {
      const status = err.response ? err.response.status : "NO_STATUS";
      console.error(`[Pantry] Failed to save basket '${basketName}': status ${status} - ${err.message}`);
      return { success: false, error: err.message };
    });
  });
}

/**
 * Periodically reads all baskets every 7 days to reset the 30-day inactivity timer,
 * ensuring baskets never expire even if the bot is idle for a long time.
 */
function startKeepAlivePing() {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      console.log("[Pantry] Refreshing 30-day TTL on cloud baskets...");
      await getBasket("playlists");
      await getBasket("allowed_admins");
      await getBasket("allowed_users");
      console.log("[Pantry] Cloud baskets TTL successfully reset for another 30 days.");
    } catch (err) {
      console.warn("[Pantry] TTL refresh warning:", err.message);
    }
  }, SEVEN_DAYS_MS).unref();
}

// Start keepalive scheduler in the background
startKeepAlivePing();

module.exports = {
  getBasket,
  setBasket,
  getPantryId,
  startKeepAlivePing
};

