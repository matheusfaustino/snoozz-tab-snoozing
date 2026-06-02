# Tab Snooze — Project Spec

The main browser supported is Firefox. Chrome is second class citizen and full support won't be added.

## What It Does
A self-hosted tab snooze system. User snoozes a browser tab from a Firefox extension, gets a push notification on iOS at the scheduled time with action buttons (Open, Snooze 1hr, Dismiss). All state is tracked to prevent duplicate notifications.

---

## Infrastructure

- **Homelab**: Proxmox
- **External access**: Cloudflare Tunnel (`cloudflared`) — no open ports
- **mTLS**: Enforced at Cloudflare edge for external traffic (Firefox extension)
- **Internal traffic**: Plain HTTP over LAN, no mTLS needed

---

## Final Stack

| Component | Technology |
|---|---|
| Browser extension | Firefox WebExtension |
| Backend API | Python + FastAPI |
| Scheduler | APScheduler (AsyncIOScheduler) with SQLAlchemy jobstore |
| Database | SQLite |
| Push notifications | Home Assistant Companion App (APNs) |
| Tunnel | Cloudflare Tunnel |

---

## What Was Dropped & Why

- **ntfy** — iOS app does not support mTLS client certs, workarounds were messy
- **n8n** — replaced by Python + APScheduler, no need for extra service
- **Caddy/Nginx** — not needed, Cloudflare Tunnel handles ingress
- **Bark** — unnecessary since HA is already running with mTLS working
- **Cron polling** — replaced by APScheduler `date` trigger (fires exactly on time)

---

## Traffic Flows

### Snooze Creation
```
Firefox Extension
  → POST https://tabs.yourdomain.com/api/snooze  (Cloudflare Tunnel + mTLS)
  → FastAPI (LAN :8000)
  → SQLite (write snooze record, status=snoozed)
  → APScheduler.add_job(run_date=fire_at)
```

### Notification Fire
```
APScheduler fires at exact time
  → check status == "snoozed" (skip if already dismissed)
  → update status = "fired"
  → POST http://homeassistant.local:8123/api/services/notify/mobile_app_xxx  (LAN)
  → HA Companion → APNs → iOS notification
```

### Action Response
```
User taps action on iOS notification
  → HA Companion callback → HA automation
  → HA rest_command → POST http://python-api.local:8000/api/action  (LAN)
  → FastAPI updates status (dismissed | reschedule)
```

---

## Snooze State Machine

```
SNOOZED → FIRED → DISMISSED
                ↘ RE-SNOOZED (back to SNOOZED)
```

---

## Database Schema

```sql
CREATE TABLE snoozes (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT,
  fire_at    TIMESTAMP NOT NULL,
  status     TEXT DEFAULT 'snoozed',  -- snoozed | fired | dismissed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Dedup Rules

- On POST `/api/snooze`: check if URL already has a `snoozed` record → warn user instead of creating duplicate
- On notification fire: check `status == "snoozed"` before firing → skip if already dismissed
- Re-notify if status stays `fired` for >30min (user ignored notification)

---

## Python Project Structure

```
app/
  main.py        # FastAPI: /api/snooze POST, /api/action POST
  scheduler.py   # AsyncIOScheduler + SQLAlchemy jobstore (sqlite:///jobs.sqlite)
  ha.py          # HA local HTTP client (notify + action forward)
  models.py      # SQLModel: Snooze table + status enum
  config.py      # HA_URL, HA_TOKEN
  db.sqlite
  jobs.sqlite    # APScheduler persisted jobs
```

---

## Key Implementation Notes

### APScheduler Setup
```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore

scheduler = AsyncIOScheduler(
    jobstores={'default': SQLAlchemyJobStore(url='sqlite:///jobs.sqlite')}
)
```
Jobs survive process restarts. Missed jobs fire immediately on restart.

### FastAPI Lifespan
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
```

### HA Notification Call
```python
await client.post(
    f"{HA_URL}/api/services/notify/mobile_app_your_iphone",
    headers={"Authorization": f"Bearer {HA_TOKEN}"},
    json={
        "message": title,
        "data": {
            "url": url,
            "actions": [
                {"action": f"OPEN_{snooze_id}",    "title": "Open Tab"},
                {"action": f"SNOOZE_{snooze_id}",  "title": "Snooze 1hr"},
                {"action": f"DISMISS_{snooze_id}", "title": "Dismiss"}
            ]
        }
    }
)
```

### HA Automation (action callback → Python API)
```yaml
automation:
  trigger:
    platform: event
    event_type: mobile_app_notification_action
  action:
    - action: rest_command.forward_tab_action
      data:
        action: "{{ trigger.event.data.action }}"

rest_command:
  forward_tab_action:
    url: "http://python-api.local:8000/api/action"
    method: POST
    payload: '{"action": "{{ action }}"}'
    content_type: "application/json"
```

### Action Handler
```python
@app.post("/api/action")
async def handle_action(body: ActionPayload):
    action, snooze_id = body.action.split("_", 1)
    if action == "DISMISS":
        await db.update(snooze_id, status="dismissed")
    elif action == "SNOOZE":
        await reschedule(snooze_id, hours=1)
    elif action == "OPEN":
        await db.update(snooze_id, status="dismissed")
```

---

## Cloudflare Tunnel Config

```yaml
# cloudflared config.yml
ingress:
  - hostname: tabs.yourdomain.com
    service: http://localhost:8000
  - service: http_status:404
```

Only the Python API is exposed externally. HA stays LAN-only.

---

## Scale

Current expected load is ~50 concurrent snoozes. SQLite + APScheduler is appropriate. No need for Postgres or a dedicated queue at this scale.
