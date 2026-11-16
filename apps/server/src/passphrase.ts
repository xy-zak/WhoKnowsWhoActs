import { existsSync } from "node:fs";
import readline from "node:readline";

/** Read a line from the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error("No terminal available to enter the passphrase. Set WKWA_DB_PASSPHRASE (dev/tests only)."),
      );
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
      else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * Obtain the database passphrase: from WKWA_DB_PASSPHRASE if set (development
 * and automated tests only), otherwise typed by the facilitator. A new
 * database asks twice so a typo cannot lock you out.
 */
export async function obtainPassphrase(dbFile: string): Promise<string> {
  const fromEnv = process.env.WKWA_DB_PASSPHRASE;
  if (fromEnv) {
    console.warn("⚠  Using WKWA_DB_PASSPHRASE from the environment — acceptable for development only.");
    return fromEnv;
  }
  if (!existsSync(dbFile)) {
    console.log("No database found — creating a new encrypted database.");
    console.log("Choose a strong passphrase. If you lose it, the data CANNOT be recovered.\n");
    for (;;) {
      const a = await promptHidden("New database passphrase: ");
      if (a.length < 10) {
        console.log("Please use at least 10 characters.");
        continue;
      }
      const b = await promptHidden("Repeat passphrase: ");
      if (a === b) return a;
      console.log("Passphrases do not match, try again.\n");
    }
  }
  return promptHidden("Database passphrase: ");
}
