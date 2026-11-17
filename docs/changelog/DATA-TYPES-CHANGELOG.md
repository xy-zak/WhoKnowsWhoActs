# Change log: DATA-TYPES.md

History of [DATA-TYPES.md](../DATA-TYPES.md). Newest first. How entries are written: [README.md](README.md).

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
