# Change log: NETWORKING.md

History of [NETWORKING.md](../NETWORKING.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · grid map, scores and game rules (documents the code in the same commit)

- **Type:** Feature
- **Change:** The `state` message (generated) now lists the grid, the player's own knowledge type's scores, the map score and the knowledge type the player acts on. The REST table describes `/api/scenarios/:id` as board, views and starting scores, and the proposal effect is called a mark.
- **Reason:** The player's projection changed with the grid map; the protocol description must say what a browser receives, because the asymmetry of knowledge is enforced there.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Feature
- **Change:** § 5 explains that simulated sessions have no client binding, and that fake players are network clients the server starts itself (new sequence diagram). The generated message catalogue adds `simulation:start` and `fake:add`, the REST table covers both databases (`players`, `fakeSeats`), and the security table says a browser cannot pretend to be a fake player.
- **Reason:** Both features change what the facilitator sends and what the API returns, and skipping consent must only be possible for clients the server created.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** In the REST API table, the single printable takedown-card page is replaced by a list of cards plus one A6 PDF per seat. New endpoints delete a whole session and show the session-deletion register.
- **Reason:** Each participant can now get their own printed card, and practice or withdrawn sessions can be removed. Deletion is refused while a session is running and requires typing the session ID, which guards against accidental data loss.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** "Terminal" becomes "Client" in the sequence diagrams, the browser-identity section, the message catalogue and troubleshooting. The label messages (`labels:set`, `labels:randomise`) now carry the K–P pairing, which sets how each seat's knowledge label is matched with a power label.
- **Reason:** This follows the new labelling design and the interface's wording. The protocol fields keep the name `terminal`, so older recordings still parse.

### 2026-11-16 · `a3bf84e` · Restructure the facilitator manager: SETUP/LIVE · REPLAY · DATABASE

- **Type:** Feature
- **Change:** Two REST endpoints are added: the full scenario, used for the map preview during setup, and server info, which lists the player URLs on the local network.
- **Reason:** The new step-by-step setup shows a map preview and tells the facilitator which address to open on each player PC.

### 2026-11-16 · `e7871f4` · Add README, session runbook and reconcile docs with the implementation

- **Type:** Risk mitigation
- **Change:** The REST API table now matches the server. It adds the session-defaults and session-scenario endpoints, paging for telemetry, and fuller details on participant lookup and erasure, including that erasure is refused while that participant's session is still running.
- **Reason:** The table had drifted from the implementation. The update also makes the erasure safeguard explicit.

### 2026-11-16 · `7e7b590` · Add design documentation with diagrams and doc generator

- **Type:** Feature
- **Change:** Document created. It covers the physical and logical network set-up (hub and spoke: players talk only to the facilitator laptop), browser identity and reconnects, clock synchronisation, a message catalogue generated from the code, the REST API, LAN security, a checklist and troubleshooting.
- **Reason:** A session can only run if the local network works first time. This document explains how it works and what to do when it doesn't.
