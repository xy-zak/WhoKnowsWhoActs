# Change log: ARCHITECTURE.md

History of [ARCHITECTURE.md](../ARCHITECTURE.md). Newest first. How entries are written: [README.md](README.md).

### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** The text now uses the project name *Who Knows, Who Acts?*. The component and code-layout tables add session deletion, takedown cards as PDF files, and display settings that each player's browser keeps to itself.
- **Reason:** These features were new. The doc also states that display settings never reach the server, so no accessibility choices end up in the research data.

### 2026-11-16 · `7998b1f` · UI and labelling update: accordion setup, animations, themes, K–P pairings

- **Type:** Feature
- **Change:** "Terminal" is renamed "Client" in the glossary, the session phases and the bot options. A note explains that stored data keeps the old field name `terminal`.
- **Reason:** "Client" is the word the interface now uses. Keeping the stored field name means older recordings still line up with new ones.

### 2026-11-16 · `2f11891` · Docs and screenshots for the UI pass

- **Type:** Feature
- **Change:** The code-layout table adds the new `ui/` design-system folder and the reorganised facilitator and player folders.
- **Reason:** It documents the new interface structure, so developers can find where each screen and component lives.

### 2026-11-16 · `e7871f4` · Add README, session runbook and reconcile docs with the implementation

- **Type:** Risk mitigation
- **Change:** The code-layout table now lists the server modules in detail. The testing section says what each test suite actually checks, and a new table lists the options of the simulated players ("bots").
- **Reason:** These sections were written before the code was finished. Updating them keeps the document from describing a system that does not exist.

### 2026-11-16 · `7e7b590` · Add design documentation with diagrams and doc generator

- **Type:** Feature
- **Change:** Document created. It covers the system overview, code layout, event sourcing (every action is stored as a permanent record, and the game state is rebuilt from those records), the session and onboarding state machines, who sees what, the rules engine, timing, recovery, an extension guide and testing. Mermaid diagrams show the components, the message sequences and the states.
- **Reason:** It gives supervisors, reviewers and future developers a reference design to check the implementation against.
