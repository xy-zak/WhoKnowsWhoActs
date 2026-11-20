# Change log: ARCHITECTURE.md

History of [ARCHITECTURE.md](../ARCHITECTURE.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `4c1f565`, `15615b1`, `3c3f5e3`, `2b82c98`, `90e6bb9`, `b377c25`, `18ad4eb`, `74f74ac`, `384f810`

- **Type:** Risk mitigation
- **Change:** § 4 adds `packages/shared/src/rest.ts` (the REST response types) and `api/http.ts` (one `HttpError`, answered as `{ error }`), and says that `recordingVerdict.ts` holds the per-reason catalogue `NOT_RECORDING_REASONS` (indicator, tooltip, refusal text, late chunks). § 12's socket-message guide says what a `MESSAGES` entry still needs. § 13's testing table adds the code-free logs, `secure_delete` after an erasure, the failed-export clean-up, the offline facilitator command, the REST error answers, the per-reason refusals and `npm run test:coverage`.
- **Reason:** The audit fixes and refactors moved these rules into single places and added tests for them; the document must say where they live (docs drifting from the code).

### 2026-11-19 · `3828155` · Server: hub sends the facilitator snapshot from one place; one seatCmd for every seated request

- **Type:** Risk mitigation
- **Change:** § 12's socket-message guide no longer names the `audioCmd` handler: every seated request now goes through `seatCmd`.
- **Reason:** The hub's handlers were merged into one; the guide must name the handlers that exist (docs drifting from the code).

### 2026-11-19 · `7f0e859` · Docs: session startup flow (welcome page, eleven setup steps, consent sections, mic check hold until the briefing, calibration readiness); change logs

- **Type:** Feature
- **Change:** The glossary adds **Mic check hold** and **Welcome page**; § 3 shows the second, plain-HTTP listener; § 4 lists the welcome page code, the 11-step setup and the consent `section` field; § 7's onboarding state diagram now ends with the mic check and the readiness step; § 13–15 update the tests, step numbers and audio state (`ready`, `requested`, automatic start).
- **Reason:** The startup flow was redesigned: the document must show where the new rules live (onboarding order, readiness, welcome page).

### 2026-11-19 · `2f030b5` · Erasure: a failed reload or compaction after the commit no longer fails the erasure

- **Type:** Bug fix
- **Change:** The **Session guard** row in § 15 adds that if the session cannot be reloaded after an erasure, it is detached (unloaded) and the erasure is still reported as done.
- **Reason:** An erasure that had already been committed was reported as failed when the reload afterwards failed, and a loaded session could keep the erased code in memory.

### 2026-11-19 · `2ea6151` · Audio: late-chunk grace outlasts the browser's 30-minute buffer, so a long outage keeps its audio

- **Type:** Bug fix
- **Change:** The **Recovery** row in § 15 now says browsers can resend unacknowledged audio for up to 35 minutes after a track closed, not 10.
- **Reason:** The server's grace period for late audio (10 minutes) was shorter than the browser's 30-minute buffer, so a long network outage lost the audio the browser still held (data loss).

### 2026-11-19 · `9a3960a` · E2E: one flows module, setup walked by step key; bots instead of 3 browsers

- **Type:** Risk mitigation
- **Change:** The testing table in § 13 describes the slimmer browser tests: one real player browser and three socket bots instead of four browsers, fake-player checks moved into the audio test, and a shared `e2e/flows.ts` whose `setupSession()` walks the setup by each step's key. The *Audio* row checks the recording verdict as a table of cases; the *Screenshots* row counts five scenarios and names setup shots by step key.
- **Reason:** Each change to the setup steps broke the browser tests in about 30 places; the suite was cut to what only a browser can prove, without losing unit-test coverage, and the table must describe the suite as it is.

### 2026-11-19 · `97e3fc4` · Docs: hover consent rule, failed session switch; change logs for wave 3

- **Type:** Risk mitigation
- **Change:** § 7 adds that the live hover signal follows the telemetry consent rule, and the testing row for the live figures adds hover and a failed session switch, which now shows that no session is attached.
- **Reason:** Hover was shown to the facilitator before consent and after a withdrawal (privacy); after a failed switch the dashboard kept showing the session that had left.

### 2026-11-19 · `84c5b37` · Telemetry: none stored or sent from a withdrawn seat

- **Type:** Risk mitigation
- **Change:** The consent rules in § 7 say that UI telemetry also stops when a seat is withdrawn, not only that it starts after consent.
- **Reason:** A withdrawn participant's browser kept sending telemetry and the server stored it; the rule now matches the consent promise (privacy).

### 2026-11-19 · `11aefb4` · Session: SessionManager owns a session's live state; seat monitor

- **Type:** Feature
- **Change:** The glossary gains **Seat monitor** (the live per-seat figures of the facilitator's dashboard, never stored). The `SessionManager` component row, the projection and audio diagrams, the code layout and § 15 now show that everything a seat sends goes through the session manager, that the facilitator is sent the full game state with three derived audio fields, and that the unused `facilitatorView` is gone. The testing table adds a row for the live figures.
- **Reason:** The live state of a session moved out of the network hub into the session that owns it, so the document must show where these rules now live and what clears the figures.

### 2026-11-19 · `bee2f52` · Docs: recording controller states, mic-check attempt, session guard

- **Type:** Risk mitigation
- **Change:** The code layout names `player/recordingMachine.ts` and `player/micCheckAttempt.ts`. In § 15 the *Busy check* row becomes *Session guard*: the one module that decides when deletion, erasure, attribution and audio export are refused, checking the running session first. The testing table adds the guard, controller-transition and mic-check tests.
- **Reason:** The "is the session running or busy?" rule was written about five ways, and the recording controller's decisions were spread over many flags; the document must say where each now lives.

### 2026-11-19 · `0126dec` · Docs: personal-data map, recording verdict, audio reason catalogue, seat gate

- **Type:** Risk mitigation
- **Change:** The glossary adds *recording verdict*, *audio reason catalogue*, *personal-data map* and *delivery policy*. The code layout adds `audioReasons.ts`, `recordingVerdict.ts`, `db/personalData.ts`, `net/delivery.ts` and `player/connection.ts` and drops `player/intents.ts` and the erasure files under `gdpr/`; the § 13 testing table and the § 15 state and projection rows follow.
- **Reason:** Four refactors each moved a rule that was copied in several places into one module (which audio reasons exist, whether a seat records, which tables hold personal data, how the browser sends again); the document must say where those rules now live.

### 2026-11-19 · `490686a` · Docs: headset gate engine, speech model, storage fixes

- **Type:** Feature
- **Change:** The component table, the code layout and § 15 (diagram and table) add the Silero VAD model file with its SHA-256 check, `onnxruntime-node` loaded only in the attribution worker, and the busy check that blocks deletion during a job or export. The bot `--audio` flag explains when to use `WKWA_SPEECH_MODEL=off`, and the testing table lists the new audio tests.
- **Reason:** The commit adds a runtime dependency and a model file to the server and a new rule between audio jobs and deletion.

### 2026-11-19 · `f309df0` · Seats survive session switches; read-only GameState; audio waits for the seat

- **Type:** Risk mitigation
- **Change:** § 5 adds the invariant that only the reducer changes state (`ReadonlyGameState` everywhere else; `afterReplay` for the reset after a load). § 11 says that switching sessions keeps the players' seats.
- **Reason:** The "reducer is the only place state changes" rule was a convention: `SessionManager.load` reset `connected` outside it, and nothing stopped other code from writing. The compiler now enforces it.

### 2026-11-19 · `0f343ea` · Typed socket protocol, intent resend after reconnect, CalibrationRunner

- **Type:** Risk mitigation
- **Change:** The code layout adds `packages/shared/src/socket.ts` (typed event maps), the schema tables in `protocol.ts`, `session/CalibrationRunner.ts` and `player/intents.ts`. The component table says what `SessionManager` delegates. The idempotency bullet covers the browser's resend and restarts. The extension guide gets *Add a socket message*. The testing table adds the protocol and intent-queue tests and the restart deduplication test.
- **Reason:** The socket protocol was typed by message name strings only, so a payload drift was not caught by the compiler, and the calibration's timers made SessionManager the largest file. The document must say where those parts now live and how to extend the protocol.

### 2026-11-19 · `2428109` · Docs: audio design document (AUDIO.md), docs sweep against the built behaviour and change logs (U14) (#14)

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
