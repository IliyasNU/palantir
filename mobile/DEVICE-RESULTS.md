# Device acceptance results

Results of the runs described in [DEVICE-ACCEPTANCE.md](DEVICE-ACCEPTANCE.md). Every row stays `pending` until it has been run on a physical phone. Use synthetic tickets only and never record credentials, tokens or QR payloads here.

## iPhone

Date: pending · Phone and iOS: pending · Expo Go: pending · Network: pending

Commits: mobile pending · web pending · backend pending

PostgreSQL version and locale: pending · `SELECT lower('ӘЛИЯ') = 'әлия'`: pending

| # | Exercise | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Website ticket scanned by assigned staff | pending | |
| 2 | Same QR scanned again | pending | |
| 3 | Wrong-event ticket, non-ticket QR, unassigned account, revoked staff | pending | |
| 4 | Manual search in RU and KZ, Kazakh name in another letter case | pending | |
| 5 | Camera denied, re-enabled, app backgrounded | pending | |
| 6 | Connection interrupted, language changed, expired token | pending | |
| 7 | Uncertain attempt, organizer verification, return to events | pending | |
| 8 | Ticket PDF on A4 paper in grayscale and on screen | pending: needs a candidate with the PDF route and download button, and a printer | |
| 9 | Attendance refresh after an entry on another phone, and with the network off | pending | |
| 10 | Cancelled ticket and refunded ticket, scan and search, RU and KZ | pending: needs a backend with migration 0003 | |
| 11 | Undo from search as organizer; no undo action as staff | pending: needs a backend with migration 0003 | |
| 12 | Undo from the result screen, then scan the ticket again | pending: needs a backend with migration 0003 | |
| 13 | Undo with the network interrupted, then retry | pending: needs a backend with migration 0003 | |
| 14 | Undo, lost response, expired session, another account, sign in again, retry | pending: needs a backend with migration 0003 | |

### Scan latency (W7)

| Sample | Ticket ID | Seconds | Outcome |
| --- | --- | --- | --- |
| 1 | | | pending |
| 2 | | | pending |
| 3 | | | pending |
| 4 | | | pending |
| 5 | | | pending |
| 6 | | | pending |
| 7 | | | pending |
| 8 | | | pending |
| 9 | | | pending |
| 10 | | | pending |

Median: pending · Maximum: pending · SRS target: typical time within 2 seconds

Connection failures and rejected samples, with reasons: pending

## Android (physical device)

Result: pending. No physical Android run has been recorded. The Android bundle export passes in the build checks.
