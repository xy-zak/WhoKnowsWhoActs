# Change log: SESSION-RUNBOOK.md

History of [SESSION-RUNBOOK.md](../SESSION-RUNBOOK.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · grid map, scores and game rules (documents the code in the same commit)

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
