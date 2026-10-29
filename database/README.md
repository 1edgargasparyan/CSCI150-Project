# Database: Reserve and Check-In/Out (Radio RNC)

Supabase (Postgres 17) backend for room and equipment reservations with RFID check-in/out.
Owner: Nick Mendoza

- **Project URL:** `https://ciybtljbqogoknnfffmv.supabase.co`
- **Status:** schema, security policies, test data, and the ESP32 scan endpoint are live and tested.

## Files (run in order)

| File | What it does | Run when |
|---|---|---|
| `01_schema.sql` | 9 tables, enums, indexes, auto-profile trigger, row-level security (RLS) on every table, Realtime on `resources` | Once, on a new project |
| `02_seed.sql` | Test org (Fresno State CS), Study Room 101, TI-84 calculator, reader `ESP32_01`, template for a test user | Once, after 01 |
| `03_handle_scan.sql` | `handle_scan()`, the function the ESP32 calls on every card tap | Once, after 02 |
| `04_checks.sql` | Health checks, scan tests, and key rotation | Anytime |

To rebuild from scratch: Supabase Dashboard → SQL Editor → run 01, 02, 03 in order, then set a reader key (bottom of `04_checks.sql`).
Re-running 01 or 02 on an existing database fails with "already exists" / "duplicate key". That's expected and changes nothing.

## Tables

| Table | Purpose | Requirement |
|---|---|---|
| `organizations` | Each club/org using the system | FR8 |
| `profiles` | One row per user, created automatically on first login | FR6 |
| `org_members` | Who belongs to which org, as `member` or `admin` | FR8, FR27 |
| `rfid_cards` | Card UID → user | FR20 |
| `resources` | Rooms and equipment, with live `status` (available / reserved / in_use / maintenance) | FR14, FR26 |
| `readers` | Each ESP32: which room it's on, plus a hashed device key | FR2 |
| `reservations` | Bookings. Overlaps are blocked by the database itself | FR10–FR12, FR17 |
| `usage_logs` | One row per check-in/check-out session | FR15 |
| `scan_events` | Every scan attempt, approved or denied | FR4 |

## How the ESP32 talks to the database

```
POST https://ciybtljbqogoknnfffmv.supabase.co/rest/v1/rpc/handle_scan
Headers: Content-Type: application/json
         apikey: <anon key>
         Authorization: Bearer <anon key>
Body:    {"card_uid":"04A3B21C","reader_id":"ESP32_01","device_key":"<secret>"}
         add "equipment_uid":"A1B2C3D4" at an equipment station
```

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"ok": true, "message": "Checked in"}` | Room check-in, or equipment return |
| 200 | `{"ok": true, "message": "Checked out"}` | Room check-out, or equipment checkout |
| 403 | `{"ok": false, "message": "Not authorized"}` | Unknown card or not in this org |
| 403 | `{"ok": false, "message": "Room is reserved"}` | Someone else holds the reservation (FR25) |
| 403 | `{"ok": false, "message": "In use by another user"}` | Someone else is checked in |
| 403 | `{"ok": false, "message": "Unknown device"}` | Wrong reader ID or device key |
| 403 | `Unknown equipment` / `Under maintenance` / `No room on reader` | Self-explanatory |

`message` is written to be shown directly on the OLED (FR16). The database stamps the time (`now()`), so the ESP32 doesn't need a clock (FR15: within 1 second of server time).

### Decision order inside `handle_scan`
1. Reader exists and device key matches its stored hash?
2. Card belongs to a user who is in the reader's org?
3. Which resource: equipment tag if sent, else the reader's room
4. Session already open? Yours → end it. Someone else's → deny. Within 5 seconds → treat as a double tap, no change
5. Reserved right now by someone else → deny. Otherwise → start a session

## Security model

- **RLS on every table.** Users only see rows for orgs they belong to (FR8). The public anon key alone reads nothing.
- **The anon key is public** (it ships inside the website), so `handle_scan` also requires a **per-reader device key**. Only a bcrypt hash is stored in `readers.device_secret_hash`; the plain key lives only in the ESP32's `secrets.h`.
- `handle_scan` runs as `security definer`, so it can write to `usage_logs` and `scan_events` even though no user can write there directly.
- Logged-in website users cannot call `handle_scan` (only the `anon` role can), so nobody can fake a scan from the website.

**Never commit:** the device key, the `service_role` key, or a `secrets.h` file.

## Lost or leaked device key?
Run the ADMIN query at the bottom of `04_checks.sql`. It makes a new key, shows it once, and the old one stops working. Then update `DEVICE_KEY` in the ESP32's `secrets.h`.

## Still to build
- Admin function to assign/unassign cards (FR20)
- Scheduled job to cancel no-shows after 15 minutes (FR28)
- Scheduled job to delete logs older than 120 days (FR3)
- Lock down helper functions flagged by the Supabase security advisor (low risk)
