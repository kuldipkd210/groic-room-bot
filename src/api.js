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

async function updateRoomKickList(roomUid, targetUsername, isKick) {
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) {
      throw new Error(`Room details not found for UID: ${roomUid}.`);
    }

    let kickedList = details.kicked || [];
    if (isKick) {
      if (kickedList.includes(targetUsername)) {
        console.log(`User ${targetUsername} is already in the kick list.`);
        return { message: "Already kicked", error: false };
      }
      kickedList.push(targetUsername);
    } else {
      if (!kickedList.includes(targetUsername)) {
        console.log(`User ${targetUsername} is not in the kick list.`);
        return { message: "Not in kick list", error: false };
      }
      kickedList = kickedList.filter(u => u !== targetUsername);
    }

    const payload = {
      roomOwner: details.roomOwner,
      username: details.username,
      roomName: details.roomName,
      roomDesc: details.roomDesc,
      roomGenre: details.roomGenre,
      roomCountry: details.roomCountry || "IN",
      maxParticipants: details.maxParticipants,
      isPublicRoom: details.isPublicRoom,
      kicked: kickedList
    };

    const res = await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 10000
    });

    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not update kick list for room ${roomUid}`);
    return null;
  }
}

async function updateRoomAdminList(roomUid, targetUsername, isAdmin) {
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) {
      throw new Error(`Room details not found for UID: ${roomUid}.`);
    }

    let adminsList = details.admins || [];
    if (isAdmin) {
      if (adminsList.includes(targetUsername)) {
        console.log(`User ${targetUsername} is already in the admin list.`);
        return { message: "Already admin", error: false };
      }
      adminsList.push(targetUsername);
    } else {
      if (!adminsList.includes(targetUsername)) {
        console.log(`User ${targetUsername} is not in the admin list.`);
        return { message: "Not in admin list", error: false };
      }
      adminsList = adminsList.filter(u => u !== targetUsername);
    }

    const payload = {
      roomOwner: details.roomOwner,
      username: details.username,
      roomName: details.roomName,
      roomDesc: details.roomDesc,
      roomGenre: details.roomGenre,
      roomCountry: details.roomCountry || "IN",
      maxParticipants: details.maxParticipants,
      isPublicRoom: details.isPublicRoom,
      admins: adminsList
    };

    const res = await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 10000
    });

    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not update admin list for room ${roomUid}`);
    return null;
  }
}

async function updateRoomVisibility(roomUid, isPublic) {
  try {
    const payload = {
      isPublicRoom: isPublic
    };

    const res = await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 10000
    });

    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not update room visibility for ${roomUid}`);
    return null;
  }
}

async function updateRoomEngagement(roomUid, score, joins, messages) {
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) {
      throw new Error(`Room details not found for UID: ${roomUid}. Cannot safely update engagement without overwriting owner/credentials.`);
    }
    const payload = {
      roomOwner: details.roomOwner,
      username: details.username,
      roomName: details.roomName,
      roomDesc: details.roomDesc,
      roomGenre: details.roomGenre,
      roomCountry: details.roomCountry || "IN",
      maxParticipants: details.maxParticipants,
      isPublicRoom: details.isPublicRoom,
      engagementScore: score,
      joinCount: joins,
      messagesSent: messages
    };

    const res = await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 10000
    });

    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not update room engagement for ${roomUid}`);
    return null;
  }
}

async function clearRoomKickList(roomUid) {
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) {
      throw new Error(`Room details not found for UID: ${roomUid}.`);
    }

    const payload = {
      roomOwner: details.roomOwner,
      username: details.username,
      roomName: details.roomName,
      roomDesc: details.roomDesc,
      roomGenre: details.roomGenre,
      roomCountry: details.roomCountry || "IN",
      maxParticipants: details.maxParticipants,
      isPublicRoom: details.isPublicRoom,
      kicked: []
    };

    const res = await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 10000
    });

    return res.data;
  } catch (err) {
    logAxiosError(err, `Could not clear kick list for room ${roomUid}`);
    return null;
  }
}

module.exports = {
  createRoom,
  getRoomDetails,
  deleteRoom,
  getGroicHeaders,
  updateRoomKickList,
  updateRoomAdminList,
  updateRoomVisibility,
  updateRoomEngagement,
  clearRoomKickList
};
