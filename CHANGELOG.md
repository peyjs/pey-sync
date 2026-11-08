# Changelog — pey.sync

## [2.0.1] - 1405-08-17

Round-3 review fixes. No contract change; `sync:changed` items now match their documented shape exactly.

### Fixed

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
