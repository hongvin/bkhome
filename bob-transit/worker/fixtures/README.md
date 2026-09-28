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
```

## Notes

- `rapid-rail-kl` has **no** realtime vehicle-position feed; only bus categories
  return data. `buildFeedUrl()` accepts the category as a parameter.
- The endpoint answers `301` before `200`; the worker follows redirects.
- Tests that need a synthetic feed (empty header, unusable entities) encode one
  in-memory with `encodeFeedMessage()` from `worker/proto.ts`.
