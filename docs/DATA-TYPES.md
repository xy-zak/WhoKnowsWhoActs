# Data types: everything the server logs

*Change log: [DATA-TYPES-CHANGELOG.md](changelog/DATA-TYPES-CHANGELOG.md)*

This is the field-level catalogue of every record the harness stores. It answers **"what exactly is being recorded, when, and about whom?"** Use it when writing the ethics application, the analysis scripts or the methods chapter.

Most tables below are **generated from the schemas** in `packages/shared` (`npm run docs:generate`). The same definitions validate the data at runtime and produce the `codebook.md` inside every export, so this document cannot silently drift from what is actually logged. A test fails if it is out of date.

Related documents: [DATA-MANAGEMENT.md](DATA-MANAGEMENT.md) (why the data is collected and how it is protected), [ARCHITECTURE.md](ARCHITECTURE.md), [NETWORKING.md](NETWORKING.md).

## Contents

1. [How to read this document](#how-to-read-this-document)
2. [Overview of record kinds](#overview-of-record-kinds)
3. [Storage model](#storage-model)
4. [Game events](#game-events)
5. [Telemetry types](#telemetry-types)
6. [One action, all its traces](#one-action-all-its-traces)
7. [Session configuration](#session-configuration)
8. [Label pairings](#label-pairings)
9. [Audio storage](#audio-storage)
10. [Other tables](#other-tables)
11. [Export files](#export-files)

---

## How to read this document

- **Envelope vs payload.** Every stored record has fixed *envelope* columns (who, when, which session) plus a type-specific *payload*, stored as JSON.
- **Data class.** Each type is marked as *non-personal*, *pseudonymous* (linked to a participant code, and therefore personal data under GDPR) or *pseudonymous · sensitive* (consent and demographics). See [DATA-MANAGEMENT.md § 13](DATA-MANAGEMENT.md#13-personal-data-classes-per-record-type).
- **Participant codes appear only in `participant_code` columns** (of `events` and `telemetry`, and of the audio tables `audio_tracks` and `audio_derivatives`), and **never inside a payload, an audio file name or an audio file**. Inside a session, players are referred to by seat number. This is what makes erasure complete.
- **Time.** `server_ts` is epoch milliseconds with sub-millisecond precision (authoritative order). `client_ts` is the player PC's time, corrected to the server clock. See [ARCHITECTURE.md § 10](ARCHITECTURE.md#10-timing-model).
- **No telemetry before consent.** Telemetry rows exist only for seats whose consent status is `given` (or `skipped`, if the consent step is disabled). The server drops earlier batches. Before consent, a seat has only operational events (`SeatBound`, `PlayerConnected` / `PlayerDisconnected`); a participant who declines additionally has `ConsentRecorded` with `consented: false`.
- **Not logged anywhere:** names, e-mail addresses, IP addresses, user agents/device data, pointer coordinates, keystrokes, free text typed by players, **microphone names, device ids or group ids** (only the processing flags and sample rate of a microphone are kept), voiceprints.

## Overview of record kinds

| Record kind | Stored in | Triggered by | Typical volume per session | Data class |
| --- | --- | --- | --- | --- |
| Game events: actions (`ProposalMade`, `DecisionMade`, `IntentRejected`) | `events` | Player confirms a propose or decide | ≈ 120 (4 players × 10 × 3 rounds) + rejections | pseudonymous |
| Game events: session flow (`SessionCreated`, `RoundStarted`, `RoundCompleted`, `GameCompleted`, …) | `events` | Facilitator or system | ≈ 10–20 | non-personal |
| Seat and label records (`SeatBound`, `SeatUnbound`, `LabelsAssigned`) | `events` | Facilitator in the lobby | ≈ 5–10 | pseudonymous |
| Consent records (`ConsentRecorded`) | `events` | Player submits the consent screen | 4 | pseudonymous · sensitive |
| Demographics records (`DemographicsSubmitted`) | `events` (payload redacted in `events.csv` and the live log) | Player submits the questionnaire | 4 | pseudonymous · sensitive |
| Briefing acknowledgements | `events` | Player confirms the briefing | 4 | pseudonymous |
| Connection events (`PlayerConnected`, `PlayerDisconnected`) | `events` | Browser connects/disconnects | ≈ 4 + reconnects | pseudonymous |
| Facilitator / audit events (`SessionNote`, `FacilitatorBroadcast`, `ActionRevoked`, `GamePaused`, `GameResumed`, `ParticipantWithdrawn`, `SessionClosed`, `SessionAborted`) | `events` | Facilitator (or system on disconnect/erasure) | 0–20 | mostly non-personal |
| UI telemetry (hover, inspect, pan/zoom, tool, confirm, focus, visibility, idle, screen) | `telemetry` | Player's interface use, **after consent only** | hundreds to a few thousand | pseudonymous |
| Delivery acks and clock sync (`state_received`, `clock_sync`) | `telemetry` | Every state push / every 60 s | hundreds | pseudonymous / non-personal |
| Microphone audio (sessions that record it): raw 16 kHz mono PCM, 5 s chunks | Encrypted `.wka` files in `data/audio/<sessionId>/`; track and chunk rows in `audio_tracks`, `audio_chunks` | Player's browser while the seat should record | about 115 MB per seat per hour | **voice** (identifying) |
| Audio events (`MicCheckCompleted`, `MicCheckSkipped`, `AudioTrackStarted`, `AudioTrackStopped`, `Calibration*`) | `events` | Mic check, track start and stop, calibration | a few per seat and track | pseudonymous (some non-personal) |
| Recording pauses (`RecordingPaused`, `RecordingResumed`) | `events` | Facilitator | 0–5 | non-personal |
| Audio results: speech segments, talk time, quality report, leakage matrix, cleaned tracks | `audio_derivatives` (cleaned tracks also as encrypted files), `audio_jobs` | Speaker attribution run from DATABASE | one `speech_segments` and one `clean` row per recorded seat, plus 3 session-wide rows | pseudonymous (timing); cleaned tracks are **voice** |
| Audio deletion register entry | `audio_deletions` | Delete raw or all audio | 0–n | pseudonymous (via the session) |
| Session row | `sessions` | Session created/updated | 1 | non-personal |
| Erasure register entry | `erasures` | Erasure executed | 0–n (whole DB) | pseudonymous (hash of code) |
| Export register entry + `manifest.json` (audio exports too) | `exports` + export folder | Export written | 1 per export | pseudonymous (hashes of codes) |
| Database metadata | `meta` | DB creation | constant | non-personal |

## Storage model

All tables live in one SQLCipher-encrypted SQLite file per kind of session: **`data/wkwa.db`** for sessions with participants and **`data/wkwa-sim.db`** for simulated sessions (agents instead of people; see [ARCHITECTURE.md § 14](ARCHITECTURE.md#14-simulated-players)). Both files have exactly the schema below and the same passphrase. In the simulation database, `participant_code` is always empty, the `telemetry` and `erasures` tables stay empty, and session ids start with `SIM-`.

```mermaid
erDiagram
  sessions ||--o{ events : "has log"
  sessions ||--o{ telemetry : "has telemetry"
  sessions ||--o{ exports : "exported as"
  sessions ||--o{ audio_tracks : "records (audio sessions)"
  audio_tracks ||--o{ audio_chunks : "one row per 5 s chunk"
  sessions ||--o{ audio_derivatives : "attribution results"
  sessions ||--o{ audio_jobs : "processing runs"
  sessions ||--o{ audio_deletions : "audio deletion register"
  erasures }o..o{ sessions : "lists affected (JSON)"
  meta {
    TEXT key PK "schema_version, server_secret, created_wall"
    TEXT value
  }
  sessions {
    TEXT id PK "S-YYYYMMDD-XXXX or SIM-YYYYMMDD-XXXX"
    TEXT created_wall
    TEXT scenario_id
    TEXT scenario_version
    TEXT scenario_hash
    TEXT status "current phase"
    TEXT condition "pre-v3; copy of tags"
    TEXT tags_json "session tags (v3)"
    TEXT notes
    TEXT config_json
    TEXT harness_version
    TEXT git_commit
    TEXT updated_wall
    INTEGER last_seq "high-water mark of seq"
  }
  events {
    TEXT session_id PK, FK
    INTEGER seq PK
    TEXT type "indexed (schema v5)"
    TEXT actor_kind
    INTEGER seat
    TEXT participant_code "indexed, the only place codes are stored"
    INTEGER round
    REAL server_ts
    TEXT server_wall
    REAL client_ts
    INTEGER client_seq
    TEXT payload_json
  }
  telemetry {
    INTEGER id PK
    TEXT session_id FK
    INTEGER seat
    TEXT participant_code "indexed"
    INTEGER round
    TEXT type
    REAL client_ts
    REAL client_offset_ms
    REAL server_ts
    TEXT server_wall
    TEXT payload_json
  }
  erasures {
    INTEGER id PK
    TEXT code_sha256
    TEXT requested_wall
    TEXT executed_wall
    TEXT sessions_json
    TEXT rows_json
    TEXT note
  }
  exports {
    TEXT id PK
    TEXT session_id FK
    TEXT kind "standard, anonymised or audio"
    TEXT created_wall
    TEXT path
    TEXT code_hashes_json
    TEXT files_json
    TEXT details_json "schema v7: who asked, note, seats (audio exports)"
  }
  audio_tracks {
    TEXT track_id PK
    TEXT session_id FK
    INTEGER seat
    TEXT participant_code "indexed"
    TEXT file_name "random hex, never the code"
    BLOB file_key "AES-256 key, NULL after raw deletion"
    INTEGER sample_rate
    TEXT settings_json "processing flags only"
    TEXT reason "why it started"
    REAL started_server_ts
    REAL started_client_ts
    REAL clock_offset_ms
    REAL closed_server_ts
    TEXT stop_reason
    INTEGER samples
    INTEGER chunks
    INTEGER dropped_chunks
    INTEGER bytes
    TEXT status "recording, closed or deleted"
  }
  audio_chunks {
    TEXT track_id PK, FK
    INTEGER seq PK
    INTEGER start_sample
    INTEGER sample_count
    REAL client_ts
    REAL clock_offset_ms
    REAL server_ts
    TEXT server_wall
    INTEGER round
    TEXT phase
    REAL rms_db
    REAL peak_db
    INTEGER clipped
  }
  audio_derivatives {
    TEXT derivative_id PK
    TEXT session_id FK
    INTEGER seat "NULL for session-wide results"
    TEXT participant_code
    TEXT kind "speech_segments, talk_time, quality_report, leakage_matrix, clean"
    TEXT source_tracks_json
    TEXT file_name
    BLOB file_key
    TEXT data_json
    TEXT params_json
    TEXT engine_version
  }
  audio_jobs {
    TEXT job_id PK
    TEXT session_id FK
    TEXT kind "attribution"
    TEXT status "queued, running, done, failed"
    REAL progress
    TEXT params_json
    TEXT result_json
    TEXT error
  }
  audio_deletions {
    INTEGER id PK
    TEXT session_id
    TEXT scope "raw or all"
    TEXT requested_wall
    TEXT executed_wall
    TEXT counts_json
    TEXT note
  }
```

The five audio tables exist in the participant database only (a simulated session never records) and are described under [Audio storage](#audio-storage). Consent and demographics are not separate tables. They are **events** (`ConsentRecorded`, `DemographicsSubmitted`), so they share the envelope, the ordering and the erasure path of all other data.

## Game events

The `events` table is the authoritative, append-only log of a session. Game state is derived from it (see [ARCHITECTURE.md § 5](ARCHITECTURE.md#5-event-sourcing-from-click-to-data)).

### Event envelope

Columns shared by every event row:

<!-- BEGIN GENERATED: event-envelope -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| SQLite column | JSON field | Type | Description |
| --- | --- | --- | --- |
| `session_id` | `sessionId` | `string` | Session id, e.g. S-20261116-7KQ2 |
| `seq` | `seq` | `integer ≥ 1` | Position in the session's event log (1, 2, 3, …; gaps only after erasure) |
| `type` | `type` | `"SessionCreated" \| "SessionNote" \| "SeatBound" \| "SeatUnbound" \| "AgentBound" \| "LabelsAssigned" \| "OnboardingStarted" \| "ConsentRecorded" \| "MicCheckCompleted" \| "MicCheckSkipped" \| "DemographicsSubmitted" \| "BriefingAcknowledged" \| "PlayerConnected" \| "PlayerDisconnected" \| "AudioTrackStarted" \| "AudioTrackStopped" \| "CalibrationRequested" \| "CalibrationReady" \| "CalibrationStarted" \| "CalibrationTurn" \| "CalibrationCompleted" \| "CalibrationChecked" \| "CalibrationSkipped" \| "RoundStarted" \| "ProposalMade" \| "DecisionMade" \| "IntentRejected" \| "ActionRevoked" \| "RoundCompleted" \| "GamePaused" \| "GameResumed" \| "RecordingPaused" \| "RecordingResumed" \| "FacilitatorBroadcast" \| "ParticipantWithdrawn" \| "GameCompleted" \| "SessionClosed" \| "SessionAborted"` | Event type |
| `actor_kind` | `actorKind` | `"player" \| "facilitator" \| "system"` | Who caused the event |
| `seat` | `seat` | `integer 1–4 \| null` | Seat the event is about/caused by (null for session-level events) |
| `participant_code` | `participantCode` | `string \| null` | Pseudonymous participant code of that seat — the ONLY place codes are stored |
| `round` | `round` | `integer ≥ 0` | Current round when the event happened (0 = before round 1) |
| `server_ts` | `serverTs` | `number` | Server timestamp, Unix epoch milliseconds with sub-ms precision (monotonic within a server run) |
| `server_wall` | `serverWall` | `string` | Server wall-clock time, ISO-8601 UTC (human-readable copy of serverTs) |
| `client_ts` | `clientTs` | `number \| null` | Client timestamp corrected to server time (epoch ms) for player-initiated events, else null |
| `client_seq` | `clientSeq` | `integer \| null` | Client-side sequence number of the intent (idempotency on reconnect), else null |
| `payload_json` | `payload` | `object` | Type-specific payload (see the event sections below) |

<!-- END GENERATED: event-envelope -->

### Event index

<!-- BEGIN GENERATED: event-index -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| Type | Summary | Caused by | Changes state | Data class | Typical frequency |
| --- | --- | --- | --- | --- | --- |
| [`SessionCreated`](#sessioncreated) | A new session was created with a scenario and configuration. | facilitator | yes | non-personal | 1 per session |
| [`SessionNote`](#sessionnote) | Facilitator annotation (e.g. 'fire alarm', 'participant asked a question'), or a system note in a simulated session (e.g. an agent that stopped after errors). | facilitator, system | no | non-personal | 0–n per session |
| [`SeatBound`](#seatbound) | A client (player browser) was assigned to a seat and a participant code was generated. For a fake player (a test client the server created) no code is generated. | facilitator | yes | pseudonymous | 1 per seat (more if re-bound) |
| [`SeatUnbound`](#seatunbound) | A seat binding was removed before the game started. | facilitator | yes | pseudonymous | rare |
| [`AgentBound`](#agentbound) | A simulated player (agent) took a seat. Simulated sessions only: the seat gets no participant code and no client. | system | yes | non-personal | 1 per seat (simulated sessions only) |
| [`LabelsAssigned`](#labelsassigned) | Knowledge-type, power-type and map view were (re)assigned to seats, with the K–P pairing used. | facilitator | yes | pseudonymous | 1–n per session |
| [`OnboardingStarted`](#onboardingstarted) | Seats are locked; players move to the consent / demographics / briefing / mic check screens. | facilitator | yes | non-personal | 1 per session |
| [`ConsentRecorded`](#consentrecorded) | Participant answered the in-game consent form. | player | yes | pseudonymous · sensitive | 1 per seat |
| [`MicCheckCompleted`](#miccheckcompleted) | A player finished their own mic check (sessions that record audio): how loud the room and their voice were, and whether it passed. | player | yes | pseudonymous | 1 per seat (audio sessions only; more if failed checks are logged) |
| [`MicCheckSkipped`](#miccheckskipped) | The facilitator skipped a seat's mic check: the player continues onboarding, but the seat is NOT recorded. | facilitator | yes | pseudonymous | rare (audio sessions only) |
| [`DemographicsSubmitted`](#demographicssubmitted) | Participant submitted the demographics questionnaire. | player | yes | pseudonymous · sensitive | 1 per seat |
| [`BriefingAcknowledged`](#briefingacknowledged) | Participant confirmed they read the briefing / instructions. | player | yes | pseudonymous | 1 per seat |
| [`PlayerConnected`](#playerconnected) | A bound player's browser (re)connected. | system | yes | pseudonymous | 1 + number of reconnects per seat |
| [`PlayerDisconnected`](#playerdisconnected) | A bound player's browser disconnected. | system | yes | pseudonymous | 0–n per seat |
| [`AudioTrackStarted`](#audiotrackstarted) | A seat's browser started a new audio track: one continuous capture run of its microphone, uploaded in 5 s chunks of 16 kHz mono audio. | player | no | pseudonymous | 1 per seat, plus 1 per reconnect, reload and recording pause (audio sessions only) |
| [`AudioTrackStopped`](#audiotrackstopped) | A seat's audio track ended. The audio itself is stored separately, encrypted (never in the event log). | player, system | no | pseudonymous | 1 per AudioTrackStarted |
| [`CalibrationRequested`](#calibrationrequested) | The facilitator asked for the calibration to be run again: every recorded seat is asked again to say it is ready, and the turns start once all are. | facilitator | yes | non-personal | 0–1 per redo (audio sessions only) |
| [`CalibrationReady`](#calibrationready) | A player said they are ready for the calibration (part 2 of 'Mic check & calibration', after their mic check), so the turns never start by surprise. | player | yes | pseudonymous | 1 per recorded seat per calibration run (audio sessions only) |
| [`CalibrationStarted`](#calibrationstarted) | The calibration started: each seat in turn reads a sentence aloud while the others stay quiet, which measures how much each voice leaks into the other microphones. | system, facilitator | yes | non-personal | 0–1 per session, plus 1 per redo (audio sessions only) |
| [`CalibrationTurn`](#calibrationturn) | A seat's calibration turn began (the event's serverTs is the start of the turn): that seat reads its sentence aloud, the others stay quiet. | system | yes | pseudonymous | 1 per seat per calibration |
| [`CalibrationCompleted`](#calibrationcompleted) | Every calibration turn has run; the turn windows are used to measure the leakage between microphones. | system | yes | non-personal | 0–1 per calibration |
| [`CalibrationChecked`](#calibrationchecked) | Quick quality check of the calibration: per seat, how much louder its own voice was on its own microphone than on the loudest other one. | system | yes | pseudonymous | 1 per CalibrationCompleted |
| [`CalibrationSkipped`](#calibrationskipped) | The facilitator skipped (or cancelled) the calibration; speaker attribution then assumes a conservative default leakage between microphones. Logged by the server with `cancelled: true` when it had to stop a running calibration itself (recording paused, server restart): the calibration is then back to not done and has to be run (or skipped) again. | facilitator, system | yes | non-personal | 0–1 per session (audio sessions only), plus 1 per cancelled run |
| [`RoundStarted`](#roundstarted) | A round began; players may now propose/decide. | facilitator, system | yes | non-personal | roundCount per session (default 3) |
| [`ProposalMade`](#proposalmade) | A player proposed a sub-square of the map (hatched in its knowledge-type colour for all players). | player | yes | pseudonymous | ≤ quota.propose × seats × rounds (default 60) |
| [`DecisionMade`](#decisionmade) | A player decided on a sub-square of the map (filled in its knowledge-type colour for all players); the game rules change the scores. | player | yes | pseudonymous | ≤ quota.decide × seats × rounds (default 60) |
| [`IntentRejected`](#intentrejected) | A player's propose/decide attempt was refused by the rules. | player | no | pseudonymous | rare |
| [`ActionRevoked`](#actionrevoked) | Facilitator undid a proposal/decision (e.g. misclick). The original event is kept. | facilitator | yes | pseudonymous | rare |
| [`RoundCompleted`](#roundcompleted) | A round ended. | system, facilitator | yes | non-personal | roundCount per session |
| [`GamePaused`](#gamepaused) | The game was paused; actions are refused until resumed. | facilitator, system | yes | non-personal | 0–n |
| [`GameResumed`](#gameresumed) | The game was resumed after a pause. | facilitator | yes | non-personal | 0–n |
| [`RecordingPaused`](#recordingpaused) | The facilitator paused audio recording for every seat (players cannot mute themselves). The game itself goes on. | facilitator | yes | non-personal | 0–n (audio sessions only) |
| [`RecordingResumed`](#recordingresumed) | The facilitator resumed audio recording; every recorded seat starts a new track. | facilitator | yes | non-personal | 1 per RecordingPaused |
| [`FacilitatorBroadcast`](#facilitatorbroadcast) | Facilitator sent a message shown on every player's screen. | facilitator | yes | non-personal | 0–n |
| [`ParticipantWithdrawn`](#participantwithdrawn) | A participant withdrew (during the session) or their data was erased afterwards. | facilitator, system | yes | non-personal | rare |
| [`GameCompleted`](#gamecompleted) | The last round finished (or the facilitator ended the game early). | system, facilitator | yes | non-personal | 1 per session |
| [`SessionClosed`](#sessionclosed) | Session archived; no further events except erasure markers. | facilitator | yes | non-personal | 1 per session |
| [`SessionAborted`](#sessionaborted) | Session abandoned before completion (data kept, marked as aborted). | facilitator | yes | non-personal | rare |

<!-- END GENERATED: event-index -->

<!-- BEGIN GENERATED: event-sections -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

### `SessionCreated`

A new session was created with a scenario and configuration.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Create session' on the setup screen. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator |
| **Data class** | non-personal |
| **Typical frequency** | 1 per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `config` | `SessionConfig` | Full effective session configuration |
| `scenario` | `object` | Scenario used in this session |
| `scenario.id` | `string` | Scenario id |
| `scenario.title` | `string` | Scenario title |
| `scenario.version` | `string` | Scenario version |
| `scenario.hash` | `string` | SHA-256 of the loaded scenario (board, views and starting scores) |
| `regionIds` | `array<string>` | Every region id of the map: one per sub-square, e.g. 'C7-Kb' (square C7, knowledge type Kb) |
| `viewIds` | `array<string>` | All view ids available in the scenario (one per knowledge type) |
| `board` | `object` | Size of the grid map in squares (absent in sessions recorded before the grid map) |
| `board.cols` | `integer 1–26` | Number of columns (lettered A, B, C, …) |
| `board.rows` | `integer 1–26` | Number of rows (numbered 1, 2, 3, …) |
| `initialScores` | `map<string, number>` | Starting score of every sub-square, by region id (from the scenario) |
| `rules` | `object` | Game rules this session is played with (docs/GAME-RULES.md) |
| `rules.id` | `string` | Id of the game rules (game/rules.ts) |
| `rules.version` | `string` | Version of those rules' code (bumped whenever their behaviour changes) |
| `harness` | `object` | Software version, for reproducibility |
| `harness.version` | `string` | Harness package version |
| `harness.gitCommit` | `string` | Git commit of the harness code ('unknown' if not a git checkout) |
| `notes` | `string` | Researcher notes entered at creation (no personal data) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SessionCreated",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "config": {
      "players": "real",
      "simulation": {
        "policy": "random",
        "seatPolicies": {},
        "params": {},
        "seed": null,
        "minDelayMs": 800,
        "maxDelayMs": 2500
      },
      "rules": "standard",
      "seatCount": 4,
      "roundCount": 3,
      "defaultRound": {
        "rule": "quota",
        "quota": {
          "propose": 5,
          "decide": 5
        },
        "timeLimitSec": null
      },
      "roundOverrides": {},
      "roundAdvance": "facilitator",
      "autoAdvanceDelaySec": 10,
      "viewAssignment": "byKnowledgeType",
      "clearHighlightsEachRound": true,
      "pauseOnDisconnect": true,
      "onboarding": {
        "consent": true,
        "demographics": true,
        "briefing": true
      },
      "audio": {
        "enabled": false,
        "requireCalibration": true
      },
      "visibility": {
        "showActorToPlayers": true,
        "showOwnLabels": true,
        "showOtherLabelsToPlayers": false,
        "showOthersProgress": true
      },
      "tags": []
    },
    "scenario": {
      "id": "demo",
      "title": "Demo grid",
      "version": "2",
      "hash": "9f2c…"
    },
    "regionIds": [
      "A1-Ka",
      "A1-Kb",
      "A1-Kc",
      "A1-Kd",
      "B1-Ka"
    ],
    "viewIds": [
      "Ka",
      "Kb",
      "Kc",
      "Kd"
    ],
    "board": {
      "cols": 10,
      "rows": 10
    },
    "initialScores": {
      "A1-Ka": 6,
      "A1-Kb": 3,
      "A1-Kc": 8,
      "A1-Kd": 5,
      "B1-Ka": 7
    },
    "rules": {
      "id": "standard",
      "version": "1"
    },
    "harness": {
      "version": "0.1.0",
      "gitCommit": "3e1a9c2"
    },
    "notes": "Pilot session"
  }
}
```

</details>

### `SessionNote`

Facilitator annotation (e.g. 'fire alarm', 'participant asked a question'), or a system note in a simulated session (e.g. an agent that stopped after errors).

|  |  |
| --- | --- |
| **Trigger** | Facilitator adds a note on the dashboard; the simulation runner when an agent policy fails. |
| **Caused by** | facilitator, system |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | non-personal |
| **Typical frequency** | 0–n per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string (≤ 500 chars)` | Note text — must not contain names or other identifying information |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SessionNote",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "text": "Seat 3 asked how to zoom; explained."
  }
}
```

</details>

### `SeatBound`

A client (player browser) was assigned to a seat and a participant code was generated. For a fake player (a test client the server created) no code is generated.

|  |  |
| --- | --- |
| **Trigger** | Facilitator binds a connected client to a seat in the lobby (setup step 08), or adds a fake player to a seat there. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator; the bound player sees their seat |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per seat (more if re-bound) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `terminal` | `integer ≥ 1` | Client number displayed on the player's screen (field kept as `terminal` for compatibility) |
| `bindingId` | `string` | Random id of this binding (used to derive the reconnect token) |
| `fake` | `boolean` | True if the client is a fake player: a test client the server created itself (no participant, no code, no onboarding). Absent in sessions recorded before fake players existed (= false) |
| `fakePace` | `"normal" \| "fast"` | Fake players only: pause between their actions ('normal' 1–4 s, 'fast' 0.1–0.3 s) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SeatBound",
  "actorKind": "facilitator",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 2,
    "terminal": 3,
    "bindingId": "b-7KQ2M9",
    "fake": false
  }
}
```

</details>

### `SeatUnbound`

A seat binding was removed before the game started.

|  |  |
| --- | --- |
| **Trigger** | Facilitator unbinds a seat (wrong PC, participant left before onboarding). |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | rare |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `reason` | `string (≤ 200 chars)` | Short reason |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SeatUnbound",
  "actorKind": "facilitator",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 2,
    "reason": "bound wrong client"
  }
}
```

</details>

### `AgentBound`

A simulated player (agent) took a seat. Simulated sessions only: the seat gets no participant code and no client.

|  |  |
| --- | --- |
| **Trigger** | Server, right after SessionCreated, once per seat of a simulated session. |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Facilitator |
| **Data class** | non-personal |
| **Typical frequency** | 1 per seat (simulated sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `policy` | `string` | Id of the agent policy that plays this seat |
| `policyVersion` | `string` | Version of that policy's code (bumped whenever its behaviour changes) |
| `params` | `object` | Effective policy parameters for this seat, defaults filled in |
| `seed` | `string` | Seed of this agent's random number generator (session seed + seat number) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "AgentBound",
  "actorKind": "system",
  "seat": 1,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 1,
    "policy": "random",
    "policyVersion": "1",
    "params": {
      "proposeBias": 0.5
    },
    "seed": "7KQ2M9AB:1"
  }
}
```

</details>

### `LabelsAssigned`

Knowledge-type, power-type and map view were (re)assigned to seats, with the K–P pairing used.

|  |  |
| --- | --- |
| **Trigger** | Facilitator chooses the K–P pairing (each seat keeps its K; seat n holds the n-th K by default), in setup step 09 or between rounds; the bots and tests may also shuffle K across seats. P always follows from the pairing. Not allowed during an active round. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator; each player sees own labels (configurable) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1–n per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `assignments` | `array<object>` | Complete assignment for every seat |
| `assignments[].seat` | `integer 1–4` | Seat number (1–4) within the session |
| `assignments[].k` | `"Ka" \| "Kb" \| "Kc" \| "Kd"` | Knowledge-type label (Ka–Kd) |
| `assignments[].p` | `"Pa" \| "Pb" \| "Pc" \| "Pd"` | Power-type label (Pa–Pd) |
| `assignments[].view` | `string` | Id of the map view (dataset) shown to a seat, e.g. 'Ka' |
| `method` | `"manual" \| "random"` | How the assignment was produced |
| `seed` | `string \| null` | Seed of the random part of the assignment (null for manual) |
| `pairing` | `object` | K–P pairing used for this label assignment |
| `pairing.mode` | `"aligned" \| "dissociated"` | aligned (Ka–Pa …) or fully dissociated |
| `pairing.id` | `integer 1–6 \| null` | Number (1–6) of the fully dissociative pairing in the pairing table; null when aligned |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "LabelsAssigned",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "assignments": [
      {
        "seat": 1,
        "k": "Ka",
        "p": "Pd",
        "view": "Ka"
      },
      {
        "seat": 2,
        "k": "Kb",
        "p": "Pc",
        "view": "Kb"
      }
    ],
    "method": "random",
    "seed": "4QX9T2",
    "pairing": {
      "mode": "dissociated",
      "id": 6
    }
  }
}
```

</details>

### `OnboardingStarted`

Seats are locked; players move to the consent / demographics / briefing / mic check screens.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Start onboarding' once all seats are bound and labelled. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 1 per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `steps` | `array<"consent" \| "demographics" \| "briefing" \| "mic_check">` | Onboarding steps enabled for this session, in order ('mic_check' only when the session records audio) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "OnboardingStarted",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "steps": [
      "consent",
      "demographics",
      "briefing"
    ]
  }
}
```

</details>

### `ConsentRecorded`

Participant answered the in-game consent form.

|  |  |
| --- | --- |
| **Trigger** | Player submits the consent screen (agree or decline). |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Facilitator (consent status only) |
| **Data class** | pseudonymous · sensitive |
| **Typical frequency** | 1 per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `formVersion` | `string` | Version of the consent form shown |
| `textSha256` | `string` | SHA-256 of the exact consent text shown |
| `answers` | `map<string, boolean>` | Answer per consent item id |
| `consented` | `boolean` | True if all required items were accepted |
| `durationMs` | `number ≥ 0` | Time the consent screen was open (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "ConsentRecorded",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "formVersion": "2026-11-v1",
    "textSha256": "a3f1…",
    "answers": {
      "participate": true,
      "data_use": true,
      "future_research": false
    },
    "consented": true,
    "durationMs": 84213
  }
}
```

</details>

### `MicCheckCompleted`

A player finished their own mic check (sessions that record audio): how loud the room and their voice were, and whether it passed.

|  |  |
| --- | --- |
| **Trigger** | The player's browser ends the mic check (the last onboarding step, part 1 of 'Mic check & calibration'; it opens once every seat has finished the briefing). Passed: it heard enough speech above the background noise, and the step is done. Not passed: the step stays open (the player tries again, or the facilitator skips the check). Recording starts with the mic check. |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Facilitator (mic check status and levels) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per seat (audio sessions only; more if failed checks are logged) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `passed` | `boolean` | True if enough speech was heard above the background noise; the mic check step is then done |
| `attempts` | `integer 1–100` | Attempts the player made, including the last one |
| `durationMs` | `number ≥ 0` | Time the mic check screen was open (milliseconds) |
| `settings` | `object` | Microphone processing settings reported by the browser (getSettings()); never the device name or id |
| `settings.sampleRate` | `integer 8000–384000` | Native sample rate of the capture, before resampling to 16 000 Hz (Hz): from getSettings(), or the AudioContext's rate where the browser does not report it (e.g. Firefox) |
| `settings.echoCancellation` | `boolean` | Echo cancellation actually applied by the browser (requested off; absent if not reported) |
| `settings.noiseSuppression` | `boolean` | Noise suppression actually applied by the browser (requested off; absent if not reported) |
| `settings.autoGainControl` | `boolean` | Automatic gain control actually applied by the browser (requested off; absent if not reported) |
| `settings.channelCount` | `integer 1–32` | Channels the browser delivered (requested 1; mixed to mono before upload) |
| `noiseFloorDb` | `number -120–0` | Background level measured before the player spoke (dBFS, -120–0; 0 = full scale) |
| `speechDb` | `number -120–0` | Level of the player's speech (dBFS, -120–0; 0 = full scale) |
| `speechMs` | `number ≥ 0` | Speech heard (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "MicCheckCompleted",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "passed": true,
    "attempts": 1,
    "durationMs": 14250,
    "settings": {
      "sampleRate": 48000,
      "echoCancellation": false,
      "noiseSuppression": false,
      "autoGainControl": false,
      "channelCount": 1
    },
    "noiseFloorDb": -58.2,
    "speechDb": -21.7,
    "speechMs": 2840
  }
}
```

</details>

### `MicCheckSkipped`

The facilitator skipped a seat's mic check: the player continues onboarding, but the seat is NOT recorded.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Skip mic check' for a seat (e.g. no working microphone); the seat's recording stops. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator; the player moves on to the next onboarding step |
| **Data class** | pseudonymous |
| **Typical frequency** | rare (audio sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `reason` | `string (≤ 200 chars)` | Facilitator's reason, e.g. 'no working microphone' (free text, no personal data) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "MicCheckSkipped",
  "actorKind": "facilitator",
  "seat": 3,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 3,
    "reason": "no working microphone"
  }
}
```

</details>

### `DemographicsSubmitted`

Participant submitted the demographics questionnaire.

|  |  |
| --- | --- |
| **Trigger** | Player submits the demographics screen. |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Nobody live (facilitator sees 'submitted ✓' only); exported to demographics.csv only |
| **Data class** | pseudonymous · sensitive |
| **Typical frequency** | 1 per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `formVersion` | `string` | Version of the demographics form |
| `answers` | `map<string, string>` | Selected option value per question id |
| `durationMs` | `number ≥ 0` | Time the questionnaire was open (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "DemographicsSubmitted",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "formVersion": "2026-11-v1",
    "answers": {
      "age_bracket": "25_34",
      "field": "design",
      "games_experience": "weekly"
    },
    "durationMs": 41022
  }
}
```

</details>

### `BriefingAcknowledged`

Participant confirmed they read the briefing / instructions.

|  |  |
| --- | --- |
| **Trigger** | Player presses 'I'm ready' on the briefing screen. |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `textSha256` | `string` | SHA-256 of the briefing text shown |
| `durationMs` | `number ≥ 0` | Time the briefing was open (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "BriefingAcknowledged",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "textSha256": "77be…",
    "durationMs": 120400
  }
}
```

</details>

### `PlayerConnected`

A bound player's browser (re)connected.

|  |  |
| --- | --- |
| **Trigger** | Socket connects and authenticates with its seat token. |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Facilitator; other players see connection status |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 + number of reconnects per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `reconnect` | `boolean` | True if this seat had connected before in this session |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "PlayerConnected",
  "actorKind": "system",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 2,
    "reconnect": false
  }
}
```

</details>

### `PlayerDisconnected`

A bound player's browser disconnected.

|  |  |
| --- | --- |
| **Trigger** | Socket disconnects (tab closed, network drop, reload). |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Facilitator; other players see connection status |
| **Data class** | pseudonymous |
| **Typical frequency** | 0–n per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `reason` | `string` | Socket.IO disconnect reason, e.g. 'transport close' |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "PlayerDisconnected",
  "actorKind": "system",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 2,
    "reason": "transport close"
  }
}
```

</details>

### `AudioTrackStarted`

A seat's browser started a new audio track: one continuous capture run of its microphone, uploaded in 5 s chunks of 16 kHz mono audio.

|  |  |
| --- | --- |
| **Trigger** | Recording (re)starts for a seat: at its mic check, after the facilitator resumes recording, after a reconnect or page reload, or when the microphone comes back after a permission or device loss. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (LIVE mic column) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per seat, plus 1 per reconnect, reload and recording pause (audio sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `trackId` | `string (uuid)` | Random id of the audio track (one continuous capture run of one seat) |
| `sampleRate` | `16000` | Sample rate of the uploaded audio (Hz; always 16 000) |
| `settings` | `object` | Microphone processing settings reported by the browser (getSettings()); never the device name or id |
| `settings.sampleRate` | `integer 8000–384000` | Native sample rate of the capture, before resampling to 16 000 Hz (Hz): from getSettings(), or the AudioContext's rate where the browser does not report it (e.g. Firefox) |
| `settings.echoCancellation` | `boolean` | Echo cancellation actually applied by the browser (requested off; absent if not reported) |
| `settings.noiseSuppression` | `boolean` | Noise suppression actually applied by the browser (requested off; absent if not reported) |
| `settings.autoGainControl` | `boolean` | Automatic gain control actually applied by the browser (requested off; absent if not reported) |
| `settings.channelCount` | `integer 1–32` | Channels the browser delivered (requested 1; mixed to mono before upload) |
| `reason` | `"mic_check" \| "resume" \| "reconnect" \| "reload" \| "permission_regained" \| "context_resumed" \| "clock_jump" \| "discontinuity" \| "cleared"` | Why the track started: 'mic_check' = first capture of the seat (its mic check), 'resume' = recording resumed after a facilitator pause, 'reconnect' = the browser reconnected, 'reload' = the page was reloaded, 'permission_regained' = the microphone came back after a permission or device loss, 'context_resumed' = the browser's audio engine ran again after the system suspended it (e.g. sleep, another app took the device), 'clock_jump' = the capture clock jumped, so a new track keeps the sample timeline exact, 'discontinuity' = the browser delivered a gap or overlap in the audio too large to patch, 'cleared' = the browser discarded its unsent audio (e.g. the seat was unbound) and capture continued in a new track |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "AudioTrackStarted",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "trackId": "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
    "sampleRate": 16000,
    "settings": {
      "sampleRate": 48000,
      "echoCancellation": false,
      "noiseSuppression": false,
      "autoGainControl": false,
      "channelCount": 1
    },
    "reason": "mic_check"
  }
}
```

</details>

### `AudioTrackStopped`

A seat's audio track ended. The audio itself is stored separately, encrypted (never in the event log).

|  |  |
| --- | --- |
| **Trigger** | The browser stops capturing (recording paused, game complete, page unload, microphone lost, capture error), or the server closes the track (disconnect, withdrawal, session closed or aborted). |
| **Caused by** | player, system |
| **Changes game state** | no |
| **Visible to** | Facilitator (LIVE mic column) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per AudioTrackStarted |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `trackId` | `string (uuid)` | Random id of the audio track (one continuous capture run of one seat) |
| `reason` | `"paused" \| "game_complete" \| "closed" \| "aborted" \| "withdrawn" \| "disconnect" \| "permission_lost" \| "error" \| "client_stop" \| "skipped" \| "interrupted" \| "context_suspended" \| "context_interrupted" \| "clock_jump" \| "discontinuity" \| "track_ended" \| "cleared"` | Why the track stopped: 'paused' = facilitator paused recording, 'game_complete' = the game ended, 'closed' = the session was closed, 'aborted' = the session was aborted, 'withdrawn' = the participant withdrew, 'disconnect' = the browser disconnected (the server closed the track), 'permission_lost' = the microphone permission or device went away, 'error' = capture failed (also when the browser closed its audio engine), 'client_stop' = the browser stopped the track itself (e.g. page unload), 'skipped' = the facilitator skipped the seat's mic check (the seat is not recorded), 'interrupted' = the server found the track still open when it loaded the session again (e.g. after a restart) or the seat started another track, 'context_suspended' = the system suspended the browser's audio engine, 'context_interrupted' = the system interrupted the browser's audio engine, 'clock_jump' = the capture clock jumped, 'discontinuity' = a gap or overlap in the audio too large to patch, 'track_ended' = the browser ended the microphone track (device unplugged or permission revoked), 'cleared' = the browser discarded its unsent audio (e.g. the seat was unbound) |
| `samples` | `integer ≥ 0` | Samples the server stored for this track (16 000 per second) |
| `chunks` | `integer ≥ 0` | Chunks the server stored for this track |
| `droppedChunks` | `integer ≥ 0` | Chunks the browser had to drop (e.g. its in-memory resend queue overflowed during a long disconnect); their audio is missing |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "AudioTrackStopped",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {
    "trackId": "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
    "reason": "paused",
    "samples": 9600000,
    "chunks": 120,
    "droppedChunks": 0
  }
}
```

</details>

### `CalibrationRequested`

The facilitator asked for the calibration to be run again: every recorded seat is asked again to say it is ready, and the turns start once all are.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Redo calibration' (in the onboarding or between rounds); a running calibration ends with it (its turns so far are not used). |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone (players see the 'ready for the calibration' button again) |
| **Data class** | non-personal |
| **Typical frequency** | 0–1 per redo (audio sessions only) |

**Payload**

_No payload fields._

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationRequested",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {}
}
```

</details>

### `CalibrationReady`

A player said they are ready for the calibration (part 2 of 'Mic check & calibration', after their mic check), so the turns never start by surprise.

|  |  |
| --- | --- |
| **Trigger** | Player clicks 'I'm ready for the calibration'. Once every recorded seat is ready, the server starts the calibration (CalibrationStarted). |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Facilitator (who is ready); players see who they wait for |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per recorded seat per calibration run (audio sessions only) |

**Payload**

_No payload fields._

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationReady",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": null,
  "payload": {}
}
```

</details>

### `CalibrationStarted`

The calibration started: each seat in turn reads a sentence aloud while the others stay quiet, which measures how much each voice leaks into the other microphones.

|  |  |
| --- | --- |
| **Trigger** | The server, as soon as every recorded seat has said it is ready (CalibrationReady) and every seat is past its mic check; or the facilitator's 'Start calibration' then (sessions that record audio). |
| **Caused by** | system, facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone (players see whose turn it is) |
| **Data class** | non-personal |
| **Typical frequency** | 0–1 per session, plus 1 per redo (audio sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `order` | `array<integer 1–4>` | Seats in turn order |
| `sentenceIds` | `array<string (≤ 40 chars)>` | Sentence each turn reads (ids from config/audio.json), parallel to order |
| `turnMs` | `number ≥ 0` | Length of one seat's turn (milliseconds) |
| `gapMs` | `number ≥ 0` | Silence between two turns (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationStarted",
  "actorKind": "system",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "order": [
      1,
      2,
      3,
      4
    ],
    "sentenceIds": [
      "h01-01",
      "h01-02",
      "h01-03",
      "h01-04"
    ],
    "turnMs": 6000,
    "gapMs": 1000
  }
}
```

</details>

### `CalibrationTurn`

A seat's calibration turn began (the event's serverTs is the start of the turn): that seat reads its sentence aloud, the others stay quiet.

|  |  |
| --- | --- |
| **Trigger** | Server timer during the calibration: right after CalibrationStarted, then every turnMs + gapMs. |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Everyone (only the seat whose turn it is sees the sentence) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per seat per calibration |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `index` | `integer ≥ 0` | Position of the turn in the order (0-based) |
| `seat` | `integer 1–4` | Seat whose turn it is |
| `sentenceId` | `string (≤ 40 chars)` | Id of the calibration sentence (config/audio.json) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationTurn",
  "actorKind": "system",
  "seat": 3,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "index": 2,
    "seat": 3,
    "sentenceId": "h01-03"
  }
}
```

</details>

### `CalibrationCompleted`

Every calibration turn has run; the turn windows are used to measure the leakage between microphones.

|  |  |
| --- | --- |
| **Trigger** | Server timer, at the end of the last turn. |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 0–1 per calibration |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `turns` | `array<object>` | Every turn with its window, in order |
| `turns[].seat` | `integer 1–4` | Seat number (1–4) within the session |
| `turns[].sentenceId` | `string (≤ 40 chars)` | Id of the calibration sentence (config/audio.json) |
| `turns[].startTs` | `number` | Start of the turn (server clock, Unix epoch ms) |
| `turns[].endTs` | `number` | End of the turn (server clock, Unix epoch ms) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationCompleted",
  "actorKind": "system",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "turns": [
      {
        "seat": 1,
        "sentenceId": "h01-01",
        "startTs": 1794825979000.4,
        "endTs": 1794825985000.4
      },
      {
        "seat": 2,
        "sentenceId": "h01-02",
        "startTs": 1794825986000.9,
        "endTs": 1794825992000.9
      }
    ]
  }
}
```

</details>

### `CalibrationChecked`

Quick quality check of the calibration: per seat, how much louder its own voice was on its own microphone than on the loudest other one.

|  |  |
| --- | --- |
| **Trigger** | Server, right after CalibrationCompleted, from the audio of the calibration turns. |
| **Caused by** | system |
| **Changes game state** | yes |
| **Visible to** | Facilitator (LIVE: per-seat margins and advice, e.g. 'check the headset is plugged in and worn close to the mouth') |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per CalibrationCompleted |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `perSeat` | `array<object>` | Result per seat |
| `perSeat[].seat` | `integer 1–4` | Seat number (1–4) within the session |
| `perSeat[].ownDb` | `number -120–0 \| null` | Level of the seat's voice on its own mic during its turn (dBFS, -120–0; 0 = full scale) |
| `perSeat[].bestOtherDb` | `number -120–0 \| null` | Loudest level of that voice on another seat's mic (dBFS, -120–0; 0 = full scale) |
| `perSeat[].marginDb` | `number \| null` | ownDb − bestOtherDb (dB); null when the seat's audio is missing |
| `perSeat[].ok` | `boolean` | True if the margin is large enough to tell this seat's speech apart |
| `ok` | `boolean` | True if every seat passed |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationChecked",
  "actorKind": "system",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "perSeat": [
      {
        "seat": 1,
        "ownDb": -22.4,
        "bestOtherDb": -38.9,
        "marginDb": 16.5,
        "ok": true
      },
      {
        "seat": 3,
        "ownDb": -30.1,
        "bestOtherDb": -34.2,
        "marginDb": 4.1,
        "ok": false
      }
    ],
    "ok": false
  }
}
```

</details>

### `CalibrationSkipped`

The facilitator skipped (or cancelled) the calibration; speaker attribution then assumes a conservative default leakage between microphones. Logged by the server with `cancelled: true` when it had to stop a running calibration itself (recording paused, server restart): the calibration is then back to not done and has to be run (or skipped) again.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Skip calibration' and confirms; or the server stops a running calibration (recording paused, restart). |
| **Caused by** | facilitator, system |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 0–1 per session (audio sessions only), plus 1 per cancelled run |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `reason` | `string (≤ 200 chars)` | Facilitator's reason (free text, no personal data) |
| `cancelled` | `boolean` | True when the server stopped a running calibration (recording paused, restart): its status goes back to 'pending', so round 1 still waits for a calibration (absent = a facilitator skip) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "CalibrationSkipped",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "reason": "everyone uses a headset"
  }
}
```

</details>

### `RoundStarted`

A round began; players may now propose/decide.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Start round' (or auto-advance timer fires). |
| **Caused by** | facilitator, system |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | roundCount per session (default 3) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `round` | `integer ≥ 1` | Round number (1-based) |
| `spec` | `object` | Effective round definition |
| `spec.rule` | `"quota" \| "manual"` | Round-completion rule: 'quota' = round ends when every active player has used all quotas; 'manual' = only the facilitator (or the time limit) ends the round |
| `spec.quota` | `object` | Per-player action quotas for the round |
| `spec.quota.propose` | `integer ≥ 0 \| null` | Max proposals per player in this round (null = unlimited) |
| `spec.quota.decide` | `integer ≥ 0 \| null` | Max decisions per player in this round (null = unlimited) |
| `spec.timeLimitSec` | `integer > 0 \| null` | Optional time limit in seconds; the round ends automatically when it elapses |
| `startedBy` | `"facilitator" \| "auto"` | Started by the facilitator, or automatically (roundAdvance = auto) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "RoundStarted",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "round": 1,
    "spec": {
      "rule": "quota",
      "quota": {
        "propose": 5,
        "decide": 5
      },
      "timeLimitSec": null
    },
    "startedBy": "facilitator"
  }
}
```

</details>

### `ProposalMade`

A player proposed a sub-square of the map (hatched in its knowledge-type colour for all players).

|  |  |
| --- | --- |
| **Trigger** | Player picks a square with the propose tool and confirms; the server accepts it. The sub-square is the one the game rules give the player (standard rules: the one matching their power type). |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Everyone (actor seat visible to players if showActorToPlayers) |
| **Data class** | pseudonymous |
| **Typical frequency** | ≤ quota.propose × seats × rounds (default 60) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `regionId` | `string` | Target sub-square, e.g. 'C7-Kb' |
| `quotaUsed` | `integer ≥ 1` | Proposals this seat has made this round, including this one |
| `quotaLimit` | `integer \| null` | Proposal quota this round (null = unlimited) |
| `priorProposals` | `array<integer 1–4>` | Seats that had already proposed this sub-square this round |
| `priorDecisions` | `array<integer 1–4>` | Seats that had already decided this sub-square this round |
| `msSinceRoundStart` | `number ≥ 0` | Active (un-paused) server time since the round started (milliseconds) |
| `scoreChanges` | `array<object>` | Score changes caused by this event, computed by the session's game rules (docs/GAME-RULES.md); only sub-squares whose score changed. Absent in sessions recorded before the grid map |
| `scoreChanges[].regionId` | `string` | Sub-square whose score changed, e.g. 'C7-Ka' |
| `scoreChanges[].from` | `number` | Score before |
| `scoreChanges[].to` | `number` | Score after |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "ProposalMade",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": 7,
  "payload": {
    "regionId": "C7-Kb",
    "quotaUsed": 2,
    "quotaLimit": 5,
    "priorProposals": [
      3
    ],
    "priorDecisions": [],
    "msSinceRoundStart": 51234,
    "scoreChanges": []
  }
}
```

</details>

### `DecisionMade`

A player decided on a sub-square of the map (filled in its knowledge-type colour for all players); the game rules change the scores.

|  |  |
| --- | --- |
| **Trigger** | Player picks a square with the decide tool and confirms; the server accepts it. The sub-square is the one the game rules give the player (standard rules: the one matching their power type). |
| **Caused by** | player |
| **Changes game state** | yes |
| **Visible to** | Everyone (actor seat visible to players if showActorToPlayers) |
| **Data class** | pseudonymous |
| **Typical frequency** | ≤ quota.decide × seats × rounds (default 60) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `regionId` | `string` | Target sub-square, e.g. 'C7-Kb' |
| `quotaUsed` | `integer ≥ 1` | Decisions this seat has made this round, including this one |
| `quotaLimit` | `integer \| null` | Decision quota this round (null = unlimited) |
| `priorProposals` | `array<integer 1–4>` | Seats that had proposed this sub-square this round before this decision |
| `priorDecisions` | `array<integer 1–4>` | Seats that had already decided this sub-square this round |
| `msSinceRoundStart` | `number ≥ 0` | Active (un-paused) server time since the round started (milliseconds) |
| `scoreChanges` | `array<object>` | Score changes caused by this event, computed by the session's game rules (docs/GAME-RULES.md); only sub-squares whose score changed. Absent in sessions recorded before the grid map |
| `scoreChanges[].regionId` | `string` | Sub-square whose score changed, e.g. 'C7-Ka' |
| `scoreChanges[].from` | `number` | Score before |
| `scoreChanges[].to` | `number` | Score after |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "DecisionMade",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": 7,
  "payload": {
    "regionId": "C7-Kb",
    "quotaUsed": 1,
    "quotaLimit": 5,
    "priorProposals": [
      3,
      2
    ],
    "priorDecisions": [],
    "msSinceRoundStart": 73410,
    "scoreChanges": [
      {
        "regionId": "C7-Kb",
        "from": 6,
        "to": 10
      },
      {
        "regionId": "C7-Ka",
        "from": 5,
        "to": 4
      },
      {
        "regionId": "C7-Kc",
        "from": 2,
        "to": 1
      }
    ]
  }
}
```

</details>

### `IntentRejected`

A player's propose/decide attempt was refused by the rules.

|  |  |
| --- | --- |
| **Trigger** | Server validation fails (not active, paused, quota used up, unknown sub-square, a sub-square the game rules do not give this player, …). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator; the acting player gets an error message |
| **Data class** | pseudonymous |
| **Typical frequency** | rare |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"propose" \| "decide"` | Map interaction: 'propose' or 'decide' |
| `regionId` | `string` | Sub-square the player tried to act on |
| `reason` | `"round_not_active" \| "paused" \| "seat_inactive" \| "unknown_region" \| "quota_exhausted" \| "rule"` | Machine-readable rejection reason |
| `detail` | `string` | Human-readable explanation |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "IntentRejected",
  "actorKind": "player",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": 1794825999995.8,
  "clientSeq": 7,
  "payload": {
    "kind": "decide",
    "regionId": "B2-Ka",
    "reason": "quota_exhausted",
    "detail": "No decisions left this round"
  }
}
```

</details>

### `ActionRevoked`

Facilitator undid a proposal/decision (e.g. misclick). The original event is kept.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Revoke' on an action during the active round. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone (the hatch/fill disappears and its score changes are undone) |
| **Data class** | pseudonymous |
| **Typical frequency** | rare |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `targetSeq` | `integer` | seq of the ProposalMade/DecisionMade being revoked |
| `targetType` | `"ProposalMade" \| "DecisionMade"` | Type of the revoked event |
| `targetSeat` | `integer 1–4` | Seat whose action was revoked |
| `regionId` | `string` | Sub-square of the revoked action |
| `reason` | `string (≤ 200 chars)` | Facilitator's reason (free text, no personal data) |
| `scoreChanges` | `array<object>` | Score changes caused by the revocation: the scores replayed without the revoked action, compared with before. Absent in sessions recorded before the grid map |
| `scoreChanges[].regionId` | `string` | Sub-square whose score changed, e.g. 'C7-Ka' |
| `scoreChanges[].from` | `number` | Score before |
| `scoreChanges[].to` | `number` | Score after |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "ActionRevoked",
  "actorKind": "facilitator",
  "seat": 4,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "targetSeq": 57,
    "targetType": "DecisionMade",
    "targetSeat": 4,
    "regionId": "F3-Kd",
    "reason": "misclick",
    "scoreChanges": [
      {
        "regionId": "F3-Kd",
        "from": 9,
        "to": 5
      },
      {
        "regionId": "F3-Ka",
        "from": 2,
        "to": 3
      }
    ]
  }
}
```

</details>

### `RoundCompleted`

A round ended.

|  |  |
| --- | --- |
| **Trigger** | All quotas used (rule 'quota'), time limit elapsed, or facilitator force-ended the round. |
| **Caused by** | system, facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | roundCount per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `round` | `integer ≥ 1` | Round that ended (1-based) |
| `reason` | `"quota_met" \| "time_limit" \| "facilitator"` | Why the round ended: all quotas used, time limit elapsed, or facilitator force-ended it |
| `durationMs` | `number ≥ 0` | Wall-clock server time from RoundStarted to RoundCompleted, pauses included (milliseconds) |
| `pausedMs` | `number ≥ 0` | Total time paused during the round (milliseconds) |
| `actionCounts` | `map<string, { propose: integer, decide: integer }>` | Non-revoked actions per seat in this round |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "RoundCompleted",
  "actorKind": "system",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "round": 1,
    "reason": "quota_met",
    "durationMs": 612000,
    "pausedMs": 0,
    "actionCounts": {
      "1": {
        "propose": 5,
        "decide": 5
      },
      "2": {
        "propose": 5,
        "decide": 5
      }
    }
  }
}
```

</details>

### `GamePaused`

The game was paused; actions are refused until resumed.

|  |  |
| --- | --- |
| **Trigger** | Facilitator presses pause, or a player disconnects during a round (pauseOnDisconnect). |
| **Caused by** | facilitator, system |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `reason` | `"facilitator" \| "disconnect"` | Paused by the facilitator, or automatically because a player disconnected |
| `seat` | `integer 1–4 \| null` | Seat that disconnected (reason = disconnect) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "GamePaused",
  "actorKind": "facilitator",
  "seat": 3,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "reason": "disconnect",
    "seat": 3
  }
}
```

</details>

### `GameResumed`

The game was resumed after a pause.

|  |  |
| --- | --- |
| **Trigger** | Facilitator presses resume. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `pausedMs` | `number ≥ 0` | Length of the pause (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "GameResumed",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "pausedMs": 45000
  }
}
```

</details>

### `RecordingPaused`

The facilitator paused audio recording for every seat (players cannot mute themselves). The game itself goes on.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Pause recording' in TOOLS and confirms; every seat's track stops. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone (players see that recording is paused) |
| **Data class** | non-personal |
| **Typical frequency** | 0–n (audio sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `reason` | `string (≤ 200 chars)` | Facilitator's reason, e.g. 'private conversation' (free text, no personal data) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "RecordingPaused",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "reason": "break"
  }
}
```

</details>

### `RecordingResumed`

The facilitator resumed audio recording; every recorded seat starts a new track.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Resume recording' in TOOLS. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 1 per RecordingPaused |

**Payload**

_No payload fields._

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "RecordingResumed",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {}
}
```

</details>

### `FacilitatorBroadcast`

Facilitator sent a message shown on every player's screen.

|  |  |
| --- | --- |
| **Trigger** | Facilitator uses 'Broadcast'. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string (≤ 300 chars)` | Message text |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "FacilitatorBroadcast",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 1,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "text": "Five minutes left in this round."
  }
}
```

</details>

### `ParticipantWithdrawn`

A participant withdrew (during the session) or their data was erased afterwards.

|  |  |
| --- | --- |
| **Trigger** | Facilitator marks a participant as withdrawn, or an erasure request is executed. |
| **Caused by** | facilitator, system |
| **Changes game state** | yes |
| **Visible to** | Facilitator; other players see the seat as inactive |
| **Data class** | non-personal |
| **Typical frequency** | rare |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seat` | `integer 1–4` | Seat number (1–4) within the session |
| `by` | `"facilitator" \| "erasure"` | How the withdrawal was recorded |
| `phase` | `string` | Session phase when the withdrawal was recorded |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "ParticipantWithdrawn",
  "actorKind": "facilitator",
  "seat": 3,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "seat": 3,
    "by": "facilitator",
    "phase": "round_active"
  }
}
```

</details>

### `GameCompleted`

The last round finished (or the facilitator ended the game early).

|  |  |
| --- | --- |
| **Trigger** | RoundCompleted for the final round, or facilitator clicks 'End game'. |
| **Caused by** | system, facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone (players see the end screen with their takedown code) |
| **Data class** | non-personal |
| **Typical frequency** | 1 per session |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `roundsPlayed` | `integer ≥ 0` | Number of rounds started |
| `reason` | `"all_rounds" \| "facilitator"` | All rounds were played, or the facilitator ended the game early |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "GameCompleted",
  "actorKind": "system",
  "seat": null,
  "participantCode": null,
  "round": 3,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "roundsPlayed": 3,
    "reason": "all_rounds"
  }
}
```

</details>

### `SessionClosed`

Session archived; no further events except erasure markers.

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Close session'. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Facilitator |
| **Data class** | non-personal |
| **Typical frequency** | 1 per session |

**Payload**

_No payload fields._

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SessionClosed",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {}
}
```

</details>

### `SessionAborted`

Session abandoned before completion (data kept, marked as aborted).

|  |  |
| --- | --- |
| **Trigger** | Facilitator clicks 'Abort session'. |
| **Caused by** | facilitator |
| **Changes game state** | yes |
| **Visible to** | Everyone |
| **Data class** | non-personal |
| **Typical frequency** | rare |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `reason` | `string (≤ 200 chars)` | Facilitator's reason (free text, no personal data) |

<details><summary>Example row</summary>

```json
{
  "sessionId": "S-20261116-7KQ2",
  "seq": 42,
  "type": "SessionAborted",
  "actorKind": "facilitator",
  "seat": null,
  "participantCode": null,
  "round": 0,
  "serverTs": 1794826000000.512,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "clientTs": null,
  "clientSeq": null,
  "payload": {
    "reason": "network failure"
  }
}
```

</details>

<!-- END GENERATED: event-sections -->

## Telemetry types

Telemetry is fine-grained interface behaviour. It **never changes game state** and is **recorded only after the participant has consented**: the client enables it then, and the server discards batches from seats without consent. The client batches it (every 2 s or 20 items) and buffers it while offline, so rows can arrive a few seconds after the moment they describe; `client_ts` records when the behaviour actually happened.

### Telemetry envelope

<!-- BEGIN GENERATED: telemetry-envelope -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| SQLite column | JSON field | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | `integer` | Auto-increment row id |
| `session_id` | `sessionId` | `string` | Session id |
| `seat` | `seat` | `integer 1–4` | Seat that produced the telemetry |
| `participant_code` | `participantCode` | `string` | Pseudonymous participant code of that seat |
| `round` | `round` | `integer ≥ 0` | Round when the batch was received (0 = before round 1) |
| `type` | `type` | `"screen_view" \| "region_hover" \| "region_inspect" \| "map_view_change" \| "tool_select" \| "action_draft" \| "focus_change" \| "visibility_change" \| "idle" \| "state_received" \| "clock_sync" \| "mic_permission"` | Telemetry type |
| `client_ts` | `clientTs` | `number` | Client timestamp corrected to server time (epoch ms) |
| `client_offset_ms` | `clientOffsetMs` | `number` | Clock offset applied by the client when correcting clientTs (ms) |
| `server_ts` | `serverTs` | `number` | Server receive time, epoch ms |
| `server_wall` | `serverWall` | `string` | Server receive time, ISO-8601 UTC |
| `payload_json` | `payload` | `object` | Type-specific payload (see the telemetry sections below) |

<!-- END GENERATED: telemetry-envelope -->

### Telemetry index

<!-- BEGIN GENERATED: telemetry-index -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| Type | Summary | Caused by | Changes state | Data class | Typical frequency |
| --- | --- | --- | --- | --- | --- |
| [`screen_view`](#screen_view) | The player's client showed a new screen. | player | no | pseudonymous | ~10 per seat |
| [`region_hover`](#region_hover) | The pointer rested on a sub-square of the map (recorded when it leaves). | player | no | pseudonymous | tens to hundreds per seat per round |
| [`region_inspect`](#region_inspect) | The player opened or closed the info panel of a square. | player | no | pseudonymous | tens per seat per round |
| [`map_view_change`](#map_view_change) | The player panned or zoomed the map. | player | no | pseudonymous | 0–tens per seat per round |
| [`tool_select`](#tool_select) | The player selected the propose or decide tool (or deselected). | player | no | pseudonymous | tens per seat per round |
| [`action_draft`](#action_draft) | Confirmation step of a propose/decide: opened, cancelled or confirmed. | player | no | pseudonymous | ≥ number of actions |
| [`focus_change`](#focus_change) | The game window gained or lost keyboard focus. | player | no | pseudonymous | 0–n |
| [`visibility_change`](#visibility_change) | The game tab became hidden or visible (tab switch, minimise). | player | no | pseudonymous | 0–n |
| [`idle`](#idle) | No pointer/keyboard input for 30 s (start), or input resumed (end). | player | no | pseudonymous | 0–n |
| [`state_received`](#state_received) | Acknowledgement that the client received and rendered a state update. | player | no | pseudonymous | 1 per state push (hundreds per seat) |
| [`clock_sync`](#clock_sync) | Result of a clock synchronisation between client and server. | player | no | non-personal | ~1 per minute per seat |
| [`mic_permission`](#mic_permission) | The browser's answer when the game asked for the microphone, or a later change of that permission. | player | no | pseudonymous | 1–few per seat (audio sessions only) |

<!-- END GENERATED: telemetry-index -->

<!-- BEGIN GENERATED: telemetry-sections -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

### `screen_view`

The player's client showed a new screen.

|  |  |
| --- | --- |
| **Trigger** | Client switches screen. Telemetry is only stored after consent, so pre-consent screens (waiting, lobby, consent, declined) never appear in the data. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | ~10 per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `screen` | `"waiting" \| "lobby" \| "consent" \| "declined" \| "mic_check" \| "demographics" \| "briefing" \| "ready" \| "calibration" \| "game" \| "round_break" \| "paused" \| "end" \| "withdrawn"` | Screen now shown |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "screen_view",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "screen": "consent"
  }
}
```

</details>

### `region_hover`

The pointer rested on a sub-square of the map (recorded when it leaves).

|  |  |
| --- | --- |
| **Trigger** | Pointer leaves a sub-square after ≥150 ms on it (shorter passes are ignored as noise). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (live hover indicator + log) |
| **Data class** | pseudonymous |
| **Typical frequency** | tens to hundreds per seat per round |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `regionId` | `string` | Hovered sub-square, e.g. 'C7-Kb' |
| `durationMs` | `number ≥ 0` | Hover duration (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "region_hover",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "regionId": "C7-Kb",
    "durationMs": 1840
  }
}
```

</details>

### `region_inspect`

The player opened or closed the info panel of a square.

|  |  |
| --- | --- |
| **Trigger** | Player clicks a square (open) or closes/replaces the panel (close). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | tens per seat per round |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `regionId` | `string` | Inspected square, e.g. 'C7' (the panel shows all four sub-squares) |
| `action` | `"open" \| "close"` | Panel opened or closed |
| `durationMs` | `number ≥ 0 \| null` | How long the panel was open (close only) (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "region_inspect",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "regionId": "C7",
    "action": "close",
    "durationMs": 5320
  }
}
```

</details>

### `map_view_change`

The player panned or zoomed the map.

|  |  |
| --- | --- |
| **Trigger** | Pan/zoom settles (debounced 500 ms) or the player presses 'reset view'. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | 0–tens per seat per round |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `x` | `number` | viewBox x (map units) |
| `y` | `number` | viewBox y (map units) |
| `w` | `number` | viewBox width (map units) |
| `h` | `number` | viewBox height (map units) |
| `zoom` | `number` | Zoom factor relative to the full map (1 = whole map) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "map_view_change",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "x": 120,
    "y": 80,
    "w": 500,
    "h": 350,
    "zoom": 2
  }
}
```

</details>

### `tool_select`

The player selected the propose or decide tool (or deselected).

|  |  |
| --- | --- |
| **Trigger** | Player clicks a tool button or presses its keyboard shortcut. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | tens per seat per round |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `tool` | `"propose" \| "decide" \| null` | Selected tool (null = none) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "tool_select",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "tool": "propose"
  }
}
```

</details>

### `action_draft`

Confirmation step of a propose/decide: opened, cancelled or confirmed.

|  |  |
| --- | --- |
| **Trigger** | Player clicks a square with a tool selected, or a Propose/Decide button in the square panel (opened), then confirms or cancels. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | ≥ number of actions |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `"propose" \| "decide"` | Map interaction: 'propose' or 'decide' |
| `regionId` | `string` | Sub-square the drafted action would land on (the one the game rules give this player) |
| `outcome` | `"opened" \| "cancelled" \| "confirmed"` | Confirmation step opened, cancelled, or confirmed (confirmed → intent sent) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "action_draft",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "kind": "propose",
    "regionId": "C7-Kb",
    "outcome": "cancelled"
  }
}
```

</details>

### `focus_change`

The game window gained or lost keyboard focus.

|  |  |
| --- | --- |
| **Trigger** | Browser window focus/blur. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (player card shows focus state) |
| **Data class** | pseudonymous |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `focused` | `boolean` | True = window has focus |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "focus_change",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "focused": false
  }
}
```

</details>

### `visibility_change`

The game tab became hidden or visible (tab switch, minimise).

|  |  |
| --- | --- |
| **Trigger** | document.visibilitychange. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (player card shows visibility) |
| **Data class** | pseudonymous |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `visible` | `boolean` | True = tab is visible |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "visibility_change",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "visible": true
  }
}
```

</details>

### `idle`

No pointer/keyboard input for 30 s (start), or input resumed (end).

|  |  |
| --- | --- |
| **Trigger** | Inactivity timer on the client. |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator |
| **Data class** | pseudonymous |
| **Typical frequency** | 0–n |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `state` | `"start" \| "end"` | Idle period started or ended |
| `durationMs` | `number ≥ 0 \| null` | Length of the idle period (end only) (milliseconds) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "idle",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "state": "end",
    "durationMs": 47210
  }
}
```

</details>

### `state_received`

Acknowledgement that the client received and rendered a state update.

|  |  |
| --- | --- |
| **Trigger** | Every state push from the server (lets you compute exact 'saw it → acted' reaction times). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (not shown in the live log) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1 per state push (hundreds per seat) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `seq` | `integer ≥ 0` | seq of the last event included in the state |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "state_received",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "seq": 58
  }
}
```

</details>

### `clock_sync`

Result of a clock synchronisation between client and server.

|  |  |
| --- | --- |
| **Trigger** | On connect and every 60 s (5 ping/pong samples, best round trip used). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (player card shows latency) |
| **Data class** | non-personal |
| **Typical frequency** | ~1 per minute per seat |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `offsetMs` | `number` | Estimated server clock minus client clock (ms) |
| `rttMs` | `number ≥ 0` | Round-trip time of the best sample (milliseconds) |
| `samples` | `integer ≥ 1` | Number of ping/pong samples |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "clock_sync",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "offsetMs": -12.4,
    "rttMs": 3.1,
    "samples": 5
  }
}
```

</details>

### `mic_permission`

The browser's answer when the game asked for the microphone, or a later change of that permission.

|  |  |
| --- | --- |
| **Trigger** | The player's client asks for the microphone (mic check, reload, reconnect, after a loss) and gets an answer, or the permission or device changes during the session (sessions that record audio). |
| **Caused by** | player |
| **Changes game state** | no |
| **Visible to** | Facilitator (LIVE mic column) |
| **Data class** | pseudonymous |
| **Typical frequency** | 1–few per seat (audio sessions only) |

**Payload**

| Field | Type | Description |
| --- | --- | --- |
| `state` | `"prompt" \| "granted" \| "denied" \| "error"` | 'prompt' = the browser is asking the player, 'granted' = microphone available, 'denied' = permission refused, 'error' = no usable microphone (missing, busy, or not a secure page) |
| `errorName` | `string (≤ 64 chars, pattern)` | Name of the browser error for 'denied' / 'error', e.g. 'NotAllowedError', 'NotFoundError', 'NotReadableError' (never the device name) |

<details><summary>Example row</summary>

```json
{
  "id": 1234,
  "sessionId": "S-20261116-7KQ2",
  "seat": 2,
  "participantCode": "WK-7F3K-Q9XM-Z",
  "round": 1,
  "type": "mic_permission",
  "clientTs": 1794825998799.6,
  "clientOffsetMs": -12.4,
  "serverTs": 1794826000000.9,
  "serverWall": "2026-11-16T10:46:40.000Z",
  "payload": {
    "state": "denied",
    "errorName": "NotAllowedError"
  }
}
```

</details>

<!-- END GENERATED: telemetry-sections -->

## One action, all its traces

What is stored when seat 2 (power type `Pb`) looks at square **C7**, opens its info panel, selects the *Propose* tool and proposes it. The proposal lands on sub-square **C7-Kb**, the sub-square of the seat's power type ([GAME-RULES.md § 3](GAME-RULES.md#3-what-a-player-can-act-on)). Telemetry rows reach the `telemetry` table through the server in batches; the diagram shows the logical order.

```mermaid
sequenceDiagram
  autonumber
  actor U as Participant at seat 2
  participant C as Player client
  participant S as Server
  participant E as events table
  participant T as telemetry table
  participant O as Other player clients
  S->>C: state (seq 57)
  C->>T: state_received seq 57
  U->>C: pointer enters sub-square C7-Kb
  C-->>S: presence C7-Kb (live mirror only, not stored)
  U->>C: click square C7
  C->>T: region_inspect open C7
  U->>C: move to toolbar, choose Propose
  C->>T: region_hover C7-Kb, 2310 ms
  C->>T: tool_select propose
  U->>C: click square C7 with the Propose tool
  C->>T: action_draft opened
  U->>C: confirm
  C->>T: action_draft confirmed
  C->>S: intent (clientSeq 7, propose, C7-Kb)
  S->>E: ProposalMade seq 58 (no score changes)
  S-->>C: ack ok, seq 58
  S->>O: state (seq 58), C7-Kb hatched for everyone
  S->>C: state (seq 58)
  C->>T: state_received seq 58
  U->>C: close the info panel
  C->>T: region_hover C7-Kb, 2700 ms
  C->>T: region_inspect close, 6120 ms
```

The resulting rows, ordered by client time (t = 0 at the first `state_received`). Envelope columns repeated on every row (`session_id`, `seat` = 2, `participant_code`, `round` = 1) are omitted:

| t (ms) | Table | seq / id | Type | Payload | Notes |
| ---: | --- | --- | --- | --- | --- |
| 0 | telemetry | id 1201 | `state_received` | `{"seq":57}` | Player's screen now shows state 57 |
| 2100 | telemetry | id 1202 | `region_inspect` | `{"regionId":"C7","action":"open","durationMs":null}` | Info panel of square C7 opened (shows the seat's own Kb score) |
| 3810 | telemetry | id 1203 | `region_hover` | `{"regionId":"C7-Kb","durationMs":2310}` | Pointer had rested on C7-Kb since t = 1500 |
| 4050 | telemetry | id 1204 | `tool_select` | `{"tool":"propose"}` | |
| 5600 | telemetry | id 1205 | `action_draft` | `{"kind":"propose","regionId":"C7-Kb","outcome":"opened"}` | Confirmation prompt shown |
| 6900 | telemetry | id 1206 | `action_draft` | `{"kind":"propose","regionId":"C7-Kb","outcome":"confirmed"}` | |
| 6903 | **events** | **seq 58** | **`ProposalMade`** | `{"regionId":"C7-Kb","quotaUsed":2,"quotaLimit":5,"priorProposals":[3],"priorDecisions":[],"msSinceRoundStart":51234,"scoreChanges":[]}` | `client_ts` = t 6900, `client_seq` = 7, `actor_kind` = player |
| 6910 | telemetry | id 1207 | `state_received` | `{"seq":58}` | The other three clients send their own `state_received` 58 rows |
| 7900 | telemetry | id 1208 | `region_hover` | `{"regionId":"C7-Kb","durationMs":2700}` | Second hover, from t = 5200 |
| 8220 | telemetry | id 1209 | `region_inspect` | `{"regionId":"C7","action":"close","durationMs":6120}` | |

In `actions.csv` this becomes one row with `reaction_ms` = 6903 (from seeing state 57 to the accepted proposal), `ms_since_prev_own_action` measured from this seat's previous action in the round, `prior_proposals` = `3`, `square_id` = `C7`, `target_k` = `Kb`, an empty `score_changes` (a proposal changes no scores) and `map_score_after` equal to the map score before. A decision would fill the sub-square instead and record its score changes, e.g. `C7-Kb 6>10; C7-Ka 4>3; C7-Kc 5>4; C7-Kd 2>1`.

## Session configuration

Stored verbatim in `SessionCreated.config` and in `sessions.config_json`. Defaults come from `config/session.default.json` and can be changed per session on the facilitator's setup screen.

<!-- BEGIN GENERATED: session-config -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `players` | `"real" \| "simulated"` | `"real"` | Who plays: 'real' = participants on player PCs (consent, codes, client binding; participant database); 'simulated' = in-process agents (no consent, codes or clients; simulation database) |
| `simulation` | `object` | — | Simulated players (used only when players = 'simulated') |
| `simulation.policy` | `string (≤ 40 chars, pattern)` | `"random"` | Agent policy every simulated seat uses unless overridden (see ARCHITECTURE.md § Simulated players) |
| `simulation.seatPolicies` | `map<string, string (≤ 40 chars, pattern)>` | — | Per-seat policy overrides keyed by seat number, e.g. { '2': 'idle' } |
| `simulation.params` | `map<string, object>` | — | Policy parameters keyed by policy id, e.g. { 'random': { 'proposeBias': 0.7 } }; each policy checks and completes its own |
| `simulation.seed` | `string (≤ 40 chars) \| null` | `null` | Seed for the agents' random choices; null = a random seed is drawn when the session is created and stored here |
| `simulation.minDelayMs` | `integer 0–600000` | `800` | Shortest pause before an agent's turn (ms); 0 and 0 = as fast as possible |
| `simulation.maxDelayMs` | `integer 0–600000` | `2500` | Longest pause before an agent's turn (ms) |
| `rules` | `string (pattern)` | `"standard"` | Game rules: what players act on and how actions change the scores (id from game/rules.ts; see GAME-RULES.md) |
| `seatCount` | `integer 1–4` | `4` | Number of player seats (4 for real sessions; fewer for pilots) |
| `roundCount` | `integer 1–20` | `3` | Number of rounds in the game |
| `defaultRound` | `object` | — | Round definition used for every round unless overridden |
| `defaultRound.rule` | `"quota" \| "manual"` | `"quota"` | Round-completion rule: 'quota' = round ends when every active player has used all quotas; 'manual' = only the facilitator (or the time limit) ends the round |
| `defaultRound.quota` | `object` | — | Per-player action quotas for the round |
| `defaultRound.quota.propose` | `integer ≥ 0 \| null` | `5` | Max proposals per player in this round (null = unlimited) |
| `defaultRound.quota.decide` | `integer ≥ 0 \| null` | `5` | Max decisions per player in this round (null = unlimited) |
| `defaultRound.timeLimitSec` | `integer > 0 \| null` | `null` | Optional time limit in seconds; the round ends automatically when it elapses |
| `roundOverrides` | `map<string, { rule?: "quota" \| "manual", quota?: { propose?: integer ≥ 0 \| null, decide?: integer ≥ 0 \| null }, timeLimitSec?: integer > 0 \| null }>` | — | Per-round overrides keyed by round number, e.g. { '3': { ... } } |
| `roundAdvance` | `"facilitator" \| "auto"` | `"facilitator"` | Who starts the next round after one completes |
| `autoAdvanceDelaySec` | `integer ≥ 0` | `10` | Delay before the next round starts when roundAdvance = 'auto' |
| `viewAssignment` | `"byKnowledgeType" \| "manual"` | `"byKnowledgeType"` | How a seat's map view is chosen: from its K label, or set manually by the facilitator |
| `clearHighlightsEachRound` | `boolean` | `true` | If true, the map only shows the current round's proposals (hatched) and decisions (filled); scores always carry over |
| `pauseOnDisconnect` | `boolean` | `true` | Automatically pause the game when a player disconnects during a round |
| `onboarding` | `object` | — | Onboarding steps each player completes before round 1 |
| `onboarding.consent` | `boolean` | `true` | Show the in-game consent screen (keep ON for real sessions) |
| `onboarding.demographics` | `boolean` | `true` | Show the demographics questionnaire |
| `onboarding.briefing` | `boolean` | `true` | Show the briefing / instructions screen |
| `audio` | `object` | — | Microphone recording (research data: see DATA-MANAGEMENT.md) |
| `audio.enabled` | `boolean` | `false` | Record each participant's microphone, from their mic check (an onboarding step after consent) until the game is complete. Needs the consent step with the audio consent item, and HTTPS; never used for simulated sessions or fake players |
| `audio.requireCalibration` | `boolean` | `true` | With audio on: round 1 can start only once the calibration (each seat reads a sentence aloud in turn while the others stay quiet) is done or skipped |
| `visibility` | `object` | — | What players can see about each other |
| `visibility.showActorToPlayers` | `boolean` | `true` | Players see which seat made each proposal/decision |
| `visibility.showOwnLabels` | `boolean` | `true` | Players see their own K/P labels |
| `visibility.showOtherLabelsToPlayers` | `boolean` | `false` | Players see other seats' K/P labels |
| `visibility.showOthersProgress` | `boolean` | `true` | Players see other seats' quota progress |
| `tags` | `array<string (≤ 40 chars, pattern)>` | — | Researcher-entered session tags, e.g. ['pilot', 'condition-A'] (entered comma-separated; no personal data) |

<!-- END GENERATED: session-config -->

## Label pairings

Every seat holds one knowledge type (K) and one power type (P). The facilitator chooses which seat gets which K (setup step 08); **P is never chosen freely**. It follows from one of two kinds of **pairing**:

- **Aligned**: each seat holds the same letter for K and P (Ka–Pa, Kb–Pb, Kc–Pc, Kd–Pd).
- **Fully dissociated**: no seat holds the same letter for K and P, **and** no two seats mirror each other. A "player pair" such as Ka–Pd plus Kd–Pa is excluded. Following the links K → P → (same letter as K) visits all four letters in one loop. There are exactly **3! = 6** such pairings, numbered **D1–D6** in the order below.

  Of the 9 pairings without a same-letter seat, the other 3 (Ka–Pb + Kb–Pa with Kc–Pd + Kd–Pc, and so on) consist of two player pairs and are not allowed.

The pairing is stored with every `LabelsAssigned` event as `pairing: { mode, id }`. `id` is the number in this table; it is `null` for aligned. Exports carry it as `players.csv.pairing` (`aligned` / `D1`…`D6`) and `session.json.labelPairing`. With fewer than four seats, the seats hold the pairs of their K labels only.

<!-- BEGIN GENERATED: label-pairings -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

| Pairing | Stored as | Ka → | Kb → | Kc → | Kd → | Cycle |
| --- | --- | --- | --- | --- | --- | --- |
| **aligned** | `{"mode":"aligned","id":null}` | Pa | Pb | Pc | Pd | — |
| **D1** | `{"mode":"dissociated","id":1}` | Pb | Pc | Pd | Pa | a→b→c→d→a |
| **D2** | `{"mode":"dissociated","id":2}` | Pb | Pd | Pa | Pc | a→b→d→c→a |
| **D3** | `{"mode":"dissociated","id":3}` | Pc | Pa | Pd | Pb | a→c→d→b→a |
| **D4** | `{"mode":"dissociated","id":4}` | Pc | Pd | Pb | Pa | a→c→b→d→a |
| **D5** | `{"mode":"dissociated","id":5}` | Pd | Pa | Pb | Pc | a→d→c→b→a |
| **D6** | `{"mode":"dissociated","id":6}` | Pd | Pc | Pa | Pb | a→d→b→c→a |

Matrices (rows = knowledge type, columns = power type, ■ = held by the same seat):

**aligned**

| aligned | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | ■ | · | · | · |
| Kb | · | ■ | · | · |
| Kc | · | · | ■ | · |
| Kd | · | · | · | ■ |

**D1**

| D1 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | ■ | · | · |
| Kb | · | · | ■ | · |
| Kc | · | · | · | ■ |
| Kd | ■ | · | · | · |

**D2**

| D2 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | ■ | · | · |
| Kb | · | · | · | ■ |
| Kc | ■ | · | · | · |
| Kd | · | · | ■ | · |

**D3**

| D3 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | · | ■ | · |
| Kb | ■ | · | · | · |
| Kc | · | · | · | ■ |
| Kd | · | ■ | · | · |

**D4**

| D4 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | · | ■ | · |
| Kb | · | · | · | ■ |
| Kc | · | ■ | · | · |
| Kd | ■ | · | · | · |

**D5**

| D5 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | · | · | ■ |
| Kb | ■ | · | · | · |
| Kc | · | ■ | · | · |
| Kd | · | · | ■ | · |

**D6**

| D6 | Pa | Pb | Pc | Pd |
| --- | --- | --- | --- | --- |
| Ka | · | · | · | ■ |
| Kb | · | · | ■ | · |
| Kc | ■ | · | · | · |
| Kd | · | ■ | · | · |

<!-- END GENERATED: label-pairings -->

## Audio storage

Sound is **not** stored in the database. Each track is an encrypted file `data/audio/<sessionId>/<random 16-byte hex>.wka`; the database holds the metadata and the key. How and why: [AUDIO.md § 7](AUDIO.md#7-storage-and-encryption). The audio events and the telemetry type `mic_permission` are generated above; the audio CSV files are generated under [Export files](#export-files).

**File layout** (all integers big-endian):

| Part | Bytes | Content |
| --- | ---: | --- |
| Header | 22 | `WKA1` (4), format version `u16` (2), file id (16 random bytes) |
| Record (one per uploaded chunk, repeated) | 36 + payload | payload length `u32`, `seq` `u32`, nonce (12), ciphertext (payload length), GCM tag (16) |

The cipher is AES-256-GCM with a random 32-byte key per file. The authenticated data of a record is the file id followed by its `seq`. A raw chunk's payload is 16 kHz mono signed 16-bit little-endian PCM; a cleaned track is written the same way.

| Table | Column | Type | Description |
| --- | --- | --- | --- |
| `audio_tracks` | `track_id` | TEXT | Random id of the track (one continuous capture run of one seat) |
| | `session_id`, `seat`, `participant_code` | TEXT, INTEGER, TEXT | Where and whose. The code is stored here and never in a file name. |
| | `file_name`, `file_key` | TEXT, BLOB | Random file name; the file's AES-256 key. The key is set to NULL when the raw audio is deleted. Listings and the REST API never show either. |
| | `sample_rate`, `settings_json` | INTEGER, TEXT | 16 000; the processing flags the browser reported (echo cancellation, noise suppression, automatic gain control, channels, capture rate). Never a device name or id. |
| | `reason`, `stop_reason` | TEXT | Why it started and why it stopped (lists: [NETWORKING.md § 9](NETWORKING.md#9-message-catalogue)) |
| | `started_server_ts`, `started_client_ts`, `clock_offset_ms`, `closed_server_ts` | REAL | Start on the server clock, the browser's own timestamp and offset, close time |
| | `samples`, `chunks`, `dropped_chunks`, `bytes` | INTEGER | Totals; `dropped_chunks` counts chunks the browser had to discard from its full queue while this track was recording (if the backlog spans a track boundary, an older track's chunks can be counted here: [AUDIO.md § 13](AUDIO.md#13-known-limits)) |
| | `status` | TEXT | `recording`, `closed` or `deleted` (raw audio removed, metadata kept). The REST API and `audio_tracks.csv` add `interrupted` for tracks that ended with a stop reason the audio reason catalogue (`packages/shared/src/audioReasons.ts`) marks as interrupted: `disconnect`, `interrupted` (still open after a restart), `permission_lost`, `error` and `track_ended` (the microphone went away); the generated `status` column of `audio_tracks.csv` below lists the current set. |
| `audio_chunks` | `track_id`, `seq` | TEXT, INTEGER | Primary key: a resent chunk is stored once. `seq` is also the record number in the file. |
| | `start_sample`, `sample_count` | INTEGER | Position and length in the track |
| | `client_ts`, `clock_offset_ms`, `server_ts`, `server_wall` | REAL, TEXT | Capture time on the server clock (as the browser computed it), the offset used, arrival time |
| | `round`, `phase` | INTEGER, TEXT | Game position when the chunk arrived |
| | `rms_db`, `peak_db`, `clipped` | REAL, INTEGER | Level summary (dBFS) and number of clipped samples |
| `audio_derivatives` | `derivative_id`, `session_id` | TEXT | One result of an attribution run |
| | `seat`, `participant_code` | INTEGER, TEXT | Empty for session-wide results (`talk_time`, `quality_report`, `leakage_matrix`) |
| | `kind` | TEXT | `speech_segments` (JSON: segments and talk time of one seat), `talk_time`, `quality_report` (grade, speech detector `silero` or `energy`, calibration per seat, ambiguous share, and per seat coverage, clipping, noise floor, speech level, signal-to-noise ratio, drift, talk time and overlap; plus the alignment of every track), `leakage_matrix` (dB, `[speaker][mic]`, source `calibration` or `default`), `clean` (an encrypted track with attenuation 30 dB and 10 ms fades). Later: `transcript` (planned). |
| | `source_tracks_json` | TEXT | The tracks it was computed from. Erasing a participant removes every result whose sources include one of their tracks, and removes their seat from the `overlapWith` of the other seats' kept speech segments. |
| | `file_name`, `file_key`, `data_json` | TEXT, BLOB, TEXT | An encrypted file (cleaned track) or small JSON (the rest) |
| | `params_json`, `engine_version` | TEXT | Parameters and version of the attribution engine (now `wkwa-gate-attribution/2.0.0`). *Export audio* reuses the stored alignment only when its `engine_version` is the current one; otherwise it places the tracks by their chunk timestamps. |
| `audio_jobs` | `job_id`, `session_id`, `kind`, `status` | TEXT | `kind` is `attribution`; `status` is `queued`, `running`, `done` or `failed` |
| | `progress`, `params_json`, `result_json`, `error` | REAL, TEXT | 0 to 1; options; the summary (talk time, overlap, grade, speech detector, margin, drift and coverage per seat, ambiguous share, warnings; set to NULL for the whole session when a participant of it is erased); an error text with anything that looks like a participant code scrubbed |
| `audio_deletions` | `session_id`, `scope` | TEXT | `raw` or `all` |
| | `requested_wall`, `executed_wall`, `note` | TEXT | When, and a free note (no names) |
| | `counts_json` | TEXT | `tracks`, `audioMs`, `chunks`, `derivatives`, `jobs`, `files`, `bytes`, `seatMask` (a bit mask of seats) |

**Acknowledgement shape.** Every `audio:start`, `audio:chunk` and `audio:stop` is answered with `{ ok: true, data?, duplicate? }` or `{ ok: false, error, retry }` (`retry: true` = send again later, `false` = drop it). Nothing of this is stored; it only steers the browser's send queue.

## Other tables

| Table | Column | Type | Description |
| --- | --- | --- | --- |
| `meta` | `key`, `value` | TEXT | `schema_version` (DB migrations), `server_secret` (random, used to derive seat reconnect tokens), `created_wall` |
| `sessions` | `id` | TEXT | Session id `S-YYYYMMDD-XXXX` |
| | `created_wall`, `updated_wall` | TEXT | ISO-8601 UTC |
| | `scenario_id`, `scenario_version`, `scenario_hash` | TEXT | Scenario used (hash = SHA-256 of the loaded map and views) |
| | `status` | TEXT | Current phase (`lobby` … `closed` / `aborted`), a cache of the reduced state |
| | `tags_json` | TEXT | Session tags as a JSON list, e.g. `["pilot","A"]` (schema v3; entered comma-separated in setup) |
| | `condition` | TEXT | Before schema v3: a single free-text condition label. Since v3 it holds a readable copy of the tags; migration 3 converted old values to tags |
| | `notes` | TEXT | Researcher-entered notes (no personal data) |
| | `config_json` | TEXT | Effective session configuration (see above) |
| | `harness_version`, `git_commit` | TEXT | Software version |
| | `last_seq` | INTEGER | Highest `seq` ever assigned in the session, so seq numbers are never reused after an erasure (schema v2) |
| `erasures` | `code_sha256` | TEXT | SHA-256 of the erased participant code (not the code itself) |
| | `requested_wall`, `executed_wall` | TEXT | When the request was made and executed |
| | `sessions_json` | TEXT | Sessions in which data was found |
| | `rows_json` | TEXT | Rows deleted per table (`{"events":…,"telemetry":…,"audioTracks":…,"audioChunks":…,"audioDerivatives":…,"audioFiles":…}`; entries made before audio existed lack the audio counts) |
| | `note` | TEXT | Free note (no names) |
| `session_deletions` | `session_id`, `deleted_wall`, `created_wall` | TEXT | Which session was deleted, and when it was deleted and created (schema v4) |
| | `rows_json` | TEXT | Rows deleted (`{"events":…,"telemetry":…,"exports":…}`) |
| | `code_hashes_json` | TEXT | SHA-256 of the participant codes the session contained (to re-apply the deletion after a backup restore) |
| | `exports_json`, `note` | TEXT | Export folders known for the session; free note |
| `exports` | `id`, `session_id`, `kind` | TEXT | Export id, session, `standard` / `anonymised` / `audio` (the *Export audio* action) |
| | `created_wall`, `path` | TEXT | When and where it was written |
| | `code_hashes_json` | TEXT | SHA-256 of every participant code contained (lets you find affected exports after an erasure) |
| | `files_json` | TEXT | Files with row counts and SHA-256 checksums |
| | `details_json` | TEXT | Schema v7. For audio exports: who asked, the note, the seats and the kind. Never a participant code: those stay hashed in `code_hashes_json`. |

## Export files

Every export folder (`exports/<sessionId>/<exportId>/`, or `anon-<id>/` for anonymised exports) contains the files below. CSV conventions: UTF-8, comma-separated, RFC 4180 quoting, header row, empty cell = null, booleans `0`/`1`, `*_ts` = epoch ms, `*_wall` = ISO-8601 UTC, seat lists space-separated. In anonymised exports, `participant_code` holds a random `A-XXXXXX` id instead.

<!-- BEGIN GENERATED: export-columns -->
<!-- Generated by `npm run docs:generate` from packages/shared — do not edit by hand. -->

#### `session.json`

Session metadata: configuration, scenario, software version and a per-round summary. _Unit:_ one document per export. _Data class:_ non-personal.

| Key | Type | Description | Source |
| --- | --- | --- | --- |
| `exportId` | string | Id of this export | generated at export time |
| `kind` | string | 'standard' (pseudonymised) or 'anonymised' | export request |
| `exportedWall` | iso-datetime | When the export was made | server clock |
| `sessionId` | string | Session id | sessions.id |
| `status` | string | Session phase at export time | reduced state.phase |
| `createdWall` | iso-datetime | Session creation time | SessionCreated |
| `scenario` | json | { id, title, version, hash } of the scenario used | SessionCreated.scenario |
| `config` | json | Full effective session configuration | SessionCreated.config |
| `tags` | json | Session tags (list of strings), e.g. ["pilot", "condition-A"] | SessionCreated.config.tags |
| `notes` | string | Researcher notes at creation | SessionCreated.notes |
| `harness` | json | { version, gitCommit } of the harness software | SessionCreated.harness |
| `rounds` | json | [{ round, startedWall, endedWall, reason, durationMs, pausedMs }] per played round | RoundStarted + RoundCompleted |
| `labelPairing` | json | { mode, id, name, pairs } of the final label assignment: aligned, or fully dissociated D1–D6 (see the pairing table), e.g. { mode: 'dissociated', id: 6, name: 'D6', pairs: 'Ka–Pd Kb–Pc Kc–Pa Kd–Pb' } | last LabelsAssigned.pairing |
| `fakeSeats` | json | Seats played by fake players (test clients the server created, not participants), e.g. [1, 3]; [] when every seat was a participant or an agent | SeatBound.fake |
| `counts` | json | { events, telemetry, actions, players } row counts in this export | computed |

#### `players.csv`

Who sat where, with which labels, and their onboarding status; which seats were fake players; which agent policy played each seat in a simulated session. _Unit:_ one row per seat that was bound at the end of the session. _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `terminal` | integer | Client number of the browser bound to the seat (column name kept as terminal) | SeatBound.terminal |
| `k_label` | string | Knowledge type (Ka–Kd) | last LabelsAssigned |
| `p_label` | string | Power type (Pa–Pd) | last LabelsAssigned |
| `view` | string | Map view id shown to the seat | last LabelsAssigned |
| `consent_status` | string | pending \| given \| declined \| skipped | ConsentRecorded (skipped if consent step disabled) |
| `consent_version` | string | Consent form version answered | ConsentRecorded.formVersion |
| `demographics_submitted` | bool01 | 1 if the questionnaire was submitted | DemographicsSubmitted |
| `briefing_acknowledged` | bool01 | 1 if the briefing was confirmed | BriefingAcknowledged |
| `withdrawn` | bool01 | 1 if the participant withdrew | ParticipantWithdrawn |
| `reconnects` | integer | Number of reconnections during the session | PlayerConnected.reconnect |
| `rejections` | integer | Number of rejected propose/decide attempts | IntentRejected |
| `pairing` | string | K–P pairing in force at the end: 'aligned' or 'D1'…'D6' (fully dissociated, see the pairing table) | last LabelsAssigned.pairing |
| `agent_policy` | string | Simulated sessions: id of the agent policy that played the seat (version, parameters and seed are in AgentBound). Empty for real participants | AgentBound.policy |
| `fake_player` | bool01 | 1 if the seat was played by a fake player: a test client the server created (not a participant; no code, no onboarding). Leave these rows out of analyses of participants | SeatBound.fake |

#### `actions.csv`

Analysis-ready table of every map interaction with labels, timings and context. _Unit:_ one row per ProposalMade / DecisionMade event (revoked ones included, flagged). _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seq` | integer | Event seq of the action | envelope.seq |
| `round` | integer | Round number | envelope.round |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `k_label` | string | Knowledge type of the seat at action time | state |
| `p_label` | string | Power type of the seat at action time | state |
| `view` | string | View of the seat at action time | state |
| `kind` | string | propose \| decide | event type |
| `region_id` | string | Target sub-square id, e.g. C7-Kb (square C7, knowledge type Kb) | payload.regionId |
| `region_name` | string | Target sub-square name, e.g. 'C7 · Kb' | scenario regions |
| `square_id` | string | Square of the target sub-square, e.g. C7 | payload.regionId |
| `target_k` | string | Knowledge type of the target sub-square (Ka–Kd) | payload.regionId |
| `server_ts` | epoch-ms | Server time the action was accepted | envelope |
| `server_wall` | iso-datetime | Same as server_ts, human-readable | envelope |
| `client_ts` | epoch-ms | Client time of the confirm click, corrected to server time | envelope.clientTs |
| `client_seq` | integer | Client intent counter | envelope.clientSeq |
| `ms_since_round_start` | number | Active (un-paused) server ms since the round started | payload.msSinceRoundStart |
| `ms_since_prev_own_action` | number | Server ms since this seat's previous action in the same round (empty for the first) | derived from server_ts |
| `reaction_ms` | number | server_ts minus clientTs of this seat's latest state_received telemetry before the action (time from seeing the latest state to acting); empty if none | derived: telemetry state_received |
| `quota_used` | integer | Actions of this kind used by the seat this round, incl. this one | payload.quotaUsed |
| `quota_limit` | integer | Quota for this kind this round (empty = unlimited) | payload.quotaLimit |
| `prior_proposals` | seat-list | Seats that had proposed this sub-square earlier this round | payload.priorProposals |
| `prior_decisions` | seat-list | Seats that had decided this sub-square earlier this round | payload.priorDecisions |
| `score_changes` | string | Score changes the game rules applied when the action was accepted, e.g. 'C7-Kb 6>10; C7-Ka 5>4' (empty if none) | payload.scoreChanges |
| `map_score_after` | number | Map score right after the action (empty for sessions without a grid map); a later revocation is not reflected here | derived: replayed scores + game rules |
| `revoked` | bool01 | 1 if the facilitator revoked the action | ActionRevoked |
| `revoked_by_seq` | integer | seq of the ActionRevoked event (empty if not revoked) | ActionRevoked.seq |

#### `events.csv`

The complete event log (envelope + JSON payload). DemographicsSubmitted payloads are redacted here — answers are only in demographics.csv. _Unit:_ one row per stored event. _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seq` | integer | Position in the event log | envelope.seq |
| `type` | string | Event type (see DATA-TYPES.md) | envelope.type |
| `actor_kind` | string | player \| facilitator \| system | envelope.actorKind |
| `seat` | integer | Seat (empty for session-level events) | envelope.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `round` | integer | Round at the time (0 = before round 1) | envelope.round |
| `server_ts` | epoch-ms | Server timestamp | envelope.serverTs |
| `server_wall` | iso-datetime | Server wall-clock time | envelope.serverWall |
| `client_ts` | epoch-ms | Corrected client timestamp (player events only) | envelope.clientTs |
| `client_seq` | integer | Client intent counter | envelope.clientSeq |
| `payload_json` | json | Event payload as JSON (DemographicsSubmitted → {"redacted":true}) | events.payload_json |

#### `telemetry.csv`

Fine-grained UI behaviour (hover, inspect, pan/zoom, focus, idle, acks, clock sync). _Unit:_ one row per stored telemetry item. _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `id` | integer | Telemetry row id | telemetry.id |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `round` | integer | Round when received | telemetry.round |
| `type` | string | Telemetry type (see DATA-TYPES.md) | telemetry.type |
| `client_ts` | epoch-ms | Corrected client timestamp | telemetry.client_ts |
| `client_offset_ms` | number | Clock offset the client applied | telemetry.client_offset_ms |
| `server_ts` | epoch-ms | Server receive time | telemetry.server_ts |
| `server_wall` | iso-datetime | Server receive time, human-readable | telemetry.server_wall |
| `payload_json` | json | Telemetry payload as JSON | telemetry.payload_json |

#### `consent.csv`

Consent answers per participant, one column per consent item. _Unit:_ one row per ConsentRecorded event. _Data class:_ pseudonymous · sensitive.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seq` | integer | Event seq | envelope.seq |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `form_version` | string | Consent form version | payload.formVersion |
| `text_sha256` | string | SHA-256 of the exact consent text shown | payload.textSha256 |
| `consented` | bool01 | 1 if all required items were accepted | payload.consented |
| `duration_ms` | number | Time on the consent screen | payload.durationMs |
| `server_wall` | iso-datetime | When consent was recorded | envelope |

Plus one column `answer_<id>` (bool01) per consent item in `config/consent.json`: Answer to consent item <id>.

#### `demographics.csv`

Questionnaire answers (option values), one column per question. _Unit:_ one row per DemographicsSubmitted event. _Data class:_ pseudonymous · sensitive.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `form_version` | string | Questionnaire version | payload.formVersion |
| `duration_ms` | number | Time on the questionnaire | payload.durationMs |
| `server_wall` | iso-datetime | When submitted | envelope |

Plus one column `q_<id>` (string) per question in `config/demographics.json`: Selected option value for question <id> ('prefer_not_to_say' allowed).

#### `audio_tracks.csv`

Index of the recorded microphone audio: when each track ran, how much audio arrived and how the browser processed it. Metadata only: the audio itself stays encrypted on the server and is never part of this export (see 'Export audio'). Empty (header only) for sessions without audio. _Unit:_ one row per stored audio track (one continuous microphone capture run of one seat). _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `track_id` | string | Random id of the track (UUID) | AudioTrackStarted.trackId |
| `status` | string | open (still recording) \| closed (stopped normally) \| interrupted (the browser or microphone went away, or the server restarted: stop_reason disconnect, permission_lost, error, interrupted, track_ended, or a reason this version does not know) \| deleted (raw audio deleted, metadata kept) | audio_tracks.status + stop_reason |
| `start_reason` | string | Why the track started: 'mic_check' = first capture of the seat (its mic check), 'resume' = recording resumed after a facilitator pause, 'reconnect' = the browser reconnected, 'reload' = the page was reloaded, 'permission_regained' = the microphone came back after a permission or device loss, 'context_resumed' = the browser's audio engine ran again after the system suspended it (e.g. sleep, another app took the device), 'clock_jump' = the capture clock jumped, so a new track keeps the sample timeline exact, 'discontinuity' = the browser delivered a gap or overlap in the audio too large to patch, 'cleared' = the browser discarded its unsent audio (e.g. the seat was unbound) and capture continued in a new track | AudioTrackStarted.reason |
| `stop_reason` | string | Why the track stopped: 'paused' = facilitator paused recording, 'game_complete' = the game ended, 'closed' = the session was closed, 'aborted' = the session was aborted, 'withdrawn' = the participant withdrew, 'disconnect' = the browser disconnected (the server closed the track), 'permission_lost' = the microphone permission or device went away, 'error' = capture failed (also when the browser closed its audio engine), 'client_stop' = the browser stopped the track itself (e.g. page unload), 'skipped' = the facilitator skipped the seat's mic check (the seat is not recorded), 'interrupted' = the server found the track still open when it loaded the session again (e.g. after a restart) or the seat started another track, 'context_suspended' = the system suspended the browser's audio engine, 'context_interrupted' = the system interrupted the browser's audio engine, 'clock_jump' = the capture clock jumped, 'discontinuity' = a gap or overlap in the audio too large to patch, 'track_ended' = the browser ended the microphone track (device unplugged or permission revoked), 'cleared' = the browser discarded its unsent audio (e.g. the seat was unbound); empty while open | AudioTrackStopped.reason |
| `started_server_ts` | epoch-ms | When the server opened the track | audio_tracks.started_server_ts |
| `first_sample_ts` | epoch-ms | Capture time of the first sample, as estimated by the browser's synchronised clock | audio_tracks.started_client_ts |
| `closed_server_ts` | epoch-ms | When the track was closed (empty while open) | audio_tracks.closed_server_ts |
| `duration_ms` | number | Audio stored: samples / sample_rate | audio_tracks.samples |
| `samples` | integer | Samples stored (16 000 per second) | audio_tracks.samples |
| `chunks` | integer | Chunks (about 5 s each) stored | audio_tracks.chunks |
| `dropped_chunks` | integer | Chunks the browser reported as lost (their audio is missing) | AudioTrackStopped.droppedChunks |
| `gaps` | integer | Missing chunks: sequence numbers or sample ranges never received | derived: audio_chunks seq / start_sample |
| `sample_rate` | integer | Sample rate of the stored audio (Hz; always 16000) | AudioTrackStarted.sampleRate |
| `capture_sample_rate` | integer | Native sample rate of the microphone before resampling (Hz) | AudioTrackStarted.settings.sampleRate |
| `echo_cancellation` | bool01 | 1 if the browser applied echo cancellation (requested off; empty if not reported) | AudioTrackStarted.settings.echoCancellation |
| `noise_suppression` | bool01 | 1 if the browser applied noise suppression (requested off; empty if not reported) | AudioTrackStarted.settings.noiseSuppression |
| `auto_gain_control` | bool01 | 1 if the browser applied automatic gain control (requested off; empty if not reported) | AudioTrackStarted.settings.autoGainControl |
| `channel_count` | integer | Channels the browser delivered (mixed to mono before upload; empty if not reported) | AudioTrackStarted.settings.channelCount |

#### `speech_segments.csv`

Who spoke when, from the speaker attribution run in the DATABASE tab: it compares the loudness of the seats' microphones and never identifies a voice. Timing only, no voice content. Empty (header only) until an attribution has been run, and for sessions without audio. A participant's rows disappear when their data is erased. _Unit:_ one row per stretch of speech of one seat. _Data class:_ pseudonymous.

| Column | Type | Description | Source |
| --- | --- | --- | --- |
| `session_id` | string | Session id, e.g. S-20261116-7KQ2 | envelope.sessionId |
| `seat` | integer | Seat number (1–4) | envelope.seat / SeatBound.seat |
| `participant_code` | string | Pseudonymous participant code (anonymised export: random A-XXXXXX id) | envelope.participantCode |
| `start_server_ts` | epoch-ms | Start of the speech (server clock, aligned across seats) | attribution segment.startTs |
| `end_server_ts` | epoch-ms | End of the speech (server clock) | attribution segment.endTs |
| `duration_ms` | number | end_server_ts − start_server_ts | attribution segment.durationMs |
| `round` | integer | Round in progress when the speech started (0 = before round 1) | event log at start_server_ts |
| `phase` | string | Session phase when the speech started, e.g. onboarding, round_active, round_complete | event log at start_server_ts |
| `paused` | bool01 | 1 if the game was paused when the speech started | GamePaused / GameResumed |
| `recording_paused` | bool01 | 1 if recording was paused when the speech started (only possible at the edge of a pause) | RecordingPaused / RecordingResumed |
| `mean_db` | number | Mean level of the seat's own microphone over the speech (dBFS) | attribution segment.meanDb |
| `confidence` | number | 0–1: mean speech probability of the speech model over the segment (with the energy fallback: share of frames that passed the gate) | attribution segment.confidence |
| `overlap` | bool01 | 1 if another seat spoke at the same time for part of the segment | attribution segment.overlap |
| `overlap_ms` | number | Time within the segment during which another seat also spoke | attribution segment.overlapMs |
| `overlap_with` | seat-list | Seats that spoke at the same time | attribution segment.overlapWith |
| `engine_version` | string | Version of the attribution engine that produced the segment | audio_derivatives.engine_version |

#### `manifest.json`

Inventory of the export, used to trace which exports contain a participant after an erasure request. _Unit:_ one document per export. _Data class:_ pseudonymous.

| Key | Type | Description | Source |
| --- | --- | --- | --- |
| `exportId` | string | Id of this export | generated |
| `sessionId` | string | Session exported | sessions.id |
| `kind` | string | 'standard' \| 'anonymised' | export request |
| `createdWall` | iso-datetime | When the export was made | server clock |
| `files` | json | [{ name, rows, sha256 }] for every file in the folder (integrity check) | computed |
| `codeHashes` | json | SHA-256 of every participant code contained (standard exports only; empty list in anonymised exports) | computed |

#### `codebook.md`

Human-readable data dictionary for this export (generated from the same definitions as this table). _Unit:_ one document per export. _Data class:_ non-personal.

<!-- END GENERATED: export-columns -->
