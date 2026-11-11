# Changelog — pey.sync

## [2.0.1] - 1405-08-19

Round-3 through round-9 review fixes (all unpublished; one release). No contract change; `sync:changed` items now match their documented shape exactly.

### Fixed

- **The prompt guard is FAIL-CLOSED**: a conflict that was never presented in a conflict report (it came to life in the resolve's own capture) refuses its remote resolution too — absence from the pin list means "never shown" (regression test added).
- The delete-vs-change **local** choice's DELETION branch runs the same freshness check: a remote file that changed after the prompt is not destroyed on the strength of a stale view (regression test added).
- The record-rename twin conflict is addressed honestly (round 9): a rename onto an occupied path while the OLD path's remote was edited made the planner ask twice with ONE id — `resolveConflict` silently picked the first match, the rename's free-the-old-path delete destroyed the old path's never-shown remote content, and the twin vanished from the open set with the clock advancing (a fake "complete" round). Now resolve refuses twins with `SYNC_INVALID_CONFIG` until the ambiguity clears, the contested old-path delete is skipped while a conflict owns that path, and both choices are locked by regression tests. The docs' guard-refusal wording no longer describes a nonexistent `applied: false` field — the observable refusal is `remaining` not dropping (and the conflict staying in the `sync:changed` open set) (238 tests).
- The local choice's PUSH branch (overwriting the remote file with the local content) runs the same freshness check (round 8): a remote change after the prompt is not silently overwritten on a stale view — every branch that destroys remote content now guards (regression test added).
- Prompt pins belong to the destination, not the service (round 8): `removeBackend` deletes the pin record and switching the backend identity clears the pin list, so a stale pin can never authorize resolving a conflict the current destination never prompted (regression test added). Requirement 29 and the reference guard paragraph now state the freshness exception on the delete-vs-change branch explicitly, ending their internal disagreement with requirement 22.
- **The prompt→resolve window is now guarded too**: when a round stops on conflicts, each open conflict's remote hash is pinned as the prompt anchor; resolving the **remote** choice against a remote whose hash no longer matches is refused (applied stays false) — the user can never accept content they were not shown. The next round re-asks with the fresh content (regression test added).
- A backend configured without `branch` no longer wedges every later call: stored `null` fields are stripped before the adapter factory runs, so the factory's documented default (`main`) applies (regression test added).
- The conflict report's remote content is `null` — never an empty string — when the file was unreadable at report time, so the host can tell "empty" from "unreadable" (documented; regression test added).
- **The git backend now fails loudly when a directory listing hits GitHub's silent 1,000-entry truncation limit** (`GIT_DIRECTORY_TRUNCATED`, mapped to `SYNC_REMOTE_INVALID`): an incomplete listing previously read as "remotely deleted" for everything past the cutoff and would have silently destroyed local edits. Documented in the reference next to the gitlab adapter's pagination cap (regression test added).
- A takeover conflict whose remote file was skipped by the rev shortcut now reports the REAL remote content to the host — an empty string made a non-empty file look "remotely empty" and steered the user's choice (regression test added).
- The skipped "remote" resolution of a conflict whose remote file vanished is documented honestly: the conflict stays open, and a file that never comes back is closed by the next round's regular takeover push rule (comment, reference and regression test aligned).
- The CAS guard of the **local** choice now covers its deletion branch too: a host re-creation racing the resolution window keeps the conflict open instead of letting the remote file be deleted on the strength of a deletion that no longer exists (regression test added).
- A remote file that vanishes at resolve time in a takeover conflict no longer half-applies the "remote" choice (empty baseline pin while the local record survives — the local content would have overwritten the remote deletion next round): the conflict stays open like every other unrepresentable outcome (regression test added).
- Resolving a conflict with the **remote** choice no longer pins the snapshot when the remote content is readable but cannot shape into a local record (e.g. a JSON file whose payload id disagrees with its path): the resolution is now reported as not applied and the conflict stays open. Previously the baseline was pinned anyway, so the next round saw the local record as "changed" again and silently overwrote — or deleted — the very file the user had chosen to keep (regression test added).
- The **local** choice of a conflict resolution now applies the same CAS guard as the remote choice: a host edit racing the plan-to-apply window keeps the conflict open instead of being silently overwritten on the backend (regression test added).
- `sync:changed` items published by `resolveConflict` carry exactly the documented `{ collection, id }` shape — the internal `path` field is no longer leaked (test added).

### Changed

- JSDoc of `applyLocalResolution` / `applyRemoteResolution` updated to the real `{ applied, pushed, pulled }` outcomes; 16 older test names moved to the `should_..._when_...` convention; README version badge and backend list (git, gitlab) brought up to date.


## [2.0.0] - 1405-08-15

Review-fix release. **Breaking:** the `sync:conflicts` event is renamed to `sync:conflicted` to follow the Bonyan past-tense event naming rule — listeners must update.

### Fixed (second review pass)

- A rev mismatch on the planned remote DELETE now maps to `SYNC_CONCURRENT_CHANGE` in both backends (git 409/422, GitLab 400/409) instead of reading as a network failure.
- `SYNC_REMOTE_INVALID` and `SYNC_PATH_COLLISION` are declared in the manifest for `resolveConflict` (its capture phase can raise both).
- The resolution CAS guard is fail-closed on storage read failures: the resolution is skipped and the conflict stays open instead of proceeding on unknown state.
- A freshly re-read remote conflict content is verified against the plan-time hash before adoption; a mid-window change skips the resolution so the user never accepts content they did not preview.
- A failed `resolveConflict` lands in `lastError` and reaches the bus as a partial `sync:changed` (same pattern as `syncNow`); a half-applied resolution is never unreported.
- `sync:changed` after a resolution carries the real `pushed`/`pulled` outcomes of that resolution (a local-side resolution writes to the remote).

### Fixed

- CAS now also guards conflict resolution: `applyRemoteResolution` re-reads the local record and compares it with the plan-time state before the adoption write or the delete-vs-change deletion; a host edit racing the prompt skips the resolution and keeps the conflict open (`remaining` reflects it).
- `sync:changed` after `resolveConflict` carries the real open-conflict set (other pending conflicts included) instead of always an empty array.
- GitHub DELETE responses with 401 map to `GIT_AUTH_FAILED` (and a rate-limited 403 to `GIT_RATE_LIMITED`), mirroring the write path — an invalidated token mid-round no longer reads as a network failure.
- `npm test` now discovers the whole tree (`node --test`): the five entry-point tests were silently excluded by the old non-recursive glob.
- `onDeactivated` unsubscribes from `core:service-unavailable` like `onShutdown` already did.
- `titleOf` fallback is an honest empty string instead of the unexplained `'|'`; the corrupted `matchesExtension` comment now matches the (case-insensitive) code.

### Changed

- The 32-bit FNV-1a change-detection hash and its ~2⁻³² collision trade-off are documented (reference + engine JSDoc).
- `planSync` and `applyRoundPlan` are split into small decision/apply helpers; per-source test files added for `sync-remote`, `sync-round`, `sync-store` and `adapters/shared`; `tests/sync.test.js` renamed to `tests/entry.test.js`; new tests cover 401/rate-limit on git write/delete, `remaining > 0` resolutions, an end-to-end `SYNC_CONCURRENT_CHANGE`, and shutdown unsubscribe.

## [1.1.0] - 1405-08-08

Hardening release after an external review (six reproduced defects plus five static risks, each fixed with a regression test).

### Fixed

- The baseline advances only from the round's verified outcomes (the content actually written, with its revision) instead of re-reading the whole store, and every local overwrite/delete compares the record against the round's baseline first (CAS) — a host edit racing the round is skipped and stays dirty instead of being marked synced behind stale content.
- Switching destinations (repo/branch/URL) now resets the baseline: the new target's emptiness reads as a first sync (everything pushes), never as "everything was remotely deleted". Token-only changes keep the state. Identity is `(kind, baseUrl, repo, branch)`.
- A corrupt remote file the serializer cannot decode stops the round with `SYNC_REMOTE_INVALID` before any write or deletion, instead of disappearing from the listing and reading as "remotely deleted".
- Delete-vs-edit conflicts now accept a `local` resolution: the remote file is deleted (rev-guarded) and the local deletion stands.
- `basePath` round-trips symmetrically for both serializers (outgoing paths join it, incoming paths strip it; `..`/empty segments are rejected).
- A failure inside `finalizeRound` now rides the mapped run-error path (recorded as `lastError`, published) instead of escaping raw past the catch.

### Changed

- Mutating operations (sync/resolve/configure/remove) run single-flight: overlaps reject with the new `SYNC_IN_PROGRESS`.
- Root-listing 404 is no longer read as an empty tree: both adapters verify the destination still exists first, so a deleted branch can never trigger mass local deletions.
- GitLab pagination only follows Link targets inside the configured instance and API path prefix, with a 50-page cap and a loop guard.
- Legacy cleanup deletes only the known root manifest path (`sync-manifest.json`), and only when a readable legacy manifest was actually seen; paths merely named in an old manifest are never touched.
- Error `source` is the plugin name (`pey.sync`), per the Bonyan error convention; serializer and backend registries use own-property lookups; adapter factory and param-normalization failures are mapped inside the error boundary.
- The manifest no longer declares `adapterType: "sync-target"`: backend selection is a dynamic, user-driven runtime choice, so the `sync-target` contract is documented as plugin-internal (same pattern as pey-filesystem's environment adapter).

## [1.0.0] - 1405-08-08

Initial pey release: manual, backend-neutral sync of `pey.storage` collections — path-keyed three-way engine, `git` (GitHub Contents API) and `gitlab` (GitLab Files API) backends extensible through the `sync-target` descriptor contract, ignore patterns, custom commit messages, legacy-snapshot migration, conflict prompts with both-side previews, and `docs/requirements.md` (numbered pey format) as the construction source of truth. Conflict resolution applies the chosen side exactly: a `remote` choice on a delete-vs-change conflict deletes the local record, and resolving a path-takeover conflict frees the displaced owner's snapshot entry so the same conflict cannot re-fire.

> Incubated in Parsinegar as 0.1.0–0.4.0; that history stays with the source project — the pey release lineage starts here.
