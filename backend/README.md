# Palantir backend

FastAPI + PostgreSQL (SQLAlchemy, Alembic). Architecture and data model: [`../docs/architecture.md`](../docs/architecture.md).

**Implemented:** authentication (register / login / refresh, JWT + bcrypt), role-based access control
(`admin`, `organizer`, `attendee`), organizer profiles (create / view / update), event creation and editing.

## Run everything with Docker (recommended)

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
| `GET /events/{id}` | owner or admin | |
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
