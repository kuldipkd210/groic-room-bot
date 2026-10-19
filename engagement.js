const { startEngagementBooster } = require("./src/runners/engagement");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    roomUid: null,
    interval: null,
    targetRate: null,
    channels: 1
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fast") {
      options.targetRate = 20; // 20 msgs/sec
    } else if (arg === "--max" || arg === "--turbo") {
      options.targetRate = 25; // 25 msgs/sec
    } else if (arg === "--ultra" || arg === "--overdrive") {
      options.targetRate = 35; // 35 msgs/sec
    } else if (arg === "--rate" || arg === "--speed" || arg === "-s") {
      options.targetRate = parseFloat(args[++i]);
    } else if (arg === "--clients" || arg === "-c" || arg === "--channels") {
      options.channels = parseInt(args[++i], 10);
    } else if (arg === "--interval" || arg === "-i") {
      options.interval = parseInt(args[++i], 10);
    } else if (arg === "--room" || arg === "-r") {
      options.roomUid = args[++i];
    } else if (!arg.startsWith("-") && !options.roomUid) {
      options.roomUid = arg;
    }
  }

  // Default target rate guarantees at least 22 msgs/sec across the accounts
  if (!options.targetRate && !options.interval) {
    options.targetRate = 22;
  }

  return options;
}

const options = parseArgs();
startEngagementBooster(options).catch((err) => {
  console.error("Fatal Error running Booster:", err);
  process.exit(1);
});
