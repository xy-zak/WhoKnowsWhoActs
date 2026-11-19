# Change log: SESSION-RUNBOOK.md

History of [SESSION-RUNBOOK.md](../SESSION-RUNBOOK.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `880ecba` (Headset gate engine: Silero VAD + cross-channel level gate; storage fixes) and `c438572` (e2e server: speech by energy for the bots' synthetic audio)

- **Type:** Risk mitigation
- **Change:** § 2, § 3, § 7 and § 11 now ask for one wired single-ear USB headset per player (no Bluetooth), describe the new mic-check instructions, the 12 dB calibration pass margin with headset advice, the speech-detector line of the DATABASE result (the Lag column is gone), the refusal of erasure while a job runs, and `WKWA_SPEECH_MODEL=off` for bot dry runs; § 6 gets a row for a seat with a low calibration margin.
- **Reason:** Attribution now depends on headsets worn close to the mouth (research validity), and bot audio would otherwise give an empty attribution.

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio)

- **Type:** Feature
- **Change:** A new § 11 *Sessions with audio* (flow diagram) covers preparation, setup step 04, the consent hold, the mic check, the calibration, pausing recording, a failing microphone, a withdrawing participant, the wrap-up audio check and the DATABASE audio actions (attribution, export, delete raw audio). §§ 2 to 7 get matching checklist items, NEXT rows and troubleshooting rows.
- **Reason:** Audio adds steps the facilitator must do in the right order and decisions to make live (pause for crosstalk, skip a mic, wait for uploads). The runbook is how those are done the same way at every session.

### 2026-11-18 · `fe15759` · Self-signed HTTPS by default (WKWA_TLS=auto) for microphone access (#6)

- **Type:** Risk mitigation
- **Change:** A new § 10 explains the certificate warning for Chrome, Edge, Firefox and Safari, how to compare the fingerprint, when the warning returns, and how participants can remove the exception afterwards. Setup, session-day and troubleshooting steps use `https://` URLs.
- **Reason:** Each participant must accept the certificate knowingly, because accepting it blindly would let an impostor on the network capture audio. Nothing is installed on their laptops.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Feature
- **Change:** The preparation checklist describes the new scenario files (`scenario.json`, `scores.json`) and both demos. Step 01 explains the starting-score preview, the start map score and the game-rules choice; step 08 says the P label decides which sub-square a seat acts on. LIVE describes the composite map with scores and the square comparison, and revoking restores the scores.
- **Reason:** Facilitators must check the right things in setup and understand what revoking does to the scores.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Feature
- **Change:** New § 8 *Simulated sessions* and § 9 *Testing without people: fake players* describe both procedures step by step, with a flowchart, what the data records and how to clean up afterwards. The overview mentions the DATABASE switch and the `–` glyph for skipped steps, and steps 03 and 07 point to the new sections.
- **Reason:** Facilitators need a procedure for each new mode. Fake players replace `npm run bots` for rehearsals because their data is marked as fake.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** Player-screen appearance is removed from setup step 03, because each participant now sets colours, font, text size and animations on their own screen. Takedown cards are downloaded as one A6 PDF per seat. New instructions cover deleting practice or failed sessions, and the keyboard shortcuts are updated.
- **Reason:** The steps must match the screens the facilitator actually sees.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** Setup steps are described as collapsible panels instead of popups. Step 08 explains how to choose an aligned or dissociated (D1–D6) K–P pairing, and "Terminal" becomes "Client". Replay speed (1 s per action) and the new theme and animation keys are added.
- **Reason:** This keeps the runbook in line with the redesigned setup and labelling, so every session is run the same way.

### 2026-11-16 · `2f11891` · Docs and screenshots for the UI pass

- **Type:** Feature
- **Change:** The runbook is rewritten for the restructured facilitator manager. It covers the SETUP|LIVE, REPLAY and DATABASE tabs, the ten setup steps, the LIVE lifecycle with its NEXT panel (which always shows the one next action), the wrap-up popups, tags and shortcuts.
- **Reason:** The old instructions referred to screens that no longer existed.

### 2026-11-16 · `e7871f4` · Add README, session runbook and reconcile docs with the implementation

- **Type:** Risk mitigation
- **Change:** Document created. It has checklists for before the study and for the day before, session-day steps with a flow diagram, wrap-up, a troubleshooting table and a printable checklist.
- **Reason:** A fixed procedure means every session is run the same way, and key steps such as consent, handing out takedown cards and exporting data are not forgotten.
