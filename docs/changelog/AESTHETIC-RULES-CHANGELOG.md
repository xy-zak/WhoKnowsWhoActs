# Change log: AESTHETIC-RULES.md

History of [AESTHETIC-RULES.md](../AESTHETIC-RULES.md). Newest first. How entries are written: [README.md](README.md).

## Unreleased

### Not yet committed · documents `abcacbe`

- **Type:** Bug fix
- **Change:** § 8.1 "Where they appear" is corrected to the built screens: the game has a `RecTag` in the status line and a banner only while the microphone needs the participant (not a permanent banner), the onboarding screens have the recording line, the mic check and calibration screens have their own meter, and the facilitator status bar and calibration card are listed.
- **Reason:** The rule was written before the screens existed and described a permanent banner in the game, which would take room from the map without helping while all is well.

### 2026-11-18 · `07519c9` · Audio: facilitator LIVE monitoring (mic column, mics n/m, calibration quality, pause recording, wrap-up check) (U12) (#12)

- **Type:** Feature
- **Change:** The generated contrast table gains the `--warn` on `--sunken` pair (the status bar's `mics 3/4`).
- **Reason:** The facilitator status bar now shows microphone counts in the warn tone, which must stay readable in all three themes.

### 2026-11-18 · `9cc3f75` · Audio UI primitives: mic icons, LevelMeter, RecTag, RecordingBanner (#1)

- **Type:** Feature
- **Change:** A new § 8.1 *Audio indicators* defines the recording states (`[REC]`, `[PAUSED]`, `[NO SIGNAL]`, `[MIC DENIED]`, …) with tone and icon, why recording is not red, the level meter rules, and where each indicator appears. § 2.2, § 9 and the checklist get matching lines, and the generated tables add the new icons and the `faint` contrast pairs.
- **Reason:** Players cannot mute themselves, so the recording state must always be visible and must not look like an error. A neutral or green tag, never red, keeps real errors recognisable.

### 2026-11-18 · `db56dfe` · Fix: stretched timeline text, squeezed square panel at large text, outdated briefing

- **Type:** Bug fix
- **Change:** § 3 adds two rules: SVG charts such as the timeline are drawn at their panel's real width with `--fs-*` text, and fixed-width columns grow with the text size. The player's side panel widens at Large, and its type column may wrap with Large text or OpenDyslexic.
- **Reason:** The full-screen screenshots showed the timeline's text stretched to almost twice the body size at 1920 px, and the player's square panel squeezing its *On the map* column to nothing with OpenDyslexic at Large text.

### 2026-11-18 · `fc32ce7` · Grid map with knowledge sub-squares, scores and pluggable game rules

- **Type:** Feature
- **Change:** § 1 principle 6 and § 2.2 replace the yellow propose and red decide colours with one colour per knowledge type (`--k-a…d`, power types share the colour of their letter), with hatched = proposed and filled = decided everywhere. The generated token and contrast tables add these colours; tooltips now cover icon-only buttons through `title`, and the checklist gains a line on label swatches.
- **Reason:** Colour now carries one meaning across the map, timeline and labels. The palette was checked for colour-vision deficiencies, and text stays in text ink so labels remain readable.

### 2026-11-17 · `a4ddecd` · Document simulated and fake players

- **Type:** Feature
- **Change:** § 8 adds the `–` glyph for skipped setup steps, the neutral `[SIMULATION]` and `[FAKE]` markers, and sub-tabs inside a page. The generated icon table adds `agent`, `simulation` and `fake`.
- **Reason:** New interface states must follow the rule that colour carries meaning, so they are marked with neutral tags and icons rather than a new colour.

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** The theme section becomes **display settings**: every screen picks its own colours, font (including OpenDyslexic, a font made for readers with dyslexia), text size and animations, stored only in that browser. Also added: the setup wayfinder bar pinned to the top, hover helpers on buttons, new icons and keys, and extra checklist items.
- **Reason:** These settings improve accessibility. Keeping them out of the research data avoids recording possible hints of a visual impairment or dyslexia.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** A high-contrast theme (black and white, text contrast at WCAG AAA, the strictest web accessibility level) is added to the colour and contrast tables. "Motion and CRT" becomes "Motion and animations", with no scanlines or glow, only transitions. A lavender colour is reserved for the setup review step, and setup is described as collapsible panels.
- **Reason:** This improves readability for people with low vision and removes visual effects that could distract players during the game.

### 2026-11-16 · `2f11891` · Docs and screenshots for the UI pass

- **Type:** Bug fix
- **Change:** The popup rules are corrected. **Esc** closes a setup popup and keeps the progress, the page offers **RESUME STEP n**, and **Back** goes to the previous step.
- **Reason:** The earlier text said Esc goes back a step, which did not match how the interface behaves.

### 2026-11-16 · `f4c5233` · Add design system: Catppuccin tokens, TUI stylesheet, CRT layer, Iconoir icons

- **Type:** Feature
- **Change:** Document created. It sets the design rules for every screen: principles, colour tokens for the Catppuccin Latte (light) and Mocha (dark) themes with generated contrast tables, typography, spacing, icons, panels, popups, wayfinding, motion, keyboard and a checklist for new UI.
- **Reason:** One rulebook keeps the facilitator and player screens consistent and accessible. Its tables are generated from the code, so they cannot go out of date.
