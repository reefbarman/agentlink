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

## F6 throughput closeout

_Reproducible report command: `AGENTLINK_INDEXER_REPORT=1 npx vitest run src/indexer/workerFixture.test.ts src/indexer/structuralExtractor.test.ts`._

- [x] **101-file changed set:** three bounded worker batches complete with 3 Qdrant delete calls, 3 upsert calls, and 6 visibility calls.
- [x] **Cache amplification:** vector and structural writes fall from 202 each before batched replacement to 6 each. Total serialized cache bytes fall from 12,871,121 to 350,904 (186,012 vector; 164,892 structural).
- [x] **Memory/read bounds:** maximum active reads remain 10 and maximum retained content remains 36,900 bytes.
- [x] **Host observation:** the final reported run completed in 148 ms (`scan`: 6 ms, `read`: 5 ms, `process`: 136 ms). Timing remains non-gating because it varies by host.
- [x] **Structural resolution decision:** 644 files produced 1,814 relative specifiers, 2,263 candidate checks, and 1,813 resolutions—1.25 candidate checks per relative specifier. A module-resolution stat-cache rewrite is measurement-skipped as immaterial.
- [x] **Correctness:** journal-first ownership transitions, cancellation/failure retention, exact/non-exact restart recovery, bounded requests, coalesced recovery checkpoints, retained-content release, and read/search consistency remain covered by focused fixtures.

Run the base fixture with:

```sh
npx vitest run src/indexer/workerFixture.test.ts
```
