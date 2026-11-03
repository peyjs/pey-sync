# Changelog — pey.sync

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
