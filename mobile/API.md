# Mobile API contract — proposed, needs backend agreement

Only login exists in the inspected backend (`recovery/backend`, `09881b7`). The event-list and check-in examples below are the shapes this client expects, not evidence that those endpoints are live. If the backend team chooses another shape, update `src/api.ts` and its tests together.

## Login — existing

`POST /auth/login`, JSON:

```json
{ "email": "staff@example.com", "password": "the-user-password" }
```

Successful response includes `access_token`, `refresh_token`, `token_type`. This client keeps only `access_token` in memory and sends `Authorization: Bearer <access_token>` on the remaining endpoints. It does not infer staff access from the global role.

## Accessible events — proposed

`GET /staff/events` returns a JSON array, or `[]` when no events are assigned:

```json
[
  { "id": 7, "title": "NU Club Fair", "date": "2026-10-28T12:00:00Z", "location": "Orange Hall" }
]
```

For this small MVP, return the full list of published, non-cancelled events the user is allowed to check in: staff assignments, owned events, or the admin's permitted events. Backend enforces that access again during check-in; the list is not an authorization check. If pagination becomes necessary, agree on its shape before changing the endpoint.

## Check-in — proposed

`POST /events/{id}/check-in`, JSON:

```json
{
  "qr_payload": "biletflow:ticket:v1:<opaque-ticket-token>",
  "request_id": "f59c8ead-2eea-4ae9-b2cd-3cc2c047b049"
}
```

The mobile app passes the scanned payload unchanged. It does not decode an attendee ID, open a QR URL or decide if a ticket is valid.

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
| 401 | Any / existing string detail | `UNAUTHORIZED`, sign in again |
| 403 | Any / existing string detail | `UNAUTHORIZED`, no access |
| 409 | Other, e.g. `EVENT_CANCELLED` | Rejected, show message |
| 5xx | Any | Unconfirmed server error; retry possible |
| No response / timeout | — | `NETWORK_ERROR`; never successful |

Example error:

```json
{ "detail": { "code": "ALREADY_CHECKED_IN", "message": "Ticket already used" } }
```

An unknown route (`404` with `detail: "Not Found"`) is shown as unavailable, not as an invalid ticket. Successful status alone is insufficient: the mobile client also requires `CHECKED_IN`, the matching event/request ID, a ticket ID and a timestamp.

The backend team owns atomic check-in, duplicate protection, event/staff permissions and database storage. Mobile-side frame blocking cannot replace those checks. Confirm the above contract before describing the full flow as integrated.
