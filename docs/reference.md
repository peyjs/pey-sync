# pey.sync — Reference

Self-contained reference for the `pey.sync` infrastructure plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

A manual, backend-neutral sync engine for `pey.storage.service` collections into a user-selected space (bundled backends: GitHub and GitLab — including self-hosted instances with a custom base URL). Local is the source of truth; the remote is a mirror; nothing is destroyed without asking.

## Structure

- `manifest.json` — plugin contract (identity, service, events, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`), wiring only.
- `lib/error.js` — structured errors (`syncError`, `syncStartupError`, `syncCriticalError`).
- `lib/sync-engine.js` — pure decision logic (diff, path-keyed plan, hashing, ignore matching).
- `lib/serializers.js` — the `json` and `markdown` codecs + the file-name rule.
- `lib/sync-scope.js` — scope validation, path attribution (basePath/attribution) and record shaping.
- `lib/sync-paths.js` — folder mapping, remote path building and folder-chain reconstruction on pull.
- `lib/sync-collect.js` — local listing and ignore filtering.
- `lib/sync-remote.js` — live repository listing (path attribution), remote file hash, pulled-record shaping and the 0.2.0 legacy cleanup.
- `lib/sync-round.js` — one round of execution (plan/apply/finalize) and the remaining-conflict count.
- `lib/sync-backend.js` — the kind registry and adapter error mapping.
- `lib/sync-state.js` — local persistence (guards, errors, scope, migration, snapshot advance).
- `lib/sync-store.js` — the storage-loss guard.
- `lib/sync-service.js` — the six service methods (thin assembly over the modules).
- `adapters/git-adapter.js` — the git backend over the GitHub Contents API; `branch` is optional and defaults to `main` (even when a stored record has `null`); a paginated listing that reaches the silent cap of 1,000 entries fails loudly with `GIT_DIRECTORY_TRUNCATED` (mapped to `SYNC_REMOTE_INVALID`) — a partial list is never the basis of a deletion decision.
- `adapters/gitlab-adapter.js` — the gitlab backend over the GitLab Files API (gitlab.com and self-hosted with `baseUrl`); rev = blob sha, locked on `last_commit_id` after a verification GET.
- `adapters/shared.js` — the 30-second timeout, the base64 codec and the shared git commit message.
- `adapters/README.md` — the new-kind contract for future backends.
- `tests/` — one test file per source file (+ the shared adapter contract suite).
- `docs/requirements.md` — the sole implementation source of truth.
- `imp/` — local planning material; not in git.
- `CHANGELOG.md` — the plugin's version history.

## Dependencies

- **Required:** `pey.storage.service` — record reads/writes and the engine's state/validity; every method fails explicitly without it.
- **Optional:** none.

## Public API

The manifest is the formal contract; below is how to call it:

```js
// 1. Configure (live validation, secret-free output)
await sync.configureBackend({
  kind: 'git',
  params: { repo: 'user/notes', branch: 'main', token: '<pat>' },
});
// → { ok: true, kind: 'git', repo: 'user/notes', branch: 'main', baseUrl: null }

// 1a. GitLab: baseUrl is optional for self-hosted servers (host root,
// e.g. https://gitlab.example.com); empty/missing = gitlab.com.
await sync.configureBackend({
  kind: 'gitlab',
  params: { repo: 'user/notes', branch: 'main', token: '<pat>',
            baseUrl: 'https://gitlab.example.com' },
});
// → { ok: true, kind: 'gitlab', ..., baseUrl: 'https://gitlab.example.com' }

// 2. Run with an explicit scope (path identity: the repo only sees real documents)
const report = await sync.syncNow({
  message: 'پيام کامیت سفارشی', // optional: this exact message becomes every
  // write/delete of this round (trimmed, max 200 chars); missing/empty =
  // automatic default messages. Conflict resolution and legacy cleanup
  // always take the automatic message.
  scope: { collections: [
    { collection: 'projects', serializer: 'json' }, // → projects/<id>.json
    { collection: 'tasks', serializer: 'markdown', titleField: 'name',
      contentField: 'body', folders: { collection: 'projects', nameField: 'name' },
      ignore: ['scratch'] }, // → repo root (default basePath '')
  ] },
});
// → { pushed, pulled, deletedRemote, deleteLocal, relocated, skipped,
//     conflicts: [{ collection, id, title, local, remote }], completed }

// 3. Single resolution (returns what remains)
await sync.resolveConflict({ collection: 'tasks', id: 't1', choice: 'local' });
// → { remaining: 0 } (at zero the baseline advances)

// 4. Status and removal
await sync.getStatus();
// → { configured, kind, repo, branch, baseUrl, lastSyncAt, lastError }
await sync.removeBackend(); // → { ok: true } (local data untouched)

// 5. Local pre-flight (no network at all)
await sync.hasPendingChanges({ scope });
// → { pending: true/false } (local-only news relative to the last snapshot;
// an unconfigured backend is always false, not an error)
```

Notes:

- The engine does not know about records the host is editing — the host must flush pending saves before running (the engine compares the record content against the round's baseline before every local overwrite/delete; a mismatch is skipped and stays dirty).
- `resolveConflict` reads the scope from the previous run (no scope re-pass needed).
- A conflict's remote side is content only (git gives no timestamp): the content string, or `null` when the file was unreadable at report time ("empty" never stands in for "unreadable"). If the conflicted remote file was not read during the round itself (the rev shortcut), its real content is read right there so the host never sees a blank remote side. If the remote content is unavailable at resolve time, the resolution reports "not applied" and the conflict stays open; if the file stays missing for good, the next round sees the path local-only and closes it under the normal takeover rule.
- The pin freshness guard (before every application): the resolve-time remote hash is compared with the pinned prompt-time hash, and the conflict's absence from the pin list is a refusal too — all three remote-destroying branches are covered: the `remote` choice (accepting remote content), the delete branch of a `local` choice on a delete-vs-change conflict, and the rewrite branch of that choice when a local side exists. A hash mismatch or an unpinned conflict means the user never saw the content they were deciding on; the resolution is refused without an error — the refusal is observable in `remaining`, which does not decrease (and the conflict stays in the `sync:changed` event) so the next round can ask again with fresh content.
- If the host has more than one open conflict with the same `(collection, id)` (the record-rename shape on an occupied path while the old remote path was edited — two prompts with one id), `resolveConflict` refuses with `SYNC_INVALID_CONFIG`: two same-id prompts are not separately addressable and the ambiguity must be resolved by the data itself (e.g. the record no longer claims both paths). Deleting the old path during a rename application is also skipped while a conflict on that path is open, so unseen content stays with its own prompt.
- Pins are bound to the destination: `removeBackend` and a destination switch empty the pin list, so a stale destination's pin can never authorize a fresh destination's resolution.
- On a delete-vs-change conflict each choice applies its own side: `local` deletes the remote file, `remote` revives the remote content — with the same freshness-guard exception.
- `hasPendingChanges` is the same hash comparison as `syncNow` without network: it understands "local news" but not falling-behind against the remote.

### Scope (per-collection fields)

- `collection` (required): the storage collection name.
- `serializer`: `json` (default) or `markdown`.
- `basePath`: this collection's remote path root (default: json → the collection's own name, text → the repo root; an explicit `''` is allowed for the root). Two collections sharing both the serializer extension AND the basePath are refused (`SYNC_INVALID_CONFIG` with `detail.collections`/`basePath`/`extension`) — remote attribution between them would stay ambiguous; a duplicate `collection` name in the whole scope is refused the same way.
- `idField` (default `id`), `updatedAtField` (default `updatedAt`), `titleField` (default `title`), `contentField` (default `content`): the host's record field names — a host with a different shape maps here.
- `folders`: `{ collection, nameField, idField?, parentField?, folderField? }` for path building from name chains; a folder record never goes to the remote and a missing chain is rebuilt from the path on pull.
- `ignore`: an array of gitignore-like patterns (default `[]`).
- The file extension comes from the serializer (`md`/`json`) and pattern matching ignores those extensions; an empty `title` falls back to `untitled`; a pulled title comes from the file name.

### Registering a new backend

The engine refuses a kind whose descriptor is not registered with `SYNC_INVALID_CONFIG`. The descriptor (`kind`, `create(params, fetchFn)`, `errorMap`, optional `revMismatchCode`) is defined in `adapters/README.md`; the host hands it to the service's `adapters` state and the Core needs no editing (`git` is the bundled default). The descriptor no longer carries `manifestPath` — a backend writes no metadata to the repository and is fully file-centric.

### Ignoring (gitignore-like)

Any collection in the scope may take `ignore: [...]` (an array of non-empty strings, otherwise `SYNC_INVALID_CONFIG`):

```js
await sync.syncNow({
  scope: { collections: [
    { collection: 'docs', serializer: 'markdown', ignore: ['پیش‌نویس', 'آرشیو/'] },
  ] },
});
```

- Patterns match the synced path **without the extension** (the host never asks the user for one): `*` and `?` within one segment, `**` across segments, a slash-less pattern matches any segment at any depth, and a trailing `/` means the folder and its whole subtree. No `!` negation — deliberately literal; case-sensitive like the host. A typed extension falls back off the full path so it is not silently lost.
- An ignored record leaves the local listing, the repo listing and the last snapshot (in the report's `skipped`, same shape; out-of-attribution paths are that report's `foreign`) — a folder is judged by its display path (`آموزش/زیر`) so ignoring a folder also takes the folder itself, not just its content. An ignored entry in the last snapshot never becomes `deleteLocal`: the record is out of the engine's jurisdiction and gets no false deletion.
- A rename/relocation can pull a record out from under an exact pattern (like gitignore itself); a broad pattern (`پیش*`) is safer against that.

## Events

- `sync:changed` — after every run (complete or not): `{ pushed, pulled, conflicts }` (items are `{ collection, id }`; full detail only in `syncNow`'s return value).
- `sync:conflicted` — when stopping on conflicts: `{ conflicts: [{ collection, id }] }`.

## Errors Reference

Errors are plain objects (`code`/`message`/`source`/`type`/`timestamp`/`detail`, like the Pey family), not `Error` instances; `detail` defaults to `null` and the adapter code stays in `detail.adapterCode`. All codes are operational.

| Code | When |
|---|---|
| `SYNC_NOT_CONFIGURED` | sync/resolve called without a backend |
| `SYNC_INVALID_CONFIG` | Unknown kind, bad GitLab base URL (non-http(s)), bad scope, bad choice, non-existent conflict, more than one open conflict with one `(collection, id)` (the rename twin — a failing refusal, unlike the freshness guard's error-free refusal), a duplicate `collection` name in the scope, or two collections sharing the extension and the basePath |
| `SYNC_AUTH_FAILED` | Token refused (401) or insufficient access (403: GitHub — the repo is not selected or Contents permission is missing; GitLab — a token of another project/repo or a token without the `api` scope: `write_repository`/`read_repository` scopes are invalid for the REST API) |
| `SYNC_REPO_NOT_FOUND` | Repo/branch missing (GitLab: no project with that owner/name path or branch) |
| `SYNC_NETWORK_FAILED` | Network down, a misc HTTP error, or the 30-second request timeout |
| `SYNC_RATE_LIMITED` | Rate cap (403 + header) |
| `SYNC_PATH_COLLISION` | Two local records claim one remote path (with both ids, before any remote write) |
| `SYNC_CONCURRENT_CHANGE` | Writing/deleting a file on a stale rev (the next run re-reads fresh) |
| `SYNC_STORAGE_UNAVAILABLE` | The local storage is unavailable |
| `SYNC_REMOTE_INVALID` | An existing remote file the collection codec cannot decode (the round stops before any write/delete) |
| `SYNC_IN_PROGRESS` | Another sync/resolve/configure operation is in flight |

## Config

The plugin needs no bootstrap key beyond the adapter registration (`adapters: {sync-target}` — the default value is a kind; the real kind arrives per run with `configureBackend`). The store schema (`sync_backends`, `sync_state` with `keyPath: id`) comes from the `pey.storage` config in `bootstrap.json` (schemaVersion 5).

## Business Rules

- Local is always the source of truth; the destination is a mirror.
- **The sync identity is the remote path itself**: no metadata file is written to the repository (`sync-manifest.json` was the 0.2.0 story and is cleaned up). The sync-id map is kept in `sync_state` (snapshot version 2, path-keyed with `{collection,id,path,hash,rev}`) so the repository only ever sees real files.
- Round order: live repo listing (+ snapshot migration) → the rev shortcut (rev-equal paths keep the old hash and are not read) → push, pull, two-way deletes, conflict detection; the snapshot advances only on a clean completion.
- Change comparison is content-hash based (no timestamp), not clock based; a conflict = both sides alive with a differing hash, or delete-vs-change — it always stops and asks (no side silently wins).
- Identical content with an equal hash is never rewritten; baseless equality (hash-less migration) is settled without asking when the content matches.
- A rename = push to the new path + delete of the old one; two local documents to one path yield `SYNC_PATH_COLLISION`; an id-less record is rejected.
- A json collection is path-addressed (`<base>/<id>.json`); a text collection takes title and folder from the path.
- On GitLab, rev = blob sha (tree and the write response give no `last_commit_id`); a write/delete of a file seen before its change is verified with a GET (a decayed or missing blob = the GitLab 400 mapped to `SYNC_CONCURRENT_CHANGE`), and after a write one follow-up GET returns the fresh blob.
- On GitLab, the file path is one fully encoded URL segment (slashes are `%2F`): a real slash only works at the repo root and documents inside folders get 404 (documented and verified against GitLab 17).

## Constraints

- The only trigger is manual (`syncNow`); scheduling belongs to the host.
- Every network request has a 30-second cap; an unresponsive server yields a network error, never an endless wait.
- UTF-8 text; binary is out of scope for this version.
- The token is plaintext in IndexedDB — the only guard is the OS profile lock (disclosed in the guide).
- Two devices in the same second yield `SYNC_CONCURRENT_CHANGE`: run again.
- Skewed device clocks are accepted (coverage: hash + prompt).
- The change-detection hash is 32-bit (FNV-1a): a ~2⁻³² collision loses one push; accepted deliberately because "local is the source of truth" compensates on the next round.
- The state is bound to the destination identity `(kind, baseUrl, repo, branch)` (the token is not part of it): a destination switch zeroes the baseline and the next round is like a first connection — no local deletions follow; a token-only change keeps the state.
- An existing remote file the codec cannot decode stops the round with `SYNC_REMOTE_INVALID` before any write/delete — a failure is never "deleted from the remote".
- The snapshot advances only from the round's verified outcomes, never a full store re-read; a racing host edit is skipped and stays dirty.
- Mutating operations are single-flight; overlap yields `SYNC_IN_PROGRESS`.
- Each collection's `basePath` applies symmetrically in the round trip (outgoing paths are built with it, incoming paths are stripped of it); `..` and empty segments are refused; two same-extension same-basePath collections and duplicate collection names are refused at the entrance (attribution ambiguity — a loud refusal, not silent behavior).
- Legacy cleanup deletes only `sync-manifest.json`, and only when a readable legacy manifest was actually seen; paths merely named in an old manifest are never touched.
- GitLab pagination follows only Link targets inside the same instance and API path prefix (a 50-page cap + a loop guard).
