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
| `GET /tickets/me` or `/tickets/{id}` | authenticated | ownership enforced |
| `POST /events/{id}/staff` | owner or admin | assign event staff |
| `GET /staff/events` | authenticated | permitted published events |
| `POST /events/{id}/check-in` | staff, owner or admin | exact QR payload plus UUID request ID |
| `PUT` or `PATCH /events/{id}` | owner or admin | partial update |

Send the access token as `Authorization: Bearer <token>`. Use paths exactly as written (no trailing slash).
Datetimes are ISO 8601; values without a timezone are treated as UTC and responses are always UTC.
Errors: 401 missing/invalid/expired token · 403 wrong role or not the owner · 404 not found · 409 conflict · 422 validation.

## Admin accounts

Admins cannot register through the API. Create one (or promote an existing user) with:

```bash
python -m scripts.create_admin --email admin@example.com --full-name "Platform Admin"
```

## Conventions

Conventional Commits (`feat(auth): ...`, `fix(events): ...`, `test: ...`, `docs: ...`); one ClickUp task per feature,
linked to its GitHub issues.
