# Local Publication performance review

Keep the existing sample planner baseline and its same-environment comparison
policy. Performance and mutation measurements remain local-only: neither this
script nor the existing benchmark belongs in GitHub Actions or `npm run check`.

From `packages/node/`, build the exact source under review, then run:

```sh
npm run build
node scripts/measure-publication-pipeline.mjs --samples 20 --output reports/pipeline-before.json
# After the change and a new build, on the same quiet host:
node scripts/measure-publication-pipeline.mjs --samples 20 --compare reports/pipeline-before.json --output reports/pipeline-after.json
```

Each workload uses its own Node process. The matrix covers 100, 1,000 and 10,000
folders for planning, GET byte emission, HEAD, 304 preparation, receive-side
I-JSON/schema/semantic validation, and multi-page assembly. Receive measurement
explicitly raises the parser member budget for the large fixture; this is not a
change to client defaults. Timings are warm-path measurements and do not include
module import. GET/HEAD/304 measurements use already-issued plans and retain
all response preparation; they do not pretend that conditional responses are
free or bypass authorization/representation selection in a real host.

Reports record Node/OS/architecture/CPU, source revision and dirty status, byte
sizes, sample count, mean/p50/p95/max duration, sampled heap/RSS and process peak
RSS. Sampled memory is not an exact allocation peak; process peak also includes
startup and fixture preparation. Compare only the same quiet host and compatible
environment. There is no committed absolute throughput floor for this matrix.
The script rejects Actions execution and incompatible baseline environments.

Byte reuse removes a repeated clone/stringify of an already-validated immutable
Snapshot at response emission. It does not remove every projection copy or
prove a particular latency/memory improvement. Retain before/after reports to
decide whether additional optimization is justified. Do not trade away immutable
boundaries, public projection, content identity, or HEAD/304 header correctness.
