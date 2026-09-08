**Data pipeline implementation — 8 September 2026**

Scope: shared search/fetch reliability, durable admission and prepopulation checkpoints, evaluation batching, selective images, recoverable listings, shared page reads, Overture Places and accessibility.cloud. Additional search vendors are outside this implementation; the user selected Overture and accessibility.cloud.

Work branch: `feat/data-pipeline-reliability`, based on `f3fc96c`, in `/home/alain/dev/webmcp-data-pipeline`. Original drawer worktree and unrelated main edits are untouched.

- [x] Typed provider/deferred outcomes; no failed search/evaluation omission writes.
- [x] Shared database quotas and workload reservations, safe request/cost accounting.
- [x] Durable resumable CLI jobs/stages, request/cost caps, retry and repair commands.
- [x] Batched evaluation with backpressure and explicit workload intent.
- [x] Conditional Commons discovery; normal no-image outcome.
- [x] Listing task validation, pagination and durable partial-batch recovery.
- [x] Shared bounded page cache reads, concurrent-read coordination and alternate results.
- [x] Overture regional import, conservative entity matching and site discovery.
- [x] accessibility.cloud scoped/licensed imports, provenance and shared enrichment.
- [x] Regression tests, isolated API database checks, deterministic benchmark and documentation.

Verified on Node.js 24 with an isolated PostgreSQL 17 database:

- 801 unit tests passed across 61 files.
- 275 API tests passed across 40 files, using `--maxWorkers=2` to bound server-fixture connections.
- Workspace type checking and the production web build passed.
- CLI dry run, Overture/maintenance help, migration hash checks and `git diff --check` passed.
- Recovery tests cover cross-pool quota races, model reservations before search, resume leases, partial listing pages, missing migrations, import rollback, source attribution and publishing saved facts during a Commons outage.

Credential-dependent activation: accessibility.cloud requires `ACCESSIBILITY_CLOUD_TOKEN` and selected source IDs; Overture requires a regional import and `OVERTURE=1`. Provider behavior was verified with fixtures. No production deployment or broad paid rerun has occurred.

Validation and operating details are in [PREPOPULATE.md](PREPOPULATE.md). The replay result is structural evidence for batching, not a production speed or accuracy claim. Production activation and the historical repair remain explicit operational steps.
