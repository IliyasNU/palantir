# Mobile device acceptance

Use the same test API and isolated PostgreSQL database for the visitor website and both phones. The earlier iPhone check with an API-issued QR displayed as a PNG is useful baseline evidence. This checklist records the website-to-phone run, the attendance screens, and the physical Android result on the candidate being reviewed.

## Set up the run

1. Record the full Git SHA for mobile, web, and backend, the device model and OS, the Expo Go or build version, and the date. If the components come from separate checkouts, record each SHA separately.
2. Follow the [root setup](../README.md) and the [PostgreSQL locale setup](../backend/README.md#w2-postgresql-16-locale-and-acceptance). Record the PostgreSQL version, migration head, UTF-8 and ICU locale, and a successful `GET /health`. Verify the phone can reach that same API. For a local run, set `EXPO_PUBLIC_API_URL` to the computer’s reachable LAN address and start Expo with `npx expo start --go --lan` from `mobile/`.
3. Publish a test event and assign a staff account. Prepare separate attendee accounts and fresh tickets through the website, with enough capacity for the timing samples. Keep an account without an assignment and a second event for permission and wrong-event checks.

## Verify the admission flow

| Exercise | Expected evidence |
| --- | --- |
| On the website, claim a ticket and open its QR from **My tickets**. Scan it on a phone signed in as assigned staff. | A confirmed check-in appears. Record the ticket ID and count its `check_ins` rows in the test database. Exactly one row exists. |
| Scan the same website QR again. | The app reports the already-used ticket. The row count and attendance total stay the same. |
| Scan a ticket from the other event and a non-ticket QR. Use an unassigned account and separately revoke staff access after opening the scanner. | Each inadmissible attempt is rejected by the server. The app shows no confirmed admission. |
| Open manual search, first in RU and then in KZ. Search a fresh attendee by name and email, including a Kazakh name in another letter case. Confirm their entry and reopen the search. | The result shows a masked email. Check-in time appears after confirmation. Search cannot admit the checked-in attendee again. The attendance count increases once and matches the API. |
| Deny camera permission, try manual search, re-enable the camera in Settings, then send the app to the background and return. | Manual search remains usable. Camera recovery works and the prior view cannot submit a stale scan. |
| Interrupt the test connection during a fresh scan. Change the app language, restore the connection, and retry. Repeat with an expired token. | Until the server confirms, the visitor is held. Retry retains the original request ID. Reauthentication permits replay only as the original staff account. Verify at most one check-in row. |
| Repeat an uncertain attempt that ends in a terminal rejection. Have the organizer verify the original record on the server before confirming return to events. | The app can return to the event list after the staff member confirms the organizer check. The exit itself grants no admission and creates no check-in. |
| Download the actual ticket PDF once the web/backend PDF requirement is implemented. Print it at A4 size in grayscale and scan the paper, then scan the digital copy. | Both media represent the same ticket. The paper QR is readable and the other copy does not create another admission. Printing a screenshot only exercises camera readability. |

To confirm the first two rows, run this read-only query on the isolated database with the recorded ticket ID:

```sql
SELECT count(*) FROM check_ins WHERE ticket_id = <test_ticket_id>;
```

An uncertain response may have committed on the server. Keep the visitor waiting and retry the same request or have the organizer verify the record. If the app was restarted, use the organizer check before deciding whether the visitor can enter.

## Measure W7 latency and record results

Record 10 scans of fresh tickets on the intended test network. For each sample, measure from the QR first being fully in the camera frame to a visible admission result, using a second camera or another timestamped recording that shows both points. Record each duration and report median and maximum per device. Compare the observed typical time with the SRS target of two seconds. Record connection failures or rejected samples separately with their reason.

For each exercise, log the date, component SHAs, phone model/OS, app version, network, result (`passed`, `failed`, or `pending`), and brief evidence. Use synthetic tickets and redact credentials, tokens and QR payloads. Record iOS and physical Android separately. If no Android phone was available, mark the physical Android result `pending`. Expo bundle exports are recorded under build checks.

Individual cancelled/refunded-ticket rejection and authorized undo require the corresponding backend contracts. Record those checks as pending until the candidate contains the API and client support.
