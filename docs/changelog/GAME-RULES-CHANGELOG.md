# Change log: GAME-RULES.md

History of [GAME-RULES.md](../GAME-RULES.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `03fa07e`

- **Type:** Risk mitigation
- **Change:** § 3 points to the new step numbers: views chosen per seat are switched on in step 04 and picked in the **Labels** step 09.
- **Reason:** The setup steps were renumbered when **Who plays** became its own step.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Feature
- **Change:** Document created. It describes the grid map (squares of four knowledge-type sub-squares, ids such as `C7-Kb`), who sees which scores, targeting by power type (Pa → Ka …), what a proposal and a decision do to the scores (+4 / −1 within 0–10), the map score, rounds, revoking, how the rules are applied and recorded (flowchart), versioning, how to change the rules, and the scenario format. The rule-set table is generated from the code.
- **Reason:** The game rules are expected to change often during the game design. One document that matches the code, together with rules kept in a single file, lets them change without affecting the rest of the harness or the meaning of data already collected.
