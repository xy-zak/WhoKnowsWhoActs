# Change log: DATA-TYPES.md

History of [DATA-TYPES.md](../DATA-TYPES.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · grid map, scores and game rules (documents the code in the same commit)

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
