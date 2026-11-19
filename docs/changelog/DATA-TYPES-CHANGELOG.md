# Change log: DATA-TYPES.md

History of [DATA-TYPES.md](../DATA-TYPES.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `72c5778`

- **Type:** Risk mitigation
- **Change:** The `audio_tracks` row for `dropped_chunks` says the count is of chunks dropped while the track was recording, which can include an older track's chunks, and links the known limit in AUDIO.md § 13.
- **Reason:** The per-track figure can be shifted between neighbouring tracks, so analysts should not read it as exact.

### 2026-11-19 · `0126dec` · Docs: personal-data map, recording verdict, audio reason catalogue, seat gate

- **Type:** Risk mitigation
- **Change:** The hand-written `audio_tracks.status` row adds `track_ended` to the stop reasons shown as `interrupted` and names the audio reason catalogue as their source, pointing to the generated column text.
- **Reason:** The row was a hand copy of a list the code had changed; the generated text below it cannot drift.

### 2026-11-19 · `dc1a59f` · Audio: a track that ends because the mic went away counts as interrupted

- **Type:** Bug fix
- **Change:** The generated `status` column of `audio_tracks.csv` lists `track_ended` among the stop reasons that make a track `interrupted`.
- **Reason:** The browser reports a lost microphone as `track_ended`, so those tracks were exported as `closed` although the column defines `interrupted` as "the browser or microphone went away".

### 2026-11-19 · `07fcc02` · Audio reason catalogue: one source for start/stop reasons and mic states

- **Type:** Bug fix
- **Change:** In the generated `audio_tracks.csv` table, `start_reason` and `stop_reason` now list all 9 start and 17 stop reasons with their meaning (before: 5 and 9), and `status` names the stop reasons that count as interrupted.
- **Reason:** The codebook texts were typed by hand and had fallen behind the schemas; they are now generated from the audio reason catalogue, so researchers see every value that can occur.

### 2026-11-19 · `490686a` · Docs: headset gate engine, speech model, storage fixes

- **Type:** Feature
- **Change:** The *Audio storage* table describes the new content of the `quality_report` (speech detector, per-seat coverage, clipping, noise floor, speech level, drift, talk time) and `leakage_matrix` results, names the engine version `wkwa-gate-attribution/2.0.0` and says that *Export audio* reuses a stored alignment only from that version. It also states that an erasure strips the erased seat from kept speech segments and clears `audio_jobs.result_json`.
- **Reason:** The new attribution engine stores results of a different shape (an older alignment can no longer be read), and the erasure now changes stored rows of other seats.

### 2026-11-19 · `5c76bd2` · Simplify the audio feature: shared helpers and types, fewer duplicates, cheaper hot paths (#16)

- **Type:** Bug fix
- **Change:** The `audio_tracks.status` row now lists the stop reason `interrupted` among those the REST API shows as `interrupted`.
- **Reason:** The cleanup in #16 merged the two `trackStatusOf` copies; the one REST and CSV now use also counts the stop reason `interrupted` as interrupted, as the shared schema already said.

### 2026-11-19 · `2428109` · Docs: audio design document (AUDIO.md), docs sweep against the built behaviour and change logs (U14) (#14)

- **Type:** Feature
- **Change:** The overview table and the ER diagram add the five audio tables and `exports.details_json`. A new *Audio storage* section gives the `.wka` file layout and a column table for every audio table, and the acknowledgement shape. The *Other tables* rows for `exports` and `erasures` cover audio, and the statements on participant codes and on what is never logged now include the audio tables and microphone names.
- **Reason:** The hand-written part of the catalogue must show where audio and its keys are stored, and that file names never contain a code, so the erasure path stays complete.

### 2026-11-18 · `f7bfd8b` · Audio: attribution jobs, audio REST routes, registered "Export audio", audio CSVs (U10) (#9)

- **Type:** Feature
- **Change:** The generated export-file section adds `audio_tracks.csv` and `speech_segments.csv`.
- **Reason:** Standard and anonymised exports now carry the audio index and the who-spoke-when timing, and the codebook is generated from the export contract.

### 2026-11-18 · `b84158a` · Audio: live recording path on the server (consent hold, mic check, calibration, ingest) (#10)

- **Type:** Feature
- **Change:** The generated event sections update `AudioTrackStarted` and `AudioTrackStopped` with the browser engine reasons, and add the `cancelled` field of `CalibrationSkipped`.
- **Reason:** The server accepts the capture engine's start and stop reasons, so the fields and their meanings changed.

### 2026-11-18 · `0f6971a` · Shared audio contracts: config, events, messages, state, projections, REST types (#5)

- **Type:** Feature
- **Change:** The generated sections add the events `MicCheckCompleted`, `MicCheckSkipped`, `AudioTrackStarted`, `AudioTrackStopped`, `Calibration*`, `RecordingPaused` and `RecordingResumed`, the telemetry type `mic_permission`, the `audio` session setting and the mic check and calibration screens.
- **Reason:** Microphone recording adds records and settings; every one is documented from its schema.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Feature
- **Change:** The generated sections add `board`, `initialScores` and `rules` to `SessionCreated`, `scoreChanges` to `ProposalMade`, `DecisionMade` and `ActionRevoked`, the `rules` setting, and the `square_id`, `target_k`, `score_changes` and `map_score_after` columns of `actions.csv`; region ids are now sub-squares such as `C7-Kb`. The worked example "One action, all its traces" follows one proposal on the grid.
- **Reason:** Analysts need to know what every new field means, and that the recorded score changes, not the current rules, are the record of what happened.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Feature
- **Change:** The generated sections add the `AgentBound` event, `fake` and `fakePace` on `SeatBound`, the `players` and `simulation` session settings, the `agent_policy` and `fake_player` columns of `players.csv`, and `fakeSeats` in `session.json`. The storage model describes the second database file for simulations and the new index on `events.type` (schema version 5, i.e. the fifth layout of the database).
- **Reason:** Every new field is documented, so analysts can tell simulated sessions and fake seats apart from participants.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** The `appearance` block is removed from the session configuration and from its example event. A new `session_deletions` table is described (database schema v4, i.e. the fourth version of the database layout), with the deleted session, when it was deleted, row counts and hashed participant codes.
- **Reason:** Display settings are now a private choice on each screen, not session data. The deletion register lets a deletion be repeated after a backup is restored.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** A new **Label pairings** section has a generated table of the allowed K–P pairings: *aligned* (Ka–Pa …) or one of six *fully dissociated* pairings, D1–D6, where no seat holds matching letters. `LabelsAssigned` events now store the pairing used, `allowDuplicateLabels` is removed, and player appearance gains a high-contrast theme, with `playerCrt` renamed to `playerAnimations`.
- **Reason:** Allowing only two clear kinds of pairing keeps the experimental manipulation (who knows vs. who acts) unambiguous, and recording the pairing makes every session analysable.

### 2026-11-16 · `478d660` · Replace condition with session tags; add player appearance setting

- **Type:** Feature
- **Change:** The free-text `condition` field is replaced by a list of session tags, in the configuration, the `sessions` table (schema v3, `tags_json`) and the `session.json` export. A player-screen `appearance` setting (theme and CRT effects) is added.
- **Reason:** Tags let researchers label a session with several attributes (e.g. "pilot", "condition-A"). Old condition values are converted automatically, so earlier data stays usable.

### 2026-11-16 · `5a67d17` · Add GDPR tooling: exports, erasure, anonymisation, print, CLI

- **Type:** Risk mitigation
- **Change:** A `last_seq` column (schema v2) is documented, which ensures event sequence numbers are never reused after a participant is erased. `ms_since_round_start` is clarified to count only active time, excluding pauses.
- **Reason:** Without this column, erasing data could let new events take old numbers and confuse the event order. The timing definition was ambiguous for analysis.

### 2026-11-16 · `7e7b590` · Add design documentation with diagrams and doc generator

- **Type:** Feature
- **Change:** Document created. It is a field-level catalogue of every stored record: game events, telemetry, session configuration, database tables (with an ER diagram) and export files, plus one action traced through all of its records. Most tables are generated from the code's schemas, and a test fails if they fall out of date.
- **Reason:** It answers "what exactly is recorded, when, and about whom?" for the ethics application and the analysis scripts.
