const { startEngagementBooster } = require("./src/runners/engagement");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    roomUid: null,
    clients: 8,
    interval: 220
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fast" || arg === "--max" || arg === "--turbo") {
      options.clients = 12;
      options.interval = 180;
    } else if (arg === "--clients" || arg === "-c" || arg === "--channels") {
      options.clients = parseInt(args[++i], 10);
    } else if (arg === "--interval" || arg === "-i") {
      options.interval = parseInt(args[++i], 10);
    } else if (arg === "--room" || arg === "-r") {
      options.roomUid = args[++i];
    } else if (!arg.startsWith("-") && !options.roomUid) {
      options.roomUid = arg;
    }
  }

  return options;
}

const options = parseArgs();
startEngagementBooster(options).catch((err) => {
  console.error("Fatal Error running Booster:", err);
  process.exit(1);
});
