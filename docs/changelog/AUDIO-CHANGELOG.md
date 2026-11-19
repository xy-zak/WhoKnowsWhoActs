# Change log: AUDIO.md

History of [AUDIO.md](../AUDIO.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `07fcc02`, `088ab40`, `f5bce64` and `dc1a59f`

- **Type:** Bug fix
- **Change:** § 8 describes the recording verdict (the fixed order in which the reason for not recording is chosen, and the new `notRecording` field), and the track tables now say that a lost microphone stops with `track_ended`, which counts as interrupted, also for tracks recorded earlier. § 4 and the code map point to the reason catalogue, the verdict and the personal-data map.
- **Reason:** Tracks whose microphone went away were exported as cleanly `closed`, against the status column's own meaning, and the reason lists had been copied by hand into places that disagreed (also a research-validity risk).

### 2026-11-19 · `490686a` · Docs: headset gate engine, speech model, storage fixes

- **Type:** Feature
- **Change:** § 1 and § 2 add the hardware assumption (one wired single-ear USB headset per player, no Bluetooth) and the shipped, checksum-checked speech model. § 10 is rewritten for the new engine, a speech detector (Silero VAD) plus a level gate between the mics, with a new pipeline diagram and new synthetic accuracy figures with and without a calibration; § 6, § 9, § 11 and § 13 follow (one clock line per track and no lag refinement, leakage and the 12 dB gain-invariant pass margin from the calibration, export timing only from this engine version, `.partial` export folders, damaged clean records kept in place, erased seats removed from overlap partners, new limits).
- **Reason:** The energy-pattern engine was replaced by a simpler method that relies on close headset microphones, and the storage layer was fixed; the design reference must describe the method the code runs and what it cannot do.

### 2026-11-19 · `f309df0` · Seats survive session switches; read-only GameState; audio waits for the seat

- **Type:** Bug fix
- **Change:** The browser-events table adds the detached session (the seat kept: stop `disconnect`, start `reconnect`, unsent chunks kept). A paragraph *Waiting for the seat* says that each upload attempt waits until the socket is seated, and that an attempt the queue gave up on is cancelled before it is sent.
- **Reason:** Uploads emitted right after a reconnect were refused ("Not seated") and retried; a session switch dropped the unsent audio together with the seat token.

### 2026-11-19 · `0f343ea` · Typed socket protocol, intent resend after reconnect, CalibrationRunner

- **Type:** Risk mitigation
- **Change:** The code map names `session/CalibrationRunner.ts` for the timed turns and the quick check.
- **Reason:** The calibration moved out of SessionManager into its own module; behaviour is unchanged.

### 2026-11-19 · `5c76bd2` · Simplify the audio feature: shared helpers and types, fewer duplicates, cheaper hot paths (#16)

- **Type:** Bug fix
- **Change:** The track-status paragraph now says a track closed with `interrupted` after a restart reads as `interrupted` in the REST and CSV view, not `closed`.
- **Reason:** The cleanup in #16 merged the two `trackStatusOf` copies; the one REST and CSV now use also counts the stop reason `interrupted` as interrupted, as the shared schema already said.

### 2026-11-19 · `2428109` · Docs: audio design document (AUDIO.md), docs sweep against the built behaviour and change logs (U14) (#14)

- **Type:** Feature
- **Change:** Document created. It describes the audio design in diagrams: the architecture, the browser capture pipeline, upload with acknowledgements and retries, the timing model (client timestamps, clock offset, drift), the encrypted file format and keys, the recording lifecycle with the consent hold, the calibration sequence, the attribution algorithm step by step, export and deletion, and the data types. It also lists the known limits and a code map.
- **Reason:** Microphone recording is a new subsystem built in four parts by different workers. One design reference that matches the code lets a reader (or an assessor) follow the whole path from microphone to clean track, and states what the method cannot do.
