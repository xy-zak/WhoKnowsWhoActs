/**
 * npm run bots -- [--url http://localhost:3000] [--count 3] [--delay 2000-6000] [--auto] [--admin-token T]
 *
 * Starts simulated players that connect like real browsers. Use it to fill
 * empty seats while developing or piloting, or to load-test a setup.
 *
 * --auto also drives the facilitator side: creates a session if none is
 * active, binds every client (bots AND humans) to the next free seat,
 * randomises labels, starts onboarding and starts each round. Never use
 * --auto during a real session.
 */
import { parseArgs } from "node:util";
import { Bot, FacilitatorClient } from "./botClient";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    count: { type: "string", default: "3" },
    delay: { type: "string", default: "1500-5000" },
    auto: { type: "boolean", default: false },
    seats: { type: "string", default: "4" },
    "admin-token": { type: "string" },
    "round-pause": { type: "string", default: "3000" },
  },
});

const [minDelay, maxDelay] = values.delay.split("-").map(Number) as [number, number];
const count = Number(values.count);
const url = values.url;
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

const bots = Array.from(
  { length: count },
  (_, i) =>
    new Bot({ url, name: `bot${i + 1}`, minDelayMs: minDelay, maxDelayMs: maxDelay ?? minDelay, log }),
);
log(`${count} bot(s) connecting to ${url}`);

if (values.auto) void autoFacilitate();

async function autoFacilitate() {
  const fac = new FacilitatorClient(url, values["admin-token"]);
  await fac.connected();
  log("auto-facilitator connected");
  const seatCount = Number(values.seats);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const d = fac.dashboard;
      if (!d) return;
      const st = d.state;
      if (!st || ["closed", "aborted"].includes(st.phase)) {
        if (!st) {
          const r = await fac.cmd<{ sessionId: string }>("session:create", {
            scenarioId: "demo",
            config: { seatCount },
            notes: "auto-facilitated test session (bots)",
          });
          log(`created session ${r.sessionId}`);
        }
        return;
      }
      const seats = Object.values(st.seats);
      if (st.phase === "lobby") {
        const free = seats.filter((s) => !s.bound).map((s) => s.seat);
        const unseated = d.terminals.filter((t) => t.connected && t.seat === null);
        if (free.length > 0 && unseated.length > 0) {
          await fac.cmd("seat:bind", { terminal: unseated[0]!.terminal, seat: free[0] });
          log(`bound client ${unseated[0]!.terminal} → seat ${free[0]}`);
        } else if (free.length === 0) {
          if (seats.some((s) => !s.k)) await fac.cmd("labels:randomise");
          else await fac.cmd("onboarding:start");
        }
      } else if (st.phase === "onboarding" || st.phase === "round_complete") {
        try {
          if (st.phase === "round_complete")
            await new Promise((r) => setTimeout(r, Number(values["round-pause"])));
          await fac.cmd("round:start");
          log(`round ${st.round + 1} started`);
        } catch {
          /* waiting for players */
        }
      }
    } catch (e) {
      log(`auto-facilitator: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), 500);
}

process.on("SIGINT", () => {
  for (const b of bots) b.stop();
  process.exit(0);
});
