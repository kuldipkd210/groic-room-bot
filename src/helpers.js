function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCloudflareChallenge(data) {
  if (typeof data !== "string") return false;
  return (
    data.includes("Just a moment") ||
    data.includes("challenges.cloudflare.com") ||
    data.includes("__cf_chl") ||
    data.includes("Enable JavaScript and cookies")
  );
}

function logAxiosError(err, label = "Request failed") {
  console.log(label);
  if (err.response) {
    console.log("Status:", err.response.status);
    const data = err.response.data;
    if (isCloudflareChallenge(data)) {
      console.log("Cloudflare challenge detected. Server IP is likely blocked/challenged.");
      return;
    }
    if (typeof data === "string") {
      console.log("Response:", data.slice(0, 500));
    } else {
      console.log("Response:", JSON.stringify(data, null, 2));
    }
  } else {
    console.log("Error:", err.message);
  }
}

module.exports = {
  sleep,
  isCloudflareChallenge,
  logAxiosError
};
