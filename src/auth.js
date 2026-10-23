const axios = require("axios");
const { FIREBASE_API_KEY, REFRESH_TOKEN, EXTRA_REFRESH_TOKENS } = require("../config/env");

let TOKEN = "";
let ALL_TOKENS = [];

async function refreshSingleToken(refreshToken) {
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", refreshToken);

  try {
    const res = await axios.post(url, params.toString(), {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Referer: "https://groic.in/",
        Origin: "https://groic.in"
      },
      timeout: 20000,
      proxy: false
    });

    return res.data.id_token || res.data.access_token;
  } catch (err) {
    if (err.response && err.response.data) {
      const errMsg = err.response.data?.error?.message;
      if (errMsg === "USER_NOT_FOUND" || errMsg === "TOKEN_EXPIRED") {
        console.error(`❌ [Auth Error] Your REFRESH_TOKEN in .env is invalid or expired (${errMsg}).`);
        console.error("👉 Please log into https://groic.in, grab your new Firebase refreshToken from DevTools (Application > IndexedDB/LocalStorage), and update REFRESH_TOKEN in .env.");
      } else {
        console.error("Firebase refreshSingleToken error:", JSON.stringify(err.response.data));
      }
    }
    throw err;
  }
}

async function refreshAccessToken() {
  TOKEN = await refreshSingleToken(REFRESH_TOKEN);

  if (!TOKEN) {
    throw new Error("No token received from Firebase refresh API");
  }

  const all = [TOKEN];
  if (Array.isArray(EXTRA_REFRESH_TOKENS) && EXTRA_REFRESH_TOKENS.length > 0) {
    for (const extraToken of EXTRA_REFRESH_TOKENS) {
      try {
        const idTok = await refreshSingleToken(extraToken);
        if (idTok) all.push(idTok);
      } catch (err) {
        console.log("Could not refresh extra token:", err.message);
      }
    }
  }

  ALL_TOKENS = all;
  return TOKEN;
}

function getToken() {
  return TOKEN;
}

function getAllTokens() {
  return ALL_TOKENS.length > 0 ? ALL_TOKENS : [TOKEN];
}

module.exports = {
  refreshAccessToken,
  getToken,
  getAllTokens
};
