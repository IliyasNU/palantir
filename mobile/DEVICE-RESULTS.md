# Device acceptance results

Results of the runs described in [DEVICE-ACCEPTANCE.md](DEVICE-ACCEPTANCE.md). Distinguish user-reported phone checks from automated tests and database observations. `partial` means only the stated portion was reported; everything else in that row remains pending. Use synthetic tickets only and never record credentials, tokens or QR payloads here.

## iPhone

Date: 2026-11-13 · Reporter: IliyasNU, in the project chat

Device: physical iPhone; model, iOS version and installed Expo Go version not recorded. Network: same Wi-Fi as the development computer; API accessed over LAN with port `8000`.

Test checkout (mobile, web and backend): `907c7a96a24b26dc68f57de3f4d803b4a2e0e47a`, branch `bugfix/checkin-session-regressions`. This documentation update does not change the tested application code.

Evidence source: the user reported that scanning a printed ticket on the iPhone admitted it and a repeat scan was rejected. After the suggested cancelled-ticket, refunded-ticket and manual-search/admission follow-up, the user reported that everything worked. No screen recording, timings or post-run database counts were supplied. The API and Docker were stopped when this record was finalized, so no new database verification was performed.

PostgreSQL version/locale and `SELECT lower('ӘЛИЯ') = 'әлия'` for this device run: not recorded. Separate automated PostgreSQL results do not fill in the physical-device evidence below.

Staff login and connection to the test API: passed, user-reported. The local API address was corrected to include port `8000` before the successful run.

| # | Exercise | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Website ticket scanned by assigned staff | partial | Printed-ticket admission passed, user-reported. Website-screen source and database row count were not recorded. |
| 2 | Same QR scanned again | partial | Duplicate rejection passed, user-reported. Database row count and attendance comparison were not recorded. |
| 3 | Wrong-event ticket, non-ticket QR, unassigned account, revoked staff | pending | |
| 4 | Manual search in RU and KZ, Kazakh name in another letter case | partial | Basic search for `әлия`, manual admission and searching again were included in the confirmed follow-up. Email, upper-case and RU/KZ variants were not individually recorded. |
| 5 | Camera denied, re-enabled, app backgrounded | pending | |
| 6 | Connection interrupted, language changed, expired token | pending | |
| 7 | Uncertain attempt, organizer verification, return to events | pending | |
| 8 | Ticket PDF on A4 paper in grayscale and on screen | partial | Printed QR readability passed, user-reported. PDF origin, A4, grayscale, print scale and screen comparison were not recorded. |
| 9 | Attendance refresh after an entry on another phone, and with the network off | pending | |
| 10 | Cancelled ticket and refunded ticket, scan and search, RU and KZ | partial | Both scan checks were included in the confirmed follow-up. Exact messages, language variants, search states and database counts were not individually recorded. |
| 11 | Undo from search as organizer; no undo action as staff | pending | No specific device result supplied. |
| 12 | Undo from the result screen, then scan the ticket again | pending | No specific device result supplied. |
| 13 | Undo with the network interrupted, then retry | pending | No specific device result supplied. |
| 14 | Unconfirmed undo survives sign-out and is isolated to its original account | pending | No specific device result supplied; a lost-server-response case requires separate fault injection. |
| 15 | Automatic renewal, background/return and refused refresh | pending | No specific device result supplied. |
| 16 | RU/KZ/EN screens and small-screen header | pending | No specific device result supplied. |

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

## Automated evidence (separate from phone acceptance)

On application commit `907c7a96a24b26dc68f57de3f4d803b4a2e0e47a`: 92 mobile tests, TypeScript, lint and Android/iOS JavaScript exports passed. Both `mobile` and `backend-web` jobs succeeded in [CI run 43388164251](https://github.com/IliyasNU/palantir/actions/runs/43388164251). Exports are not signed installable builds and do not verify a physical Android camera or device performance.

The delivery is tracked in [PR #26](https://github.com/IliyasNU/palantir/pull/26), targeting `integration/biletflow-e2e`; it remains unmerged pending approval. Pending device rows are unverified scenarios, not confirmed defects.
