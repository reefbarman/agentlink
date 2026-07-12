# Indexer F2 transition and recovery protocol

## Decision

Use a **durable cleanup journal with predeclared random point IDs**.

Before any Qdrant mutation, persist the file operation with:

- operation ID, file path, kind (`remove` or `replace`), and target generation;
- target content hash for replacements;
- the complete old point-ID set from the committed vector cache;
- every intended replacement point ID grouped by file and upsert batch.

The journal writer must assign a fresh operation ID for diagnostics and journal-record identity; it is not part of the cache commit proof and is not an ABA discriminator. Generated point IDs are unique both within the operation and against the file's committed IDs. The journal owns every listed ID until the operation is committed or recovered. This keeps the current random-ID scheme, avoids a Qdrant payload migration, and closes the Qdrant-success/cache-checkpoint crash window because successful remote mutations can always be cleaned up after restart.

## Durable ordering

1. Generate all replacement point IDs and the batch plan in memory.
2. Atomically replace the journal file, fsync the journal file, then fsync its directory.
3. Hide files with active journal operations from indexed-query visibility.
4. Delete old Qdrant points. Keep the old committed cache entry unchanged until checkpoint.
5. Perform replacement upsert batches. Record confirmations in memory only; an unresolved journal always owns all predeclared IDs.
6. After every intended batch succeeds, atomically replace the vector cache, fsync it, then fsync its directory. The durable vector proof is the generation, target hash, and ordered point IDs; runtime mutation confirmations are not durable.
7. Checkpoint the structural cache with the journal generation and mark it `current`. Until this independently durable write completes, structural state remains `stale` or `unavailable`; status without an exact generation match does not prove structural commit.
8. Only after both exact vector proof and `current` structural state for the journal generation exist, atomically rewrite/remove the journal, fsync the journal file when rewritten, then fsync its directory.
9. Expose the new committed cache entry only after journal cleanup.

Vector and structural files are not claimed to be transactionally atomic together. Each durable cache record carries its observed generation/status; cross-generation or invalid records keep the target generation unavailable.

## Recovery

For each journal operation on startup:

- **Exact replacement vector proof with current structural state:** generation, target hash, and ordered point IDs exactly match the journal intent, and structural status is `current` for that same journal generation; clear the journal and expose the file even though restart discarded all in-memory mutation confirmations.
- **Exact replacement vector proof with stale/unavailable structural state:** repair and durably checkpoint structural state for the journal generation, then clear the journal. Do not destructively reindex an already-proven vector commit.
- **Any other replacement state:** hide the cache entry, idempotently delete the union of old and all intended IDs, record a distinct runtime-only full-cleanup confirmation, atomically checkpoint vector absence and structural unavailability, then clear the journal and reindex. Initial old-delete confirmation never authorizes this path, and any subsequent upsert invalidates both full-cleanup and invalidation confirmations. A crash before journal cleanup replays idempotent union deletion before reconfirming invalidation and clearing the journal.
- **Removal:** idempotently delete all old IDs even when the cache entry is already absent, checkpoint absence, then clear the journal.
- **Corrupt vector or structural cache:** mark the affected generation unavailable and require rebuild; an active valid journal still owns all listed IDs.
- **Corrupt journal:** mark the affected generation unavailable and preserve the damaged record for operator-assisted recovery/rebuild; never infer ownership or silently discard possible ownership evidence.

A graceful completion or cancellation awaits the final cache/journal checkpoint. Abrupt crash/kill relies only on the durable journal and atomic cache files, never exit-time flushing.

## Crash boundaries

The executable model in `src/indexer/fileIndexState.ts` and `src/indexer/fileIndexState.test.ts` requires:

- crash before or after old-delete confirmation → delete old and all intended IDs, then retry/finalize;
- crash after any partial or full upsert → delete old and all intended IDs, then retry;
- crash before cache replacement → same conservative cleanup;
- crash after vector-cache replacement but before structural checkpoint → accept only an exact generation/hash/ordered-ID match, repair structural state, then clear the journal;
- crash after structural checkpoint but before journal cleanup → exact vector proof plus current structural state authorizes journal cleanup without recovered runtime confirmations;
- crash after journal cleanup → the committed cache is authoritative;
- collection reset/granularity change → no generation is available from durable reset preparation through collection deletion/recreation; the new generation becomes available only at the final reset commit.

## Deferred production boundaries

This commit defines and characterizes the protocol only. Follow-up F2 rollback boundaries must implement, separately:

1. atomic journal/cache persistence and fsync/temp cleanup;
2. removed-file deletion correctness;
3. changed-file batch ownership and cache visibility;
4. startup recovery and crash injection against the real worker fixture;
5. collection reset generation persistence.
