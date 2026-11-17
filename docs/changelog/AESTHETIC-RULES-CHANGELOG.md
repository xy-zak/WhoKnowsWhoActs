# Change log: AESTHETIC-RULES.md

History of [AESTHETIC-RULES.md](../AESTHETIC-RULES.md). Newest first. How entries are written: [README.md](README.md).

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
