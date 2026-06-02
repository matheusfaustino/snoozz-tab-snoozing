# User Story — Global Snooze Server API Integration

## User Story

**As a** snoozz extension user with a self-hosted backend,
**I want** the extension to sync snooze state with a central server API,
**So that** I never receive duplicate wake notifications across my browser and phone, and can continue working offline if the server is unreachable.

---

## Acceptance Criteria

1. The settings page has a server URL and API token field; these are persisted in extension storage.
2. When a tab is snoozed, the extension registers the snooze on the server (non-blocking — local snooze proceeds regardless).
3. When a tab is about to wake, the extension queries the server to check if it was already woken elsewhere; if the server says `status != "snoozed"`, the local wake is skipped.
4. Every 5 minutes, the extension sends a heartbeat to the server to signal the browser is alive.
5. The server uses heartbeat presence to decide whether to notify the browser (primary) or iOS (fallback when browser is offline).
6. If the server is unreachable at any point, the extension silently falls back to its existing local-only behavior — no existing mechanism is replaced or broken.
7. A background sync routine runs every 5 minutes, reconciling local and server state using `updated_at` timestamps; the most recently updated record wins in both directions.
8. When the browser starts up (or reconnects after being offline), it immediately fires a sync + heartbeat before processing any pending wakes — mirroring the existing local behavior where the extension wakes all overdue tabs on startup.
9. mTLS is handled by the browser certificate store; the extension does not manage certificates.

---

## Decisions

| # | Decision |
|---|---|
| Sync interval | Every 5 minutes, same cadence as heartbeat |
| Conflict: server `dismissed`, local `snoozed` | Extension cancels the local wake |
| Conflict: local `dismissed`, server `snoozed` | Extension pushes dismissal up to server |
| Conflict resolution field | `updated_at` timestamp (added to server schema and tracked locally) |
| Pre-wake server timeout | 3 seconds, then fall back to local wake |
| Browser instances | Single browser; heartbeat means "this browser is alive" |
| Startup / reconnect | Trigger sync + heartbeat before processing any pending wakes |

---

## Tasks

### ✅ T1 — Settings: server URL + token

- Add server URL and API token input fields to the settings page UI
- Persist values to extension storage (`browser.storage.sync` or `local`)
- Validate URL format on save; show inline error if invalid
- Add a "Test connection" button that calls a health/ping endpoint and shows success or failure

### ✅ T2 — API client module

- Create a shared `serverApi.js` module wrapping all server calls
- Attach `Authorization: Bearer <token>` header to every request
- Implement a circuit-breaker / availability flag: if a request fails, mark server as unavailable and skip further calls until next heartbeat succeeds
- All calls must be non-blocking and must not throw unhandled errors that affect local behavior

### ✅ T3 — Heartbeat routine

- POST to `<server>/api/heartbeat` every 5 minutes from the background script
- Payload: `{ timestamp: <ISO> }`
- On success, mark server as available (reset circuit-breaker)
- On failure, mark server as unavailable

### ✅ T4 — Snooze registration on creation

- After the local snooze record is created, POST the snooze to `<server>/api/snooze`
- Payload: `{ id, url, title, fire_at, status: "snoozed", updated_at: <ISO> }`
- Fire-and-forget: local snooze is not blocked on server response
- On conflict (server returns 409 / already exists), log and continue

### ✅ T5 — Pre-wake server check

- Before executing a local wake, GET `<server>/api/snooze/<id>` with a 3s timeout
- If server returns `status != "snoozed"` (dismissed or fired elsewhere), skip local wake
- If server does not respond within 3s or is unavailable, proceed with local wake

### ✅ T6 — Sync routine (every 5 minutes + on startup/reconnect)

- GET `<server>/api/snoozes` to fetch all server snooze records
- Compare each record against local state using `updated_at`:
  - Server record is newer → apply server state locally (including cancelling a pending local wake if server status is `dismissed`)
  - Local record is newer → push local state to server via PATCH/PUT `<server>/api/snooze/<id>`
  - Local-only record → POST to server
  - Server-only record → create locally
- On startup and reconnect, this sync runs before any pending wakes are processed
- Skip sync entirely if server is marked unavailable

### ✅ T7 — Schema: add `updated_at`

- Add `updated_at` field to the server `snoozes` table (auto-updated on every status change)
- Track `updated_at` locally in the extension's snooze storage alongside existing fields

### ✅ T8 — Fallback behavior

- Every server call is wrapped so that any network error, timeout, or non-2xx response causes a silent fallback to local behavior
- No user-visible error for transient failures
- Surface a persistent indicator on the settings page if server has been unreachable for >15 minutes
