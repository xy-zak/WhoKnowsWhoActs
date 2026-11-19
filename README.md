# Who Knows, Who Acts?

A **research game harness** for a four-player, map-based serious game played on a local network. It provides everything *around* the game: networking, sessions and rounds, a grid map where each player knows a different part of the scores, propose/decide interactions, pluggable game rules, a facilitator manager, and a GDPR-aware data pipeline with rich, documented metadata. The game itself can then be designed on top.

| Facilitator · LIVE (Catppuccin Mocha) | Facilitator · SETUP wizard (Catppuccin Latte) |
| --- | --- |
| ![Facilitator LIVE tab in Mocha: lifecycle stepper, NEXT and TOOLS panels, seats with K/P labels and quota bars, the composite map with every score and the map score, the comparison of one square's four sub-squares, and live mirrors of every player's screen](docs/img/server/theme-mocha.png) | ![Setup at step 01: scenario, game rules and a preview of the starting scores of the 10 × 10 demo grid](docs/img/server/setup-01-scenario.png) |
| **Player · game (Latte)** | **Player · game (Mocha)** |
| ![Player game screen in Latte: status line with labels, map score and quota bars, the propose/decide tools, the grid map with this player's own scores, hatched proposals and filled decisions, the panel of the selected square and a message from the facilitator](docs/img/client/11-game-marks.png) | ![The same player screen in Mocha](docs/img/client/theme-mocha.png) |

*Screenshots use the fictional demo scenario and scripted players, at full-screen size (1920 × 1080). **[All screenshots](docs/img/SCREENSHOTS.md)**, grouped by functionality: every setup step, the live panels, popups, wrap-up, database and replay (`docs/img/server/`), and every player screen (`docs/img/client/`).*

*Every player and the facilitator choose their own display settings (colours, font, text size, animations) as accessibility settings; they are never recorded.*

## What it does

- **Hub-and-spoke LAN game.** Four browsers connect to one server (the facilitator's laptop), and every message passes through it. No internet is needed; all assets are bundled.
- **Same map, different knowledge.** The map is a grid of squares (10 × 10 in the demo, 5 × 5 in a smaller one). Every square holds four **sub-squares**, one per knowledge type (`Ka`–`Kd`), each with a score from 0 to 10. A player sees only the scores of their own knowledge type. The server enforces this: a player's browser never receives the other scores. Everyone sees the **map score** (the average of all scores). The facilitator sees the **composite** of all scores and live mirrors of every player's screen.
- **Propose and decide.** A player acts on the sub-square of their **power type** (`Pa` → `Ka` …) in the square they pick. *Propose* hatches it for everyone; *decide* fills it, adds 4 to its score and takes 1 from the other three sub-squares of that square. Both pass through a confirmation step. Colour = knowledge type, pattern = what happened, everywhere in the interface.
- **Pluggable game rules.** What an action lands on and what it does to the scores live in one file (`packages/shared/src/game/rules.ts`). Each session records the rule set and version it used, and events store the score changes they caused, so past sessions never change when the rules do ([GAME-RULES.md](docs/GAME-RULES.md)).
- **Real or simulated players.** In setup step 03 the facilitator chooses *real participants* or *simulated players*. Simulated sessions are played by agents inside the server, following pluggable **policies** (the rules are added in `packages/shared/src/simulation/`). They skip consent, client binding, participant codes and the key sheet, can run in real time or as fast as possible, repeat exactly from a logged seed, and are stored in a **separate simulation database** (`data/wkwa-sim.db`).
- **Fake players for testing.** In a session with real players, the server can put a *fake player* in any seat (the **Fake player** button per seat in setup step 08): test clients that connect like a browser and play at random. They skip consent and the questionnaire, get no participant code, and are marked fake in the log and the exports (`fake_player`, `fakeSeats`). Try a session alone with three fake players and yourself on the fourth seat.
- **Rounds.** Default: 3 rounds, and a round ends when every player has made 5 proposals and 5 decisions. Rounds can be changed per session (quotas, unlimited, time limits, facilitator-ended rounds, per-round overrides) and extended in code (pluggable round rules and validators).
- **Labels.** Each seat gets a knowledge type (`Ka`–`Kd`; seat 1 holds Ka, seat 2 Kb …) and a power type (`Pa`–`Pd`). In setup step 09 the facilitator only chooses the K–P pairing: aligned, or one of six dissociated pairings D1–D6 (drawn at random, seed logged, or picked); each choice is saved at once. By default the K label selects which scores the seat sees, and the P label which sub-squares it acts on.
- **Microphone audio, optional.** In a session with audio (setup step 05, off by default) every participant's browser records its own microphone, after a separate required consent section and a mic check. The mic checks wait until every real seat has finished the briefing, so the questionnaire and the briefing are not recorded. A short calibration, which starts by itself once every player has clicked *I'm ready for the calibration*, and the recordings let the server work out **who spoke when** although all four players sit in one room, by comparing loudness across the mics (no voiceprints). Audio is stored in encrypted files (one key per file, erased by deleting the key), and leaves the store only through a registered *Export audio* action. Automatic transcription is researched only. See [docs/AUDIO.md](docs/AUDIO.md) and [docs/AUDIO-TRANSCRIPTION.md](docs/AUDIO-TRANSCRIPTION.md).
- **Every interaction is recorded** in an append-only, event-sourced log with server and clock-corrected client timestamps. Fine-grained UI telemetry is recorded too: hover, inspect, pan/zoom, tool choice, confirm/cancel, focus, idle, and state acknowledgements for exact reaction times.
- **Facilitator manager**, organised in order of use: **[1] SETUP | LIVE · [2] REPLAY · [3] DATABASE**.
  - **SETUP** is 11 steps stacked as a vertical accordion (scenario → rounds → who plays → seats & visibility → onboarding → tags → create session → connect clients → labels → key sheet → start). The current step is expanded; finished steps collapse into a one-line summary, and a blue wayfinder bar stays pinned to the top while you scroll, so you always see where you are. Create session and start onboarding have their own colour.
  - After *Start onboarding* the tab flips to **LIVE**, and a green **● LIVE** indicator appears. LIVE has a lifecycle stepper, a NEXT panel with the next action, seats with quota bars, a composite map, player mirrors, a timeline, the event log, live telemetry, and wrap-up popups (takedown cards → export → close).
  - **REPLAY** plays any session back at 1 s per action, pausing at each round end (about 2 minutes for a default session), or lets you step and scrub; **DATABASE** holds exports, printables and takedown.
- **Intentional TUI aesthetic:**
  - Catppuccin **Latte** and **Mocha** plus a **High contrast** theme (WCAG AAA text), with contrast-tested tokens, **JetBrains Mono**, **Iconoir** icons, box-drawn panels and keyboard shortcuts.
  - CRT-style **animations** only (tab/screen switches, popups, connect/disconnect), no scanlines or glow; off under reduced motion.
  - **Display settings on every screen** (accessibility, never recorded): colours (Latte / Mocha / High contrast), font (JetBrains Mono / **OpenDyslexic** / system font), text size (Small / Large), animations on/off.
  - The rules every screen follows are in [AESTHETIC-RULES.md](docs/AESTHETIC-RULES.md).
- **GDPR by design:**
  - in-game versioned consent, with the hash of the exact text shown, one fold-out section per part of the information letter, each confirmed by its own statement
  - **no telemetry before consent**
  - pseudonymous participant codes with a check character
  - names only on a hand-written paper key sheet
  - the database **encrypted at rest** (SQLCipher)
  - IP-free logs
  - one-step **takedown/erasure** with a register, audio included
  - audio only after a separate consent item, never in anonymised exports, encrypted per file
  - anonymised exports for publication
- **Documented data.** Every export comes with a generated codebook. The docs are generated from the same schemas that validate the data, and tests fail if they drift.

## Quick start

Requirements: **Node.js ≥ 22**. A C/C++ build toolchain (Python 3, make, g++) may be needed for the native SQLCipher module if no prebuilt binary exists for your platform.

```bash
npm install
npm run build        # build the browser clients
npm start            # asks for (or creates) the database passphrase
```

- Facilitator manager: open `https://localhost:3000/facilitator` **on the server laptop**. The SETUP wizard opens automatically.
- Players: open the **welcome page**, one of the `http://<laptop-ip>:8080/` URLs printed first at start-up. Once a session is open it shows **Join live session**, which leads to the game page (`https://<laptop-ip>:3000/`). In `npm run dev` the welcome page is `http://localhost:5173/landing`.
- Microphone recording is off by default. To record audio, tick **Record audio** in setup step 05 (it needs the consent step); see the audio part of the [session runbook](docs/SESSION-RUNBOOK.md#11-sessions-with-audio). `npm run bots -- --count 4 --auto --audio` rehearses a whole audio session.
- The server speaks HTTPS with a **self-signed certificate** it makes itself (browsers only allow the microphone on secure pages), so each browser shows a security warning **once**. The welcome page tells participants beforehand what to click and why; see [SESSION-RUNBOOK.md § 10](docs/SESSION-RUNBOOK.md#10-https-and-the-certificate-warning). The terminal, setup step 08 and the welcome page show the certificate's fingerprint to compare. `WKWA_TLS=off npm start` serves plain HTTP instead (for tests on the laptop itself).

Try it alone: walk the SETUP wizard in the manager, bind your own browser window to one seat in step 08, and click **Fake player** next to each of the other seats. Alternatively, `npm run bots -- --count 4 --auto` plays a whole session by itself. Or choose **Simulated players** in setup step 03 (*Who plays*): agents fill every seat and play while you watch LIVE.

For real sessions, follow the **[session runbook](docs/SESSION-RUNBOOK.md)**.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the server (serves the built clients). Env: `PORT`, `HOST`, `WKWA_DATA_DIR`, `WKWA_EXPORTS_DIR`, `ADMIN_TOKEN`, `WKWA_TLS` (`auto`/`off`), `TLS_CERT`/`TLS_KEY`, `LANDING_PORT` (the plain-HTTP welcome page, default `8080`, `off` disables it) (see [NETWORKING.md § 4](docs/NETWORKING.md#4-ports-interfaces-and-configuration)) |
| `npm run dev` | Development mode: server with auto-restart, plus Vite with hot reload on `http://localhost:5173` (separate dev database; the welcome page is at `/landing`, `LANDING_PORT` is off) |
| `npm run build` | Build the player and facilitator clients |
| `npm run bots -- [--count N] [--auto] [--audio] [--url U]` | External test players that connect like browsers (to this laptop over HTTPS or HTTP, whichever the server speaks, unless `--url` says otherwise) (and optionally an automatic facilitator; `--audio` also tests microphone recording with synthetic audio), e.g. for load tests. They are **not** marked in the data: for rehearsals use **fake players** (setup step 08); for agents choose *Simulated players* (step 03). |
| `npm run cli -- <command> [--sim]` | Data management: `sessions`, `lookup`, `export`, `anonymise`, `erase`, `erasures`, `delete-session`, `deletions`, `delete-audio`, `audio-deletions`, `backup`, `rekey`, `verify`; `--sim` works on the simulation database |
| `npm test` | Unit and integration tests (rules, full bot games, GDPR guarantees, docs drift) |
| `npm run test:coverage` | The unit tests with a coverage summary (`coverage/`); speed checks are skipped, nothing is enforced |
| `npm run test:e2e` | Playwright: a full game through the real UI (one player browser and three bots), a simulated session, audio with a fake microphone, display settings, plus a render check of every diagram |
| `npm run docs:generate` | Regenerate the schema-derived parts of `docs/` |
| `npm run screenshots -- <command>` | Versioned documentation screenshots: `plan` (what changed since the last review), `capture` (Playwright plays the sessions needed, on a temporary database), `publish` (new version `name-v2.png` … in `docs/img/`, gallery regenerated), `check`, `mark`. Not part of `test:e2e`; the `/screenshot-app` skill runs the whole workflow |
| `npm run lint` / `npm run typecheck` | Biome / TypeScript |

CI (`.github/workflows/ci.yml`) runs `typecheck`, `lint`, `docs:check` and `npm test` on every push to `main` and every pull request, then the Playwright suite.

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, event sourcing, state machines, projections (information asymmetry), rules, extension guide, testing |
| [GAME-RULES.md](docs/GAME-RULES.md) | The grid map, who sees which scores, what players act on, what proposals and decisions do, the map score, revoking, how to change the rules, scenario format |
| [NETWORKING.md](docs/NETWORKING.md) | LAN topology, hub-and-spoke protocol, connection/reconnect/clock-sync sequences, message catalogue, REST API, security, troubleshooting |
| [DATA-MANAGEMENT.md](docs/DATA-MANAGEMENT.md) | GDPR design: data inventory and flow, pseudonymisation, consent, encryption, takedown procedure, anonymisation, retention, risk table, ethics checklist |
| [DATA-TYPES.md](docs/DATA-TYPES.md) | Field-level catalogue of everything that is logged and exported |
| [SESSION-RUNBOOK.md](docs/SESSION-RUNBOOK.md) | Step by step for running a session (setup wizard, LIVE, wrap-up), plus troubleshooting |
| [AESTHETIC-RULES.md](docs/AESTHETIC-RULES.md) | Colour tokens and reserved meanings, typography, icons, panels, popups, wayfinding, CRT/motion, keyboard, checklist for new UI |
| [AUDIO.md](docs/AUDIO.md) | Microphone recording: capture pipeline, timing model, encrypted storage, the hold before the mic checks and the recording lifecycle, calibration, speaker attribution (who spoke when), export and deletion, known limits |
| [AUDIO-TRANSCRIPTION.md](docs/AUDIO-TRANSCRIPTION.md) | **Research, not implemented.** Local transcription engines compared (accuracy on accented speech, timestamps, speed, licence, Node integration), pitfalls, proposed pipeline and data model, per-user and composite document mock-ups, GDPR notes, evaluation plan, recommendation |

Each document has a change log (date, commit, change, reason) in [docs/changelog/](docs/changelog/README.md), maintained with the `/update-docs` skill.

## Repository layout

```
packages/shared/   schemas (zod), event reducer, rules, projections, agent policies, doc generators — used by server and clients
apps/server/       Fastify + Socket.IO server, encrypted store, session manager, REST API, GDPR tooling, CLI, bots
apps/client/       React/Vite: design system (ui/), player app (/) and facilitator manager (/facilitator)
config/            study info, consent, demographics, briefing, default session settings (placeholders!)
scenarios/         fictional demo grids: demo (10 × 10) and demo-small (5 × 5), four placeholder knowledge types
scripts/           doc generator, demo starting-score generator, dev and e2e helpers
docs/              design documentation
e2e/               Playwright tests
```

## Building the actual game on top

The harness is meant to be extended. See [ARCHITECTURE.md § 12 Extension guide](docs/ARCHITECTURE.md#12-extension-guide). In short:

- **Your map and data:** add `scenarios/<id>/` with a `scenario.json` (board size, one view per K label) and a `scores.json` (starting score of every sub-square); see [GAME-RULES.md § 11](docs/GAME-RULES.md#11-starting-scores-and-scenarios).
- **Simulated players:** write agent policies in `packages/shared/src/simulation/policies.ts` (template at the top of the file; see ARCHITECTURE.md § 14).
- **Game rules:** change the numbers or the behaviour in `packages/shared/src/game/rules.ts` (targeting, score changes, map score, extra validators such as "decide only on proposed sub-squares"), or add a variant to `GAME_RULES`; see [GAME-RULES.md § 10](docs/GAME-RULES.md#10-changing-the-rules). Round rules go in `roundRules.ts`.
- **New actions or data:** add event or telemetry types in `packages/shared/src/events.ts` / `telemetry.ts`, with their documentation metadata, then run `npm run docs:generate`.

> **This repository is public.** Research data lives in `data/` and `exports/`, which are git-ignored (a test checks this). Never commit databases, exports, filled-in key sheets or real participant information. Replace the `[placeholders]` in `config/` with your approved texts.

## License

[MIT](LICENSE). The license covers the software only: research data collected with it is not part of this repository and is governed by your study's data management plan.
