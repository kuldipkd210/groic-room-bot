const axios = require("axios");
const { FIREBASE_API_KEY, REFRESH_TOKEN } = require("../config/env");

let TOKEN = "";

async function refreshAccessToken() {
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", REFRESH_TOKEN);

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

    TOKEN = res.data.id_token || res.data.access_token;

    if (!TOKEN) {
      throw new Error("No token received from Firebase refresh API");
    }

    return TOKEN;
  } catch (err) {
    if (err.response && err.response.data) {
      console.error("Firebase refreshAccessToken error:", JSON.stringify(err.response.data));
    }
    throw err;
  }
}

function getToken() {
  return TOKEN;
}

module.exports = {
  refreshAccessToken,
  getToken
};
