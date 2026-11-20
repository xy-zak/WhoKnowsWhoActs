# Change log: NETWORKING.md

History of [NETWORKING.md](../NETWORKING.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `7f73c59`, `74f74ac`, `95904fc`, `15615b1`, `4c1f565`

- **Type:** Risk mitigation
- **Change:** § 7 adds that an action whose processing failed before anything was logged is processed again on resend, not answered as a duplicate, and that the facilitator dashboard refuses a command while offline instead of queuing it. § 9 points to `packages/shared/src/rest.ts` for the REST response types; § 10 states the error answer (status and `{ "error" }`); § 11 says the dashboard keeps `ADMIN_TOKEN` in the tab's `sessionStorage`, never in `localStorage`.
- **Reason:** These fixes stop a lost action, a command that runs late after a reconnect, and an admin token readable by player pages on the same address (security); the document must describe the behaviour as built.

### 2026-11-19 · `7c129ae` · Server: no meta.json for the self-signed certificate; its facts come from the certificate

- **Type:** Risk mitigation
- **Change:** The self-signed certificate's **Files** row in § 11 drops `data/tls/meta.json`: the names, expiry and fingerprint are read from the certificate itself.
- **Reason:** The separate file could disagree with the certificate it described; the document must list the files the server actually writes.

### 2026-11-19 · `7f0e859` · Docs: session startup flow (welcome page, eleven setup steps, consent sections, mic check hold until the briefing, calibration readiness); change logs

- **Type:** Feature
- **Change:** § 4 replaces `HTTP_REDIRECT_PORT` with `LANDING_PORT` and adds the subsection **The welcome page**; § 2 and § 5 (topology and seat-binding diagrams) show participants opening it first; § 10 adds `GET /api/landing` and `landingUrls`; § 11 explains why the page is plain HTTP and carries nothing about the session; § 12–14 update the firewall, checklist, troubleshooting and step numbers.
- **Reason:** Participants need a page that opens without a certificate warning and explains that warning before they meet it; the page must not expose session data over unencrypted HTTP (privacy).

### 2026-11-19 · `2ea6151` · Audio: late-chunk grace outlasts the browser's 30-minute buffer, so a long outage keeps its audio

- **Type:** Bug fix
- **Change:** The `audio:chunk` row of the message catalogue and the **Late chunks** row of § 14 now say a closed track accepts resent chunks for 35 minutes, not 10.
- **Reason:** The server refused audio the browser was still allowed to hold (up to 30 minutes), so a long outage lost recorded speech (data loss).

### 2026-11-19 · `03fa07e` · Session startup: who-plays step, create step, consent sections, calibration after the room is ready, welcome page

- **Type:** Feature
- **Change:** The generated message catalogue adds the player message `calibration:ready` and says that `calibration:start` and `calibration:redo` now wait until every recorded seat is ready.
- **Reason:** The calibration starts only once every player has said they are ready, so it never starts by surprise.

### 2026-11-19 · `ead1760` · Hover follows the telemetry consent rule; no stale dashboard after a failed switch

- **Type:** Risk mitigation
- **Change:** The message catalogue rows for `presence` and `presence:live` say that hover is dropped before consent, after a withdrawal and after the session ended, and that the facilitator is sent `null` when a seat withdraws, is unbound or disconnects.
- **Reason:** The protocol description must match the new consent rule for hover, and the old hover marker of a seat that left stayed on the facilitator's map (privacy, with a display bug fixed).

### 2026-11-19 · `bee2f52` · Docs: recording controller states, mic-check attempt, session guard

- **Type:** Bug fix
- **Change:** The REST table now gives every 409 refusal of the audio routes: starting an attribution is also refused while the session runs or an audio export is written, exporting audio while the session runs or an attribution is queued or running, and deleting audio while an attribution or export is in progress.
- **Reason:** The routes already refused these cases, but the table listed only some of them; the session guard now holds all of them in one rule table, which the text follows.

### 2026-11-19 · `0126dec` · Docs: personal-data map, recording verdict, audio reason catalogue, seat gate

- **Type:** Bug fix
- **Change:** § 7 adds the seat gate with a table of the five delivery policies (`once`, `whileSeated`, `attempt`, `retry`, `resend`) and the messages that use them, and states that telemetry waits for the seat and that an onboarding request refused as "Not seated" is sent again once seated, while an unanswered one is still never resent.
- **Reason:** An onboarding request that reached the server during a reconnect showed an error although sending it again would have worked, and each kind of message had its own waiting and resend rules.

### 2026-11-19 · `490686a` · Docs: headset gate engine, speech model, storage fixes

- **Type:** Feature
- **Change:** § 4 adds the environment variable `WKWA_SPEECH_MODEL` (`off` = speech found by energy instead of the speech model, for bots and demos; the e2e server sets it). In § 10, session deletion and participant erasure are refused (409) while an attribution or audio export of the session runs, the audio export folder is written as `.partial` and renamed once registered, and the job summary names the speech detector (the per-seat lag figure is gone).
- **Reason:** The commit adds the setting, new refusals and a new export sequence, and changes the attribution summary sent over REST.

### 2026-11-19 · `f309df0` · Seats survive session switches; read-only GameState; audio waits for the seat

- **Type:** Bug fix
- **Change:** The generated catalogue adds the `/player` message `detached` and narrows `unbound` to a released seat. § 7 gets a subsection *Switching sessions keeps the seats* with a sequence diagram, and a bullet on audio uploads waiting for the seat (and the cancelled attempt that prevents a double send).
- **Reason:** Resuming another session, an erasure's reload or a deletion sent `unbound`, so every browser deleted its seat token: switching back left the players unable to re-claim seats that are locked after onboarding. Audio uploads after a reconnect were refused as "Not seated" first and only then retried.

### 2026-11-19 · `0f343ea` · Typed socket protocol, intent resend after reconnect, CalibrationRunner

- **Type:** Bug fix
- **Change:** § 7 now says how the browser keeps an action until it is answered: it sends only while its socket is seated, resends unanswered actions unchanged after every reconnect, and gives up after 45 s; the server answers a resend with its first answer, also after a restart. It explains the transient "Not seated" refusal (`retry: true`) and why onboarding requests wait for `hello`'s answer. The reconnect diagram marks the moment the socket is seated again. § 9 describes the schema tables and the typed Socket.IO event maps derived from them.
- **Reason:** § 7 described a resend that the browser did not do: an action made during a drop was flushed by Socket.IO before `hello`, refused as "Not seated" and lost. The browser now does what the document said, and the protocol types are now checked at both ends.

### 2026-11-19 · `2428109` · Docs: audio design document (AUDIO.md), docs sweep against the built behaviour and change logs (U14) (#14)

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
