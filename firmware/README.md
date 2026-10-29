# Firmware: ESP32 Reader → Supabase (hand-off)

The database side is live and tested. This connects the reader to it.
Database owner: Nick. Questions about responses or errors → Nick.

## What changed in `reader/reader.ino`
Every change is marked `NEW` in the code.

1. **The fake backend is gone.** `simulateBackend200OK` is replaced by `sendScan()`, a real HTTPS POST to Supabase.
2. **Credentials moved to `secrets.h`.** WiFi, Supabase URL, anon key, reader ID, and device key all live in one file that never gets committed (also meets the FR21 "single file edit" requirement).
3. **Bug fix:** `equipmentUID` was declared inside the equipment `if` block, so it didn't exist when the data was sent. It's now declared at the top of `handleRFIDScan()`.
4. **The OLED shows the database's message** ("Checked in", "Room is reserved", …) instead of fixed text (FR16).
5. **Network errors** flash the red LED 4 times and show "Network error" (FR1 diagnostic).
6. `WiFi.setAutoReconnect(true)` so the reader recovers if WiFi drops.

Your wiring, pins, display layout, touch toggle, 10-second equipment timer, and beeps are unchanged.

## Setup (about 10 minutes)

1. **Install the library:** Arduino IDE → Library Manager → `ArduinoJson` (version **7.x**).
2. **Create `secrets.h`:** copy `reader/secrets.example.h` to `reader/secrets.h`, then fill in:
   - `SUPABASE_ANON_KEY`: the **anon / publishable** key (Supabase → Connect). Not `service_role`.
   - `DEVICE_KEY`: get it from Nick **in person or by direct message**. It is never posted in the repo or group chat.
3. Upload, open Serial Monitor at **115200**.

## What gets sent

```
POST https://ciybtljbqogoknnfffmv.supabase.co/rest/v1/rpc/handle_scan
{"card_uid":"04A3B21C","reader_id":"ESP32_01","device_key":"<secret>"}
{"card_uid":"04A3B21C","reader_id":"ESP32_01","device_key":"<secret>","equipment_uid":"A1B2C3D4"}   <- equipment mode
```

No timestamp: the database stamps the time itself, so the ESP32 doesn't need a clock.
(FR2 lists "current time" as an input. Note this design change in the requirements doc.)

## What comes back

| HTTP | `message` | LED |
|---|---|---|
| 200 | Checked in / Checked out | Green |
| 403 | Not authorized, Room is reserved, In use by another user, Unknown device, Unknown equipment, Under maintenance | Red |
| none | (WiFi or server unreachable) | Red flashing |

## Test plan (do these in order)

Have Nick watch `scan_events` in Supabase while you test.

| # | Do this | Expect on OLED | Serial Monitor |
|---|---|---|---|
| 1 | Boot | "Tap to Check In" | `WiFi connected, IP: ...` |
| 2 | Tap **any** card | "Not authorized" (red) | `HTTP 403` |
| 3 | Copy that card's UID from Serial Monitor, send it to Nick so he can link it to a user | — | — |
| 4 | Tap the linked card | "Checked in" (green) | `HTTP 200` |
| 5 | Wait 5+ s, tap again | "Checked out" (green) | `HTTP 200` |
| 6 | Change `DEVICE_KEY` to something wrong, re-upload, tap | "Unknown device" (red) | `HTTP 403` (then change it back) |
| 7 | Unplug the router / wrong WiFi | "Network error", red flashes | `HTTP -1` |
| 8 | Equipment mode: tap card, then tag `A1B2C3D4`* | "Checked out" (green) | `HTTP 200` |

\* The test calculator's tag UID in the database is the placeholder `A1B2C3D4`. Send Nick a real tag's UID and he'll update it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `HTTP 401` | Wrong or missing anon key, or using the wrong key type |
| `HTTP 404` | Typo in `SUPABASE_URL` or the `/rest/v1/rpc/handle_scan` path |
| `HTTP -1` | No WiFi, campus network blocking, or a captive login page on `bulldogs` |
| Always "Unknown device" | `DEVICE_KEY` or `READER_ID` doesn't match. Ask Nick to check `readers` |
| Always "Not authorized" | Card UID isn't linked to a user yet (step 3) |
| "Bad response" | Unexpected reply; copy the Serial Monitor line to Nick |

## Before the final demo
- Replace `client.setInsecure()` with `client.setCACert(...)` so the ESP32 also verifies it's really talking to Supabase (FR2 secure transmission).
- Nick will rotate the device key; update `DEVICE_KEY` in `secrets.h`.
