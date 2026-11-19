---
name: update-docs
description: Bring the design documents in docs/ up to date with recent commits and keep each document's change log in docs/changelog/. Use when asked to update, sync or reconcile the docs, to write or refresh change logs, or after a batch of commits that changed behaviour, data, protocol, UI or procedures.
---

# /update-docs

Two jobs, in this order:

1. **Official docs** (`docs/*.md`): find what recent commits changed and bring the affected documents in line with the code.
2. **Change logs** (`docs/changelog/*-CHANGELOG.md`): add one short entry per document for every commit that changed that document.

The change logs are evidence for the master's thesis evaluation. Assessors read them as the history of each document, so entries must be accurate, short and understandable to an expert and a non-expert alike.

## Files

| Official document | Change log |
| --- | --- |
| `docs/ARCHITECTURE.md` | `docs/changelog/ARCHITECTURE-CHANGELOG.md` |
| `docs/NETWORKING.md` | `docs/changelog/NETWORKING-CHANGELOG.md` |
| `docs/DATA-MANAGEMENT.md` | `docs/changelog/DATA-MANAGEMENT-CHANGELOG.md` |
| `docs/DATA-TYPES.md` | `docs/changelog/DATA-TYPES-CHANGELOG.md` |
| `docs/SESSION-RUNBOOK.md` | `docs/changelog/SESSION-RUNBOOK-CHANGELOG.md` |
| `docs/AESTHETIC-RULES.md` | `docs/changelog/AESTHETIC-RULES-CHANGELOG.md` |
| `docs/GAME-RULES.md` | `docs/changelog/GAME-RULES-CHANGELOG.md` |
| `docs/AUDIO.md` | `docs/changelog/AUDIO-CHANGELOG.md` |
| `docs/AUDIO-TRANSCRIPTION.md` | `docs/changelog/AUDIO-TRANSCRIPTION-CHANGELOG.md` |

A new `docs/X.md` gets a new `docs/changelog/X-CHANGELOG.md` (same template), a row in the table above, a row in `docs/changelog/README.md`, and the "Change log" link line under its title.

The change logs live in a sub-folder on purpose: `scripts/generate-docs.ts` and `e2e/docs-mermaid.spec.ts` only scan `docs/*.md`, so change logs are never treated as generated docs. Do not move them up into `docs/`.

## Step 1: Find the commits to review

`docs/changelog/README.md` has a line `Reviewed up to: \`<hash>\``. That is the last commit already reviewed.

```bash
git log --reverse --format='%h|%ad|%s' --date=short <hash>..HEAD
```

If the marker is missing (first run), review the full history: `git log --reverse`. Also check `git status`: uncommitted doc edits are handled under "Unreleased" (step 4).

For each commit, read the full message and the diff stat, then the parts of the diff that matter:

```bash
git show <hash> --stat
git show <hash> -U1 -- docs/                       # what the commit already changed in the docs
git show <hash> -- <code paths from the table below>
```

## Step 2: Decide which documents are affected

For every commit, decide per document: **fundamental**, **minor** or **none**.

- **Fundamental:** a new concept, section, diagram, procedure, data field, message, schema version, or a change in how something works or what is stored. The text and often a Mermaid diagram must change.
- **Minor:** renames, labels, an extra table row, a new flag or endpoint that fits an existing table, wording that no longer matches the UI.
- **None:** refactors, formatting, tests only, dependency bumps, licence, screenshots only.

Where code changes usually land:

| Code area | Documents to check |
| --- | --- |
| `packages/shared/src/events.ts`, `telemetry.ts`, `meta.ts`, `config*`, `exportColumns.ts`, `labels.ts` | DATA-TYPES (mostly generated), DATA-MANAGEMENT (inventory, exports), ARCHITECTURE (event model) |
| `packages/shared/src/protocol.ts`, `apps/server/src/net/`, `apps/server/src/api/` | NETWORKING (message catalogue, REST table, sequences) |
| `apps/server/src/db/` (migrations, schema versions) | DATA-TYPES (DB tables, ER diagram), DATA-MANAGEMENT (storage, retention) |
| `apps/server/src/gdpr/`, `cli.ts` | DATA-MANAGEMENT (takedown, erasure, exports, CLI table), SESSION-RUNBOOK (wrap-up) |
| `apps/server/src/session/`, rules, state machines | ARCHITECTURE (state machines, rules), SESSION-RUNBOOK |
| `packages/shared/src/game/`, `board.ts`, `scenarios/` | GAME-RULES (rules, targeting, scores, scenario format), ARCHITECTURE (extension guide), DATA-TYPES |
| `apps/client/src/facilitator/` | SESSION-RUNBOOK (tabs, setup steps, LIVE, shortcuts), ARCHITECTURE (module layout) |
| `apps/client/src/player/` | SESSION-RUNBOOK, AESTHETIC-RULES, ARCHITECTURE (module layout) |
| `apps/client/src/ui/` (tokens, icons, components, CSS) | AESTHETIC-RULES (partly generated) |
| `apps/server/src/audio/`, `apps/client/src/audio/`, `apps/client/src/player/recording.ts`, `config/audio.json`, `tls.ts` | AUDIO (design), NETWORKING (audio messages, HTTPS, REST), DATA-MANAGEMENT (consent, retention, erasure, exports), DATA-TYPES (audio tables, events), SESSION-RUNBOOK (§ 11), ARCHITECTURE (§ 15), AESTHETIC-RULES (§ 8.1) |
| `apps/server/src/tools/` (bots) | ARCHITECTURE § testing (bot flags), SESSION-RUNBOOK (dry run) |
| `config/`, `scenarios/` formats | SESSION-RUNBOOK (preparation), ARCHITECTURE (extension guide), DATA-TYPES |
| Project name, terminology | Every document |

If a commit already updated the docs, still check that it covered everything; commits often update one doc and forget another.

## Step 3: Update the official docs

- **Generated blocks** sit between `<!-- BEGIN GENERATED: name -->` and `<!-- END GENERATED: name -->`. Never edit them by hand. Change the source (schemas, `meta.ts`, `exportColumns.ts`, `ui/docblocks.ts`, `ui/tokens.ts`, `ui/icons.ts`) or the generator, then run `npm run docs:generate`.
- Hand-written text: match the existing tone (short sentences, plain English, UI names in **bold**, keys in `code`). Keep section numbers stable; other docs and code comments link to them (`§ 9`, `#10-takedown-and-erasure-procedure`).
- Diagrams: update the Mermaid diagram when the flow, states or entities it shows change. Keep the project's rule that each design doc carries diagrams.
- Never put real participant data, names, codes or IP addresses in a doc. The repository is public.
- Verify:
  ```bash
  npm run docs:check                                  # generated blocks up to date
  npx playwright test e2e/docs-mermaid.spec.ts        # only if a Mermaid diagram changed
  ```
- Fundamental changes: tell the user which sections changed, so they can review the wording.

## Step 4: Write the change-log entries

One entry per **commit that changed the document** (in that commit's own diff of `docs/X.md`). Commits that did not touch a document get no entry in its log, even if they changed related code. Edits that only add or fix the change-log link line under a document's title are not logged.

Doc edits made in this run are not committed yet, so they go under `## Unreleased` at the top of the log, with the commit(s) they document:

```markdown
## Unreleased

### Not yet committed · documents `abc1234`
...
```

On the next run, when those edits are part of a commit, replace the Unreleased entry with a normal entry for that commit.

### Entry format (newest first)

```markdown
### 2026-11-16 · `a8c3221` · Rename to "Who Knows, Who Acts?"; per-screen display settings; card PDFs; session deletion

- **Type:** Feature
- **Change:** What changed *in this document*, in one or two sentences.
- **Reason:** Why, in one or two sentences.
```

- **Date:** the commit's author date, `YYYY-MM-DD` (`git log --date=short`).
- **Commit title:** the commit subject line, verbatim, after the short hash.
- **Type:** exactly one of
  - **Feature**: the document describes new or changed functionality. Creating a document is usually a Feature, unless its main purpose is reducing risk (e.g. the GDPR design, the session runbook).
  - **Bug fix**: the document was wrong, or describes a fix for something that behaved incorrectly.
  - **Risk mitigation**: the change reduces a risk: privacy/GDPR, data loss, research validity (e.g. a confound), accessibility, or the docs drifting from the code.
  If two apply, pick the main one and mention the other in the reason.
- **Change + Reason together: at most 3–4 sentences.** Describe the change to the document, not the whole commit.

### Writing rules

- Plain language first. An assessor who does not program should follow it; an expert should find it precise.
- Explain a technical term in a few words the first time it appears in an entry (e.g. "the schema version (the layout of the database)").
- Name concrete things: sections, tables, diagrams, fields, screens. No vague "various updates".
- No filler ("This commit…", "In order to…"), no marketing words.
- Do not invent reasons. Take them from the commit message, the diff and the docs. If the reason is unclear, say what the change protects or enables, as far as the evidence shows.

## Step 5: Finish

1. Set `Reviewed up to: \`<hash>\`` in `docs/changelog/README.md` to the newest commit reviewed (`git rev-parse --short HEAD`).
2. Run `npm run docs:check`.
3. Report to the user: per document, fundamental / minor / none, what you changed, and the change-log entries added. Do not commit unless the user asks.
