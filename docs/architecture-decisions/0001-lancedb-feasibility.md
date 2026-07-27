# ADR 0001: Use LanceDB 0.22.3 for unified local retrieval

- **Status:** Accepted for implementation
- **Date:** 2026-07-25
- **Stage:** Unified context architecture, Stage 2 feasibility gate

## Context

The unified retrieval plan requires one embedded store for lexical, vector, structural, session, and memory retrieval. LanceDB is preferred only if a disposable spike proves Node/VS Code compatibility, native packaging, cross-process consistency, safe writer serialization, crash behavior, representative performance, the required TypeScript SDK operations, and credential-free lexical retrieval without fake vectors.

AgentLink supports Windows, macOS, and Linux on x64 and ARM64. Linux packaging must distinguish glibc and musl targets. The retrieval contracts remain storage-neutral so this decision can be replaced without redesigning records, tools, authority, ranking, or UI.

## Decision

Use `@lancedb/lancedb@0.22.3` with `apache-arrow@18.1.0` for the production implementation, subject to the staged rollout gates in the master plan.

`0.22.3` is the last stable LanceDB JavaScript release with one consistent native package version for all eight required targets:

| VS Code target | LanceDB native package                     |
| -------------- | ------------------------------------------ |
| `darwin-arm64` | `@lancedb/lancedb-darwin-arm64@0.22.3`     |
| `darwin-x64`   | `@lancedb/lancedb-darwin-x64@0.22.3`       |
| `linux-x64`    | `@lancedb/lancedb-linux-x64-gnu@0.22.3`    |
| `linux-arm64`  | `@lancedb/lancedb-linux-arm64-gnu@0.22.3`  |
| `alpine-x64`   | `@lancedb/lancedb-linux-x64-musl@0.22.3`   |
| `alpine-arm64` | `@lancedb/lancedb-linux-arm64-musl@0.22.3` |
| `win32-x64`    | `@lancedb/lancedb-win32-x64-msvc@0.22.3`   |
| `win32-arm64`  | `@lancedb/lancedb-win32-arm64-msvc@0.22.3` |

Do not use `0.31.0`: its published optional dependencies and N-API targets omit macOS x64, and `@lancedb/lancedb-darwin-x64@0.31.0` does not exist.

Ship target-specific VSIX packages. Bundle the TypeScript/JavaScript SDK and Arrow runtime for Node 22, while staging exactly one target-native `.node` addon beside each Node bundle that can load LanceDB. Add an explicit `dist/**` allowlist entry to `.vscodeignore` when production staging is introduced. Do not ship all native targets in one universal VSIX.

Use `readConsistencyInterval: 0` for each long-lived connection. Serialize schema migrations and writes through one shared cross-process repository lock based on AgentLink's atomic-directory lock convention: exclusive `mkdir`, bounded wait, stale-owner reclamation, and `finally` release. Deduplicate `mergeInsert` input by key before mutation.

## Feasibility evidence

The disposable spike ran outside production source paths and did not add a project dependency.

### Gate results

| #   | Required proof                                 | Result | Evidence                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | VS Code Node 22 Extension Host                 | Pass   | Official VS Code `1.109.0` Extension Development Host reported Node `22.21.1`, Electron `39.3.0`, N-API `10`; native load, table creation, FTS index, and query succeeded. The current VS Code `1.129.1` Node `24.18.0` host also passed. |
| 2   | Bundle/externalize and stage supported targets | Pass   | esbuild produced an 874 KiB Node 22 bundle with the native addon staged beside it. Eight target-specific fixtures were packaged.                                                                                                          |
| 3   | `vsce ls` and VSIX contents                    | Pass   | Every fixture's `vsce ls` contained only the manifest, README, bundle, and expected native addon. Archive inspection confirmed exactly one correctly named addon per VSIX. Compressed sizes were 33.77–40.58 MiB.                         |
| 4   | Three-process strong read consistency          | Pass   | An already-open reader using `readConsistencyInterval: 0` observed commits from two independent writer processes.                                                                                                                         |
| 5   | Serialized concurrent writers                  | Pass   | Two child writers completed through the atomic-directory lock and produced exactly the expected revisions and rows.                                                                                                                       |
| 6   | Crash/interruption recovery                    | Pass   | A killed lock owner was reclaimed after the stale interval. Killing a 100K-row append produced no partial publication; the previous version reopened and accepted a new write.                                                            |
| 7   | Representative 10K-file performance            | Pass   | See measurements below.                                                                                                                                                                                                                   |
| 8   | Required TypeScript SDK behavior               | Pass   | BM25/FTS, filtered FTS, flat vector search, hybrid RRF, update, `mergeInsert`, delete, version checkout/restore, and optimize all passed under Node 22.                                                                                   |
| 9   | Absent/null embedding behavior                 | Pass   | Explicit nullable fixed-size vector schema stored null and omitted vectors as `null`; lexical rows remained searchable; vector search excluded null vectors; a separate table without any vector field supported BM25/FTS.                |

### 10K-file fixture

The fixture contained 10,000 source-like rows, 384-dimensional vectors on 9,000 rows, 1,000 null vectors, realistic paths/revisions/languages, an FTS index, and a scalar bitmap index.

| Measurement                        |                Result |
| ---------------------------------- | --------------------: |
| Arrow conversion                   |              87.04 ms |
| Table creation                     |              53.13 ms |
| FTS index creation                 |             257.33 ms |
| Scalar index creation              |               4.37 ms |
| Total initial build                |             401.87 ms |
| Optimize                           |               6.41 ms |
| Warm BM25 p50 / p90 / max          | 1.70 / 2.03 / 2.06 ms |
| Warm filtered BM25 p50 / p90 / max | 1.73 / 1.92 / 2.16 ms |
| Warm flat-vector p50 / p90 / max   | 2.02 / 2.26 / 2.41 ms |
| Database size                      |             18.72 MiB |
| Peak process RSS                   |            279.03 MiB |

Peak RSS is an upper-bound spike measurement: the benchmark retained the generated JavaScript rows and Arrow table while querying. Production ingestion must stream/batch records and measure service steady-state memory separately.

## Consequences

- Stage 3 may define backend-neutral retrieval/publication contracts, and Stage 4 may implement the LanceDB repository.
- Production packaging must generate target-specific VSIX artifacts and verify each artifact in CI. A host-only `npm install` is not sufficient because optional native dependencies are platform-specific.
- The production cutover must not expose LanceDB query builders, versions, or record types above the repository boundary.
- The repository layer owns all migrations, writes, restore, repair, and optimize operations. Generic file tools must not mutate the database root.
- Credential-free FTS/BM25 remains mandatory. Embeddings and vector indexes are optional health capabilities, not schema prerequisites.
- Qdrant and LanceDB must not become permanent selectable backends. Qdrant remains only until the staged fresh-index cutover and rollback gates permit removal.

## Limitations and follow-up gates

- LanceDB `0.22.3` is pinned because later stable releases dropped macOS x64. Upgrading requires repeating this target matrix and all Stage 2 runtime/packaging checks.
- The spike proved flat vector search with nullable vectors. Stage 4 must repeat null-vector parity with the selected production ANN index and assert index statistics before enabling ANN reads.
- Only darwin-arm64 could be executed locally. Other target packages were verified through npm package metadata, binary format/architecture inspection, `vsce ls`, and VSIX archive inspection. Target CI must run extracted-package load/query smoke tests natively before release.
- Production benchmark gates still require the same-source retrieval/task comparison against the existing index and a representative Browser Ask Agent memory corpus.
- Compaction returned valid optimize statistics on the small mutation fixture but had no fragments to merge. Stage 4 batching tests must create fragmented data and assert non-zero compaction behavior.

## Rejected alternatives

- **LanceDB 0.31.0:** rejected because it cannot satisfy AgentLink's declared macOS x64 support.
- **Build and sign an unpublished macOS x64 addon:** rejected as unnecessary custom supply-chain and release infrastructure while a stable all-target release exists.
- **Universal VSIX containing every native addon:** rejected because it would add hundreds of megabytes and load irrelevant binaries on every target.
- **Permanent LanceDB/SQLite or LanceDB/Qdrant selection:** rejected by the one-backend migration constraint.
- **SQLite+FTS5 fallback now:** not selected because all Stage 2 hard items passed. It remains the named replacement if a later mandatory rollout gate invalidates this decision.
