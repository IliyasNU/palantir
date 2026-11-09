# Mobile API contract

Use the current `integration/biletflow-e2e` backend, which includes tickets, staff check-in, and attendance (W2, merged in [PR #5](https://github.com/IliyasNU/palantir/pull/5)). [`feature/temirlan-tickets-checkin`](https://github.com/IliyasNU/palantir/tree/26d0dbd58aaea5fc44d63144155d14fdeb8ad67a/backend) introduced the base ticket and check-in endpoints. The attendance and attendee search routes below were added by W2.

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
  { "id": 7, "title": "NU Club Fair", "date": "2026-10-28T12:00:00Z", "location": "Orange Hall", "status": "published" }
]
```

The list includes published events the account is assigned to or owns, and all published events for admins. The backend checks authorization again at check-in. The app reloads the list when it regains focus.

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
  "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049",
  "checked_in_at": "2026-10-28T11:40:00Z"
}
```

Return the same receipt for an authorized retry of the same request ID, actor, event and payload. Reject reuse of that ID with different data. A new request for an already-used ticket is a duplicate, not a retry. Check permission on every request, including retries.

| HTTP | `detail.code` | Mobile result |
| --- | --- | --- |
| 409 | `ALREADY_CHECKED_IN` | Ticket already used |
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

If a scan fails with an event error or 403 and there is no pending uncertain attempt, the app offers a return to the event list. A rejection received after a timeout or server error leaves the earlier attempt unconfirmed. The app retains the original request. For a conflict or another terminal rejection after an uncertain result, the organizer needs to verify the existing record.

The backend handles atomic check-in, duplicate protection, event and staff permissions, and storage. A valid receipt is required for the mobile client to confirm admission.

Screen messages are mapped locally to Russian or Kazakh by error code. Unknown server messages are not presented as admission instructions. An unresolved result displays the original request ID for the organizer; the raw QR payload is not displayed. Language changes do not create a new scanner session.

## Attendance totals

`GET /events/{id}/attendance` returns the event's counters:

```json
{ "event_id": 7, "capacity": 150, "tickets_issued": 42, "checked_in": 17 }
```

`checked_in` counts the event's check-in records. A new admission increases it by one. Replayed retries and `ALREADY_CHECKED_IN` scans leave it unchanged. The scanner displays `checked_in` out of `tickets_issued` and shows `capacity` separately. It reloads these values on return to the screen, on foregrounding, and after a confirmed receipt.

## Manual attendee search

`GET /events/{id}/attendees?q=<text>` searches the event's ticket holders by full name or e-mail, case-insensitively. `q` is trimmed and must contain at least 3 characters. `%` and `_` match themselves. The response is a JSON array of at most 20 results, ordered by name:

```json
[
  {
    "ticket_id": 21,
    "full_name": "Aigerim Sadykova",
    "masked_email": "ai***@example.com",
    "checked_in_at": null,
    "qr_payload": "biletflow:ticket:v1:<opaque-ticket-token>"
  }
]
```

`masked_email` shows at most the first two characters of the local part, always hides at least one, and uses a fixed `***`: `alice@x.kz` → `al***@x.kz`, `ab@x.kz` → `a***@x.kz`, `a@x.kz` → `***@x.kz`. `checked_in_at` is `null` until the ticket is admitted.

To admit a found attendee, send the returned `qr_payload` unchanged to `POST /events/{id}/check-in` with a new `request_id`, exactly as for a scanned QR. There is no separate manual check-in route, so retries, duplicates and receipts behave the same.

The camera pauses during manual search. A result with `checked_in_at` shows the local check-in time. Only a result with `checked_in_at: null` offers the admission action. When the employee advances to the next ticket, the active search reloads from the API.

Both routes allow the event's assigned staff, its organizer and admins. Access is checked before `q` is validated.

| HTTP | `detail.code` | Meaning |
| --- | --- | --- |
| 401 | Any / existing string detail | Sign in again |
| 403 | `FORBIDDEN` | Not staff for this event (including revoked staff and attendees) |
| 404 | `EVENT_NOT_FOUND` | Event missing |
| 422 | `QUERY_TOO_SHORT` | Search text shorter than 3 characters |

Undoing a check-in is not implemented.
