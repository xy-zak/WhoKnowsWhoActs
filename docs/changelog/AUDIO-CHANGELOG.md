# Change log: AUDIO.md

History of [AUDIO.md](../AUDIO.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `simplify/audio-cleanup` (#16)

- **Type:** Correction
- **Change:** The track-status paragraph now says a track closed with `interrupted` after a restart reads as `interrupted` in the REST and CSV view, not `closed`.
- **Reason:** The cleanup in #16 merged the two `trackStatusOf` copies; the one REST and CSV now use also counts the stop reason `interrupted` as interrupted, as the shared schema already said.

### Not yet committed · documents `0f6971a`…`abcacbe` (microphone audio)

- **Type:** Feature
- **Change:** Document created. It describes the audio design in diagrams: the architecture, the browser capture pipeline, upload with acknowledgements and retries, the timing model (client timestamps, clock offset, drift), the encrypted file format and keys, the recording lifecycle with the consent hold, the calibration sequence, the attribution algorithm step by step, export and deletion, and the data types. It also lists the known limits and a code map.
- **Reason:** Microphone recording is a new subsystem built in four parts by different workers. One design reference that matches the code lets a reader (or an assessor) follow the whole path from microphone to clean track, and states what the method cannot do.
