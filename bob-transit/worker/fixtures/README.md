# Worker fixtures

Committed GTFS-Realtime payloads. The decode path and every test read only
these files — no test ever touches the network.

## `vehicle-position-prasarana-rapid-bus-kl.pb`

**This is a REAL captured feed sample**, not a self-encoded one.

| Field | Value |
|---|---|
| Source URL | `https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-kl` |
| Final URL after redirect | `https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana/?category=rapid-bus-kl` (HTTP 301 → 200) |
| Captured | 2026-09-28T12:09:02Z |
| HTTP status | 200 |
| `content-type` | `application/octet-stream` |
| `content-disposition` | `attachment; filename=vehicle-position-prasarana.proto` |
| Size | 11002 bytes |
| sha256 | `89c7fb561d9f345de1440f6db10c4d40e8f4589cb7b9ceb87048a3ec8780622c` |
| Decoded | `gtfs_realtime_version` 2.0, `incrementality` FULL_DATASET, 100 entities, 100 usable vehicle positions |
| Header timestamp | 1790597324 (Unix seconds) |

Recapture with (network required, one-shot, never run in tests):

```bash
./node_modules/.bin/tsx worker/scripts/capture-fixture.ts
# write somewhere else instead of clobbering the pinned fixture:
./node_modules/.bin/tsx worker/scripts/capture-fixture.ts --out=/tmp/new-sample.pb
```

> **Recapturing invalidates pinned expectations.** `tests/worker/helpers.ts`
> pins `FIXTURE_SHA256` and `FIXTURE_ENTITY_COUNT`, and
> `tests/worker/decode.test.ts` asserts the exact first/second vehicle. Update
> those in the same change, or the suite will (correctly) fail.

## Notes

- `rapid-rail-kl` has **no** realtime vehicle-position feed; only bus categories
  return data. `buildFeedUrl()` accepts the category as a parameter. Verified:
  `--category=rapid-rail-kl` returns HTTP 404.
- The endpoint answers `301` before `200`; the worker follows redirects.
- The public endpoint rate-limits aggressive polling (HTTP 429 after many
  requests in a minute). The worker reports this as `kind: "http", status: 429`
  and exits non-zero without writing — which is the intended scheduler signal.
- Tests that need a synthetic feed (empty header, unusable entities) encode one
  in-memory with `encodeFeedMessage()` from `worker/proto.ts`.
