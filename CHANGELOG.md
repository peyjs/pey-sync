# Changelog — pey.sync

## [1.0.0] - 1405-08-08

Initial pey release: manual, backend-neutral sync of `pey.storage` collections — path-keyed three-way engine, `git` (GitHub Contents API) and `gitlab` (GitLab Files API) backends extensible through the `sync-target` descriptor contract, ignore patterns, custom commit messages, legacy-snapshot migration, conflict prompts with both-side previews, and `docs/requirements.md` (numbered pey format) as the construction source of truth. Conflict resolution applies the chosen side exactly: a `remote` choice on a delete-vs-change conflict deletes the local record, and resolving a path-takeover conflict frees the displaced owner's snapshot entry so the same conflict cannot re-fire.

> Incubated in Parsinegar as 0.1.0–0.4.0; that history stays with the source project — the pey release lineage starts here.
