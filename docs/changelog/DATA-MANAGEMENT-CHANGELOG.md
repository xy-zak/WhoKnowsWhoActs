# Change log: DATA-MANAGEMENT.md

History of [DATA-MANAGEMENT.md](../DATA-MANAGEMENT.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · grid map, scores and game rules (documents the code in the same commit)

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
