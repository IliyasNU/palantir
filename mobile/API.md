# Mobile API contract

The backend implements this contract in [`feature/temirlan-tickets-checkin`](https://github.com/IliyasNU/palantir/tree/26d0dbd58aaea5fc44d63144155d14fdeb8ad67a/backend). Use that backend revision or an integration branch that includes it. The older `recovery/backend` branch only supports login and account lookup from this flow.

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
