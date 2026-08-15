# CityOps Phase 3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch `phase-3a`. Merge to main only after the final whole-branch review passes (main auto-deploys Rob's daily tool).

**Goal:** Interest profile (synced), Build-my-prompt, Enrich (interests delta + intel pass) with a never-clobbers merge, item intel (verdicts/tips/source) rendered everywhere, PROMPT.md updated, and a real intel pass on Yerevan. Zero incremental cost: all AI runs in the traveler's own engine via paste.

**Architecture:** Engine (`src/cityops.js`) gains pure logic: intel validation + render, `mergeDelta`, `profile` normalize, prompt builders (string assembly from PROMPT.md's text embedded at assemble time). App shell (`src/app-shell.html`) gains the Profile modal, Enrich modal, Build-my-prompt, and a third sync row kind `profile`. Standalone guides get intel rendering only (no profile/enrich UI, no network). Assembler embeds PROMPT.md into index.html as a `<script type="text/plain" id="prompt-template">` block (escaped like the guide template) so prompt builders work offline.

**Spec:** docs/superpowers/specs/2026-08-12-cityops-phase3a-design.md (authoritative; reread before each task).

## Global constraints

- Branch `phase-3a`; never push main from this plan. No em-dashes anywhere authored. No dependencies, no CDN, no in-app AI calls (no fetch to any AI endpoint; the only network is the existing Supabase sync).
- Existing localStorage keys, schema v1 fields, and state shape are frozen contracts; `intel` and the profile are pure additions. All existing 63 tests pass unmodified.
- `node tests/run.js` green + `node tools/assemble.js` + re-embed cities + `grep -c SUPA template.html` = 0 at every task end. Commit per task.
- Standalone guides (template.html) must contain intel RENDERING but zero profile/enrich/prompt-builder UI and zero references to `id="prompt-template"`.

## Task 1: intel schema + validation + render (engine)

- `validate()`: if `it.intel` present it must be an object; `verdicts` optional array of `{tier in must|good|skip, text non-empty string}`; `tips` optional array of non-empty strings; `source` optional string; anything else is a validation error naming the item. Missing `intel` is fine.
- Render (engine `itemBody`, after the note): if intel has any verdicts or tips: when total entries <= 2 render inline; else render a `<details class="intel">` with `<summary>Intel: N verdicts, M tips</summary>`. Verdict rows: `<span class="tier tier-must|good|skip">Must|Good|Skip</span> text`; tips as `<ul class="tips">`; source as `<p class="intel-src">`. Share view: verdicts only (inline, no details). Calendar view: same as planner (it calls itemBody).
- CSS (`src/cityops.css`): `.intel` block, `.tier` badges reusing green-soft/green (must), bg-softer/text-3 (good), amber-soft/amber (skip); `.tips` tight list; `.intel-src` small muted italic; `details.intel summary` styled like the archive summary.
- Tests: validate accepts full intel, rejects bad tier / empty text / non-array; export round trip with intel deep-equals; existing suite untouched.
- Commit: `feat(intel): schema validation + rendering for verdicts, tips, source`.

## Task 2: profile model + Profile modal + Build my prompt + PROMPT.md

- Engine: `CityOps.profile = { normalize(obj) -> {schema:1, interests:[], avoid:[], notes:'', updated:null}, isEmpty(p) }`; app store gains `profile` (normalized on load); a `promptKit` namespace with `buildCityPrompt(promptTemplateText, cityHeader{name,country,from,to,accommodation,arrival,departure}, profile) -> string` that fills the PROMPT.md header bracket fields and inserts a "## Traveler interests" block (interests, avoid, notes) after the traveler profile section, and adds the interests-section instruction ONLY when the profile is non-empty.
- PROMPT.md: add (a) a "### Interests" research section (present when the interests block is filled: 3-6 plan picks + backups matching the listed interests, section id `interests`, label `My interests`, icon `⭐`); (b) an "Intel" quality-rules block per the spec; (c) intel schema in the output contract; (d) a new "## Re-run prompts" section documenting the two delta output contracts (interests delta; intel pass) so file-only users can run them by hand. Keep the header bracket fields as the fill targets `buildCityPrompt` uses (do not rename them).
- Assembler: embed PROMPT.md into index.html as `<script type="text/plain" id="prompt-template">` (escape `</script` like the guide template; test asserts reversibility and byte-equality to PROMPT.md).
- App shell: Profile action in the switcher action row -> modal: interests chips (input + Enter adds; chip x removes), avoid chips, notes textarea, sync-aware footer copy, Save/Cancel; Save normalizes, stamps updated, saves store, schedules a profile push. Add-city modal: a **Build my prompt** button next to Create blank (uses the blank fields as the header; if empty, prompts inline for name/dates first); copies to clipboard via navigator.clipboard with a fallback read-only textarea + "Copy" note; also offers **Download prompt.md**.
- Also: move "Load example city" into the Profile modal footer as well (keep the switcher entry).
- Sync: `profile` table (user_id unique, data jsonb, updated_at); RLS own-rows; the controller applies SQL via Rob (dashboard) or REST; sync engine: pull/push profile as a third kind (newer-wins by profile.updated vs updated_at); the M2 baseline/flush patterns apply. Config-gated like everything else.
- Tests: profile normalize; buildCityPrompt fills header + inserts interests block + omits it when empty; prompt-template embed reversibility; store normalize carries profile.
- Commit: `feat(profile): interest profile, Build my prompt, PROMPT.md interests+intel+re-run sections, profile sync`.

## Task 3: mergeDelta + Enrich modal

- Engine `CityOps.mergeDelta(cityData, delta) -> {data, summary, errors}` exactly per spec: validates delta (schema 1, delta true; new items validated with the SAME per-item rules as validate() against existing+delta sections; duplicate ids skipped not overwritten; delta.sections appended if new; delta.intel applied per id onto EXISTING items' intel only; never mutates inputs; never touches city/dates). `errors` non-empty => no merge.
- Engine `promptKit.buildInterestsDeltaPrompt(promptTemplateText, cityData, profile)` and `buildIntelPassPrompt(promptTemplateText, cityData)`: assemble from the PROMPT.md "Re-run prompts" section text plus the city header, the profile block (delta only), and a compact current-item list (`id | section | name`, one per line).
- App shell: toolbar **Enrich** button (app only, not in share mode) -> modal with two tabs/blocks: "Interests delta" (disabled with reason when profile empty: "Add interests in Profile first") and "Intel pass"; each has Copy prompt + Download; below, one paste box + Apply: parse JSON, run mergeDelta against the ACTIVE city's canonical data (effectiveData with override handling: apply to store.cities[activeId] and clear any dataOverride, same as Update data replace semantics: document), save, push data row, reboot, notice with the summary. Errors inline.
- Tests: mergeDelta full matrix (adds; skips dup; adds section once; intel applied only to existing ids; invalid delta rejected with errors; inputs unmutated; state untouched is by construction but assert the function never reads state); prompt builders contain the item list and profile; a delta round-trip through export stays lossless.
- Browser: enrich a city with a hand-made delta (2 new items, 1 dup, 1 new section, intel on an existing item): summary correct, live state (a done-mark set before) intact after merge, intel renders on the target card.
- Commit: `feat(enrich): mergeDelta + Enrich modal with interests-delta and intel-pass prompt builders`.

## Task 4: real Yerevan intel pass + whole-branch review + ship

- Research (opus, live web): intel for Yerevan's dinner plan picks + top backups (must/good/skip on named dishes with multi-reviewer support only; tips; source line), plus 1-3 verdicts/tips for the anchor activities (Cascade, Garni-Geghard, Vernissage, GUM, ARARAT). Output as an intel-pass delta JSON; validate via mergeDelta against cities/yerevan.json; write merged result back to cities/yerevan.json; re-embed. If Rob has filled his profile by then, also run the interests delta.
- Whole-branch review (opus): spec coverage, merge safety, standalone-guide isolation (grep template.html for profile/enrich/prompt-template = 0), sync additions RLS discipline, prompt quality, no em-dashes. Fix wave if needed.
- Merge to main, deploy, verify live: intel renders on a Yerevan dinner card; Profile modal saves + syncs; Enrich builds and copies both prompts; Build my prompt on Add city.
- Update README (Profile + Enrich workflow, intel field) and the launch-parked note.
