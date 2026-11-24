# BiletFlow

We built BiletFlow for CSCI 361 Software Engineering at Nazarbayev University in Fall 2026. Team Palantir consisted of Iliyas Ussabay (team lead), Abbas Uteulin, Temirlan Bayangazy, Sanzhar Toktargazin and Alibi Boranbayev. BiletFlow lets organizers publish events, attendees obtain tickets and check-in staff verify admission. Payments are simulated. The system runs locally with Docker Compose for the API and database. The published course release is tagged `v1.0` (commit `ce8aa25`). This checkout prepares v1.1 on the local `release/v1.1` branch.

- The [web client](web/README.md) uses React for public event listings, registration, sign-in, free ticket claims and access to the attendee’s tickets and QR codes.
- The [backend](backend/README.md) uses FastAPI and PostgreSQL for JWT authentication, role checks, event publication and cancellation, ticket issuance, staff assignments and idempotent check-in.
- The [mobile client](mobile/README.md) uses Expo for staff sign-in, event selection and QR scanning. After an uncertain response, check-in staff can retry with the same `request_id` during the open session.

The [integration audit](docs/integration-audit.md) records verification results and remaining risks. The [team checklist](docs/manual-acceptance.md) contains demonstration and manual acceptance scenarios.

## 1. Obtain the integration branch

For the v1.1 candidate, start in the local `release/v1.1` checkout and continue with section 2. The clone command below retrieves the published integration branch.

Install Node.js 24 and npm. Run the backend with Docker Compose, or use a local PostgreSQL instance and Python 3.12+. The examples use PowerShell.

```powershell
git clone --branch integration/biletflow-e2e https://github.com/IliyasNU/palantir.git biletflow
cd biletflow
```

<a id="2-запустить-postgresql-и-api"></a>

## 2. Start PostgreSQL and the API

Run these commands from the root of a fresh checkout. They create a local `.env` only if it does not already exist. The Compose project `biletflow-test` uses a separate data volume. If that project name is in use, choose an unused name and use it throughout.

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  $biletflowDbPassword = node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
  $biletflowJwtSecret = node -e "console.log(require('node:crypto').randomBytes(64).toString('hex'))"
  $biletflowConfig = Get-Content -LiteralPath .env.example -Raw
  $biletflowConfig = $biletflowConfig.Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$biletflowDbPassword")
  $biletflowConfig = $biletflowConfig.Replace('JWT_SECRET_KEY=', "JWT_SECRET_KEY=$biletflowJwtSecret")
  Set-Content -LiteralPath .env -Value $biletflowConfig -Encoding ascii
}
docker compose -p biletflow-test up --build -d
docker compose -p biletflow-test ps
docker compose -p biletflow-test exec backend alembic current
Invoke-RestMethod http://127.0.0.1:8000/health
```

Compose waits for PostgreSQL to pass `pg_isready`, then applies `alembic upgrade head` before starting the API. The original setup reported `0003 (head)`. The migration head is `0011` for v1.0 and `0013` for this v1.1 candidate. Wait for migrations to finish and check `/health` for `{"status":"ok","database":"up"}` before opening the forms. Inspect `docker compose -p biletflow-test logs backend db` if startup fails. Use `docker compose -p biletflow-test stop` to retain the data.

For a direct launch, create a separate PostgreSQL database named `biletflow_test` with its own user and password. Set `DATABASE_URL` in `backend/.env` using the format `postgresql+psycopg://USER:PASSWORD@127.0.0.1:5432/biletflow_test` and the actual PostgreSQL port. Percent-encode special characters in the username and password. Set the generated `JWT_SECRET_KEY` and `CORS_ORIGINS=http://localhost:5173`. You can administer PostgreSQL through pgAdmin.

```powershell
cd backend
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Edit backend/.env before starting the API.
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m alembic current
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For production, set `ENVIRONMENT=production` and supply a random key. The minimum key lengths for `HS256`, `HS384` and `HS512` are 32, 48 and 64 bytes respectively. Startup rejects empty keys and known example keys. Store secrets in a local `.env` or the environment’s secret manager.

## 3. Start the web client

Open a separate terminal at the checkout root.

```powershell
cd web
if (-not (Test-Path -LiteralPath .env.local)) { Copy-Item .env.example .env.local }
npm ci
npm run dev
```

Open `http://localhost:5173/register`. If the API runs on the same computer, set `VITE_API_URL=http://127.0.0.1:8000` in `web/.env.local`. For another environment, use its API base URL and restart Vite. The value is also required for `npm run build`. An HTTPS deployment needs a reachable HTTPS API and the exact frontend origin in `CORS_ORIGINS`.

In the test database, create an organizer with `POST /auth/register` and the `organizer` role. Open `http://127.0.0.1:8000/docs`, sign in as the organizer, create an event with `POST /events` and publish it with `POST /events/{id}/publish`. Register a separate check-in staff account and assign it using `POST /events/{id}/staff` with JSON `{"email":"<test staff email>"}`. In the web client, register and sign in as an attendee, open the event and select “Получить бесплатный билет” (Get a free ticket). The ticket also appears in “Мои билеты” (My tickets). Reloading the page ends the in-memory web session.

## 4. Run the mobile client on a phone

For a LAN test, bind the API to the LAN interface. With Compose, set `API_BIND_HOST=0.0.0.0` in the local `.env` and repeat `up -d`. For a direct launch, use `--host 0.0.0.0`. On a trusted test network, open `http://<IP-компьютера>:8000/health` on the phone, replacing the placeholder with the computer’s IP address. On the phone, `127.0.0.1` refers to the phone itself.

```powershell
cd mobile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Replace EXPO_PUBLIC_API_URL in mobile/.env with the actual API address.
npm ci
npm start
```

Use Expo Go with SDK 58 support or a device build. On a physical iPhone, use the same account for Expo CLI and Expo Go. From Windows PowerShell, run `npx.cmd expo login` in `mobile`. The [mobile instructions](mobile/README.md) cover the camera, two consecutive scans, access checks and recovery after a lost response. Values prefixed with `VITE_*` or `EXPO_PUBLIC_*` are included in client builds. Use them only for service addresses.

## Verification

| Component | Commands (run from the component directory) |
| --- | --- |
| Backend | `python -m pytest -q tests` |
| PostgreSQL | `python -m pytest -q e2e` with the explicit test configuration in the [backend instructions](backend/README.md#end-to-end-tests-against-postgresql) |
| Web | `npm test`, `npm run typecheck`, `npm run build`, `npm run test:browser` |
| Mobile | `npm test`, `npm run typecheck`, `npm run lint`, `npx expo export --platform android`, `npx expo export --platform ios` |

Browser checks against a live API create test accounts and events. The [integration audit](docs/integration-audit.md) documents the flags and sequence for a live run.
