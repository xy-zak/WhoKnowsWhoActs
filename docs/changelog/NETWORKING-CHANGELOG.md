# Change log: NETWORKING.md

History of [NETWORKING.md](../NETWORKING.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · typed socket protocol, intent resend after reconnect

- **Type:** Bug fix
- **Change:** § 7 now says how the browser keeps an action until it is answered: it sends only while its socket is seated, resends unanswered actions unchanged after every reconnect, and gives up after 45 s; the server answers a resend with its first answer, also after a restart. It explains the transient "Not seated" refusal (`retry: true`) and why onboarding requests wait for `hello`'s answer. The reconnect diagram marks the moment the socket is seated again. § 9 describes the schema tables and the typed Socket.IO event maps derived from them.
- **Reason:** § 7 described a resend that the browser did not do: an action made during a drop was flushed by Socket.IO before `hello`, refused as "Not seated" and lost. The browser now does what the document said, and the protocol types are now checked at both ends.

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio)

- **Type:** Feature
- **Change:** The REST table adds the six audio routes and the `audio` export kind. § 8 notes that audio timestamps use the clock offset. A new § 14 *Microphone audio on the network* covers the secure context, messages, chunk size, data rate, acknowledgements, retries, late chunks, volatile levels, reconnects and the fingerprint comparison. § 12 and § 13 get audio rows. The advice not to install a certificate on participants' laptops is stated (compare fingerprints instead).
- **Reason:** The protocol narrative must say how audio travels, what happens when the network drops, and what limits apply. The generated catalogue lists the messages but not the retry and late-chunk behaviour.

### 2026-11-18 · `b84158a` · Audio: live recording path on the server (consent hold, mic check, calibration, ingest) (#10)

- **Type:** Feature
- **Change:** The generated message catalogue now lists the mic check and audio messages with the acknowledgement type, the extra start and stop reasons and the `requesting` state. The `CalibrationSkipped` field `cancelled` is added to the generated tables.
- **Reason:** The live recording path on the server changed the messages and their acknowledgements, and the catalogue is generated from the schemas.

### 2026-11-18 · `fe15759` · Self-signed HTTPS by default (WKWA_TLS=auto) for microphone access (#6)

- **Type:** Feature
- **Change:** § 4 (environment and URL tables), § 11 (a new subsection on the self-signed certificate with a regeneration flowchart, plus the man-in-the-middle and key-theft rows) and § 13 (certificate troubleshooting rows) describe HTTPS by default. The fingerprint check is introduced as the way to compare certificates.
- **Reason:** Browsers allow the microphone only on secure pages, so the server uses HTTPS with a certificate it makes itself. The network design had to say what that means for participants.

### 2026-11-18 · `0f6971a` · Shared audio contracts: config, events, messages, state, projections, REST types (#5)

- **Type:** Feature
- **Change:** The generated message catalogue adds the player messages `mic:check`, `audio:start`, `audio:chunk`, `audio:stop` and `audio:level`, and the facilitator messages for calibration, mic skip and recording pause.
- **Reason:** Microphone recording adds messages. The catalogue is generated from the schemas, so it lists them as soon as they exist.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

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
