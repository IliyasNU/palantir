# Mobile API contract

Use the current `integration/biletflow-e2e` backend, which includes tickets, staff check-in, and attendance (W2, merged in [PR #5](https://github.com/IliyasNU/palantir/pull/5)). [`feature/temirlan-tickets-checkin`](https://github.com/IliyasNU/palantir/tree/26d0dbd58aaea5fc44d63144155d14fdeb8ad67a/backend) introduced the base ticket and check-in endpoints. The attendance and attendee search routes below were added by W2.

Ticket states and check-in undo come from [PR #10](https://github.com/IliyasNU/palantir/pull/10) (migration `0003`). The printable ticket comes from [PR #11](https://github.com/IliyasNU/palantir/pull/11), and the website's download button and ticket states from [PR #12](https://github.com/IliyasNU/palantir/pull/12). Against a backend without it, the app still scans and searches: every ticket reads as active, no undo is offered, and the undo route answers as unavailable.

## Connection check

`GET /health` is called without credentials from the sign-in screen. Only a successful HTTP response with both `"status": "ok"` and `"database": "up"` confirms connection readiness. A database-down response, malformed response, timeout or failed request is shown as an error. This check does not verify staff assignment or replace authorization on later requests.

## Login and account identity

`POST /auth/login`, JSON:

```json
{ "email": "staff@example.com", "password": "the-user-password" }
```

Successful login returns `access_token`, `refresh_token`, and `token_type`. The client calls `GET /auth/me` with the access token and holds the token and returned user ID in memory. Authenticated requests send `Authorization: Bearer <access_token>`. Before a retry after reauthentication, the client checks that `/auth/me` returns the original user ID. Staff access is scoped to each event.

## Accessible events

`GET /staff/events` returns a JSON array, or `[]` when no events are assigned:

```json
[
  { "id": 7, "title": "NU Club Fair", "date": "2026-10-28T12:00:00Z", "location": "Orange Hall", "status": "published", "can_manage": false }
]
```

The list includes published events the account is assigned to or owns, and all published events for admins. The backend checks authorization again at check-in. The app reloads the list when it regains focus.

`can_manage` is `true` for the event's organizer and for admins. The app offers the undo action only then. It is a display hint: the server checks the permission again on every undo.

## Check-in

`POST /events/{id}/check-in`, JSON:

```json
{
  "qr_payload": "biletflow:ticket:v1:<opaque-ticket-token>",
  "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049"
}
```

The mobile app passes the scanned payload unchanged. The backend accepts a payload of 1–512 characters and a canonical lower-case UUID as `request_id`.

`200` after successful check-in:

```json
{
  "status": "CHECKED_IN",
  "event_id": 7,
  "ticket_id": 21,
  "check_in_id": 90,
  "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049",
  "checked_in_at": "2026-10-28T11:40:00Z"
}
```

`check_in_id` identifies this admission for the undo route.

Return the same receipt for an authorized retry of the same request ID, actor, event and payload. Reject reuse of that ID with different data. A new request for an already-used ticket is a duplicate, not a retry. Check permission on every request, including retries.

| HTTP | `detail.code` | Mobile result |
| --- | --- | --- |
| 409 | `ALREADY_CHECKED_IN` | Ticket already used |
| 409 | `TICKET_CANCELLED` | This ticket was cancelled; no entry |
| 409 | `TICKET_REFUNDED` | This ticket was refunded; no entry |
| 409 | `CHECK_IN_UNDONE` | This request's check-in was undone; scan the ticket again |
| 404 | `INVALID_TICKET` | Unknown QR or wrong event |
| 404 | `EVENT_NOT_FOUND` | Event missing |
| 409 | `EVENT_CANCELLED` / `EVENT_NOT_PUBLISHED` | Event unavailable for new check-ins |
| 409 | `REQUEST_ID_CONFLICT` | Ask the organizer to verify the ticket |
| 401 | Any / existing string detail | `UNAUTHORIZED`, sign in again |
| 403 | Any / existing string detail | `FORBIDDEN`, no access; keep the session |
| 422 | `INVALID_INPUT` or validation details | Invalid request format |
| 5xx | Any | Unconfirmed server error; retry possible |
| No response / timeout | — | `NETWORK_ERROR`; never successful |

Example error:

```json
{ "detail": { "code": "ALREADY_CHECKED_IN", "message": "Ticket already used" } }
```

An unknown route (`404` with `detail: "Not Found"`) is shown as unavailable, not as an invalid ticket. Successful status alone is insufficient: the mobile client also requires `CHECKED_IN`, the matching event/request ID, a ticket ID and a timestamp.

If a scan fails with an event error or 403 and there is no pending uncertain attempt, the app offers a return to the event list. A rejection received after a timeout or server error leaves the earlier attempt unconfirmed, with three exceptions described under [Ticket states](#ticket-states). The app retains the original request. If a retry cannot resolve the result, the staff member can give the displayed request ID to the organizer. After the organizer verifies the record, the staff member can explicitly confirm a return to the event list. The app keeps the original scan locked until the screen is dismissed. This action does not confirm admission, undo a check-in, or send another request.

The backend handles atomic check-in, duplicate protection, event and staff permissions, and storage. A valid receipt is required for the mobile client to confirm admission.

Screen messages are mapped locally to Russian or Kazakh by error code. Unknown server messages are not presented as admission instructions. An unresolved result displays the original request ID for the organizer; the raw QR payload is not displayed. Language changes do not create a new scanner session.

## Attendance totals

`GET /events/{id}/attendance` returns the event's counters:

```json
{ "event_id": 7, "capacity": 150, "tickets_issued": 42, "checked_in": 17 }
```

`checked_in` counts current admissions: a new admission adds one and an undo removes one. Replayed retries and `ALREADY_CHECKED_IN` scans leave it unchanged. `tickets_issued` counts active tickets, so a cancelled or refunded ticket leaves it. The scanner displays `checked_in` out of `tickets_issued` and shows `capacity` separately.

The app reads these values when the scanner opens, on return to the screen, on foregrounding, after a confirmed receipt or undo, and when the staff member taps the refresh button. It shows the time of the last successful read. If a refresh fails, the last totals stay on screen marked as outdated. Use the refresh button to see admissions made on another phone. A response for another event, another account, or a screen that has lost focus is discarded.

## Manual attendee search

`GET /events/{id}/attendees?q=<text>` searches the event's ticket holders by full name or e-mail, case-insensitively. `q` is trimmed and must contain at least 3 characters. `%` and `_` match themselves. The response is a JSON array of at most 20 results, ordered by name:

```json
[
  {
    "ticket_id": 21,
    "full_name": "Aigerim Sadykova",
    "masked_email": "ai***@example.com",
    "status": "active",
    "checked_in_at": null,
    "check_in_id": null,
    "qr_payload": "biletflow:ticket:v1:<opaque-ticket-token>"
  }
]
```

`masked_email` shows at most the first two characters of the local part, always hides at least one, and uses a fixed `***`: `alice@x.kz` → `al***@x.kz`, `ab@x.kz` → `a***@x.kz`, `a@x.kz` → `***@x.kz`.

`status` is `active`, `cancelled` or `refunded`. `checked_in_at` and `check_in_id` describe the current admission and are both `null` when the ticket is not admitted right now, including after an undo. The app rejects a response in which a closed ticket is admitted or an admission id comes without a time.

To admit a found attendee, send the returned `qr_payload` unchanged to `POST /events/{id}/check-in` with a new `request_id`, exactly as for a scanned QR. There is no separate manual check-in route, so retries, duplicates and receipts behave the same.

The camera pauses during manual search. Only an active result with `checked_in_at: null` offers the admission action. An admitted result shows the local check-in time, and the undo action for an account that manages the event. A cancelled or refunded result shows its state and no action. Pressing search again, moving to the next ticket, or completing an undo reloads the results from the API.

Both routes allow the event's assigned staff, its organizer and admins. Access is checked before `q` is validated.

| HTTP | `detail.code` | Meaning |
| --- | --- | --- |
| 401 | Any / existing string detail | Sign in again |
| 403 | `FORBIDDEN` | Not staff for this event (including revoked staff and attendees) |
| 404 | `EVENT_NOT_FOUND` | Event missing |
| 422 | `QUERY_TOO_SHORT` | Search text shorter than 3 characters |

## Ticket states

A ticket is `active`, `cancelled` or `refunded`. The last two are final: such a ticket is never admitted. They describe one ticket. `EVENT_CANCELLED` describes the whole event, is checked first, and does not stand in for either ticket state.

| How the state is set | Who |
| --- | --- |
| `POST /tickets/{id}/cancel` | The ticket's attendee, the event's organizer, or an admin |
| `POST /tickets/{id}/refund` | The event's organizer or an admin |

Tickets are free. `refunded` is an admission state recorded by the organizer; the system processes no payment and this is not a money refund.

A ticket that is checked in cannot be cancelled or refunded until the check-in is undone (`409 TICKET_CHECKED_IN`). So once the server reports a ticket as cancelled or refunded, it has no current admission and can never get one.

That is why three answers settle an earlier unknown result. If a scan timed out or got a server error and the retry with the same `request_id` returns `409` with one of these codes, the app treats the attempt as resolved and not admitted, and lets the staff member move on:

- `TICKET_CANCELLED` or `TICKET_REFUNDED`: the ticket is closed for good.
- `CHECK_IN_UNDONE`: the server recognised this exact request; it did commit and was later reversed.

Every other rejection after an unknown result, including `ALREADY_CHECKED_IN`, 401 and 403, leaves the attempt unconfirmed as before. So does a 5xx response, whatever code it carries.

## Undo a check-in

`POST /events/{id}/check-ins/{check_in_id}/undo`, JSON:

```json
{ "request_id": "9a0b7c1e-58f3-4d0a-8f6e-2b1c3d4e5f60" }
```

`check_in_id` comes from a check-in receipt or from an admitted search result. `request_id` is a new UUID for the undo itself, not the one used for the scan.

`200`:

```json
{
  "status": "UNDONE",
  "event_id": 7,
  "ticket_id": 21,
  "check_in_id": 90,
  "request_id": "9a0b7c1e-58f3-4d0a-8f6e-2b1c3d4e5f60",
  "undone_at": "2026-10-28T11:45:00Z"
}
```

The app confirms the undo only on an `UNDONE` receipt with the same event, check-in and request ID.

| HTTP | `detail.code` | Mobile result |
| --- | --- | --- |
| 403 | `UNDO_NOT_ALLOWED` | Assigned staff may scan but only the organizer or an admin may undo |
| 403 | `FORBIDDEN` | No access to this event |
| 404 | `CHECK_IN_NOT_FOUND` | No such check-in at this event; refresh the search |
| 404 | `EVENT_NOT_FOUND` | Event missing |
| 409 | `CHECK_IN_ALREADY_UNDONE` | Another request already undid it |
| 409 | `REQUEST_ID_CONFLICT` | The undo `request_id` was used for something else |
| 401 | Any | Sign in again |
| 5xx / no response | — | Unknown outcome; the app repeats the same `request_id` |

The server keeps the check-in row as history and marks it undone. After that:

- The ticket has no current admission. Search shows `checked_in_at: null` and the totals drop by one.
- The undone scan's own `request_id` answers `409 CHECK_IN_UNDONE`. It cannot admit again and is never replayed as a success.
- A new scan with a new `request_id` admits the ticket again as a new record with a new `check_in_id`.
- A retry of the same undo by the same account returns the same receipt.

The app asks for confirmation before sending. A second tap while a request is in flight sends nothing. After a confirmed undo the app reloads the search results and the totals.

### An undo without a definite answer

An undo that ended in a lost response, a 5xx or a 401 is kept in memory for the whole app, not inside the screen that started it. The record holds the account's user ID, the event ID, the check-in ID and the request ID.

- The scanner of that event lists it as “Отмена входа не подтверждена” with the request ID and a retry button. The event list marks the event.
- The retry sends the same request ID to the same event and check-in, with the token the account holds at that moment. The server then either reverses the entry or replays the receipt of the reversal it already made, so the entry is reversed once.
- After a 401 the record offers “Войти снова”. Signing in again unmounts the scanner; the record stays. Once the same account is signed in with a new token, the retry is offered again.
- Another account on the same phone never sees or sends the record. If it undoes the same check-in, it uses its own request ID and gets the server's definite answer.
- A definite answer (a receipt, or a refusal such as `CHECK_IN_ALREADY_UNDONE`, `UNDO_NOT_ALLOWED` or `CHECK_IN_NOT_FOUND`) removes the record.

The record does not survive an app restart, and neither does a pending scan. After a restart, read the ticket's state from search before deciding anything.

## Printable ticket

`GET /tickets/{id}/pdf` returns the holder's ticket as one A4 page. Its QR encodes the same `qr_payload` as the website's QR, so the scanner sees one ticket: whichever copy is scanned first is admitted and the other is then `ALREADY_CHECKED_IN`. A cancelled or refunded ticket, or a ticket of a cancelled event, has no PDF. The staff app does not call this route.
