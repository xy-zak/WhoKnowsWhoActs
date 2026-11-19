# Change log: AUDIO.md

History of [AUDIO.md](../AUDIO.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · uploads wait for the seat; a detached session keeps the unsent audio

- **Type:** Bug fix
- **Change:** The browser-events table adds the detached session (the seat kept: stop `disconnect`, start `reconnect`, unsent chunks kept). A paragraph *Waiting for the seat* says that each upload attempt waits until the socket is seated, and that an attempt the queue gave up on is cancelled before it is sent.
- **Reason:** Uploads emitted right after a reconnect were refused ("Not seated") and retried; a session switch dropped the unsent audio together with the seat token.

### Not yet committed · calibration moved to CalibrationRunner

- **Type:** Risk mitigation
- **Change:** The code map names `session/CalibrationRunner.ts` for the timed turns and the quick check.
- **Reason:** The calibration moved out of SessionManager into its own module; behaviour is unchanged.

### Not yet committed · documents `simplify/audio-cleanup` (#16)

- **Type:** Correction
- **Change:** The track-status paragraph now says a track closed with `interrupted` after a restart reads as `interrupted` in the REST and CSV view, not `closed`.
- **Reason:** The cleanup in #16 merged the two `trackStatusOf` copies; the one REST and CSV now use also counts the stop reason `interrupted` as interrupted, as the shared schema already said.

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio)

- **Type:** Feature
- **Change:** Document created. It describes the audio design in diagrams: the architecture, the browser capture pipeline, upload with acknowledgements and retries, the timing model (client timestamps, clock offset, drift), the encrypted file format and keys, the recording lifecycle with the consent hold, the calibration sequence, the attribution algorithm step by step, export and deletion, and the data types. It also lists the known limits and a code map.
- **Reason:** Microphone recording is a new subsystem built in four parts by different workers. One design reference that matches the code lets a reader (or an assessor) follow the whole path from microphone to clean track, and states what the method cannot do.
