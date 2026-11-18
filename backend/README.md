# Palantir backend

FastAPI + PostgreSQL (SQLAlchemy, Alembic). Architecture and data model: [`../docs/architecture.md`](../docs/architecture.md).

**Implemented:** authentication (register / login / refresh, JWT + bcrypt), role-based access control
(`admin`, `organizer`, `attendee`), organizer profiles (create / view / update), events (create, edit, publish,
cancel, public listing), free tickets with QR payloads, per-event staff, and idempotent ticket check-in.

## Run the API and database with Docker

Use the [root setup](../README.md#2-запустить-postgresql-и-api) to generate the required local credentials before starting Compose.

```bash
# from the repository root
docker compose up --build
```

API: <http://localhost:8000> · interactive docs: <http://localhost:8000/docs>.
The backend container applies the Alembic migrations on start. Stop with `docker compose down`
(`-v` also deletes the database volume).

Useful commands while it is running:

```bash
docker compose exec backend pytest                       # run the tests inside the container
docker compose exec backend python scripts/smoke_check.py  # end-to-end check against the live API + PostgreSQL
docker compose exec backend python -m scripts.create_admin --email admin@example.com
docker compose exec db psql -U palantir -d palantir -c "\dt"
```

## Run tests locally (no Docker, no PostgreSQL needed)

Tests use an in-memory SQLite database. Python 3.11+ recommended.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
pytest                               # all tests
pytest tests/test_auth.py -v         # one file
pytest --cov=app --cov-report=term-missing
```

## End-to-end tests against PostgreSQL

`tests/` runs in-process on SQLite. `e2e/` drives the running API over HTTP and checks rows in PostgreSQL:
the mobile MVP run (login, staff access, ticket, scan, retries, lost response) and real concurrency
(last seat, two phones on one ticket, parallel retries).

Set `RUN_POSTGRES_E2E=1`, `ENVIRONMENT=test`, `E2E_BASE_URL` and `E2E_DATABASE_URL` explicitly. Use the same test JWT key and database as the running API. The database name must be `biletflow_test`, `biletflow_test_*`, `test_*` or `e2e_*`. The migration parity test needs permission to create and drop its own randomly named scratch database.

```powershell
# From backend/ with the isolated API running.
$env:RUN_POSTGRES_E2E = '1'
$env:ENVIRONMENT = 'test'
$env:E2E_BASE_URL = 'http://127.0.0.1:8000'
# Set E2E_DATABASE_URL and JWT_SECRET_KEY from your local test configuration.
python -m pytest -q e2e
```

Run `tests` and `e2e` in separate pytest processes. E2E creates disposable users and events in the configured database.

## Run the API locally against your own PostgreSQL

```bash
cd backend
cp .env.example .env                 # then adjust DATABASE_URL if needed
alembic upgrade head
uvicorn app.main:app --reload
```

## Migrations

```bash
alembic upgrade head                                  # apply
alembic downgrade -1                                  # undo the last one
alembic revision --autogenerate -m "describe change"  # after editing models; ALWAYS review the generated file
```

Run these from `backend/`. Import new models in `app/models/__init__.py` so autogenerate sees them.

## API summary

| Method & path | Access | Notes |
|---|---|---|
| `GET /health` | public | API + DB check |
| `POST /auth/register` | public | JSON `{email, full_name, password, role?}`; `role` is `attendee` (default) or `organizer` |
| `POST /auth/login` | public | JSON `{email, password}` → `{access_token, refresh_token, token_type}` |
| `POST /auth/token` | public | same, as OAuth2 form (`username` = email); used by the `/docs` "Authorize" button |
| `POST /auth/refresh` | public | JSON `{refresh_token}` → new token pair |
| `GET /auth/me` | logged in | current user |
| `POST /organizer-profiles` | organizer | one profile per organizer (409 if it exists) |
| `GET /organizer-profiles/me` | organizer | 404 until created |
| `PUT` or `PATCH /organizer-profiles/me` | organizer | partial update: only sent fields change |
| `GET /organizer-profiles/{id}` | logged in | |
| `POST /events` | organizer | `{title, description?, date, location, capacity}` |
| `GET /events` | public | published events |
| `GET /events/{id}` | public or owner/admin | draft details are restricted |
| `POST /events/{id}/publish` or `/cancel` | owner or admin | state transitions |
| `POST /events/{id}/tickets` | authenticated | `201` new ticket, `200` existing ticket |
| `GET /tickets/me` or `/tickets/{id}` | authenticated | ownership enforced; `status` is `active`, `cancelled` or `refunded` |
| `GET /tickets/{id}/pdf` | holder of the ticket or admin | one A4 page with the same QR as the screen; `409` for a closed ticket or a cancelled event |
| `POST /tickets/{id}/cancel` | attendee of the ticket, event owner or admin | final; releases the seat; `409 TICKET_CHECKED_IN` while admitted |
| `POST /tickets/{id}/refund` | event owner or admin | final; records the admission state only, no payment is processed |
| `POST /events/{id}/staff` | owner or admin | assign event staff |
| `GET /staff/events` | authenticated | permitted published events, each with `can_manage` |
| `POST /events/{id}/check-in` | staff, owner or admin | exact QR payload plus UUID request ID; `409 TICKET_CANCELLED` / `TICKET_REFUNDED` for closed tickets |
| `POST /events/{id}/check-ins/{check_in_id}/undo` | owner or admin | `{request_id}`; keeps the row as history, the ticket can be scanned again |
| `GET /events/{id}/attendance` | staff, owner or admin | `{event_id, capacity, tickets_issued, checked_in}` |
| `GET /events/{id}/attendees?q=` | staff, owner or admin | name/e-mail search, `q` ≥ 3 chars, ≤ 20 results, masked e-mail, ticket `status`, current `check_in_id` + `qr_payload` |
| `PUT` or `PATCH /events/{id}` | owner or admin | partial update |

Send the access token as `Authorization: Bearer <token>`. Use paths exactly as written (no trailing slash).
Datetimes are ISO 8601; values without a timezone are treated as UTC and responses are always UTC.
Errors: 401 missing/invalid/expired token · 403 wrong role or not the owner · 404 not found · 409 conflict · 422 validation.

## Ticket types and action log (P1)

Revision `0004` follows `0003`. Each existing event receives one free type with its full
capacity. Every existing ticket is linked to that type and the initial issued count includes
only active tickets. New events start with the same default type.

| Method and path | Access | Result |
| --- | --- | --- |
| `GET /events/{id}/ticket-types` | Same visibility as the event | Visible types and remaining quantities |
| `GET /events/{id}/ticket-types/manage` | Event owner or admin | All types, including hidden ones |
| `POST /events/{id}/ticket-types` | Event owner or admin | Create a type (201). An optional body `event_id` must match the path |
| `PATCH /events/{id}/ticket-types/{type_id}` | Event owner or admin | Edit or hide a type |
| `GET /events/{id}/action-log` | Event owner or admin | Read action history, newest first |
| `POST /events/{id}/tickets` | Authenticated | Optional `{"ticket_type_id": 42}`. Existing tickets return 200. New free tickets return 201 |

Set `name`, `quantity` and optionally `description`, integer `price_tiyn`, `sales_start`,
`sales_end`, `order_limit`, and `hidden`. Sales open at the start and close at the end.
Omit either timestamp to leave that boundary open. Hidden types still count toward event
capacity. Reduce the default quantity before allocating another type. A type's quantity
cannot fall below its active ticket count. A single default allocation equal to the event
capacity follows edits to that capacity.

The shared name policy in `app/assets/ticket-type-name.json` defines the 120-character
API limit and two display lines for the ticket page and PDF. Ticket type IDs are scoped to
the event in the URL. A foreign type returns 404 on edit and claim, including at full capacity
or when the attendee already holds a ticket. Request validation returns 422 with a field-error
array in `detail`. A PATCH that conflicts with the stored sales window returns 422 with
`detail.code = INVALID_INPUT`.

When the body is omitted, the API selects the sole visible free type. P1 issues at most one
ticket per attendee per event and stores the order limit for later phases. Paid types can be
configured. Issuing a ticket for one returns `409 PAID_TICKETS_NOT_SUPPORTED`.
Ticket responses include `ticket_type_id` and a `ticket_type` summary. The PDF prints the
type name. These fields reflect the type's current details.

The event and type counters change together. A failed type claim rolls back the event seat.
Cancellation and refunds release both counters. The API records type creation and edits
with the actor and time in the same transaction. The downgrade guard rejects databases
whose configured types or action history cannot be represented in revision `0003`.

P1's isolated demo-compatible run used PostgreSQL 16.15 initialized with
`POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale-provider=icu --icu-locale=und"`.
SQL confirmed provider ICU (`i`), locale `und` and encoding `UTF8`. The PostgreSQL
e2e suite passed 38 tests, including case-insensitive Kazakh name search, concurrent
type claims, and upgrade and downgrade against data from revision `0003`.

## Admin suspension and the event timeline

Revision `0005` follows `0004`. It adds `events.suspended_at` and lets an action log record
belong to no event. All `/admin` routes need an admin account
(`python -m scripts.create_admin --email admin@example.com`).

| Method and path | Access | Result |
| --- | --- | --- |
| `GET /admin/users?q=&limit=` | Admin | Users whose name or e-mail contains `q`; the newest accounts without `q`. At most 50 |
| `POST /admin/users/{id}/suspend` | Admin | Body `{"reason": "..."}` (3–300 characters). Disables the account; its tokens stop working at once |
| `POST /admin/users/{id}/reactivate` | Admin | Enables the account again |
| `GET /admin/events?q=&suspended=&limit=` | Admin | Events in every status by title; `suspended=true` or `false` narrows the list. At most 50 |
| `POST /admin/events/{id}/suspend` | Admin | Body `{"reason": "..."}`. Hides the event from the public and stops ticket claims |
| `POST /admin/events/{id}/reactivate` | Admin | Lifts the suspension; the event returns as it was |
| `GET /admin/action-log` | Admin | The whole platform's history. Filters as below, plus `event_id` |
| `GET /events/{id}/action-log` | Event owner or admin | The event's timeline, newest first. Optional `date_from`, `date_to`, `action`, `limit` (default 200, at most 500), `offset` |

Suspending or reactivating twice is a no-op and records nothing more. An admin cannot suspend
their own account (`409 CANNOT_SUSPEND_SELF`). Unknown ids return `404 USER_NOT_FOUND` or
`404 EVENT_NOT_FOUND`.

A suspended event behaves like a draft for everyone except its organizer and admins: it is not
in `GET /events`, and its details, ticket types and claims return `404 EVENT_NOT_FOUND`. Its
organizer and admins see `suspended: true` in the event and get `409 EVENT_SUSPENDED` when
claiming. A claim that races the suspension is refused with the same code and takes no seat.
Tickets issued before the suspension stay readable and still check in.

Event responses include `suspended`. Action log entries include `actor_name`, and `event_id`
is `null` for platform actions (`user.suspended`, `user.reactivated`). The `action` filter
matches an exact type or the group before its dot: `action=check_in` returns `check_in.created` and
`check_in.undone`, `action=ticket_type` returns only ticket type changes, and `action=ticket` returns
only `ticket.*`, never `ticket_type.*`. The recorded actions are listed in
[`../docs/architecture.md`](../docs/architecture.md#admin-suspension-and-the-full-event-timeline).

Verified on 11 November 2026 on the Compose image `postgres:16-alpine` (16.15, ICU `und`,
UTF8) in an isolated project: 423 unit tests and 42 PostgreSQL e2e tests passed, with
`alembic current` at `0005 (head)`.

Verified again on 12 November 2026 after the action filter fix and the shared `ensure_not_suspended`
check, on a disposable local PostgreSQL 16.15 (ICU `und`, UTF8): 455 unit tests and 43 PostgreSQL e2e
tests passed, with `alembic heads` at `0005 (head)`.

## Simulated paid sales and orders (P2)

P2 is a university simulation: **Демонстрационная оплата, деньги не списываются**.
There is no payment provider, card entry, real verification or payout. Successful payment
responses carry `simulation: true` and `demo_notice`. Authentication and authorization are real.

Migration `0006` follows `0005`. It adds `orders`, `paid_sales_activations` and two demo fields
on organizer profiles. Existing events, tickets, QR payloads, history and counters are preserved.
Downgrade refuses if any orders, activation rows or profile confirmations would be lost.

| Method and path | Access | Result |
| --- | --- | --- |
| `GET /events/{id}/activation` | Owner/admin | Five checklist steps, activation and paid-sales suspension state, demo fee |
| `POST /events/{id}/activation/terms` | Owner/admin | Accept demo terms, idempotent |
| `POST /events/{id}/activation/fee` | Owner/admin | Simulate activation fee payment, store amount and time once |
| `POST /organizer-profiles/me/confirm-identity` | Organizer | Simulate confirmation of own existing profile |
| `POST /organizer-profiles/me/payout-details` | Organizer | `{reference_last4}`: exactly four ASCII letters/digits. Full references are rejected |
| `POST /admin/events/{id}/paid-sales/suspend` | Admin | Required `{reason}` (3–300 chars); free claims remain available |
| `POST /admin/events/{id}/paid-sales/restore` | Admin | Restore paid sales; event-wide suspension still applies |
| `POST /events/{id}/orders` | Authenticated buyer | `{ticket_type_id, attendee_name, attendee_email, request_id}`; 201 pending, 200 replay |
| `POST /orders/{id}/pay` | Buyer only | `{outcome: "success" or "failure"}`; first terminal result wins |
| `POST /orders/{id}/cancel` | Buyer only | Release a pending order once; terminal states are returned unchanged |
| `GET /orders/me`, `GET /orders/{id}` | Buyer only | Own orders, including terminal orders; another buyer's order is 404 even to admins |
| `GET /events/{id}/orders/summary` | Owner/admin | Demo gross sales, fees, refunds (0 until P5), estimated payout |

`EventRead.paid_sales_available` exposes only whether public paid checkout is available, not
the organizer's private checklist. Activation requires a paid type, confirmed profile identity,
demo payout suffix, event terms and event activation fee. Profile confirmations are shared by
that organizer's events; terms and the fee are per event. Paid-sales suspension is separate from
the admin's event-wide suspension. Payment confirmation checks both suspensions under the lock.

| HTTP | P2 error codes |
| --- | --- |
| 401 / 403 | Existing authentication/role errors; `FORBIDDEN` for another organizer's event |
| 404 | `EVENT_NOT_FOUND`, `TICKET_TYPE_NOT_FOUND`, `ORDER_NOT_FOUND`, `ORGANIZER_PROFILE_NOT_FOUND` |
| 409 | `PAID_SALES_NOT_ACTIVATED`, `PAID_SALES_SUSPENDED`, `EVENT_SUSPENDED`, `EVENT_CANCELLED`, `EVENT_NOT_PUBLISHED` |
| 409 | `TICKET_TYPE_HIDDEN`, `TICKET_TYPE_SALES_NOT_STARTED`, `TICKET_TYPE_SALES_ENDED`, `SOLD_OUT`, `TICKET_TYPE_SOLD_OUT`, `ORDER_LIMIT_EXCEEDED` |
| 409 | `ACTIVE_TICKET_EXISTS`, `CLOSED_TICKET_EXISTS`, `PENDING_ORDER_EXISTS`, `IDEMPOTENCY_CONFLICT`, `ORDER_EXPIRED`, `FREE_TICKET_USE_CLAIM` |
| 422 | Existing field-error array in `detail`; unstorable DB values use existing `detail.code = INVALID_INPUT` |

Business errors use `api_error` (`detail.code` and `detail.message`). Public reads keep B2's
404 visibility rules; an authenticated checkout checks the event under its lock and returns
the explicit state refusal listed above. Legacy free claims keep `PAID_TICKETS_NOT_SUPPORTED`
and point to checkout in the message.

Money is integer tiyn. The buyer pays exactly the ticket price. The coded demo activation fee
is 500000 tiyn, and processing is 300 basis points (3%) withheld from organizer proceeds.
Rounding is nearest tiyn, halves upwards: `(price_tiyn * 300 + 5000) // 10000`.
For 10050 tiyn the buyer pays 10050, the fee is 302, and estimated proceeds are 9748.
Orders snapshot price, rate and fee; editing the type does not reprice an existing order.

One order contains one ticket and checks `order_limit >= 1`. `request_id` is unique per buyer.
The same key and payload returns the existing order; changing its event, type or attendee
details returns `IDEMPOTENCY_CONFLICT`. Confirmation uses the order itself as its idempotency
identity: retries (even with a different outcome) return the first completed result.
Expired orders always return `ORDER_EXPIRED` on confirmation and never issue a ticket.

`UNIQUE(event_id, attendee_id)` remains unchanged: checkout rejects **any** existing ticket,
including cancelled/refunded (`CLOSED_TICKET_EXISTS`). Legacy `claim_ticket` still returns
the existing ticket with HTTP 200, including closed tickets. It only gains lazy expiry and
a pending-order check before new issuance. A zero-total order for a free claim is deliberately
out of scope, a known SRS 4.4 gap.

Reservations last 15 minutes and consume the event and type counters in the same transaction.
Counters represent active tickets **plus pending reservations**. Payment replaces the reserved
seat with a ticket, without incrementing again. Failure/cancellation/expiry decrements once.
The event is locked before checking time, buyer state, orders or inventory. Expiry is lazy on
checkout/confirmation/cancellation/order reads, public event/type inventory reads and inventory
edits. No background process runs. For a manual sweep:

```bash
python -m scripts.expire_orders
```

A reservation made inside the sales window may be confirmed until its deadline, even if the
type's window later closes. Event cancellation, event suspension and paid-sales suspension still
block confirmation. Reservation counters are physically released on the next relevant request
or sweep, not at a timer interrupt. Clients must not infer valid payment from their own clocks.

Attendee name/email are order contact snapshots. Ownership, PDF holder identity and check-in
continue to use the authenticated account. P2 does not introduce transferable tickets.
Existing ticket cancellation/refund routes still change admission state only; financial refunds
and adjustments to order totals belong to P5. The P2 sales summary reports refunds as zero.
Ticket delivery email belongs to B4 and should hook after a new paid ticket commits, once only.

Run `pytest -q tests` and, separately, the full `pytest -q e2e` against a disposable PostgreSQL 16
ICU `und`, UTF8 instance. The P2 e2e tests cover buyer/free/paid races, payment vs expiry and
suspension, repeated cleanup/confirmation, PDF and check-in, plus populated `0005 → 0006`.
Always verify the demo database's actual locale before presenting; no existing team volume is reinitialized.

P2 verification on 12 November 2026, implementation `7f8db09`, integrated tree `2e375df`
(the integration merge did not change backend files):

| Check | Observed result |
| --- | --- |
| Backend `python -m pytest -q tests` | 481 passed, one existing Starlette/httpx deprecation warning |
| PostgreSQL HTTP `python -m pytest -q e2e` | 55 passed, including 12 new P2 cases; same warning |
| SQL and migrations | PostgreSQL 16.15 / Ubuntu in WSL; provider `i`, ICU `und`, UTF8, Kazakh case folding true; sole head `0006`; empty and populated upgrade, safe downgrade and order guard passed |
| Web unit, TypeScript, production build | 72 passed; typecheck and build passed with `VITE_API_URL=http://127.0.0.1:8000` |
| Browser | 53 passed in the standard suite, 1 recovery and 1 isolation test passed separately. Two opt-in cases skipped in the standard suite: isolation was then run separately; strict Docker 667 acceptance was not run |

The API used Python 3.14.5 on Windows, browser Microsoft Edge headless. The CI container matrix
(Python 3.12, Alpine PostgreSQL, Chromium) and a clean dependency installation were not repeated
locally. P2 browser flows use HTTP fixtures; PostgreSQL e2e uses the real API, including paid-ticket
PDF and check-in. Physical phone/printing and the actual demo database remain unverified.
One earlier browser run timed out during login in the existing PDF refusal test; it passed in
the final full run without a test change. These checks are agent verification, not a teammate review.

## Admin accounts

Admins cannot register through the API. Create one (or promote an existing user) with:

```bash
python -m scripts.create_admin --email admin@example.com --full-name "Platform Admin"
```

## Conventions

Conventional Commits (`feat(auth): ...`, `fix(events): ...`, `test: ...`, `docs: ...`); one ClickUp task per feature,
linked to its GitHub issues.

## W2 PostgreSQL 16 locale and acceptance

The selected W2 demo/test configuration is PostgreSQL 16, UTF-8, ICU provider, ICU locale `und`. Attendee search compares Python-lowercased input with PostgreSQL `lower(full_name)` / `lower(email)`, so the database's Unicode case conversion is part of the contract.

For a **new isolated Compose database**, save this local override as `work/compose.w2-pg16-icu.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale-provider=icu --icu-locale=und"
```

The root Compose file does not forward `POSTGRES_INITDB_ARGS` from `.env`; setting it there alone has no effect. The override passes it explicitly. These arguments apply only when PostgreSQL initializes an empty data directory. They do not convert an existing database.

Use the existing root credential setup to prepare a separate local `.env.w2-pg16` with generated credentials, `POSTGRES_DB=biletflow_test_w2_pg16`, `ENVIRONMENT=test`, and unused `DB_PORT` / `BACKEND_PORT`. Keep that file local. Choose an unused Compose project name and confirm its `<project>_postgres_data` volume does not already exist before starting; the new project gets its own volume. Do not reuse, reinitialize, or remove any existing team database/volume to change its locale.

```powershell
# From the repository root; choose a new, unused project name.
$w2Pg16Project = 'biletflow-w2-pg16-icu-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
docker compose --env-file .env.w2-pg16 -p $w2Pg16Project -f docker-compose.yml -f work/compose.w2-pg16-icu.yml up --build -d
docker compose --env-file .env.w2-pg16 -p $w2Pg16Project -f docker-compose.yml -f work/compose.w2-pg16-icu.yml exec backend alembic current
```

Compose applies `alembic upgrade head` before starting the API. Expect `0005 (head)` and `/health` HTTP 200 with `database: up`. For a direct API launch, run `python -m alembic upgrade head` and `python -m alembic current` from `backend/` using that same isolated database.

Run this SQL **in the database used by the API** and retain the actual output with the tested commit:

```sql
SELECT version();
SELECT datname, datlocprovider, daticulocale,
       pg_encoding_to_char(encoding) AS encoding,
       current_setting('server_version') AS server_version
FROM pg_database
WHERE datname = current_database();
SELECT lower('ӘЛИЯ') = 'әлия' AS kazakh_casefold_ok;
```

Expected: server major 16, `datlocprovider = 'i'`, `daticulocale = 'und'`, `encoding = 'UTF8'`, and `kazakh_casefold_ok = true`. A successful startup alone does not verify these properties.

Reuse the explicit isolated API/JWT/database configuration from [End-to-end tests against PostgreSQL](#end-to-end-tests-against-postgresql): `RUN_POSTGRES_E2E=1`, `ENVIRONMENT=test`, `E2E_BASE_URL` pointing to this API, and matching `E2E_DATABASE_URL` / `JWT_SECRET_KEY`. The migration test needs permission for its own temporary scratch database. From `backend/`, run separate processes:

```powershell
python -m pytest -q tests
python -m pytest -q e2e
```

Acceptance includes `e2e/test_attendance.py`: uppercase Kazakh-name search must find the issued ticket and feed the existing check-in endpoint; parallel duplicate scans must leave attendance equal to the actual check-in row count. Record the date, full source SHA, PostgreSQL version/provider/locale/encoding, migration head, health result, commands, passed/failed/skipped counts, and remaining gaps.

Historical evidence from 9 November 2026, W2 `80246eab19ff0370df30625dbc7f149171e0b8f5`: PostgreSQL 18.1 with locale `C` produced 24 passed / 1 failed (Kazakh case-insensitive search); a separate PostgreSQL 18.1 ICU `und` database produced 25 passed. These are historical PostgreSQL 18.1 results, not fresh PostgreSQL 16 acceptance.

Fresh verification by the agent, 9 November 2026, source `80246eab19ff0370df30625dbc7f149171e0b8f5` (85 backend blobs verified unchanged before and after testing):

| Check | Observed result |
| --- | --- |
| Database | Official Ubuntu PostgreSQL **16.15** packages, extracted without system installation, running in WSL Ubuntu 24.04.1; new isolated tmpfs test cluster |
| SQL metadata | `datlocprovider = 'i'`, `daticulocale = 'und'`, encoding `UTF8`; `lower('ӘЛИЯ') = 'әлия'` returned `true` |
| Empty-database migrations | `python -m alembic upgrade head`, then schema revision `0002` |
| Live API health | HTTP 200, `{"status":"ok","database":"up"}` |
| Unit tests | `python -m pytest -q tests`: **300 passed, 0 failed, 0 skipped**, one Starlette deprecation warning (14.38 s) |
| Full live PostgreSQL e2e | `python -m pytest -q e2e`: **25 passed, 0 failed, 0 skipped**, one Starlette deprecation warning (27.41 s), including Kazakh case-insensitive search and parallel check-in/count assertions |
| API runtime | Python 3.14.5 on Windows 11; loopback API connected only to the new isolated PostgreSQL cluster |

`datcollate` and `datctype` were `C` in this ICU database; those fields alone do not identify the effective locale provider. Check `datlocprovider` and `daticulocale` as above. No pre-existing database or team data was connected to or changed. These agent checks are not Temirlan's independent review or approval. No W3 phone/camera validation was performed.

Docker Desktop currently crashes before its engine starts. The Ubuntu/WSL results establish that tested environment's behavior; they do not verify `postgres:16-alpine`, Docker initialization, or Compose volume parity. The Alpine/Compose run remains pending until it actually completes.
