---
name: screenshot-app
description: Screenshot the features of Who Knows, Who Acts? that were recently developed or updated, and add them to the screenshot gallery docs/img/SCREENSHOTS.md, with a one-line caption under each image. Updated screens get a new version (name-v2.png, name-v3.png, …) shown next to the older ones, so the gallery is a visual timeline of the UI. Use when asked to screenshot the app, refresh or update the screenshots or the gallery, or record what changed in the UI.
---

# /screenshot-app

Find what changed in the UI since the last screenshot review. Capture the affected screens and compare them with the published versions. Publish the real changes as new versions, each with a one-line caption.

The screenshots are documentation for a public repository and part of the thesis record. Old versions are never overwritten: together they show how each feature developed.

## The pieces (reuse them, don't rewrite them)

| File | What it is |
| --- | --- |
| `e2e/screenshots/catalogue.ts` | Every shot: id (`server/…` facilitator, `client/…` player), gallery group and subgroup, title, size (`full` / `half` / `small`), the scenario that takes it, and `sources` (files whose changes can show in it). Also the groups, `GLOBAL_SOURCES` and `REPRESENTATIVE`. |
| `e2e/screenshots/capture.ts` | Capture API. `snap()` / `snapCrop()` write a PNG to any path (usable from any Playwright spec). `shot(page, id)` / `crop(page, id, locators)` do the same for a catalogued shot. `scenario(name, title, body)` declares a scenario. `writeReport()` compares the captures with the published versions. Options: `tip`, `keepMouse`, `fixed`, `wait`, `pad`, `keepScroll`. |
| `e2e/screenshots/flows.ts` | Reusable steps through the UI: setup wizard (`chooseScenario`, `fillRounds`, `bind`, `saveLabels`, `confirmKeySheet`, `nextThrough`), players (`newPlayer`, `onboard`, `act`, `acts`, `playerDisplay`), `panel`, `hoverTip`, `blur`, `popupFoot`, `wrapUp`. |
| `e2e/screenshots.spec.ts` | The scenarios: `session` (4 player PCs, 2 rounds, wrap-up, database, replay), `small-grid` (5 × 5, one PC and three fake players), `simulation` (agents). |
| `e2e/screenshots/manifest.ts` | Version history and the gallery generator. |
| `scripts/screenshots.ts` | The CLI below (`npm run screenshots -- …`). |
| `docs/img/screenshots.json` | The history: every version of every shot (file, date, time, commit, caption), plus the review marker. |
| `docs/img/SCREENSHOTS.md` | The gallery (Obsidian-style). **Generated, never edit by hand.** |
| `docs/img/server/`, `docs/img/client/` | The published images. |
| `.screenshots/` | Staging (git-ignored): captures, `report.json`, `*.diff.png`. |

Naming: v1 of a shot is `docs/img/<side>/<name>.png`, later versions are `<name>-v2.png`, `<name>-v3.png`, and so on. The gallery shows every version of a shot together, oldest first, each with its date and caption. *Timeline of changes* at the end lists all versions by date.

## Commands

```bash
npm run screenshots -- plan                      # what changed since the last review; which shots it can touch
npm run screenshots -- capture <id…>             # capture into .screenshots/ and compare with the latest versions
                                                 # (also group:<group> or all)
npm run screenshots -- publish <id> --caption "…"   # file a staged capture as the next version, regenerate the gallery
npm run screenshots -- publish <id> --replace       # overwrite the latest version (bad capture only; see step 5)
npm run screenshots -- check                     # catalogue, versions, files and gallery agree
npm run screenshots -- mark                      # record that everything up to now is reviewed
npm run screenshots -- list                      # every shot, its scenario and latest version
```

`capture` builds the clients and starts its own throwaway server on a temporary database, on port 3999, so that port must be free. Capturing takes about a minute per scenario involved. Scenarios with no requested shot are skipped.

## Step 1: find what changed

```bash
npm run screenshots -- plan
```

It lists:
- the commits since the review marker;
- the changed UI files, committed and uncommitted;
- the shots those files can touch;
- the representative shots to check when a shared file changed (theme, components, icons);
- changed UI files that no shot covers.

Files already reviewed are skipped: a shot captured after the change, or uncommitted work recorded by `mark`.

Then understand the features: `git log --stat <marker>..HEAD`, the commit messages, and `git diff` for uncommitted work. Write down each user-visible feature or change, and where it shows.

## Step 2: decide per feature

| The change | Do |
| --- | --- |
| Changes a screen that has a shot | Capture that shot; publish it as a **new version** if it really looks different. |
| A new screen, panel, popup or state with no shot | Add a **new shot** (step 3), then publish it as v1. |
| Shared files (theme, components) | Capture the `REPRESENTATIVE` shots and look. If one changed visibly, also capture the shots that show the change best. |
| Not visible (refactor, server-only, tests, docs) | Nothing. |

`plan` is broad on purpose: a group's `sources` flag every shot in the group. The comparison in step 4 narrows it down.

## Step 3: add a new shot (only for new features)

1. **Catalogue entry** in `e2e/screenshots/catalogue.ts`: give it a short, descriptive `id` (`server/live-panel-…` or `client/part-…` for crops), and choose the functional `group` it belongs to. Add a new group only if no group fits. Also set the `title`, a `size` (`full` = wide strips and key screens, `half` = full screens in pairs, `small` = small crops), the `scenario`, and `sources` (the feature's files). Put it in the list where it belongs in the group's order; the gallery follows the list.
2. **Take it in the scenario**, at the moment the feature is on screen. Use `shot(page, id)` for a whole screen, or `crop(page, id, panel(page, "Title"))` for one part. Reach the state with the helpers in `flows.ts`, and add new helpers there rather than inline code. If no scenario reaches the feature, extend one, or add a scenario: a name in `ScenarioName` plus `scenario(…)` in the spec.
3. Rules for capture code:
   - **Never rely on a shot's side effects.** A shot that wasn't requested does nothing: no scroll, no mouse move. Scroll and hover explicitly; use `hoverTip()` for tooltips.
   - **Keep runs repeatable:** fixed labels (`saveLabels`, never `shuffleLabels`), scripted moves, the seeded simulation. Otherwise every capture differs from the last one.
   - **Fictional data only:** the demo scenarios and scripted players, never real sessions or names.
4. `npx tsc -p e2e` must pass (shot ids are type-checked against the catalogue).

## Step 4: capture and compare

```bash
npm run screenshots -- capture <ids from plan, plus new shots>
```

For each shot, it prints the staged file, the latest published version, and how much differs: identical, a share of pixels, or a changed size. It also writes a diff image `.screenshots/<id>.diff.png`, with changed pixels in red on a faded copy.

**Look at every capture that differs** (Read the staged PNG, the latest version and the diff):
- **Noise, always present:** the session id (`S-…`, `SIM-…`), participant codes (`WK-…`), clocks and timers, timestamps in the event log and telemetry, and the random moves of fake players. A diff limited to these is not a new version.
- **A real change:** new or changed controls, layout, text, colours or states. Check that it matches the feature from step 1.
- **Clean capture:** nothing important cut off, no stray tooltip, focus ring or toast, and the feature in frame. If not, fix the scenario or the crop and capture again.

## Step 5: publish

```bash
npm run screenshots -- publish <id> --caption "<one line>"
```

This copies the capture to the next version's file, records it in `docs/img/screenshots.json` and regenerates the gallery.

Captions are **one line**, plain words, under about 100 characters, and contain no personal data:
- **v2 and later:** say what is new or different in this version, e.g. "Timeline drawn at the panel's real width: labels now match the rest of the UI."
- **v1 (new shot):** say what the screen shows, e.g. "Every seat's onboarding step: consent, demographics, briefing or ready."

`--replace` overwrites the **latest** version instead of adding one. Use it only when that version was a bad capture of the same feature state, or the scenario changed but the feature didn't. Never use it to hide a change: a feature change is always a new version.

## Step 6: check and mark

```bash
npm run screenshots -- check     # must pass
npm run screenshots -- mark      # review marker = HEAD, plus the uncommitted UI files reviewed now
```

Open `docs/img/SCREENSHOTS.md` around the new versions and check that the images and captions read well.

## Step 7: report

Tell the user:
- **New versions:** each `id vN` and its caption.
- **New shots:** their files and captions.
- **Not published:** which candidates you looked at and left out, and why (e.g. "noise only: session id and clocks").
- **Problems:** anything noticed in the UI along the way, e.g. a layout bug visible at full screen.

Do not commit unless asked. When asked: the images, `docs/img/screenshots.json`, `docs/img/SCREENSHOTS.md` and any catalogue or spec changes belong together in one commit. `.screenshots/` is never committed.
