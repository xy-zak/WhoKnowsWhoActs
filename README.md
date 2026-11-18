# Who Knows, Who Acts?

A **research game harness** for a four-player, map-based serious game played on a local network. It provides everything *around* the game: networking, sessions and rounds, a grid map where each player knows a different part of the scores, propose/decide interactions, pluggable game rules, a facilitator manager, and a GDPR-aware data pipeline with rich, documented metadata. The game itself can then be designed on top.

| Facilitator · LIVE (Catppuccin Mocha) | Facilitator · SETUP wizard (Catppuccin Latte) |
| --- | --- |
| ![Facilitator LIVE tab in Mocha: lifecycle stepper, NEXT and TOOLS panels, seats with K/P labels and quota bars, the composite map with every score and the map score, the comparison of one square's four sub-squares, and live mirrors of every player's screen](docs/img/server/theme-mocha.png) | ![Setup at step 01 of 10: scenario, game rules and a preview of the starting scores of the 10 × 10 demo grid](docs/img/server/setup-01-scenario.png) |
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
- **Fake players for testing.** In a session with real players, the server can fill seats with *fake players* (setup step 07): test clients that connect like a browser and play at random. They skip consent and the questionnaire, get no participant code, and are marked fake in the log and the exports (`fake_player`, `fakeSeats`). Try a session alone with three fake players and yourself on the fourth seat.
- **Rounds.** Default: 3 rounds, and a round ends when every player has made 5 proposals and 5 decisions. Rounds can be changed per session (quotas, unlimited, time limits, facilitator-ended rounds, per-round overrides) and extended in code (pluggable round rules and validators).
- **Labels.** Each seat gets a knowledge type (`Ka`–`Kd`) and a power type (`Pa`–`Pd`), assigned manually or randomly in setup step 08 (the seed is logged). By default the K label selects which scores the seat sees, and the P label which sub-squares it acts on.
- **Every interaction is recorded** in an append-only, event-sourced log with server and clock-corrected client timestamps. Fine-grained UI telemetry is recorded too: hover, inspect, pan/zoom, tool choice, confirm/cancel, focus, idle, and state acknowledgements for exact reaction times.
- **Facilitator manager**, organised in order of use: **[1] SETUP | LIVE · [2] REPLAY · [3] DATABASE**.
  - **SETUP** is 10 steps stacked as a vertical accordion (scenario → rounds → players → onboarding → tags → review & create → connect clients → labels → key sheet → start). The current step is expanded; finished steps collapse into a one-line summary, and a blue wayfinder bar stays pinned to the top while you scroll, so you always see where you are. Review & create and start onboarding have their own colour.
  - After *Start onboarding* the tab flips to **LIVE**, and a green **● LIVE** indicator appears. LIVE has a lifecycle stepper, a NEXT panel with the next action, seats with quota bars, a composite map, player mirrors, a timeline, the event log, live telemetry, and wrap-up popups (takedown cards → export → close).
  - **REPLAY** plays any session back at 1 s per action, pausing at each round end (about 2 minutes for a default session), or lets you step and scrub; **DATABASE** holds exports, printables and takedown.
- **Intentional TUI aesthetic:**
  - Catppuccin **Latte** and **Mocha** plus a **High contrast** theme (WCAG AAA text), with contrast-tested tokens, **JetBrains Mono**, **Iconoir** icons, box-drawn panels and keyboard shortcuts.
  - CRT-style **animations** only (tab/screen switches, popups, connect/disconnect), no scanlines or glow; off under reduced motion.
  - **Display settings on every screen** (accessibility, never recorded): colours (Latte / Mocha / High contrast), font (JetBrains Mono / **OpenDyslexic** / system font), text size (Small / Large), animations on/off.
  - The rules every screen follows are in [AESTHETIC-RULES.md](docs/AESTHETIC-RULES.md).
- **GDPR by design:**
  - in-game versioned consent, with the hash of the exact text shown
  - **no telemetry before consent**
  - pseudonymous participant codes with a check character
  - names only on a hand-written paper key sheet
  - the database **encrypted at rest** (SQLCipher)
  - IP-free logs
  - one-step **takedown/erasure** with a register
  - anonymised exports for publication
- **Documented data.** Every export comes with a generated codebook. The docs are generated from the same schemas that validate the data, and tests fail if they drift.

## Quick start

Requirements: **Node.js ≥ 22**. A C/C++ build toolchain (Python 3, make, g++) may be needed for the native SQLCipher module if no prebuilt binary exists for your platform.

```bash
npm install
npm run build        # build the browser clients
npm start            # asks for (or creates) the database passphrase
```

- Facilitator manager: open `http://localhost:3000/facilitator` **on the server laptop**. The SETUP wizard opens automatically.
- Players: open one of the `http://<laptop-ip>:3000/` URLs printed at start-up.

Try it alone: walk the SETUP wizard in the manager, and in step 07 click **Fill empty seats with fake players** after binding your own browser window to one seat. Alternatively, `npm run bots -- --count 4 --auto` plays a whole session by itself. Or choose **Simulated players** in setup step 03: agents fill every seat and play while you watch LIVE.

For real sessions, follow the **[session runbook](docs/SESSION-RUNBOOK.md)**.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the server (serves the built clients). Env: `PORT`, `HOST`, `WKWA_DATA_DIR`, `WKWA_EXPORTS_DIR`, `ADMIN_TOKEN`, `TLS_CERT`/`TLS_KEY` (see [NETWORKING.md](docs/NETWORKING.md)) |
| `npm run dev` | Development mode: server with auto-restart, plus Vite with hot reload on `http://localhost:5173` (separate dev database) |
| `npm run build` | Build the player and facilitator clients |
| `npm run bots -- [--count N] [--auto]` | External test players that connect like browsers (and optionally an automatic facilitator), e.g. for load tests. They are **not** marked in the data: for rehearsals use **fake players** (setup step 07); for agents choose *Simulated players* (step 03). |
| `npm run cli -- <command> [--sim]` | Data management: `sessions`, `lookup`, `export`, `anonymise`, `erase`, `erasures`, `backup`, `rekey`, `verify`; `--sim` works on the simulation database |
| `npm test` | Unit and integration tests (rules, full bot games, GDPR guarantees, docs drift) |
| `npm run test:e2e` | Playwright: a full game through the real UI with 4 player browsers, plus a render check of every diagram |
| `npm run docs:generate` | Regenerate the schema-derived parts of `docs/` |
| `npm run screenshots -- <command>` | Versioned documentation screenshots: `plan` (what changed since the last review), `capture` (Playwright plays the sessions needed, on a temporary database), `publish` (new version `name-v2.png` … in `docs/img/`, gallery regenerated), `check`, `mark`. Not part of `test:e2e`; the `/screenshot-app` skill runs the whole workflow |
| `npm run lint` / `npm run typecheck` | Biome / TypeScript |

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
