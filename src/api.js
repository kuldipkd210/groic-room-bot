const axios = require("axios");
const { getToken } = require("./auth");
const { USER_ID, OWNER_USERNAME, ROOM_NAME, ROOM_DESC, ROOM_GENRE, MAX_PARTICIPANTS } = require("../config/constants");
const { logAxiosError } = require("./helpers");
const { HttpsProxyAgent } = require("https-proxy-agent");

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

function getGroicHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    authorization: getToken(),
    "content-type": "application/json",
    origin: "https://groic.in",
    referer: "https://groic.in/",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "x-device-type": "android"
  };
}

async function createRoom() {
  const payload = {
    roomOwner: USER_ID,
    username: OWNER_USERNAME,
    roomName: ROOM_NAME,
    roomDesc: ROOM_DESC,
    roomGenre: ROOM_GENRE,
    roomCountry: "IN",
    maxParticipants: MAX_PARTICIPANTS,
    isPublicRoom: true
  };

  const res = await axios.post("https://api.groic.in/api/room/", payload, {
    headers: getGroicHeaders(),
    ...(httpsAgent ? { httpsAgent } : {}),
    timeout: 30000
  });

  const roomUid = res?.data?.data?.roomUid;

  if (!roomUid) {
    throw new Error("Room created but roomUid not found in response");
  }

  return roomUid;
}

async function getRoomDetails(roomUid) {
  try {
    const res = await axios.get(`https://api.groic.in/api/room/${roomUid}`, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 30000
    });

    return res.data.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.log(`Room ${roomUid} definitely not found (404).`);
      return null;
    }
    logAxiosError(err, "Could not fetch room details (Network/Server error)");
    throw err; // Rethrow to indicate this is NOT a "not found" case
  }
}

async function deleteRoom(roomUid) {
  try {
    const res = await axios.delete(`https://api.groic.in/api/room/${roomUid}`, {
      headers: getGroicHeaders(),
      timeout: 30000
    });
    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not delete room ${roomUid}`);
    return null;
  }
}

module.exports = {
  createRoom,
  getRoomDetails,
  deleteRoom,
  getGroicHeaders
};
