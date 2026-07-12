# Indexer worker F1 baseline

_Reproducible fixture: `src/indexer/workerFixture.test.ts`._

- [x] **Initial index:** 51 files across two worker file batches, including one 4,000-line source file.
  - 51 files become indexed; Qdrant collection setup/deletion occurs once each.
  - Vector and structural caches are each written four times: force reset, once per file batch, and final save.
  - Active reads stay at or below the production limit of 10.
  - Simultaneously retained content exceeds 50 KB for the representative large-file batch and remains batch-bounded.
- [x] **Branch-like incremental update:** one changed file plus one removed file.
  - Old points for both files are deleted; only the changed file is re-indexed.
  - The worker performs one upsert and two writes each for vector and structural caches (batch plus final save).
- [x] **Cancellation:** cancellation while a delayed embedding request is in flight completes with `cancelled: true`, zero upserts, and a nonzero heap sample.
- [x] **Retry:** one HTTP 429 embedding response produces exactly two embedding attempts and a successful completed file.
- [x] **Partial failure:** one failed Qdrant upsert still returns a completed worker result with the error and zero successful upserts.
  - Current baseline risk for F2: the vector cache reports one indexed file even though Qdrant reports no successful points.
- [x] **Per-run observations:** completion metrics include scan/read/diff/process phase durations, UTF-8 cache bytes, maximum active reads, maximum retained content bytes, and sampled heap high-water bytes. Timing and heap values are intentionally not pinned because they vary by host.

Run the fixture with:

```sh
npx vitest run src/indexer/workerFixture.test.ts
```
