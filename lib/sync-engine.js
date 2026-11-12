// Pure sync decision logic for pey.sync: path-keyed three-way planning
// over the last snapshot, current local state and the live remote
// listing. No I/O, no state, no clock reads — the service supplies
// everything and applies the plan. The sync identity is the remote
// path itself: no manifest, no remote metadata files.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Builds the identity key for one record (collection + id).
 * @param {object} entry Entry with collection and id.
 * @returns {string} Stable key.
 */
function ownerOf(entry) {
  return `${entry.collection}::${entry.id}`;
}

/**
 * Checks a local entry carries everything planning needs.
 * @param {object} entry Candidate entry.
 * @returns {boolean} True when usable.
 */
function isPlannable(entry) {
  return (
    !!entry
    && typeof entry.collection === 'string'
    && entry.collection.length > 0
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && typeof entry.path === 'string'
    && entry.path.length > 0
    && typeof entry.hash === 'string'
    && entry.hash.length > 0
  );
}

/**
 * Checks a remote listing entry carries everything planning needs. The
 * hash is always supplied by the caller (rev-matched entries borrow the
 * snapshot hash), so planning stays decision-force without fetches.
 * @param {object} entry Candidate listing entry.
 * @returns {boolean} True when usable.
 */
function isListable(entry) {
  return (
    !!entry
    && typeof entry.collection === 'string'
    && entry.collection.length > 0
    && typeof entry.path === 'string'
    && entry.path.length > 0
    && typeof entry.hash === 'string'
    && entry.hash.length > 0
    && (entry.rev === undefined || entry.rev === null || typeof entry.rev === 'string')
  );
}

/**
 * Checks a snapshot entry carries matchable identity. Hash may be null
 * right after a legacy-snapshot migration: an unknown base always ranks
 * as changed on both sides unless local and remote content agree.
 * @param {object} entry Candidate entry.
 * @returns {boolean} True when usable.
 */
function isSnapshotEntry(entry) {
  return (
    !!entry
    && typeof entry.collection === 'string'
    && entry.collection.length > 0
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && typeof entry.path === 'string'
    && entry.path.length > 0
    && (entry.hash === null || (typeof entry.hash === 'string' && entry.hash.length > 0))
    && (entry.rev === undefined || entry.rev === null || typeof entry.rev === 'string')
  );
}

/**
 * Compares a snapshot against current local state, path-keyed. A moved
 * record reads as a deletion at the old path and a creation at the new
 * one — the same shape the next sync round acts on, so this diff is
 * exactly the local pending set.
 * @param {Array} snapshot Last-synced entries ({collection, id, path, hash}).
 * @param {Array} current Current local entries ({collection, id, path, hash}).
 * @returns {object} `{ created, changed, deleted, skipped }`.
 */
export function snapshotDiff(snapshot, current) {
  const known = new Map();
  const skipped = [];
  for (const entry of snapshot ?? []) {
    if (isSnapshotEntry(entry) && !known.has(entry.path)) {
      known.set(entry.path, entry);
    } else {
      skipped.push(entry);
    }
  }
  const created = [];
  const changed = [];
  const deleted = [];
  const seen = new Set();
  for (const entry of current ?? []) {
    if (!isPlannable(entry)) {
      skipped.push(entry);
      continue;
    }
    if (seen.has(entry.path)) {
      skipped.push(entry);
      continue;
    }
    seen.add(entry.path);
    const before = known.get(entry.path);
    if (!before) {
      created.push(entry);
      continue;
    }
    if (before.hash !== entry.hash) {
      changed.push(entry);
    }
  }
  for (const [path, entry] of known) {
    if (!seen.has(path)) {
      deleted.push({ collection: entry.collection, id: entry.id, path });
    }
  }
  return { created, changed, deleted, skipped };
}

/**
 * Plans one manual sync round from the last snapshot, current local state
 * and the remote listing — all keyed by remote path. Emits push/pull work,
 * both-side deletions and conflicts; never guesses a conflict away. A
 * local rename surfaces as a push at the new path plus a remote deletion
 * at the old one (the old path loses its local occupant). Two local
 * entries travelling to one path are collisions: the plan reports them so
 * the service can fail loudly instead of silently writing one winner.
 * @param {Array} snapshot Last-synced entries ({collection, id, path, hash, rev?}).
 * @param {Array} local Current local entries ({collection, id, path, hash}).
 * @param {Array} remote Remote listing ({collection, path, hash, rev?}).
 * @returns {object} `{ push, pull, deleteRemote, deleteLocal, conflicts,
 *   collisions, skipped, gonePaths }`; push/pull entries carry `{collection, id,
 *   path, hash, rev}` (pull `id` null when nothing local lives there),
 *   deleteRemote carries the last-known remote `{collection, id, path,
 *   rev}`, conflicts `{collection, id, local, remote}` with either side
 *   null on delete-vs-change, collisions `{collection, id, path, otherId}`,
 *   and gonePaths carries the PLAIN-STRING paths of this round's dead
 *   claims — snapshot entries with no local and no remote presence and NOT
 *   among the round's unattributed ("foreign") paths — for the clean
 *   advance to drop from the baseline.
 * @param {Set|null} [foreignPaths] Paths carrying THIS round's
 *   unattributed ("foreign") remote files: a local-only path among them
 *   stays out of the plan entirely — its remote file exists, so it is
 *   never a local deletion to propagate and never a ghost delete-vs-change
 *   question (round 12 defense-in-depth; the scope contention guard
 *   closes the class at config time).
 */
export function planSync(snapshot, local, remote, foreignPaths = null) {
  const snapByPath = new Map();
  const localOwners = new Map();
  const localByPath = new Map();
  const remoteByPath = new Map();
  const skipped = [];
  for (const entry of snapshot ?? []) {
    if (isSnapshotEntry(entry) && !snapByPath.has(entry.path)) {
      snapByPath.set(entry.path, entry);
    } else {
      skipped.push(entry);
    }
  }
  for (const entry of local ?? []) {
    if (!isPlannable(entry)) {
      skipped.push(entry);
      continue;
    }
    if (localByPath.has(entry.path)) {
      skipped.push({ ...entry, collisionWith: localByPath.get(entry.path).id });
      continue;
    }
    localByPath.set(entry.path, entry);
    if (!localOwners.has(ownerOf(entry))) {
      localOwners.set(ownerOf(entry), entry);
    }
  }
  for (const entry of remote ?? []) {
    if (!isListable(entry)) {
      skipped.push(entry);
      continue;
    }
    if (!remoteByPath.has(entry.path)) {
      remoteByPath.set(entry.path, entry);
    } else {
      skipped.push(entry);
    }
  }
  const push = [];
  const pull = [];
  const deleteRemote = [];
  const deleteLocal = [];
  const conflicts = [];
  const collisions = [];
  // Snapshot paths with NO local and NO remote presence this round: both
  // sides lost them, so their baseline entries are dead claims to drop at
  // the clean advance (see the planning loop's last branch).
  const gonePaths = [];
  for (let index = skipped.length - 1; index >= 0; index -= 1) {
    const entry = skipped[index];
    if (entry?.collisionWith) {
      collisions.push({
        collection: entry.collection,
        id: entry.id,
        path: entry.path,
        otherId: entry.collisionWith,
      });
      skipped.splice(index, 1);
    }
  }
  const paths = new Set([...localByPath.keys(), ...remoteByPath.keys(), ...snapByPath.keys()]);
  const plan = { push, pull, deleteRemote, deleteLocal, conflicts, collisions, skipped, gonePaths };
  for (const path of paths) {
    const current = localByPath.get(path) ?? null;
    const listed = remoteByPath.get(path) ?? null;
    const before = snapByPath.get(path) ?? null;
    if (current && listed) {
      planSharedPath(path, current, listed, before, localOwners, plan);
    } else if (current) {
      planLocalOnlyPath(path, current, before, plan, foreignPaths);
    } else if (listed) {
      planRemoteOnlyPath(path, listed, before, plan);
    } else if (!foreignPaths?.has(path)) {
      // Local and remote both lost the path: nothing on either side. The
      // baseline entry is a dead claim — nothing will ever write an outcome
      // for it, and mergeRoundSnapshot only touches outcome paths, so
      // without an explicit drop it would pin `pending: true` forever (the
      // dirty dot could never clear; round 13). A path carrying THIS
      // round's unattributed ("foreign") files is NOT gone — its file is
      // alive on the remote, the scope just could not claim it — so its
      // baseline entry stays and the next round with the fixed config
      // adjudicates the deletion for real (round 14: dropping it silently
      // FORGOT the user's deletion intent and resurrected the record with
      // a fresh id after the config was fixed).
      plan.gonePaths.push(path);
    }
  }
  return plan;
}

/**
 * Plans one path occupied on both sides: change detection against the
 * snapshot decides push/pull, ownership changes decide takeover vs ask.
 * @param {string} path Remote path.
 * @param {object} current Local entry at the path.
 * @param {object} listed Remote entry at the path.
 * @param {object|null} before Snapshot entry at the path.
 * @param {Map} localOwners Local entries keyed by collection::id.
 * @param {object} plan Plan accumulator ({push, pull, conflicts, ...}).
 * @returns {void}
 */
function planSharedPath(path, current, listed, before, localOwners, plan) {
  if (!before) {
    // Both sides grew the path since the last sync: agreement is a
    // silent convergence, divergence asks.
    if (current.hash !== listed.hash) {
      plan.conflicts.push({ collection: current.collection, id: current.id, local: current, remote: listed });
    }
    return;
  }
  if (ownerOf(current) !== ownerOf(before)) {
    if (localOwners.has(ownerOf(before))) {
      // The snapshot owner still lives locally somewhere else (it
      // moved): this local record takes the path over and rewrites
      // the file it used to leave behind — but only while the remote
      // file still matches the snapshot. A remote edit since the last
      // sync is content the round has never seen; overwriting it
      // silently would destroy it (goal: nothing is ever lost without
      // asking). Requirement 20: both sides changed relative to the
      // snapshot, so asking is the only safe move — the same outcome
      // the vanished-owner takeover branch below reaches.
      if (listed.hash !== before.hash) {
        plan.conflicts.push({ collection: current.collection, id: current.id, local: current, remote: listed });
      } else {
        plan.push.push(current);
      }
    } else {
      // The old owner vanished locally while the remote file stayed:
      // a real ambiguity — the remote content may be the owner's
      // edited version, and the local record may be the owner's
      // rewrite. Asking is the only safe move.
      plan.conflicts.push({ collection: current.collection, id: current.id, local: current, remote: listed });
    }
    return;
  }
  const localChanged = current.hash !== before.hash;
  const remoteChanged = listed.hash !== before.hash;
  if (!localChanged && !remoteChanged) {
    return;
  }
  if (localChanged && !remoteChanged) {
    plan.push.push(current);
    return;
  }
  if (remoteChanged && !localChanged) {
    plan.pull.push({
      collection: listed.collection,
      id: listed.id ?? current.id,
      path,
      hash: listed.hash,
      rev: listed.rev ?? null,
    });
    return;
  }
  if (current.hash === listed.hash) {
    // Both sides converged to the same content; nothing to do.
    return;
  }
  plan.conflicts.push({ collection: current.collection, id: current.id, local: current, remote: listed });
}

/**
 * Plans one path that only exists locally: a new push, a takeover push,
 * a delete-vs-edit conflict, or the local deletion to propagate.
 * @param {string} path Remote path.
 * @param {object} current Local entry at the path.
 * @param {object|null} before Snapshot entry at the path.
 * @param {object} plan Plan accumulator ({push, conflicts, deleteLocal, ...}).
 * @returns {void}
 */
function planLocalOnlyPath(path, current, before, plan, foreignPaths) {
  // Round-12 guard: a path carrying THIS round's unattributed ("foreign")
  // files has a remote file the scope could not attribute to one
  // collection — the file EXISTS, it is not remotely deleted, so the path
  // must never read as a local deletion to propagate, never ask a ghost
  // delete-vs-change question whose both answers are destructive, and
  // never push over the unattributable file either. It stays "skipped"
  // (the round reports it) and dirty; with the scope contention guard
  // (same extension AND basePath in two collections) this cannot arise
  // from a validated config — this is the defense-in-depth half.
  if (foreignPaths?.has(path)) {
    return;
  }
  // Remote dropped the path (or never had it); the local record is
  // new content there. When the snapshot holds a foreign owner, the
  // local record simply took the path over.
  if (!before || before.id !== current.id) {
    plan.push.push(current);
  } else if (current.hash !== before.hash) {
    plan.conflicts.push({ collection: current.collection, id: current.id, local: current, remote: null });
  } else {
    plan.deleteLocal.push({ collection: current.collection, id: current.id, path });
  }
}

/**
 * Plans one path that only exists remotely: a fresh pull, a delete-vs-edit
 * conflict, or the remote deletion to propagate.
 * @param {string} path Remote path.
 * @param {object} listed Remote entry at the path.
 * @param {object|null} before Snapshot entry at the path.
 * @param {object} plan Plan accumulator ({pull, conflicts, deleteRemote, ...}).
 * @returns {void}
 */
function planRemoteOnlyPath(path, listed, before, plan) {
  if (!before) {
    plan.pull.push({
      collection: listed.collection,
      id: listed.id ?? null,
      path,
      hash: listed.hash,
      rev: listed.rev ?? null,
    });
  } else if (listed.hash !== before.hash) {
    // The local record left the path (deleted, or moved away) while
    // the remote content was edited in the meantime: keep-mine frees
    // the file, take-theirs revives it.
    plan.conflicts.push({ collection: before.collection, id: before.id, local: null, remote: listed });
  } else {
    plan.deleteRemote.push({
      collection: before.collection,
      id: before.id,
      path,
      rev: listed.rev ?? null,
    });
  }
}


/**
 * Hashes file content for change comparison (FNV-1a, synchronous). The
 * 32-bit width means two different contents collide with probability
 * ~2⁻³²: such a collision would read as "unchanged" and skip one push.
 * Accepted deliberately — "local is the source of truth" keeps the next
 * round able to catch up, and the hash never guards money or safety.
 * @param {string} content Serialized file content.
 * @returns {string} Eight hex characters.
 * @throws {TypeError} When content is not a string.
 */
export function hashRecord(content) {
  if (typeof content !== 'string') {
    throw new TypeError('hashRecord requires a string');
  }
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Escapes one glob segment to a full-match regex (`*` stays inside its
 * segment, `?` is one non-slash character).
 * @param {string} segment Glob segment.
 * @returns {RegExp} Full-match pattern.
 */
function segmentPattern(segment) {
  let out = '';
  for (const character of segment) {
    if (character === '*') {
      out += '[^/]*';
    } else if (character === '?') {
      out += '[^/]';
    } else {
      out += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Matches path segments against pattern segments (`**` spans zero or more
 * whole segments on either side).
 * @param {Array<string>} patternSegs Pattern segments.
 * @param {Array<string>} pathSegs Path segments.
 * @returns {boolean} True on full match.
 */
function matchSegments(patternSegs, pathSegs) {
  if (patternSegs.length === 0) {
    return pathSegs.length === 0;
  }
  const [head, ...tail] = patternSegs;
  if (head === '**') {
    for (let skip = 0; skip <= pathSegs.length; skip += 1) {
      if (matchSegments(tail, pathSegs.slice(skip))) {
        return true;
      }
    }
    return false;
  }
  if (pathSegs.length === 0 || !segmentPattern(head).test(pathSegs[0])) {
    return false;
  }
  return matchSegments(tail, pathSegs.slice(1));
}

/**
 * Matches one synced path against one pattern, gitignore-style subset:
 * `*`/`?` inside a segment, `**` across segments, a slashless pattern hits
 * any single segment at any depth, and a trailing slash takes the whole
 * subtree. No negation (`!` is literal). Case-sensitive, like the host.
 * @param {string} path Relative synced path.
 * @param {string} pattern Single pattern.
 * @returns {boolean} True when ignored.
 */
function matchOne(path, pattern) {
  const dir = pattern.endsWith('/');
  const base = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (base.length === 0) {
    return false;
  }
  const pathSegs = path.split('/');
  if (!base.includes('/')) {
    const segment = segmentPattern(base);
    return pathSegs.some((part) => segment.test(part));
  }
  const patternSegs = base.split('/');
  if (dir) {
    patternSegs.push('**');
  }
  return matchSegments(patternSegs, pathSegs);
}

/**
 * Reports whether a synced path is ignored by the given patterns. Document
 * paths are matched extension-free (hosts map their own extensions; the
 * default covers the mandated `.md`), falling back to the full path so a
 * typed suffix still hits instead of silently missing.
 * @param {string} path Relative synced path.
 * @param {Array<string>} patterns Ignore patterns.
 * @param {Array<string>} [extensions] Suffixes to strip before matching.
 * @returns {boolean} True when ignored.
 */
export function matchesIgnore(path, patterns, extensions = ['md']) {
  if (typeof path !== 'string' || path.length === 0 || !Array.isArray(patterns)) {
    return false;
  }
  const suffixes = Array.isArray(extensions) && extensions.length > 0 ? extensions : [];
  let stripped = path;
  const lowered = path.toLowerCase();
  for (const extension of suffixes) {
    if (typeof extension !== 'string' || extension.length === 0) {
      continue;
    }
    const suffix = `.${extension.toLowerCase()}`;
    if (lowered.endsWith(suffix) && stripped.length > suffix.length) {
      stripped = stripped.slice(0, -suffix.length);
      break;
    }
  }
  const candidates = stripped !== path ? [stripped, path] : [path];
  for (const raw of patterns) {
    if (typeof raw !== 'string') {
      continue;
    }
    const pattern = raw.trim();
    if (pattern.length === 0) {
      continue;
    }
    if (candidates.some((candidate) => matchOne(candidate, pattern))) {
      return true;
    }
  }
  return false;
}
