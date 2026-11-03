# Backend: event publishing, tickets, staff and check-in

Branch: `feature/temirlan-tickets-checkin` (from `recovery/backend`).
Goal: the backend half of the mobile MVP run in `BiletFlow_Mobile_Integration_Team.pdf`.
Contract source: `mobile/API.md` on `feature/iliyas-mobile-checkin`.

## Status

- [x] Review recovered backend
- [x] Models + migration `0002`
- [x] Event lifecycle and public reads
- [x] Tickets
- [x] Staff assignments and `GET /staff/events`
- [x] Check-in
- [x] SQLite API tests for every endpoint
- [x] PostgreSQL end-to-end suite against the running Docker stack (concurrency, lost response)
- [x] Docs (`docs/architecture.md`, `backend/README.md`)

Results (2026-11-03): 151 SQLite tests and 16 PostgreSQL end-to-end tests pass; `scripts/smoke_check.py` passes.
A deliberately broken seat guard (read-then-write) was caught by the e2e suite: 20 tickets sold for 5 seats.
The e2e suite also found a real race, now fixed with a regression test: a parallel retry of the same scan could get `ALREADY_CHECKED_IN` instead of its receipt.

Independent Codex review, three rounds (2026-11-04); every reproduced defect is fixed with a regression test.
Round 1: staff assignment 500 on a concurrent revoke, NUL characters and out-of-range ids reaching PostgreSQL, UTC overflow dates, management 403s without a code.
Round 2: lone Unicode surrogates made the 422 response itself fail with 500.
Round 3: binary bodies (500) and `1e400` (`Infinity`, invalid JSON) in 422 bodies; the 422 body no longer echoes `input`.
Final state: 159 SQLite tests, 21 PostgreSQL end-to-end tests and `scripts/smoke_check.py` pass.
Not covered by review: device/browser runs, endurance load, database-outage injection.

## Open with the team

- `mobile/API.md` still marks `/staff/events` and check-in as proposed; Iliyas can mark them implemented.
- Not built: paid tickets, offline check-in, list pagination, staging deployment.

## Review findings fixed in scope

- Root `.gitignore` was empty.
- No check that the Alembic migrations match the models.
- Nothing ran against PostgreSQL, where the concurrency guarantees live.
- Event capacity could be lowered below issued tickets once tickets exist.

## Data model

- `events.status`: `draft | published | cancelled`, default `draft`.
- `events.tickets_issued`: counter with check `0 <= tickets_issued <= capacity`.
- `tickets`: `event_id`, `attendee_id`, unique `qr_payload`, unique (`event_id`, `attendee_id`).
- `event_staff`: (`event_id`, `user_id`) primary key.
- `check_ins`: unique `ticket_id` (one entry per ticket), unique `request_id` (idempotency), `event_id`, `staff_id`.

## Endpoints

| Endpoint | Access |
|---|---|
| `GET /events` | anyone; published events |
| `GET /events/mine` | organizer; own events, any status |
| `GET /events/{id}` | anyone if published or cancelled; owner or admin for drafts |
| `POST /events/{id}/publish`, `POST /events/{id}/cancel` | owner or admin |
| `POST /events/{id}/tickets` | logged-in user; repeat returns the existing ticket |
| `GET /tickets/me`, `GET /tickets/{id}` | ticket owner (admin may read any) |
| `GET/POST /events/{id}/staff`, `DELETE /events/{id}/staff/{user_id}` | owner or admin |
| `GET /staff/events` | logged-in user; published events they may scan |
| `POST /events/{id}/check-in` | assigned staff, owner or admin |

New endpoints return errors as `{"detail": {"code", "message"}}`.

## Decisions

- Last seat: one conditional `UPDATE events SET tickets_issued = tickets_issued + 1 WHERE ... < capacity`; no explicit locks.
- One check-in per ticket is enforced by the unique `check_ins.ticket_id`.
- Retry: the stored check-in row is the receipt; same `request_id` + staff + event + payload returns it, anything else with that ID is `409 REQUEST_ID_CONFLICT`.
  Permission is checked before the replay lookup, so a revoked staff member gets `403` even on retry.
- Receipts are kept as long as the check-in row (forever for the MVP).
- Staff is not a global role; it is a per-event assignment.

## Verification

- `pytest` (SQLite, in the backend container): every endpoint, permission matrix, error codes, migration/model parity.
- `pytest e2e` against `docker compose` (PostgreSQL + uvicorn): PDF run steps 1-8 over HTTP, including concurrent last-seat, concurrent double scan, concurrent same-`request_id` retries and the lost-response retry, with row counts checked in PostgreSQL.
