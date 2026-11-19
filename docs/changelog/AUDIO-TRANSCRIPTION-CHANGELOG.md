# Change log: AUDIO-TRANSCRIPTION.md

History of [AUDIO-TRANSCRIPTION.md](../AUDIO-TRANSCRIPTION.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `880ecba` (Headset gate engine: Silero VAD + cross-channel level gate; storage fixes)

- **Type:** Risk mitigation
- **Change:** The table of what exists, the non-goals, requirement R11, the echo-matching and word-timing text and the pipeline diagram no longer mention lag refinement or loudness-only attribution; they describe one clock fit per track and speech detection plus a level gate.
- **Reason:** The engine this research builds on changed; the document must not rely on an alignment from the audio that the code no longer does (docs drifting from the code).

### Not yet committed · links to `docs/AUDIO.md`

- **Type:** Risk mitigation
- **Change:** The title gets the change-log link and the related-documents line links to the new audio design document. No research content changed.
- **Reason:** The research builds on the recording and attribution that are now built, so readers should find their description from here.

### 2026-11-18 · `b47cfb5` · Docs: research on local transcription for the audio recordings (#4)

- **Type:** Feature
- **Change:** Document created. It compares local transcription engines (accuracy on accented speech, timestamps, speed, licence, Node integration), lists pitfalls, proposes a pipeline, a data model and mock-ups of one transcript per participant and a composite one, adds GDPR notes and an evaluation plan, and ends with a recommendation. Nothing in it is implemented.
- **Reason:** Automatic transcription was asked about but not yet to be built. The research gives a basis for the decision and keeps the choice local (no cloud), in line with the data protection design.
