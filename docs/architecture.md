# Palantir – System Architecture

Client–server architecture. Two clients talk to one REST API; the API owns the database.

```mermaid
flowchart LR
    Web["Web app<br/>React + TypeScript + Tailwind"] -->|"REST / JSON"| API
    Mobile["Mobile scanner app<br/>React Native + Expo"] -->|"REST / JSON"| API
    subgraph compose["Docker Compose"]
        API["Backend<br/>FastAPI"] -->|"SQLAlchemy"| DB[("PostgreSQL")]
    end
```

| Layer | Technology |
|---|---|
| Web frontend | React, TypeScript, Tailwind CSS |
| Mobile (event-staff ticket scanning) | React Native with Expo |
| Backend | FastAPI (Python), REST + JSON, interactive docs at `/docs` |
| Database | PostgreSQL, accessed through SQLAlchemy 2.0, schema managed with Alembic migrations |
| Auth | JWT access + refresh tokens, bcrypt password hashes |
| Tests | pytest (backend), React Testing Library (frontend) |
| Deployment | Docker / Docker Compose (`docker-compose.yml`) |

## Backend structure (`backend/app/`)

```
main.py              FastAPI app, CORS, router registration
core/config.py       settings from environment variables
db/                  engine + session (session.py), declarative base (base.py), role seeding (seed.py)
models/              SQLAlchemy models: role, user, organizer_profile, event, ticket, event_staff, check_in
schemas/             Pydantic request/response models (validation lives here)
auth/                security.py (bcrypt + JWT), service.py (logic), router.py (/auth/*)
dependencies/        auth.py (current user), roles.py (RBAC), events.py (event access), db.py (session)
errors.py            api_error(): {"detail": {"code", "message"}} for clients that branch on codes
routers/             organizer_profiles.py, events.py, tickets.py, staff.py, check_ins.py, health.py
```

Request flow: **router → dependencies (token → user → role check) → model/DB**. Routers contain no
password or token logic; that lives in `auth/`.

## Data model

```mermaid
erDiagram
    ROLES ||--o{ USERS : "assigned to"
    USERS ||--o| ORGANIZER_PROFILES : "has (organizers)"
    USERS ||--o{ EVENTS : "organizes"
    EVENTS ||--o{ TICKETS : "issues"
    USERS ||--o{ TICKETS : "holds"
    EVENTS ||--o{ EVENT_STAFF : "staffed by"
    USERS ||--o{ EVENT_STAFF : "scans at"
    TICKETS ||--o| CHECK_INS : "admitted once"

    ROLES {
        int id PK
        string name UK "admin | organizer | attendee"
    }
    USERS {
        int id PK
        string email UK "lower-case"
        string full_name
        string hashed_password "bcrypt"
        int role_id FK
        bool is_active
        datetime created_at
        datetime updated_at
    }
    ORGANIZER_PROFILES {
        int id PK
        int user_id FK "unique"
        string organization_name
        text description
        string contact_email
        string contact_phone
        string website
        datetime created_at
        datetime updated_at
    }
    EVENTS {
        int id PK
        int organizer_id FK
        string title
        text description
        datetime date "start, UTC"
        string location
        int capacity "> 0"
        string status "draft | published | cancelled"
        int tickets_issued "0..capacity"
        datetime created_at
        datetime updated_at
    }
    TICKETS {
        int id PK
        int event_id FK
        int attendee_id FK
        string qr_payload UK "biletflow:ticket:v1:<random>"
        datetime created_at
    }
    EVENT_STAFF {
        int event_id PK
        int user_id PK
        datetime created_at
    }
    CHECK_INS {
        int id PK
        int ticket_id FK,UK "one admission per ticket"
        int event_id FK
        int staff_id FK
        uuid request_id UK "idempotency key"
        datetime checked_in_at
    }
```

`tickets` is also unique on (`event_id`, `attendee_id`): one free ticket per person per event.

## Authentication and roles

* `POST /auth/register` creates an `attendee` or `organizer`. Admins cannot self-register; they are
  created with `python -m scripts.create_admin`.
* `POST /auth/login` (JSON) and `POST /auth/token` (OAuth2 form, used by the `/docs` "Authorize" button)
  return `{access_token, refresh_token, token_type}`. Access tokens live 30 min, refresh tokens 7 days.
* `POST /auth/refresh` exchanges a refresh token for a new pair. Tokens carry a `type` claim, so a refresh
  token cannot be used as an access token (and vice versa).
* Every protected endpoint depends on `get_current_user` (401 if the token is missing/invalid/expired,
  403 if the account is disabled). `require_roles(...)` in `dependencies/roles.py` adds the role check (403).

| Endpoint | Who |
|---|---|
| `GET /health`, `POST /auth/register`, `POST /auth/login`, `POST /auth/token`, `POST /auth/refresh` | anyone |
| `GET /events`, `GET /events/{id}` (published or cancelled) | anyone |
| `GET /events/{id}` (draft) | the event's organizer, or an admin |
| `GET /auth/me`, `GET /organizer-profiles/{id}` | any logged-in user |
| `POST /events/{id}/tickets`, `GET /tickets/me`, `GET /tickets/{id}` (own) | any logged-in user |
| `GET /staff/events` | any logged-in user (lists what they may scan; may be `[]`) |
| `POST /organizer-profiles`, `GET /organizer-profiles/me`, `PUT\|PATCH /organizer-profiles/me` | organizer |
| `POST /events`, `GET /events/mine` | organizer |
| `PUT\|PATCH /events/{id}`, `POST /events/{id}/publish`, `POST /events/{id}/cancel` | the event's organizer, or an admin |
| `GET\|POST /events/{id}/staff`, `DELETE /events/{id}/staff/{user_id}` | the event's organizer, or an admin |
| `POST /events/{id}/check-in` | the event's assigned staff, its organizer, or an admin |

## Design decisions

* **One role per user** (`users.role_id`). Simple to enforce and test; can become many-to-many later.
* **Stateless JWT.** No server-side revocation yet; "log out" means the client discards its tokens.
* **bcrypt used directly** (not via passlib) – fewer moving parts. Passwords are limited to 72 bytes (bcrypt's limit).
* **Sync SQLAlchemy.** FastAPI runs the sync endpoints in a thread pool; Alembic stays straightforward.
* **Timestamps are UTC.** Datetimes without a timezone are interpreted as UTC; responses are always UTC.
* **Tests use in-memory SQLite**, the app targets PostgreSQL. Models avoid PostgreSQL-only types so both work;
  `tests/test_migrations.py` checks that the Alembic migration applies and rolls back cleanly.

## Tickets and check-in

* Events start as `draft`, become `published` (ticketing and check-in open) and can be `cancelled` (final).
  Publishing is a conditional update, so it can never overwrite a concurrent cancel.
* Claiming a ticket takes a seat with one atomic `UPDATE events SET tickets_issued = tickets_issued + 1
  WHERE ... AND tickets_issued < capacity`; the check constraint backs it up. No explicit locks.
* Check-in follows `mobile/API.md`. The `check_ins` row is the receipt: resending the same `request_id`
  (same staff, event and QR) returns it, any other reuse is `409 REQUEST_ID_CONFLICT`. The unique `ticket_id`
  makes a second admission impossible even when two phones scan at once. Access is checked on every request,
  retries included, so revoked staff get `403`.
* Check-in holds the event row `FOR SHARE` until it commits, so a cancel or publish waits for scans in flight and a scan
  never mixes an old event status with newer staff access. Parallel scans do not block each other.
* New endpoints report errors as `{"detail": {"code": "...", "message": "..."}}`. Codes: `EVENT_NOT_FOUND`,
  `EVENT_NOT_PUBLISHED`, `EVENT_CANCELLED`, `SOLD_OUT`, `CAPACITY_BELOW_ISSUED`, `TICKET_NOT_FOUND`,
  `USER_NOT_FOUND`, `STAFF_CHANGED`, `FORBIDDEN`, `INVALID_TICKET`, `ALREADY_CHECKED_IN`, `REQUEST_ID_CONFLICT`.
* Values PostgreSQL refuses to store (NUL characters, ids beyond its integer range) return
  `422 INVALID_INPUT` on every endpoint instead of a 500.

## Not built yet

Paid tickets, offline check-in, pagination and search for event lists, a shared staging deployment.
