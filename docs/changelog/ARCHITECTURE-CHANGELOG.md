# Change log: ARCHITECTURE.md

History of [ARCHITECTURE.md](../ARCHITECTURE.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · typed socket protocol, intent resend, CalibrationRunner

- **Type:** Risk mitigation
- **Change:** The code layout adds `packages/shared/src/socket.ts` (typed event maps), the schema tables in `protocol.ts`, `session/CalibrationRunner.ts` and `player/intents.ts`. The component table says what `SessionManager` delegates. The idempotency bullet covers the browser's resend and restarts. The extension guide gets *Add a socket message*. The testing table adds the protocol and intent-queue tests and the restart deduplication test.
- **Reason:** The socket protocol was typed by message name strings only, so a payload drift was not caught by the compiler, and the calibration's timers made SessionManager the largest file. The document must say where those parts now live and how to extend the protocol.

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio)

- **Type:** Feature
- **Change:** The overview diagram, component table, harness table and code layout get the `audio` module, the encrypted audio folder and the browser capture engine. The lifecycle table and seat diagram add the mic check step and the consent hold. § 13 adds an Audio row to the testing table and the bots `--audio` flag. A new § 15 *Microphone audio* shows where audio fits (state, events, projection, timers, processing, who never records, recovery) with a diagram.
- **Reason:** Audio is a new subsystem that touches the session lifecycle, the seat states and the storage, so the architecture text had to say how it fits and why the audio is never an event.

### 2026-11-18 · `fe15759` · Self-signed HTTPS by default (WKWA_TLS=auto) for microphone access (#6)

- **Type:** Bug fix
- **Change:** The bots flag table in § 13 now says that `--url` defaults to `https://localhost:3000` when the server speaks HTTPS, and adds `--insecure` for a self-signed certificate on another machine.
- **Reason:** The server now speaks HTTPS by default for microphone access, so the documented way to start the bots had to match what they do.

### 2026-11-18 · `8ff2b36` · Versioned documentation screenshots: capture toolkit, gallery and /screenshot-app skill

- **Type:** Feature
- **Change:** The testing table in § 13 gets a **Screenshots** row. `npm run screenshots` (its own Playwright project, not run by `test:e2e`) plays three sessions at 1920 × 1080, takes the shots listed in a catalogue and compares them with the published ones. A real change is published as a new version (`name-v2.png`, …) in `docs/img/server/` or `docs/img/client/`. The gallery `docs/img/SCREENSHOTS.md` is generated from the version history, grouped by functionality.
- **Reason:** The screenshots are made by a script, so they can be refreshed after UI changes instead of going stale. Old versions are kept, so the gallery also records how the interface developed. The table now lists that script next to the real tests.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Feature
- **Change:** The glossary defines squares, sub-squares (regions), views as knowledge types, game rules and the map score. The scope table, module map, projection table and diagram, validation pipeline (new `gameRulesAllow`), event sequence diagram, testing table and extension guide (change the game rules; scenario format with `board` and `scores.json`) follow the grid map, and the SVG outline is gone.
- **Reason:** The map changed from an SVG outline to a grid with scores, and the game rules moved into their own module, so the architecture text and diagrams must match the code.

### 2026-11-17 · `43264a9` · Docs: change logs for simulated and fake players; dashboard throttle note

- **Type:** Feature
- **Change:** § 14 gets a **Dashboard** bullet: while agents play, the facilitator's full dashboard is sent at most every 100 ms, and events still arrive one batch at a time.
- **Reason:** Commit `7ca658f` throttled these updates because agents can act many times a second; the document now says so.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Feature
- **Change:** A new § 14 *Simulated players* explains how software agents play a session: a diagram of one agent turn, the lifecycle of a simulated session, a reproducibility table and a generated table of the built-in policies. The glossary, overview and code-layout diagrams, the seat state machine (new paths for agents and fake players), the extension guide ("Add an agent policy") and § 13 (a table comparing bots, fake players and simulated agents) were updated.
- **Reason:** Sessions can now be played by agents whose rules are still to be designed, or tested with fake players. The document describes the frame those rules plug into and when to use which kind of non-human player.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** The text now uses the project name *Who Knows, Who Acts?*. The component and code-layout tables add session deletion, takedown cards as PDF files, and display settings that each player's browser keeps to itself.
- **Reason:** These features were new. The doc also states that display settings never reach the server, so no accessibility choices end up in the research data.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** "Terminal" is renamed "Client" in the glossary, the session phases and the bot options. A note explains that stored data keeps the old field name `terminal`.
- **Reason:** "Client" is the word the interface now uses. Keeping the stored field name means older recordings still line up with new ones.

### 2026-11-16 · `2f11891` · Docs and screenshots for the UI pass

- **Type:** Feature
- **Change:** The code-layout table adds the new `ui/` design-system folder and the reorganised facilitator and player folders.
- **Reason:** It documents the new interface structure, so developers can find where each screen and component lives.

### 2026-11-16 · `e7871f4` · Add README, session runbook and reconcile docs with the implementation

- **Type:** Risk mitigation
- **Change:** The code-layout table now lists the server modules in detail. The testing section says what each test suite actually checks, and a new table lists the options of the simulated players ("bots").
- **Reason:** These sections were written before the code was finished. Updating them keeps the document from describing a system that does not exist.

### 2026-11-16 · `7e7b590` · Add design documentation with diagrams and doc generator

- **Type:** Feature
- **Change:** Document created. It covers the system overview, code layout, event sourcing (every action is stored as a permanent record, and the game state is rebuilt from those records), the session and onboarding state machines, who sees what, the rules engine, timing, recovery, an extension guide and testing. Mermaid diagrams show the components, the message sequences and the states.
- **Reason:** It gives supervisors, reviewers and future developers a reference design to check the implementation against.
