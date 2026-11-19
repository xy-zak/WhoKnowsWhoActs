# Change log: DATA-MANAGEMENT.md

History of [DATA-MANAGEMENT.md](../DATA-MANAGEMENT.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `880ecba` (Headset gate engine: Silero VAD + cross-channel level gate; storage fixes)

- **Type:** Risk mitigation
- **Change:** § 1, § 2 and § 8 say that who spoke when now combines a speech/non-speech model (Silero VAD) with loudness, and why that is not biometric processing (no voice description, the model's numbers are not stored). § 10 and § 11 add that an erasure removes the erased seat from the other seats' overlap partners and clears the session's job summaries, that erasure and session deletion wait for a running attribution or audio export, and that audio exports are written under a `.partial` name; risks #19, #22 and #26 reflect the headset set-up.
- **Reason:** A model now processes the voices, and the commit closes gaps where an erased seat or an unregistered folder of voice files could remain (privacy, data protection).

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio, checked against the build)

- **Type:** Bug fix
- **Change:** The text written before the build is corrected. The **consent hold** replaces "keep the room quiet during consent" and the open decliner placeholder (no mic opens until every real seat has consented). Raw deletion removes cleaned tracks too, and `--scope all` removes every audio row including speech segments (the text said they stayed). Erasure removes every seat's cleaned track and the session's attribution results (the text said they were kept). Export contents, the register entry, the `audio-deletions` command, the verify checks and the placeholder list are brought in line.
- **Reason:** The document must describe what the software does, because it supports the ethics application and the consent text. Several claims came from the plan, not the code.

### 2026-11-18 · `fefc596` · Docs: microphone audio in the data management and GDPR design (#2)

- **Type:** Risk mitigation
- **Change:** The audio design is added to the hand-written sections: summary, legal basis (separate required consent item, voice as personal data, not biometric by design), inventory rows, data-flow and lifecycle diagrams, consent, minimisation, encryption, erasure, exports, retention placeholders, risks 19 to 30, checklist and CLI.
- **Reason:** Recording voice is the most identifying data the harness collects, so its legal basis, consent, erasure and risks had to be written down before it was built.

### 2026-11-18 · `0f6971a` · Shared audio contracts: config, events, messages, state, projections, REST types (#5)

- **Type:** Feature
- **Change:** The generated data-class summary gains the class **voice · identifying** and the audio events and the `mic_permission` telemetry type.
- **Reason:** The classification is generated from the schema metadata, which now includes audio.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Risk mitigation
- **Change:** The data inventory row for proposals and decisions now names the target sub-square and the score changes, and the minimisation table speaks of sub-squares and squares instead of regions.
- **Reason:** The inventory must list exactly what is stored; score changes are game data tied to a seat, so they share the pseudonymous classification of the actions.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Risk mitigation
- **Change:** New § 17 describes the separate simulation database (`data/wkwa-sim.db`, same encryption and passphrase). New § 18 covers fake players, which are marked in the data and get no participant code, consent record or questionnaire answers. The summary, data inventory, data-flow diagram, consent design, encryption, exports, retention, risk table (risks 15–18) and command reference (`--sim`) were updated to match.
- **Reason:** Synthetic and test data must never be mistaken for participants' data (research validity), and an ethics reviewer needs to see that neither feature invents consent or personal data.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** A new procedure covers deleting an entire session: what is removed, that running sessions are refused, and a register of hashed codes that lets the deletion be repeated after a backup restore. The data inventory adds rows for this register and for player display settings (colours, font, text size, animations), which are never sent to the server or logged.
- **Reason:** Practice runs and groups that withdraw together need a clean way to be removed. Not logging display choices also avoids recording possible hints of a visual impairment or dyslexia.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** In the data inventory, "terminal number" becomes "client number". The stored field keeps the name `terminal`.
- **Reason:** This matches the new wording in the interface.

### 2026-11-16 · `2f11891` · Docs and screenshots for the UI pass

- **Type:** Risk mitigation
- **Change:** The takedown sequence diagram and the erasure steps now point to the new **DATABASE** tab of the facilitator manager, replacing the old "Sessions & data" page.
- **Reason:** With an outdated screen name, a researcher could struggle to find the erasure screen and delay a participant's takedown request.

### 2026-11-16 · `478d660` · Replace condition with session tags; add player appearance setting

- **Type:** Feature
- **Change:** The inventory row for session configuration now includes session tags and the player-screen appearance (theme and CRT effects). It warns that tags must not contain names.
- **Reason:** Tags replaced the single "condition" label, and appearance became part of the experimental condition. Both are kept so the session can be reproduced.

### 2026-11-16 · `e7871f4` · Add README, session runbook and reconcile docs with the implementation

- **Type:** Risk mitigation
- **Change:** The consent and erasure instructions now name the real dashboard screen (*Sessions & data → Takedown / erasure*). They also note that erasure is refused while the participant's session is still running.
- **Reason:** A wrong screen name in a GDPR procedure can stall a takedown. The running-session rule stops data being erased in the middle of a game.

### 2026-11-16 · `7e7b590` · Add design documentation with diagrams and doc generator

- **Type:** Risk mitigation
- **Change:** Document created. It sets out the GDPR design: roles and legal basis, data inventory, data-flow diagram, pseudonymisation (participants are known only by a random code), consent, encryption, the takedown procedure, anonymisation, retention, a DPIA-style risk table (data protection impact assessment), an ethics checklist and commands.
- **Reason:** The study collects personal data. The ethics committee and privacy officer need one place that shows what is stored, why, and how it can be removed.
