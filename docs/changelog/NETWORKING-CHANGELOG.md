# Change log: NETWORKING.md

History of [NETWORKING.md](../NETWORKING.md). Newest first. How entries are written: [README.md](README.md).

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
