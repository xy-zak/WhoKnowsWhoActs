# Architecture

*Change log: [ARCHITECTURE-CHANGELOG.md](changelog/ARCHITECTURE-CHANGELOG.md)*

This document describes how the ***Who Knows, Who Acts?* harness** is built: the parts of the system, how a player's click becomes research data, how game state is derived, and how to extend the harness when the actual game design is ready. It is written as a standalone design reference that can be cited or adapted for a thesis methods chapter.

Related documents: [AUDIO.md](AUDIO.md) (microphone recording and speaker attribution), [NETWORKING.md](NETWORKING.md) (network and protocol), [DATA-MANAGEMENT.md](DATA-MANAGEMENT.md) (GDPR and research data management), [DATA-TYPES.md](DATA-TYPES.md) (field-level catalogue of everything logged).

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Glossary](#2-glossary)
3. [System overview](#3-system-overview)
4. [Code layout](#4-code-layout)
5. [Event sourcing: from click to data](#5-event-sourcing-from-click-to-data)
6. [Session lifecycle](#6-session-lifecycle)
7. [Seat onboarding](#7-seat-onboarding)
8. [Projections: who sees what](#8-projections-who-sees-what)
9. [Rounds and the rules engine](#9-rounds-and-the-rules-engine)
10. [Timing model](#10-timing-model)
11. [Persistence, recovery and reproducibility](#11-persistence-recovery-and-reproducibility)
12. [Extension guide](#12-extension-guide)
13. [Testing strategy and bots](#13-testing-strategy-and-bots)
14. [Simulated players](#14-simulated-players)
15. [Microphone audio](#15-microphone-audio)

---

## 1. Purpose and scope

The harness is the **infrastructure** for a 4-player, turn-based, map-interaction research game played on a local network (LAN). The game design itself is still open, so the harness provides the parts that every variant will need:

| The harness provides | Left to the game built on top |
| --- | --- |
| Networking (hub-and-spoke, server-authoritative) | The actual scenario: board size, starting scores, narrative |
| Sessions, seats, participant codes, K/P labels | Win conditions, extra action types |
| A grid map (squares of four knowledge-type sub-squares), each player seeing only their own type's scores | |
| `propose` / `decide` interactions with quotas | |
| Pluggable **game rules**: what a player acts on, what actions do to the scores, the map score ([GAME-RULES.md](GAME-RULES.md)) | The final rule set and its numbers |
| Configurable rounds (default: 5 + 5 per player, 3 rounds) | Final round structure |
| Facilitator dashboard, composite view, replay | Game-specific dashboard widgets |
| Complete event + telemetry logging, exports, codebook | Analysis scripts |
| GDPR tooling: consent, pseudonymisation, encryption, erasure | Ethics approval, consent text, retention policy |
| Optional microphone recording of every participant, encrypted storage, who-spoke-when attribution ([AUDIO.md](AUDIO.md)) | Transcription (researched only: [AUDIO-TRANSCRIPTION.md](AUDIO-TRANSCRIPTION.md)), what to analyse in the talk |
| Simulated players: pluggable agent policies, a runner, a separate simulation database | The rules the agents follow (their policies) |

Design principles:

- **Server-authoritative.** Clients only send *intents*. The server decides what happens and is the single source of truth.
- **Event-sourced.** Every state change is an immutable event in an append-only log. Game state is always *derived* from the log and never stored separately.
- **Asymmetry enforced on the server.** A player's browser never receives another player's view data.
- **Privacy by design.** No names, IP addresses or device data (microphone names and ids included) are recorded. Participant codes live in one indexed column, so erasure is a single delete.
- **One source of truth for documentation.** Schemas carry their own descriptions. The tables in DATA-TYPES.md, NETWORKING.md and the per-export codebook are generated from them.

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Session** | One play-through with 4 participants, identified by `S-YYYYMMDD-XXXX`, or with 4 agents (a *simulated session*), identified by `SIM-YYYYMMDD-XXXX`. |
| **Client** | A player browser that connected to the server, shown as "Client N" until it is bound. In events, exports and the protocol the number is stored in fields named `terminal` (e.g. `SeatBound.terminal`, `players.csv.terminal`), kept for compatibility. |
| **Seat** | One of the 4 player positions (1–4). A client is *bound* to a seat by the facilitator. |
| **Participant code** | Random pseudonymous id (`WK-XXXX-XXXX-C`) generated when a seat is bound. Used for takedown requests. |
| **Labels** | Each seat gets one knowledge type (`Ka`–`Kd`) and one power type (`Pa`–`Pd`). |
| **Scenario** | A board size (squares), one *view* per knowledge type, and the starting score of every sub-square. |
| **Square** | One tile of the grid map, e.g. `C7` (column C, row 7). It holds four sub-squares, one per knowledge type. |
| **Sub-square (region)** | One knowledge type's part of a square, e.g. `C7-Kb`. It has a score (0–10) and is what every action targets. Events, telemetry and exports call its id the *region id*. |
| **View** | One knowledge type (name and description): the scores of its sub-squares are what a seat with that view knows. By default a seat's view is its K label. |
| **Game rules** | The rule set of a session: which sub-square an action lands on, what it does to the scores, and the map score ([GAME-RULES.md](GAME-RULES.md)). |
| **Map score** | One score for the whole map; in the standard rules, the average of every sub-square's score. |
| **Intent** | A request from a client ("decide C7-Kb"). It may be accepted or rejected. |
| **Event** | An immutable record in the session log (`ProposalMade`, `RoundStarted`, …). |
| **Telemetry** | Fine-grained UI behaviour (hover, inspect, focus …). Stored separately and never changes game state. |
| **Seat monitor** | The volatile per-seat figures of the facilitator's dashboard: telemetry counts, focus and visibility, hover, round trip, the mic meter merged with the stored track figures, and the last 500 live telemetry items. Owned by the `SessionManager` (`session/SeatMonitor.ts`), never stored, never sent to a player, and cleared by the events that end them (unbinding, withdrawal, mic check skipped, session closed or aborted). A new session starts with a new one. |
| **Reducer** | Pure function `applyEvent(state, event)` that derives game state from events. |
| **Projection** | The filtered part of the state that one recipient may see. A player gets `playerView`; the facilitator is sent the full `GameState` (including its derived audio fields). |
| **Recording verdict** | Whether a seat's microphone records now and, if not, the one reason why (paused, mic check skipped, mic check held, withdrawn, …). Worked out in one shared function, so the server, the player's browser and the facilitator's views always give the same answer ([§ 15](#15-microphone-audio)). |
| **Mic check hold** | In a session that records audio, no seat may start its mic check (so no microphone opens) until every real participant has finished the onboarding steps before it: consent, the questionnaire and the briefing ([§ 7](#7-seat-onboarding), [AUDIO.md § 8](AUDIO.md#8-recording-lifecycle)). Earlier called the consent hold. |
| **Audio reason catalogue** | The single list of why an audio track started or stopped and of the states a microphone reports, with each one's label and meaning. The message schemas, the codebook and the screens all take their text from it. |
| **Personal-data map** | The one list of which database tables and columns hold participant codes, session ids and audio files. Look-up, erasure, session deletion and audio deletion all work from it, so none of them can miss a table ([DATA-MANAGEMENT.md § 10](DATA-MANAGEMENT.md#10-takedown-and-erasure-procedure)). |
| **Delivery policy** | How the player's browser sends one kind of message that needs an answer: whether it waits for its seat, how long it waits for the answer, and whether it sends again after a refusal or a reconnect (`once`, `whileSeated`, `attempt`, `retry`, `resend`). |
| **Round rule** | The `rule` of a round spec (`quota` or `manual`): what counts as a round and when it is complete. |
| **Validator** | Plug-in that accepts or rejects an intent (a game-design hook). |
| **Composite** | The facilitator's overlay of all four views on one map. |
| **Fake player** | A test client the server creates itself in a session with real players (setup step 08, **Connect**). It connects over the network like a browser and plays at random, but its seat is logged as fake, gets no participant code and skips onboarding. |
| **Simulated session** | A session where software agents play every seat instead of people (setup step 03 **Who plays**: *Simulated players*). |
| **Agent** | The simulated player in one seat. It sees what a player of that seat would see and acts through the same rules. |
| **Agent policy** | The code that decides what an agent does on its turn (`PlayerPolicy`, § 14). The rules for simulations are written as policies. |
| **Welcome page** | The plain-HTTP page participants open first (`LANDING_PORT`, default 8080). It explains the certificate warning before the browser shows it and, while a session with real participants is open, links to the game page with **Join live session** ([NETWORKING.md § 11](NETWORKING.md#11-security-on-the-lan)). |
| **Simulation database** | `data/wkwa-sim.db`: where simulated sessions are stored, separate from the participant database `data/wkwa.db`. |

## 3. System overview

```mermaid
flowchart LR
  subgraph Players["Player PCs (browsers)"]
    P1["Player client<br/>seat 1"]
    P2["Player client<br/>seat 2"]
    P3["Player client<br/>seat 3"]
    P4["Player client<br/>seat 4"]
  end
  subgraph Laptop["Facilitator laptop"]
    F["Facilitator dashboard<br/>browser on localhost"]
    subgraph Server["Node.js server process"]
      NET["net<br/>Socket.IO namespaces<br/>player and facilitator"]
      API["api<br/>REST endpoints"]
      SM["SessionManager<br/>validate, append, reduce, broadcast"]
      SIM["SimulationRunner<br/>agents of a simulated session"]
      RULES["rules engine (shared)<br/>validators, round rules,<br/>reducer, projections"]
      STORE["db<br/>eventStore, telemetryStore"]
      GDPR["export and gdpr<br/>CSV/JSON, codebook,<br/>erase, anonymise, print"]
      AUD["audio<br/>live ingest, encrypted files,<br/>attribution worker, export"]
      LAND["landing<br/>welcome page, plain HTTP<br/>second listener"]
    end
    DB[("data/wkwa.db<br/>participants<br/>SQLCipher-encrypted")]
    SDB[("data/wkwa-sim.db<br/>simulations<br/>SQLCipher-encrypted")]
    AFILES[("data/audio/<br/>encrypted .wka files<br/>one key per file")]
    EXP(["exports/ folder"])
  end
  P1 <-->|WebSocket| NET
  P2 <-->|WebSocket| NET
  P3 <-->|WebSocket| NET
  P4 <-->|WebSocket| NET
  F <-->|WebSocket| NET
  F -->|HTTP| API
  P1 -.->|"plain HTTP, first visit"| LAND
  LAND -.->|"session open? (nothing else)"| SM
  NET --> SM
  SIM -->|"intents, like a player"| SM
  SIM <-->|"playerView, policies"| RULES
  SM <--> RULES
  SM --> STORE
  API --> GDPR
  API --> AUD
  SM -->|"audio chunks, only if the session records"| AUD
  AUD --> AFILES
  AUD -->|"keys and metadata"| STORE
  GDPR -->|"erase: keys first, then files"| AFILES
  API --> STORE
  STORE --> DB
  STORE -->|"simulated sessions"| SDB
  GDPR --> EXP
```

| Component | Technology | Responsibility |
| --- | --- | --- |
| Player client | React + Vite, SVG map | Shows the player's own view, sends intents, collects telemetry, syncs its clock. |
| Facilitator dashboard | React + Vite (same app, second page) | Session setup, seat binding, labels, composite map, live mirrors, controls, replay, data management. |
| `net` | Socket.IO 4 on Fastify 5, over HTTPS (self-signed certificate by default) | Namespaces `/player` and `/facilitator`. Validates every incoming payload with zod. |
| `api` | Fastify REST | Session listing, exports, printables (key sheet page, takedown-card PDFs), erasure, session deletion. |
| Welcome page | Fastify (second instance, plain HTTP on `LANDING_PORT`) + React page `landing.html` | The page participants open first. It serves only `landing.html`, `/assets/*` and `GET /api/landing` (`LandingStatus`: whether a session with real participants is open, the join link, the certificate kind and fingerprint; nothing about the session itself). Every other path redirects to `/`. The page asks every 2 s and shows **Join live session** and why the certificate warning appears. The game server also serves `/landing` and `/api/landing`. |
| `SessionManager` | TypeScript | Owns the live `GameState`. Turns intents and commands into events, appends them, then pushes projections. Audio ingest (`LiveAudio`), the calibration (`CalibrationRunner`) and the seat monitor (`SeatMonitor`) are parts it owns; their events go through its `append`. Everything a seat sends goes through one of its `submit*` methods (consent, mic check, telemetry, audio, mic level, presence) or `sayCalibrationReady`, and it decides which seats may get a fake player. At the end of each command it starts the calibration by itself once the room is ready for it. |
| Rules engine | `packages/shared` (pure TS) | Validators, round rules, reducer, projections. The server, the client (replay) and the tests share the same code. |
| `db` | better-sqlite3-multiple-ciphers | Encrypted SQLite (SQLCipher). Append-only `events`, `telemetry`, plus `sessions`, `erasures`, `exports`, `meta`. Two files with the same schema and passphrase: the participant database and the simulation database (`SessionStores` knows which session is where). |
| `FakePlayers` | TypeScript + socket.io-client | Starts and stops the fake players of a real session: network clients of this same server whose terminal keys the server registers before they connect, so their seats are marked fake. |
| `SimulationRunner` | TypeScript | Plays the agents of an attached simulated session: gives each agent a turn, asks its policy for an action and passes it to `SessionManager.intent` (§ 14). |
| `audio` | TypeScript (server), Web Audio (browser), onnxruntime-node (attribution worker only) | Browser capture engine, live ingest with the mic check hold, a calibration that starts once every player is ready, pause, encrypted file store, offline speaker attribution in a worker thread (Silero VAD speech model plus a level gate between the headset mics), *Export audio* ([AUDIO.md](AUDIO.md)). |
| `export` / `gdpr` | TypeScript | CSV/JSON exports with a generated codebook, anonymisation, erasure, backups, printable key sheet and cards. |

## 4. Code layout

The repository is an npm-workspaces monorepo. All shared logic lives in one pure package, without I/O, so the browser and the server run identical rules.

```mermaid
flowchart TB
  subgraph shared["packages/shared (pure TypeScript, no I/O)"]
    S1["config, scenario,<br/>labels, ids"]
    S2["events, telemetry, protocol<br/>zod schemas + doc metadata"]
    S3["rules<br/>reducer, validators, roundRules"]
    S4["projections<br/>playerView"]
    S5["docgen, exportColumns"]
    S6["simulation<br/>PlayerPolicy, registry,<br/>built-in policies"]
    S3 --> S2
    S4 --> S3
    S5 --> S2
    S6 --> S4
  end
  server["apps/server<br/>Fastify, Socket.IO, SQLCipher, CLI, bots"] --> shared
  client["apps/client<br/>React, Vite<br/>player page + facilitator page"] --> shared
  gen["scripts/generate-docs.ts"] --> S5
  gen --> docs["docs/*.md<br/>generated blocks"]
  server -->|codebook.md| exports["exports/"]
```

| Path | Contents |
| --- | --- |
| `packages/shared/src/config.ts` | Session config (rounds, quotas, visibility flags), study/consent/demographics schemas; `consentSections` splits the consent text into its `## ` sections, each with its one statement |
| `packages/shared/src/board.ts` | Grid geometry: squares, sub-squares, ids (`C7-Kb`), starting-score matrices |
| `packages/shared/src/game/` | `rules.ts` (rule sets: targeting, score changes, map score; registry `GAME_RULES`), `scoring.ts` (glue between rules and session state). See [GAME-RULES.md](GAME-RULES.md) |
| `packages/shared/src/scenario.ts` | Scenario, region (sub-square) and view schemas |
| `packages/shared/src/events.ts` | All game event types with payload schemas and documentation metadata |
| `packages/shared/src/telemetry.ts` | All telemetry types |
| `packages/shared/src/protocol.ts` | Socket message schemas, the schema table of each namespace (`PLAYER_SCHEMAS`, `FACILITATOR_SCHEMAS`) and the catalogue |
| `packages/shared/src/socket.ts` | Typed Socket.IO event maps derived from the schema tables (payloads, acknowledgements, server→client messages); used by every socket ([NETWORKING.md § 9](NETWORKING.md#9-message-catalogue)) |
| `packages/shared/src/rest.ts` | The REST response types of the DATABASE pages (sessions, exports, look-up, erasure, deletions), used by the server and the client |
| `packages/shared/src/state.ts` | `GameState` and derived helpers; the onboarding order (`ONBOARDING_STEPS`, `nextOnboardingStep`) and the mic check hold (`micCheckHoldSeats`) |
| `packages/shared/src/rules/` | `reducer.ts`, `validators.ts`, `roundRules.ts` |
| `packages/shared/src/projections.ts` | `playerView` (the facilitator is sent the full `GameState`) |
| `packages/shared/src/simulation/` | `policy.ts` (the `PlayerPolicy` interface, registry, helpers for writing policies), `policies.ts` (built-in policies `random` and `idle`) |
| `packages/shared/src/audio.ts` | Audio constants, settings and ack schemas, REST response types; `state.ts` holds the mic check hold and the calibration gate |
| `packages/shared/src/audioReasons.ts` | The audio reason catalogue: every track start and stop reason and every mic state, with label, description, whether a stop is clean or interrupted, and whether a state is capturing; the enums, schema descriptions and codebook texts are derived from it |
| `packages/shared/src/recordingVerdict.ts` | `recordingVerdict(state, seat)`: whether a seat records and, if not, why; `shouldRecord` is its yes/no; per reason, the catalogue `NOT_RECORDING_REASONS` holds the track's stop reason, the player's indicator state, the facilitator's mic-column tooltip, the server's refusal text and whether a closed track's late chunks are still stored; so do the calibration's readiness rules (`calibrationSeats`, `calibrationNotReadySeats`, `calibrationWaitsIn`, `calibrationReadyToStart`, `canSayCalibrationReady`) |
| `packages/shared/src/docgen.ts`, `exportColumns.ts` | Documentation and codebook generation; export file contract |
| `apps/server/src/` | `index.ts` (boot), `cli.ts`, `app.ts`, `content.ts` (scenario/config loading), `db/` (SQLCipher, store, `stores.ts`: participant and simulation database, `personalData.ts`: the personal-data map with look-up, erasure, session and audio deletion), `session/SessionManager.ts`, `session/CalibrationRunner.ts` (the timed calibration turns, the quick check and the redo), `session/SeatMonitor.ts` (the seat monitor), `session/sessionGuard.ts`, `simulation/SimulationRunner.ts` (agents), `fake/FakePlayers.ts` (fake players), `net/hub.ts` (Socket.IO), `api/` (REST; `audioRoutes.ts`, `gdprRoutes.ts`; `http.ts`: one `HttpError`, answered as `{ error }` with its status, and `requireSession`), `audio/` (live ingest, encrypted `.wka` store, attribution, jobs; the speech model file is `apps/server/models/silero_vad.onnx`), `gdpr/` (exporter, print pages), `tls.ts` (self-signed certificate), `landing.ts` (the welcome page on `LANDING_PORT`), `tools/` (bots) |
| `apps/client/src/ui/` | Design system: `tokens.ts` (Catppuccin Latte/Mocha → semantic colour tokens, contrast-tested), `theme.css` (TUI base styles), `crt.css` (subtle CRT layer), components (`Panel`, `Button`, `Popup`, `useConfirm`, `Stepper`, `StatusTag`, `AsciiProgress`, …), `Icon.tsx` + `icons.ts` (semantic Iconoir icons), `prefs.ts` + `DisplaySettings.tsx` (per-browser display settings: colours, font, text size, animations). Rules: [AESTHETIC-RULES.md](AESTHETIC-RULES.md) |
| `apps/client/src/facilitator/` | Manager shell (`App.tsx`: top bar, LIVE indicator, tabs, status bar, shortcuts), `setup/` (11-step wizard: 01 Scenario, 02 Rounds, 03 Who plays, 04 Seats & visibility, 05 Onboarding, 06 Tags, 07 Create session, 08 Connect, 09 Labels, 10 Key sheet, 11 Start; steps are addressed by key), `live/` (lifecycle, NEXT, tools, wrap-up), `seats.tsx`, `Composite.tsx`, `EventLog.tsx`, `Timeline.tsx`, `Replay.tsx`, `Database.tsx` |
| `apps/client/src/player/` | Player screens (waiting, onboarding with stepper: consent as an accordion of sections, **Mic check & calibration** in two parts; game, end) and the DISPLAY panel; display settings are per browser (`ui/prefs.ts`), never from or to the server |
| `apps/client/src/landing/` | The welcome page (`Landing.tsx`, entry `apps/client/landing.html`): title, welcome, **Join live session** and the certificate note; it reads `GET /api/landing` every 2 s |
| `apps/client/src/audio/` | Browser capture engine (`MicRecorder`, AudioWorklet, resampler, chunker, send queue, speech detector); no socket or UI code. `player/recording.ts` connects it to the socket; its states and transitions are in `player/recordingMachine.ts`, and `player/micCheckAttempt.ts` runs one mic-check attempt (pass, hold, submit, give up) for `MicCheckScreen.tsx` |
| `apps/client/src/` (other) | `map/` (grid map in SVG: squares, sub-squares, hatches, scores, legend, map score; themed via CSS variables), `net/` (typed sockets, `delivery.ts`: the seat gate and its delivery policies, clock sync, telemetry, `storage.ts`), `player/connection.ts` (the player's socket, seat and onboarding requests; it is given its socket and storage, so tests run it on a fake socket) |
| `config/` | `study.json`, `consent.json` + `consent.md` (each statement names the `## ` section it confirms; audio item and section only in audio sessions), `demographics.json`, `briefing.md`, `audio.json` (mic-check phrase, calibration sentences), `session.default.json` |
| `scenarios/<id>/` | `scenario.json` (board, views), `scores.json` (starting scores) |
| `scripts/demo-scores.mjs` | Regenerates the fixed-seed starting scores of the demo scenarios |

## 5. Event sourcing: from click to data

Clients send **intents**. The server validates them against the current state and records the outcome as an **event**, *including rejections*. State is the fold of all events: `state = events.reduce(applyEvent, initialState())`.

```mermaid
sequenceDiagram
  autonumber
  participant P as Player client (seat 2)
  participant N as net (/player)
  participant SM as SessionManager
  participant R as Rules (shared)
  participant DB as Event store (SQLCipher)
  participant O as Other clients and facilitator
  P->>N: intent (clientSeq 7, decide, C7-Kb, clientTs)
  N->>N: validate payload with zod
  N->>SM: handleIntent(seat 2, intent)
  SM->>SM: clientSeq 7 seen before? then repeat the earlier ack
  SM->>R: validateIntent(state, seat, intent)
  alt accepted
    R-->>SM: ok
    SM->>R: game rules: score changes of this decision
    SM->>DB: append DecisionMade (seq 58, scoreChanges)
    SM->>R: applyEvent(state, event)
    SM->>R: roundIsComplete(state)?
    opt round complete
      SM->>DB: append RoundCompleted (and GameCompleted after the last round)
    end
    SM-->>P: ack ok, seq 58
    SM->>O: push playerView per seat and dashboard
    SM-->>P: push own playerView
  else rejected
    R-->>SM: rejected (quota_exhausted)
    SM->>DB: append IntentRejected (state unchanged)
    SM-->>P: ack not ok, reason and detail
    SM->>O: facilitator log update
  end
```

Properties that follow from this design:

- **Complete audit trail.** Nothing is ever updated or deleted in normal operation. Undo is a new event (`ActionRevoked`) that marks the original as revoked.
- **Deterministic replay.** The reducer is pure: no clock, no randomness. Replaying the log reproduces every intermediate state exactly. The facilitator's replay view and the tests rely on this.
- **Only the reducer changes state.** Everything outside `rules/reducer.ts` sees the state as `ReadonlyGameState` (a deep read-only type): `SessionManager.state`, the projections, rules, validators, `LiveAudio`, `CalibrationRunner` and the facilitator UI. The compiler rejects a write anywhere else. `SessionManager` holds the one mutable copy privately and hands it only to `applyEvent` and `afterReplay` (which marks every human seat disconnected after a load, until its browser says hello again).
- **Idempotency.** Each intent carries a per-seat `clientSeq`. The browser resends an unanswered intent, unchanged, after every reconnect; the resend returns the original acknowledgement and appends nothing, also after a server restart (the answers are rebuilt from the log). See [NETWORKING.md § 7](NETWORKING.md#7-disconnects-and-reconnects).
- **Facilitator commands are events too** (`SeatBound`, `LabelsAssigned`, `RoundStarted`, `GamePaused`, …), so the log also documents how the session was run.

## 6. Session lifecycle

```mermaid
stateDiagram-v2
  [*] --> lobby: SessionCreated
  lobby --> lobby: SeatBound, SeatUnbound, LabelsAssigned
  lobby --> onboarding: OnboardingStarted
  onboarding --> round_active: RoundStarted (round 1)
  round_active --> round_complete: RoundCompleted
  round_complete --> round_active: RoundStarted (next round)
  round_complete --> game_complete: GameCompleted
  game_complete --> closed: SessionClosed
  lobby --> aborted: SessionAborted
  onboarding --> aborted: SessionAborted
  round_active --> aborted: SessionAborted
  round_complete --> aborted: SessionAborted
  closed --> [*]
  aborted --> [*]
  state round_active {
    [*] --> running
    running --> paused: GamePaused
    paused --> running: GameResumed
  }
```

| Phase | What happens | Who moves it on |
| --- | --- | --- |
| `lobby` | Clients connect and are bound to seats. K/P labels (and views) are assigned. | Facilitator: *Start onboarding* (all seats bound and labelled) |
| `onboarding` | Each player completes consent → demographics → briefing → (**Mic check & calibration**, in sessions that record audio). Steps can be disabled in config. In an audio session the mic checks wait until every seat is through the briefing, and the calibration starts by itself once every recorded player has said they are ready. | Facilitator: *Start round 1* (only once every seat is ready, and the calibration is done or skipped) |
| `round_active` | Players propose and decide within their quotas. Can be **paused** (by the facilitator, or automatically on disconnect). | Round rule (quotas met), time limit, or facilitator *End round* |
| `round_complete` | Break between rounds. | Facilitator *Start round* (or auto-advance after `autoAdvanceDelaySec`) |
| `game_complete` | End screen. Each player sees their participant code (takedown card). | Facilitator *Close session* |
| `closed` / `aborted` | Archived. Only erasure markers can still be appended. | — |

When the facilitator ends the game early, the server records `RoundCompleted` (reason `facilitator`) followed by `GameCompleted` (reason `facilitator`).

A **simulated session** (§ 14) follows the same phases. Its seats are filled by agents when it is created, and *Start simulation* records `OnboardingStarted` with no steps and `RoundStarted` for round 1 in one command, so the `onboarding` phase lasts zero time.

## 7. Seat onboarding

```mermaid
stateDiagram-v2
  [*] --> unbound
  unbound --> agent: AgentBound (simulated session, at creation)
  agent --> playing: RoundStarted
  unbound --> fake: SeatBound with fake true (no code)
  fake --> playing: RoundStarted
  unbound --> bound: SeatBound (code generated)
  bound --> unbound: SeatUnbound (lobby only)
  bound --> consent: OnboardingStarted
  consent --> declined: ConsentRecorded, not consented
  consent --> demographics: ConsentRecorded, consented
  demographics --> briefing: DemographicsSubmitted
  briefing --> ready: BriefingAcknowledged, no audio
  briefing --> held: BriefingAcknowledged, audio session, another real seat not through the briefing
  briefing --> micCheck: BriefingAcknowledged, audio session, every real seat through the briefing
  held --> micCheck: the last real seat finishes the briefing, or is withdrawn
  micCheck --> ready: MicCheckCompleted (passed) or MicCheckSkipped
  ready --> playing: RoundStarted
  playing --> finished: GameCompleted
  consent --> withdrawn: ParticipantWithdrawn
  demographics --> withdrawn: ParticipantWithdrawn
  briefing --> withdrawn: ParticipantWithdrawn
  held --> withdrawn: ParticipantWithdrawn
  micCheck --> withdrawn: ParticipantWithdrawn
  ready --> withdrawn: ParticipantWithdrawn
  playing --> withdrawn: ParticipantWithdrawn
  note right of ready
    Audio session: part 2 of Mic check and calibration,
    CalibrationReady, then the turns start by themselves
  end note
  declined --> [*]
  withdrawn --> [*]
  finished --> [*]
```

- **Order.** A new session runs consent → demographics (**About you**) → briefing → mic check (`ONBOARDING_STEPS`). The session logs its steps in `OnboardingStarted`, and `nextOnboardingStep` follows that list, so a session started before this order (consent → mic check → demographics → briefing) keeps its own.
- **Consent** is an accordion: one sub-section per `## ` section of `config/consent.md`, each with the one statement that confirms it (`section` in `config/consent.json`). The participant goes through every sub-section before **I agree — continue**. `consentSections` splits the text, and the server refuses to create a session unless every section has exactly one statement and every statement a section.
- **Mic check & calibration (audio sessions only).** The last step. It applies only to real participants who ticked the audio item. **No seat may start its mic check, and so no microphone opens, until every real seat has finished the steps before it**: consent, the questionnaire and the briefing (the mic check hold, `micCheckHoldSeats`, [AUDIO.md § 8](AUDIO.md#8-recording-lifecycle)). In an older session only consent holds. A decliner keeps the hold until the facilitator withdraws that seat. Part 1 is the player's own mic check, which ends the onboarding for that seat. Part 2 is the button **I'm ready for the calibration** (`CalibrationReady`). Once every seat is through its onboarding and every recorded seat is ready, the server starts the calibration by itself ([AUDIO.md § 9](AUDIO.md#9-calibration)). The facilitator can skip one seat's mic check (`MicCheckSkipped`), and that seat is then not recorded. Fake players and agents have no mic check.
- A disabled onboarding step is skipped (consent then shows status `skipped`). **Keep consent enabled for real sessions.**
- **No telemetry before consent, nor after a withdrawal.** UI telemetry for a seat starts only once its consent is `given` (or `skipped`), and stops when the seat is withdrawn. Outside that span only operational events are recorded. The live hover signal (`presence`, never stored) follows the same rule, so the facilitator does not see it either.
- If a player **declines** consent, the seat is blocked and the facilitator is alerted. Round 1 cannot start until every active seat is ready. The decliner's remaining records can be erased afterwards (see [DATA-MANAGEMENT.md § 7](DATA-MANAGEMENT.md#7-consent-design)).
- A **withdrawn** seat is excluded from round completion and its intents are rejected (`seat_inactive`).
- *Unbound → bound* happens only in the lobby. Once onboarding has started, seats are locked.
- A **fake player** (a test client the server created, § 13) goes *unbound → fake*: `SeatBound` with `fake: true` and no participant code. It skips consent, demographics and briefing, so no answers are ever made up, and counts as ready as soon as onboarding starts.
- In a **simulated session** every seat goes *unbound → agent* when the session is created (`AgentBound`). Agents have no participant code and no onboarding, and a browser can never be bound to their seats.

## 8. Projections: who sees what

The full `GameState` exists only on the server. Each recipient gets a **projection**:

```mermaid
flowchart LR
  LOG[("Event log")] -->|reduce| GS["GameState<br/>all seats, codes,<br/>all actions"]
  SC["Scenario + session<br/>grid, scores of<br/>Ka, Kb, Kc, Kd"]
  GS --> V1["playerView seat 1"]
  GS --> V2["playerView seat 2"]
  GS --> V3["playerView seat 3"]
  GS --> V4["playerView seat 4"]
  GS --> FV["full GameState<br/>+ seat monitor figures"]
  SC -->|grid + scores of seat 1's view only| V1
  SC -->|grid + scores of seat 2's view only| V2
  SC -->|grid + scores of seat 3's view only| V3
  SC -->|grid + scores of seat 4's view only| V4
  SC -->|all scores| FV
  V1 --> B1["Seat 1 browser"]
  V2 --> B2["Seat 2 browser"]
  V3 --> B3["Seat 3 browser"]
  V4 --> B4["Seat 4 browser"]
  FV --> FD["Facilitator dashboard<br/>composite + mirrors"]
```

| Information | Own player | Other players | Facilitator |
| --- | --- | --- | --- |
| Grid (board size, knowledge-type names) | ✓ | ✓ | ✓ |
| Scores of the player's own knowledge type (view) | ✓ | ✗ never sent | ✓ (all types) |
| Map score | ✓ | ✓ | ✓ |
| Which knowledge type the player acts on (`me.actsOn`) | ✓ | ✗ | ✓ |
| Proposals and decisions (hatched / filled marks) | ✓ | ✓ (actor seat only if `showActorToPlayers`) | ✓ with seat and time |
| Own K/P labels | if `showOwnLabels` | if `showOtherLabelsToPlayers` | ✓ |
| Quota progress | ✓ | if `showOthersProgress` | ✓ |
| Connection / ready status of seats | ✓ | ✓ | ✓ (+ focus, idle, latency, hover) |
| Participant code (+ study contact for takedown) | only on the end / withdrawn screen | ✗ | ✓ |
| Demographic answers | ✗ (only sends them) | ✗ | ✗ live (only "submitted ✓"); in exports only |
| Consent answers | ✗ | ✗ | consent status only |

`playerView` is the **only** code path that builds a message for a player. The automated tests check that no player's messages ever contain another view's scores.

The facilitator's `dashboard` message carries the full `GameState`, including fields the reducer derives for the server's own use (`audio.pauses`, `audio.gameCompleteTs`, `audio.calibrationRuns`), plus the seat monitor's live figures per seat. Demographic answers are redacted from the events it is sent.

## 9. Rounds and the rules engine

**What counts as a round** is set per session (`SessionConfig.defaultRound`, overridable per round via `roundOverrides`):

| Rule | Ends when | Quotas |
| --- | --- | --- |
| `quota` (default) | every active seat has used all limited quotas | `propose` and `decide` per player per round (default 5 and 5; `null` = unlimited) |
| `manual` | the facilitator ends it | quotas still cap actions |
| *(any)* + `timeLimitSec` | additionally when the time limit (paused time excluded) elapses | — |

**Validation pipeline.** Every intent passes an ordered list of validators. The first rejection wins and is logged as `IntentRejected` with a machine-readable reason:

| # | Validator | Rejection reason |
| --- | --- | --- |
| 1 | `roundIsActive` | `round_not_active` |
| 2 | `notPaused` | `paused` |
| 3 | `seatIsActive` (bound, not withdrawn) | `seat_inactive` |
| 4 | `regionExists` (a sub-square of the board) | `unknown_region` |
| 5 | `roundRuleAllows` (quota) | `quota_exhausted` |
| 6 | `gameRulesAllow`: the sub-square the game rules give the seat (standard rules: the one of its power type), then the rule set's own validators | `rule` |

`decide` is deliberately **independent** of `propose`: a player may decide any square. The `DecisionMade` event records which seats had proposed or decided that sub-square beforehand, so the relationship can still be analysed.

**Scores.** When the server accepts a proposal or decision, it asks the session's game rules what the action does to the scores and records the result in the event (`scoreChanges`). The reducer only replays recorded changes, so a past session's scores never change when the rules do. Revoking an action records the changes that undo it. Details and the rule set itself: [GAME-RULES.md](GAME-RULES.md).

## 10. Timing model

| Timestamp | Clock | Precision | Use |
| --- | --- | --- | --- |
| `serverTs` | server, `performance.timeOrigin + performance.now()` | sub-ms, monotonic within one server run | Ordering and durations of events (authoritative) |
| `serverWall` | server wall clock (ISO-8601 UTC) | ms | Human-readable copy |
| `clientTs` | client clock **corrected to server time** | ~RTT/2 (≈ 1–5 ms on a LAN) | When the player actually clicked or hovered |
| `durationMs` | measured on the client | ms | Time spent on screens and panels, hover durations |

Clients estimate their clock offset with an NTP-style exchange (5 samples on connect, again every 60 s; see [NETWORKING.md § Clock synchronisation](NETWORKING.md#8-clock-synchronisation)). Each push of state is acknowledged with `state_received` telemetry. That makes the **reaction time** (from seeing the latest state to acting) computable exactly; `actions.csv` includes it as `reaction_ms`.

## 11. Persistence, recovery and reproducibility

- The **event log is the database of record.** `GameState` is never persisted; it is rebuilt from the log whenever a session is loaded.
- **Two database files.** Sessions with participants live in `data/wkwa.db`, simulated sessions in `data/wkwa-sim.db` (same schema, same passphrase). Every API call and *Resume* finds the right file from the session id.
- **Server restart:** start the server again, enter the passphrase, then use *Resume* on the dashboard (`session:resume`). The server broadcasts `rehello`, and every player browser re-claims its seat with the reconnect token stored in `localStorage` (see [NETWORKING.md § 7](NETWORKING.md#7-disconnects-and-reconnects)). Durations keep counting from the logged timestamps.
- **Switching sessions** (create or resume another, an erasure's reload, a deletion) sends `detached` to the seated browsers: they keep their tokens, so resuming the session again gives every player their seat back.
- **Reproducibility:** `SessionCreated` stores the full effective configuration, the scenario id, version and **SHA-256 hash**, and the harness version and git commit. Together with the event log, that is enough to replay exactly what every participant saw.
- **Encryption at rest:** the SQLite file is encrypted with SQLCipher. The passphrase is typed at start-up and never stored (see [DATA-MANAGEMENT.md](DATA-MANAGEMENT.md#9-encryption-and-key-management)).

## 12. Extension guide

The harness is meant to be extended once the game design is settled. For each extension point: **where** to change it, and what to keep in sync.

### Change the game rules

Everything that is "the game" lives in `packages/shared/src/game/rules.ts`: which sub-square an action lands on (`targetOf`), what it does to the scores (`deltas`), the map score, and optional extra validators. Change the numbers in `STANDARD`, or add a rule set to `GAME_RULES`; bump the version, update the tests in `packages/shared/test/gameRules.test.ts` and [GAME-RULES.md](GAME-RULES.md) (step by step in its § 10). Nothing else in the harness needs to change.

### Add a harness validator

Restrictions that are part of the game (e.g. "decide only on sub-squares proposed by someone else") belong in the rule set's `validators` (above). A validator that every game needs goes in `packages/shared/src/rules/validators.ts`:

1. Write a `Validator`. Return `{ ok: false, reason: "rule", detail }` to reject.
2. Add it to `DEFAULT_VALIDATORS` (order matters; the first rejection wins).
3. Add a unit test in `packages/shared/test/rules.test.ts`.

Labels are available in the state (`state.seats[seat].k` / `.p`), so rules like "power type `Pa` may decide twice as often" are validators too.

### Add an agent policy (simulated players)

1. Write a policy with `definePolicy({ id, version, name, description, params, act })` in `packages/shared/src/simulation/policies.ts` (a commented template is at the top of the file). `act(view, ctx)` gets the seat's `PlayerView` and returns `{ kind, regionId }` or `null`.
2. Add it to `BUILT_IN_POLICIES` in the same file. It then appears in setup step 03.
3. Use `ctx.random()` for every random choice (never `Math.random()`), and `ctx.memory` for anything to remember between turns.
4. Add a unit test in `packages/shared/test/simulation.test.ts` and run `npm run docs:generate` (§ 14 lists every policy and its parameters).
5. Bump `version` whenever the behaviour changes. Each seat logs the version it ran with in `AgentBound`.

### Add a round rule

1. Add its completion test to `roundIsComplete` in `packages/shared/src/rules/roundRules.ts` (action caps go through `checkQuota`).
2. Add its id to the `rule` enum of `RoundSpecSchema` in `config.ts`.
3. Run `npm run docs:generate` (the config table and the `RoundStarted` payload change).

### Add a new action type (e.g. `veto`)

1. Add the kind to `ACTION_KINDS` in `labels.ts`, and a quota field to `RoundSpecSchema.quota`.
2. Add an event definition (`VetoMade`) to `EVENT_DEFS` with metadata and an example.
3. Handle it in the reducer. TypeScript's exhaustiveness check flags the missing `case`.
4. Give it a colour or style in the client map overlay and a tool button.
5. Include it in `actions.csv` (`exportColumns.ts` `kind` description and the exporter).
6. Regenerate the docs and update the briefing text.

### Add an event type

1. Add an entry to `EVENT_DEFS` in `events.ts`: summary, trigger, actors, data class, frequency, payload schema with `.describe()` on every field, and an example.
2. Handle it in `applyEvent`, even if it does not change state.
3. Emit it from `SessionManager`. For an event about one seat, set `seat` **and** `participantCode` in the envelope so erasure finds it. **Never put a participant code in a payload.**
4. Run `npm run docs:generate`. DATA-TYPES.md and the codebook pick it up automatically.

### Add a telemetry type

1. Add an entry to `TELEMETRY_DEFS` in `telemetry.ts`.
2. Emit it from the client (`apps/client/src/net/` telemetry batcher).
3. Run `npm run docs:generate`. Weigh the addition against the data minimisation principle ([DATA-MANAGEMENT.md](DATA-MANAGEMENT.md#8-data-minimisation-decisions)).

### Add a socket message

1. Write its zod schema in `packages/shared/src/protocol.ts` (`.describe()` the fields) and add it to the namespace's schema table (`PLAYER_SCHEMAS` or `FACILITATOR_SCHEMAS`).
2. If it has an acknowledgement, add its type to `PlayerAcks` (or a result to `FacilitatorResults`) in `socket.ts`. A server→client message goes in `PlayerServerToClient` / `FacilitatorServerToClient`.
3. Add its entry to `MESSAGES`, under its namespace and direction (description, acknowledgement, what is logged; the schema is taken from the table). Until steps 1–3 agree, the shared package does not compile.
4. Handle it in `net/hub.ts` (`seatCmd`, `cmd` or `act`: the schema is looked up from the table) and send it from the client; the compiler checks the name, the payload and the acknowledgement at both ends.
5. Run `npm run docs:generate` (the message catalogue in NETWORKING.md).

### Add a scenario / map

```
scenarios/<id>/
  scenario.json   { id, title, version, description, board: { cols, rows },
                    views: { "Ka": { name, description }, "Kb": …, "Kc": …, "Kd": … },
                    scores: "scores.json" }
  scores.json     { "Ka": [[3, 5, …], …], "Kb": …, "Kc": …, "Kd": … }   rows top first, columns A first
```

- The board is at most 26 × 26 squares. `demo` is 10 × 10 (400 sub-squares) and `demo-small` 5 × 5 (100).
- Every knowledge type `Ka`–`Kd` needs a view and a score matrix of exactly `rows` × `cols` numbers; the server lists a scenario with a size error in setup step 01 and does not let you choose it. Starting scores must lie in the rule set's range (0–10 for the standard rules).
- Details: [GAME-RULES.md § 11](GAME-RULES.md#11-starting-scores-and-scenarios).
- Bump `version` whenever you change the scenario. Its hash is recorded in every session anyway.

### Keeping documentation and data contracts in sync

| Changed | Run / update |
| --- | --- |
| Any schema in `packages/shared` | `npm run docs:generate` (tests fail if you forget) |
| Export columns | `exportColumns.ts` → exporter → `npm run docs:generate` |
| Consent text | bump `version` in `config/consent.json` (the text hash is logged anyway) |
| Demographic questions | bump `version` in `config/demographics.json` |
| Data collected (new field/type) | update the inventory in DATA-MANAGEMENT.md and check it against your ethics approval |

## 13. Testing strategy and bots

| Layer | Tool | What is checked |
| --- | --- | --- |
| Rules | Vitest (`packages/shared/test`) | Quotas, round completion, pause, revoke, overrides, custom validators, deterministic replay, projection asymmetry, participant-code checksums |
| Game rules | Vitest (`packages/shared/test/gameRules.test.ts`) | Board ids and starting-score matrices, targeting by power type (also in a dissociated pairing), +4 / −1 with the 0–10 limits, map score, the reducer replaying recorded score changes, revoke replay, a second rule set plugging in |
| Documentation | Vitest + `npm run docs:check` | Generated blocks are up to date; every event, telemetry type and message is documented |
| Server integration | Vitest + `socket.io-client` bots | A full 3-round game with 4 bots on a temporary encrypted DB: event counts, rejections, reconnect + auto-pause, intent deduplication (also across a server restart), the transient "Not seated" refusal, revoke, resume from the log, **no cross-view data leakage**, no codes in payloads, logs without IPs or participant codes (a code in a request path is redacted) |
| Protocol | Vitest (`packages/shared/test/protocol.test.ts`, `apps/client/test/connection.test.ts`, `delivery.test.ts`) and the compiler | The catalogue documents exactly the schema tables' messages with the same schemas; the typed event maps check every emit and listener; the player connection, run on an in-memory fake socket, goes through `hello`, `bound`, reconnects, `detached` and `unbound`: actions are sent only while seated, resent unchanged after a reconnect and given up after their deadline, a "Not seated" refusal of a request is sent again once seated, and telemetry waits for the seat; the facilitator connection refuses a command while offline instead of queuing it, and a failed download shows the server's `error` text (`facilitator-connection.test.ts`); every REST refusal answers its status with `{ error }`, and every registered `/api` route except `/api/health` and `/api/landing` refuses a request from another computer with 403 (`apps/server/test/restErrors.test.ts`) |
| GDPR | Vitest | Wrong passphrase fails; no plaintext codes in the DB file; export files match `EXPORT_FILES` column by column; anonymised exports contain no codes; erasure removes every row, adds the register entry (the erasure and session-deletion registers are checked field by field) and never reuses seq numbers, every `reaction_ms` in the export matches the stored telemetry, and leaves `secure_delete` on with no freed pages in the file; a failed export leaves no folder; the session guard refuses each operation in each session state and busy state with the documented message (`apps/server/test/sessionGuard.test.ts`); the personal-data map covers every table of the schema that holds a code, a session id or an audio file, and after an erasure no table holds the code (`apps/server/test/personalData.test.ts`); backups are encrypted; rekey works; data folders are git-ignored |
| Live figures | Vitest (`apps/server/test/seatMonitor.test.ts` on a `SessionManager` driven directly, `apps/server/test/dashboard.test.ts` over sockets) | Telemetry is stored, and hover shown, only after consent and never after a withdrawal; what clears a seat's figures in the seat monitor (unbinding, withdrawal, mic check skipped, disconnect, end of session); mic readings kept only for a seat that may be recorded; the rule for fake players (real session, lobby, a free seat); a session switch leaves no live figures of the previous session; a pending dashboard refresh ends with its session; a session switch that fails shows that no session is attached |
| Fake players | Vitest (`apps/server/test/fake.test.ts`) | Fake players in a real session: seats logged as fake without codes, no consent or demographics recorded for them, they play a full round over the network, `fake_player` / `fakeSeats` in exports, FAKE PLAYER on the key sheet and no takedown card, refused outside the lobby and in simulated sessions, a browser can never count as fake, restored after a server restart with their pace |
| Simulated players | Vitest (`packages/shared/test/simulation.test.ts`, `apps/server/test/simulation.test.ts`) | Policy registry and parameters, the random policy's quotas and seed, agents see only their own view; a full simulated game in the simulation database only, no participant codes or consent, a run repeats exactly from its seed, per-seat policies, a failing policy is stopped and noted, simulation exports, resume after a restart |
| Browser | Playwright (`npm run test:e2e`) | That the screens drive what the server tests prove over sockets (fresh temporary DB per run): the welcome page (no button before a session, **Join live session** once one is open); the facilitator's eleven setup steps → one real player browser and three socket bots bound to the seats → consent (every accordion section gone through before **I agree — continue**) → demographics → briefing → a round of propose/decide → end screen with code → export → DATABASE → replay; a simulated session through setup (onboarding and key sheet skipped) → LIVE → export → DATABASE › Simulations; display and motion settings; every Mermaid diagram in the docs parses and renders. The specs and the screenshot scenarios share `e2e/flows.ts`: `setupSession()` walks the setup by each step's `data-step` key, so a new step with defaults needs no test change |
| Audio | Vitest (`apps/server/test/liveAudio.test.ts`, `audioProcessing.test.ts`, `audioRoutes.test.ts`, `tls.test.ts`, attribution and file-store suites; `apps/client/test/audio-*.test.ts`; `packages/shared/test/audio.test.ts`, `recordingVerdict.test.ts`, `audioReasons.test.ts`), Playwright (`e2e/app-audio.spec.ts`) | The recording verdict as a table of cases, and that a seat counts as paused only when the pause is all that stops it, the reason catalogue against the schemas and the codebook, every not-recording reason's answer to an audio message (accepted or refused, with its text; `audioRefusal.test.ts`), the recording controller's transitions as a table (state and input → next state and the track start or stop it causes), the mic-check attempt on a fake clock, the encrypted store (round trip, tampering, truncation, no plaintext on disk), every ingest gate, the onboarding order and the mic check hold (until every seat is through the briefing; by consent only in an older session), the ready seats and the automatic calibration start, calibration timers, pause and resume, track lifecycle, attribution against synthetic headset and laptop-like mixes with known truth, the export of a clean track with a damaged record, the `.partial` export folder and its clean-up at start, erasure (overlap partners stripped) and the busy check; the welcome page and `LANDING_PORT` (`tls.test.ts`); a real Chromium with a fake microphone that plays a synthetic voice goes through the hold, mic check, **I'm ready for the calibration**, the automatic calibration, a round, pause and game complete, with fake players on the other seats (tracks only for real seats, takedown cards only for them, the session marked in DATABASE) |
| Screenshots | Playwright (`npm run screenshots -- capture`, own project, not run by `test:e2e`) | Not a test: five scenarios (a full session with 4 player browsers, a 5 × 5 session with fake players, a simulation, microphone problems, a session played by bots with audio) take the shots listed in `e2e/screenshots/catalogue.ts` at 1920 × 1080 and compare them with the published versions. `publish` files a real change as a new version (`name-v2.png`, …) in `docs/img/server/` (facilitator) or `docs/img/client/` (players), so old versions stay; the gallery [docs/img/SCREENSHOTS.md](img/SCREENSHOTS.md) is generated from the version history `docs/img/screenshots.json`. Setup shots are named by step key (`server/setup-<key>`). Workflow: the `/screenshot-app` skill |

`npm run test:coverage` runs the unit tests with a coverage report (`coverage/`); it is not enforced, and the speed checks of the attribution tests are skipped under it.

Three kinds of non-human players exist, for different purposes:

| | Bots (`npm run bots`) | Fake players | Simulated players (agents) |
| --- | --- | --- | --- |
| Started by | a separate command | the server, from setup step 08 (one per seat) | the server, when a simulated session is created |
| Connect over the network | yes, like a browser | yes, like a browser (loopback) | no, they run inside the server |
| Session type | real | real | simulated |
| Onboarding | consent, demographics, briefing (made-up answers) | skipped | none |
| Participant code | yes (`WK-…`) | none | none |
| Marked in the data | **no**: indistinguishable from a person | `SeatBound.fake`, `players.csv` `fake_player`, `session.json` `fakeSeats` | `AgentBound`, simulation database |
| Stored in | participant database | participant database | simulation database |
| Use | load tests, `--auto` rehearsals | trying a real session without a group of people | testing game rules with policies |

Prefer fake players over bots for rehearsals: their data is marked, and no consent or demographic answers are invented.

**Bots** (`npm run bots -- --count 3`) are test players for **real** sessions. They connect like real browsers, complete onboarding and propose/decide at random within their quotas. Use them to rehearse a session alone: run 3 bots, play the fourth seat yourself, and watch the dashboard. They are not the same as **simulated players** (§ 14): bots test the network path of a real session and are stored in the participant database, while agents run inside the server, follow a policy and are stored in the simulation database.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url` | this laptop: `https://localhost:3000` if the server speaks HTTPS, else `http://` (port from `PORT`) | Server to connect to. Over HTTPS the bots accept the server's self-signed certificate without checking it. |
| `--insecure` | off | Accept an unchecked (self-signed) certificate from a server on **another** machine; on this laptop (`localhost`, `127.0.0.1`, `[::1]`) it is accepted anyway |
| `--count` | `3` | Number of simulated players |
| `--delay` | `1500-5000` | Random pause between a bot's actions (ms, `min-max`) |
| `--auto` | off | Also act as facilitator: create a session if none is attached, bind every client (bots **and** humans) to the next free seat, randomise labels, start onboarding and each round. **Never use during a real session.** |
| `--audio` | off | Test microphone recording: tick the audio consent item, pass the mic check and upload synthetic 16 kHz audio (a noise floor with speech-like bursts, louder in the bot's own calibration turn, with 22 dB of crosstalk). With `--auto` it also creates an audio session. Each bot clicks **I'm ready for the calibration** after its mic check (and again after a redo), so the calibration starts by itself. Without it, a bot in an audio session declines the audio item and waits. The bursts are not a real voice, so the speech model finds no speech in them: start the server with `WKWA_SPEECH_MODEL=off` to attribute bot audio by energy (the e2e server does this). |
| `--seats` | `4` | Seat count of the session `--auto` creates |
| `--round-pause` | `3000` | Pause (ms) `--auto` waits between rounds |
| `--admin-token` | – | `ADMIN_TOKEN` when the server is on another machine |

## 14. Simulated players

A **simulated session** is played by software **agents** instead of people. The facilitator chooses *Simulated players* in setup step 03 (**Who plays**, with the agents' settings); consent, client binding, participant codes and the key sheet are then skipped, and the session is stored in the **simulation database** (`data/wkwa-sim.db`, see [DATA-MANAGEMENT.md § 17](DATA-MANAGEMENT.md#17-simulated-sessions-and-the-simulation-database)).

The rules the agents follow are not designed yet. The harness provides the frame for them: a small interface (`PlayerPolicy`), a registry, a runner that plays the agents, and two baseline policies.

### How an agent takes a turn

```mermaid
sequenceDiagram
  autonumber
  participant T as Timer (pause from minDelayMs to maxDelayMs)
  participant RUN as SimulationRunner
  participant P as Agent policy (seat 2)
  participant SM as SessionManager
  participant DB as Simulation database
  participant F as Facilitator dashboard
  T->>RUN: seat 2's turn
  RUN->>RUN: round active, not paused, seat active?
  RUN->>P: act(playerView of seat 2, context)
  alt returns an action
    P-->>RUN: propose C7-Kb
    RUN->>SM: intent(seat 2, propose C7-Kb), like a player's click
    SM->>SM: same validators and quotas
    SM->>DB: append ProposalMade or IntentRejected
    SM-->>RUN: ack
    RUN->>P: onFeedback(accepted or rejected) [optional]
    SM->>F: push dashboard
  else returns null (pass)
    P-->>RUN: null
  end
  RUN->>T: schedule seat 2's next turn
```

- **Same information as a person.** The policy gets the seat's `PlayerView`: the projection a player's browser would receive (§ 8), with only its own view's data. Information asymmetry between seats holds for agents too.
- **Same rules as a person.** An agent cannot change the state; it can only return one action per turn, which goes through `SessionManager.intent`, the validators and quotas, and is logged with the same event types (`ProposalMade`, `DecisionMade`, `IntentRejected`). Facilitator controls (pause, end round, revoke, withdraw, labels) work as in a real session.
- **Turns.** While a round is running and not paused, each agent gets a turn after a pause drawn between `simulation.minDelayMs` and `maxDelayMs`. After a pass (or an error) it is asked again after at least 250 ms. Rounds end by the round rule as usual; later rounds start by the facilitator or automatically (`roundAdvance`).
- **Errors.** If a policy throws three times in a row, its agent stops and a `SessionNote` (actor `system`) records why. The rest of the session carries on.
- **Dashboard.** Agents can act many times a second, so while they play the server sends the facilitator's full `dashboard` at most every 100 ms. New events still reach the event log one batch at a time.

### Lifecycle of a simulated session

```mermaid
flowchart LR
  C["session:create<br/>players = simulated"] --> E1["SessionCreated<br/>config with seed"]
  E1 --> E2["AgentBound × seats<br/>policy, version, params, seed"]
  E2 --> L["LabelsAssigned<br/>(step 09, as usual)"]
  L --> S["simulation:start"]
  S --> E3["OnboardingStarted (no steps)<br/>RoundStarted 1"]
  E3 --> R["agents play<br/>rounds as configured"]
  R --> G["GameCompleted"]
  G --> X["export to exports/simulations/<br/>SessionClosed"]
```

### Reproducibility

| What | Where it is logged |
| --- | --- |
| Policy, its version and effective parameters per seat | `AgentBound` |
| Session seed (drawn at creation when left empty) | `SessionCreated.config.simulation.seed` |
| Seed of one agent | `AgentBound.seed` = session seed + `:` + seat |
| Pause range | `SessionCreated.config.simulation` |

Each agent's random choices come from its own seeded stream (`ctx.random`); the pauses use a separate stream, so the pace never changes the choices. With both pauses set to **0** the agents take turns in a fixed seat order, and a run with the same seed, settings and policy versions **repeats exactly** (a test checks this). With real-time pauses the choices are still seeded, but which agent acts first can depend on timer precision. After a server restart the agents continue with fresh streams and empty memory.

### Writing a policy

```ts
export const cautiousPolicy = definePolicy({
  id: "cautious",
  version: "1",
  name: "Cautious",
  description: "What it does, in one or two sentences.",
  params: z.object({ threshold: z.number().min(0).max(1).default(0.3).describe("…") }),
  act(view, ctx) {
    if (!canAct(view)) return null;            // round running, not paused, not withdrawn
    // view.scores: this seat's own knowledge type · view.highlights: what is on the map
    // view.me.actsOn[kind]: the K of the sub-square an action lands on (Pa → Ka …)
    // ctx.params, ctx.random(), ctx.memory, kindsWithQuota(view), pick(list, ctx.random)
    return null;                               // or { kind: "propose", regionId: "C7-Kb" }
  },
});
```

See [§ 12 Add an agent policy](#add-an-agent-policy-simulated-players) for where to register it. The table below is generated from the registered built-in policies.

<!-- BEGIN GENERATED: simulation-policies -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| Policy | Version | Name | What it does |
| --- | --- | --- | --- |
| `random` | 2 | Random | Baseline. On each turn it proposes or decides on a uniformly random square (the sub-square the game rules give it) while it has quota left. It ignores the scores it sees. |
| `idle` | 1 | Idle | Never acts. Use it for a seat that only watches, or to test time limits and rounds the facilitator ends. |

**`random` parameters** (`simulation.params.random`):

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `proposeBias` | `number 0–1` | `0.5` | Chance of proposing rather than deciding when both are still possible |

**`idle` parameters** (`simulation.params.idle`): none.

<!-- END GENERATED: simulation-policies -->

## 15. Microphone audio

In a session with audio on (setup step 05), each participant's browser records its own microphone from the mic check until the game is complete, and uploads it to the server. The full design is in [AUDIO.md](AUDIO.md); this section shows where it fits.

```mermaid
flowchart LR
  subgraph Browser["Player browser"]
    REC["RecordingController<br/>starts and stops from PlayerView.audio"]
    ENG["MicRecorder<br/>worklet, 16 kHz, 5 s chunks"]
    REC --> ENG
  end
  subgraph Server["Server"]
    HUB["net/hub.ts<br/>audio:start, chunk, stop, level,<br/>calibration:ready"]
    SM["SessionManager<br/>submitAudio*, submitMicLevel,<br/>mic check hold, pause,<br/>sayCalibrationReady, auto start<br/>(CalibrationRunner: calibration)"]
    LIVE["audio/live.ts<br/>gates, dedupe, acks"]
    FS["audio/fileStore.ts<br/>encrypted .wka files"]
    DB[("SQLCipher<br/>tracks, chunks, keys")]
    JOB["audio/jobs.ts<br/>attribution worker"]
    VAD[("models/silero_vad.onnx<br/>SHA-256 checked")]
  end
  ENG -->|"chunks, acked"| HUB
  HUB --> SM
  SM <--> LIVE
  LIVE --> FS
  LIVE --> DB
  FS --> JOB
  VAD -.->|"onnxruntime-node"| JOB
  JOB --> DB
  SM -->|"AudioTrackStarted, RecordingPaused, Calibration…"| LOG[("Event log")]
```

| Topic | How it works |
| --- | --- |
| State | `GameState.audio` holds whether audio is on, whether calibration is required, whether recording is paused, every pause so far and when the game was complete (no audio captured in them is stored), how many calibrations were started, and the calibration (status, order, turns, quality; `ready`: the seats that said they are ready for the next run; `requested`: a run was asked for again). `recordingVerdict(state, seat)` is the single rule for when a seat's mic may be open, and names the reason when it may not. It is pure and shared, so the browser, the server and the facilitator views agree on both. |
| Events | Audio adds events to the same log: `MicCheckCompleted`, `MicCheckSkipped`, `AudioTrackStarted`, `AudioTrackStopped`, `Calibration*` (`CalibrationReady` from a player, `CalibrationRequested` on a redo, `CalibrationStarted` with actor `system` when the server starts it), `RecordingPaused`, `RecordingResumed` (generated list: [DATA-TYPES.md](DATA-TYPES.md)). **The audio itself is never an event.** It goes to the encrypted store, so the event log stays free of voice and its replay stays small. |
| Projection | A player's `PlayerView.audio` says whether to record and, if not, why (`notRecording`), whether the mic check is held, whether recording is paused, whether the player may say they are ready for the calibration (`canSayReady`) and whom it waits for (`waitingFor`) and, during calibration, only that player's own sentence and only in their turn. |
| Timers | The calibration starts when the room is ready: at the end of each command `SessionManager` checks `calibrationReadyToStart` and calls `CalibrationRunner.start("system")`. The turns run on **server** timers (`session/CalibrationRunner.ts`) and are logged, so they survive a slow browser and can be analysed afterwards. A redo (`CalibrationRequested`) or a restart ends a running calibration (a restart logs `CalibrationSkipped`, `cancelled: true`); everyone then says again that they are ready. |
| Processing | Attribution is a job in a `worker_thread`, started from the DATABASE tab after the session. It reads the encrypted tracks, detects speech per mic with the Silero VAD model and decides per 10 ms which seats speak by comparing the mics' levels (a gate, [AUDIO.md § 10](AUDIO.md#10-speaker-attribution)), writes derived results and cleaned tracks, and never touches the raw audio. The model (`apps/server/models/silero_vad.onnx`, MIT licence) ships in the repository and is checked against its SHA-256 before use; `onnxruntime-node` is loaded only inside the worker, never by the game server. If the model cannot be loaded, or `WKWA_SPEECH_MODEL=off`, speech is detected by energy and the quality report says so. |
| Session guard | `session/sessionGuard.ts` decides, for session deletion, participant erasure, audio deletion, starting an attribution and exporting audio, whether the session's stored data may change now. Every operation checks first whether the session is still running (attached and not yet game complete, closed or aborted), then whether an attribution of it is queued or running or an audio export of it is being written, and is refused over REST (409) if so, so no job reads files that are being deleted. The guard also releases the session before a deletion and reloads it after an erasure (if the reload fails, the session is detached and the erasure is still reported as done). |
| Who never records | Simulated sessions (audio is forced off), fake players and agents. A seat without the audio consent item is never recorded either, and `skipped` consent never counts as audio consent. |
| Recovery | Tracks still open after a restart are closed with `interrupted`. Browsers resend unacknowledged chunks for up to 35 minutes after a track closed. |
