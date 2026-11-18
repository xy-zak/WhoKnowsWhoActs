# Document change logs

Each design document in `docs/` has its own change log. An entry records the date, the commit, what changed in that document and why. The reason is classed as a **Feature**, a **Bug fix** or a **Risk mitigation** (privacy, data loss, research validity, accessibility, or the docs drifting from the code). Newest entries come first.

| Document | Change log |
| --- | --- |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | [ARCHITECTURE-CHANGELOG.md](ARCHITECTURE-CHANGELOG.md) |
| [NETWORKING.md](../NETWORKING.md) | [NETWORKING-CHANGELOG.md](NETWORKING-CHANGELOG.md) |
| [DATA-MANAGEMENT.md](../DATA-MANAGEMENT.md) | [DATA-MANAGEMENT-CHANGELOG.md](DATA-MANAGEMENT-CHANGELOG.md) |
| [DATA-TYPES.md](../DATA-TYPES.md) | [DATA-TYPES-CHANGELOG.md](DATA-TYPES-CHANGELOG.md) |
| [SESSION-RUNBOOK.md](../SESSION-RUNBOOK.md) | [SESSION-RUNBOOK-CHANGELOG.md](SESSION-RUNBOOK-CHANGELOG.md) |
| [AESTHETIC-RULES.md](../AESTHETIC-RULES.md) | [AESTHETIC-RULES-CHANGELOG.md](AESTHETIC-RULES-CHANGELOG.md) |
| [GAME-RULES.md](../GAME-RULES.md) | [GAME-RULES-CHANGELOG.md](GAME-RULES-CHANGELOG.md) |

The logs are maintained with the `/update-docs` Claude Code skill (`.claude/skills/update-docs/SKILL.md`). It reviews new commits, updates the documents and adds the entries.

Reviewed up to: `a4ddecd`
