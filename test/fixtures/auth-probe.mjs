// Pretend sign-in probe: `node auth-probe.mjs <agent>` prints whether that agent is signed in.
// FAKE_SIGNED_OUT is a comma-separated list of agents that are signed out.
const out = (process.env.FAKE_SIGNED_OUT || "").split(",").filter(Boolean);
console.log(out.includes(process.argv[2]) ? "signed out" : "signed in");
