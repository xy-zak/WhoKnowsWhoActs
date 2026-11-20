# Change log: AUDIO.md

History of [AUDIO.md](../AUDIO.md). Newest first. How entries are written: [README.md](README.md).

### 2026-11-20 · `2a6c8a1` · Docs: audit fixes (log redaction, failed-export clean-up, admin token storage, offline facilitator commands, action resend, REST errors, verify warning, reason catalogue, layout classes); change logs

- **Type:** Risk mitigation
- **Change:** The **Integrity** row of § 7 says `verify` reports a header-only orphan file (a crash between creating a track's file and storing its row) as a warning, not a problem. § 8 adds that the player's indicator, the facilitator's mic-column tooltip and the server's refusal of an audio message all take their wording from one catalogue per reason (`NOT_RECORDING_REASONS`).
- **Reason:** A harmless crash leftover made the integrity check fail, and three copies of the reason texts could drift apart (docs drifting from the code).

### 2026-11-19 · `7f0e859` · Docs: session startup flow (welcome page, eleven setup steps, consent sections, mic check hold until the briefing, calibration readiness); change logs

- **Type:** Feature
- **Change:** § 2, § 8 and § 9 (with their state and sequence diagrams) now describe the **mic check hold** until every seat has finished the briefing, the mic check as the last onboarding step, and the readiness step: each recorded seat says it is ready (`CalibrationReady`), the server then starts the calibration itself, and a redo asks again (`CalibrationRequested`). § 5 adds `calibration:ready` and the welcome page that explains the certificate warning; § 14 lists the new code and tests.
- **Reason:** The calibration should never start by surprise, and no microphone should record while anyone is still reading; the questionnaire and briefing are therefore no longer recorded (privacy, data minimisation).

### 2026-11-19 · `311f714` · Wrap-up: an offline recorded seat counts as still uploading, not "All audio uploaded"

- **Type:** Bug fix
- **Change:** The known limit on the wrap-up audio check (§ 13) now says it also checks that the seat is connected: a recorded seat that is offline is listed as still uploading.
- **Reason:** The check said *All audio uploaded* for a seat whose browser had gone offline with audio still unsent (data loss).

### 2026-11-19 · `2ea6151` · Audio: late-chunk grace outlasts the browser's 30-minute buffer, so a long outage keeps its audio

- **Type:** Bug fix
- **Change:** The reconnect sequence diagram and the **Late chunks** paragraph in § 5 now say a closed track accepts late chunks for 35 minutes, not 10.
- **Reason:** The grace period was shorter than the browser's 30-minute buffer, so a long outage lost recorded audio (data loss).

### 2026-11-19 · `4e6927e` · Audio: recording windows and calibration runs come from the reducer

- **Type:** Risk mitigation
- **Change:** The **Pause** paragraph of § 8 adds that the recording pauses and the moment the game was complete are part of the game state, worked out from the event log, so a late chunk of audio is cut at the same place after a server restart.
- **Reason:** The server used to keep its own copy of these moments next to the log; the text now names the one source the code uses, which protects against audio from a pause being stored after a restart (privacy and research validity).

### 2026-11-19 · `bee2f52` · Docs: recording controller states, mic-check attempt, session guard

- **Type:** Bug fix
- **Change:** § 4 describes the recording controller as a state machine (idle, running, failed) and says a mic check in progress keeps listening when a detached session comes back. § 11 adds that audio deletion is also refused while an attribution runs, decided by one guard, and § 13 says per-track `dropped_chunks` is approximate.
- **Reason:** The mic check asked for Start again after a detached session came back although the mic was recording, § 11 left out a refusal the code already made, and a drop can be counted on the wrong track (research validity).

### 2026-11-19 · `0126dec` · Docs: personal-data map, recording verdict, audio reason catalogue, seat gate

- **Type:** Bug fix
- **Change:** § 8 describes the recording verdict (the fixed order in which the reason for not recording is chosen, and the new `notRecording` field), and the track tables now say that a lost microphone stops with `track_ended`, which counts as interrupted, also for tracks recorded earlier. § 4 and the code map point to the reason catalogue, the verdict and the personal-data map.
- **Reason:** Tracks whose microphone went away were exported as cleanly `closed`, against the status column's own meaning, and the reason lists had been copied by hand into places that disagreed (also a research-validity risk).

### 2026-11-19 · `490686a` · Docs: headset gate engine, speech model, storage fixes

- **Type:** Feature
- **Change:** § 1 and § 2 add the hardware assumption (one wired single-ear USB headset per player, no Bluetooth) and the shipped, checksum-checked speech model. § 10 is rewritten for the new engine, a speech detector (Silero VAD) plus a level gate between the mics, with a new pipeline diagram and new synthetic accuracy figures with and without a calibration; § 6, § 9, § 11 and § 13 follow (one clock line per track and no lag refinement, leakage and the 12 dB gain-invariant pass margin from the calibration, export timing only from this engine version, `.partial` export folders, damaged clean records kept in place, erased seats removed from overlap partners, new limits).
- **Reason:** The energy-pattern engine was replaced by a simpler method that relies on close headset microphones, and the storage layer was fixed; the design reference must describe the method the code runs and what it cannot do.

### 2026-11-19 · `f309df0` · Seats survive session switches; read-only GameState; audio waits for the seat

- **Type:** Bug fix
- **Change:** The browser-events table adds the detached session (the seat kept: stop `disconnect`, start `reconnect`, unsent chunks kept). A paragraph *Waiting for the seat* says that each upload attempt waits until the socket is seated, and that an attempt the queue gave up on is cancelled before it is sent.
- **Reason:** Uploads emitted right after a reconnect were refused ("Not seated") and retried; a session switch dropped the unsent audio together with the seat token.

### 2026-11-19 · `0f343ea` · Typed socket protocol, intent resend after reconnect, CalibrationRunner

- **Type:** Risk mitigation
- **Change:** The code map names `session/CalibrationRunner.ts` for the timed turns and the quick check.
- **Reason:** The calibration moved out of SessionManager into its own module; behaviour is unchanged.

### 2026-11-19 · `5c76bd2` · Simplify the audio feature: shared helpers and types, fewer duplicates, cheaper hot paths (#16)

- **Type:** Bug fix
- **Change:** The track-status paragraph now says a track closed with `interrupted` after a restart reads as `interrupted` in the REST and CSV view, not `closed`.
- **Reason:** The cleanup in #16 merged the two `trackStatusOf` copies; the one REST and CSV now use also counts the stop reason `interrupted` as interrupted, as the shared schema already said.

### 2026-11-19 · `2428109` · Docs: audio design document (AUDIO.md), docs sweep against the built behaviour and change logs (U14) (#14)

- **Type:** Feature
- **Change:** Document created. It describes the audio design in diagrams: the architecture, the browser capture pipeline, upload with acknowledgements and retries, the timing model (client timestamps, clock offset, drift), the encrypted file format and keys, the recording lifecycle with the consent hold, the calibration sequence, the attribution algorithm step by step, export and deletion, and the data types. It also lists the known limits and a code map.
- **Reason:** Microphone recording is a new subsystem built in four parts by different workers. One design reference that matches the code lets a reader (or an assessor) follow the whole path from microphone to clean track, and states what the method cannot do.
