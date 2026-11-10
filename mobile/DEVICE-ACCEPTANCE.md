# Mobile device acceptance

Use the same test API and isolated PostgreSQL database for the visitor website and both phones. The earlier iPhone check with an API-issued QR displayed as a PNG is useful baseline evidence. This checklist records the website-to-phone run, the attendance screens, and the physical Android result on the candidate being reviewed.

## Set up the run

1. Record the full Git SHA for mobile, web, and backend, the device model and OS, the Expo Go or build version, and the date. If the components come from separate checkouts, record each SHA separately.
2. Follow the [root setup](../README.md) and the [PostgreSQL locale setup](../backend/README.md#w2-postgresql-16-locale-and-acceptance). Record the PostgreSQL version, migration head, UTF-8 and ICU locale, and a successful `GET /health`. Verify the phone can reach that same API. For a local run, set `EXPO_PUBLIC_API_URL` to the computer’s reachable LAN address and start Expo with `npx expo start --go --lan` from `mobile/`.
3. Publish a test event and assign a staff account. Prepare separate attendee accounts and fresh tickets through the website, with enough capacity for the timing samples. Keep an account without an assignment and a second event for permission and wrong-event checks.
4. For ticket states and undo, the backend must include migration `0003` ([PR #10](https://github.com/IliyasNU/palantir/pull/10)); `alembic current` then prints `0003 (head)`. Prepare two more tickets: cancel one with `POST /tickets/{id}/cancel` as its attendee and mark the other refunded with `POST /tickets/{id}/refund` as the organizer. Sign in on the phone once as assigned staff and once as the event's organizer.

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
| Check a visitor in on one phone. On a second phone with the same event open, tap the attendance refresh button. Then switch the network off and tap it again. | The second phone shows the new total and the time it was read. With the network off it keeps the last total, says it could not refresh, and shows the earlier time. |
| Scan the cancelled ticket and the refunded ticket, in RU and in KZ. Find both through manual search. | Two different messages: one for a cancelled ticket, one for a refunded ticket. Neither is the event-cancelled message. Search shows each state and offers no admission. No `check_ins` row exists for either ticket. |
| As assigned staff, find an admitted visitor. As the organizer, find the same visitor, tap the undo action, cancel the dialog, then tap it again and confirm. | Staff see no undo action. The organizer's cancelled dialog changes nothing. After confirming, search shows the visitor as not admitted and the total drops by one. The `check_ins` row is still there with `undone_at` set. |
| As the organizer, scan a fresh ticket and undo it from the result screen. Scan the same ticket again. | The result changes to the undone message. The second scan admits again. Two rows exist for the ticket and one has `undone_at IS NULL`. |
| As the organizer, start an undo and switch the network off before confirming. Restore it and tap the retry button. | The app says the outcome is unknown and offers a retry. After the retry the entry is undone once: one row for that admission with `undone_at` set. |
| Download the actual ticket PDF once the web/backend PDF requirement is implemented. Print it at A4 size in grayscale and scan the paper, then scan the digital copy. | Both media represent the same ticket. The paper QR is readable and the other copy does not create another admission. Printing a screenshot only exercises camera readability. |

To confirm the first two rows, run this read-only query on the isolated database with the recorded ticket ID:

```sql
SELECT count(*) FROM check_ins WHERE ticket_id = <test_ticket_id>;
```

An uncertain response may have committed on the server. Keep the visitor waiting and retry the same request or have the organizer verify the record. If the app was restarted, the pending request is gone: use the organizer check before deciding whether the visitor can enter, and do not rescan the ticket to find out, because a rescan of an unadmitted ticket admits it.

### How the organizer verifies the record

The organizer check answers one question: does this ticket have a current admission on the server? The event's organizer or an administrator looks the ticket up in one of these ways:

1. `GET /events/{event_id}/attendees?q=<name or email>` in the API docs at `/docs`, signed in as the organizer.
2. The read-only `check_ins` query above with the ticket ID, when the organizer has database access on the test setup. On a backend with migration `0003`, add `AND undone_at IS NULL` to count current admissions only.

Read the answer with these limits in mind:

- Match the ticket first. A name or e-mail search can return several people, and the same person can hold tickets for other events. Confirm that the result is this visitor at this event, and use its `ticket_id` for anything further.
- A non-null `checked_in_at` means a check-in record exists for that `ticket_id`. It does not show which request created it. The timestamp cannot prove that the record came from the request the phone lost; another phone or an earlier scan may have written it.
- An existing record is not permission to admit the visitor a second time. If the visitor is already inside under that record, or the record is older than this attempt, treat the ticket as used and let the organizer decide.
- `null` in one response means no record existed at that moment. A request that is still in flight can commit afterwards. Wait for the phone's request to end, or look again after its timeout, before treating the ticket as not admitted.

The only exact check of one request is a retry of the same `request_id` by the same staff account on the same phone. The app does this with its retry button. After a restart the request ID is gone, so only the ticket-level check above remains.

Do not show or copy the `qr_payload` from the API response while verifying. The organizer web dashboard does not show attendance on this candidate. Once it does, use its attendee search for this check and record that here.

## Measure W7 latency and record results

Record 10 scans of fresh tickets on the intended test network. For each sample, measure from the QR first being fully in the camera frame to a visible admission result, using a second camera or another timestamped recording that shows both points. Record each duration and report median and maximum per device. Compare the observed typical time with the SRS target of two seconds. Record connection failures or rejected samples separately with their reason.

For each exercise, log the date, component SHAs, phone model/OS, app version, network, result (`passed`, `failed`, or `pending`), and brief evidence. Use synthetic tickets and redact credentials, tokens and QR payloads. Record iOS and physical Android separately. If no Android phone was available, mark the physical Android result `pending`. Expo bundle exports are recorded under build checks.

Cancelled and refunded tickets and undo need a backend with migration `0003`. If the candidate does not contain it, record those rows as pending with that reason.
