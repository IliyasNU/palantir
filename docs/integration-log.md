# Integration log

One entry per verification run of a branch or pull request. GitHub Actions is the intended check. While it cannot run, the same steps from `.github/workflows/web-api-integration.yml` are run by hand and recorded here, so every merge into `integration/biletflow-e2e` still has evidence.

## CI status

As of November 10, none of the 20 runs of "Web API integration" since the first one on November 6 has succeeded; each ends within a few seconds without starting a job. GitHub reports the reason on the latest run (November 9): "The job was not started because your account is locked due to a billing issue." This is an account setting of the repository owner and is unrelated to the code. Runs resume once the owner resolves it under Settings, Billing and plans.

## How to add an entry

Record the date, the full commit SHA, what was verified, the environment, each command group with its actual result, and anything that was not run. Write `not run` with the reason instead of leaving a step out.

## Entries

### 2026-11-10 · PR #7 `fix/ci-pg16-icu` · `a38abe5`

Every step of the `backend-web` job was run by hand on Ubuntu 24.04 with Python 3.13.18, Node 22.23.4 and PostgreSQL 16.15. CI uses Python 3.12 and Node 24; that difference is not covered by this run. The database was created with `LOCALE_PROVIDER icu ICU_LOCALE 'und'`, encoding UTF8.

| Step | Result |
| --- | --- |
| New "Verify PostgreSQL 16 ICU settings" check on the ICU database | passed |
| The same check on a libc `C.UTF-8` database | rejected, as intended (`provider: c`, `locale: None`) |
| Backend unit tests, `pytest -q tests` | 300 passed |
| Migrations, `alembic upgrade head` | reached 0002 |
| Backend e2e on PostgreSQL, `pytest -q e2e` | 25 passed |
| Web `npm run typecheck`, `npm test`, `npm run build` | passed, 47 unit tests |
| Browser suite with `RUN_LIVE_AUTH=1` and `RUN_LIVE_TICKETS=1` | 31 passed, 1 skipped (the recovery test, run next) |
| Real API outage and recovery with `RUN_LIVE_RECOVERY=1` | 1 passed |

Not run: the `mobile` job on this commit, because PR #7 changes only the workflow file. The PostgreSQL service container itself (`POSTGRES_INITDB_ARGS`) was not exercised; an equivalent database was created with `CREATE DATABASE`.

### 2026-11-10 · PR #6 `feature/attendance-mobile` · `b19f65d`

The steps of the `mobile` job, on Node 22.23.4.

| Step | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm test` | 56 passed |
| `npx expo export --platform android` | exported |
| `npx expo export --platform ios` | exported |

Not run: any physical phone. Device acceptance is tracked in `mobile/DEVICE-RESULTS.md` on that branch and every row there is still pending.

### 2026-11-09 · `integration/biletflow-e2e` · `6cdacb4`

Baseline after PR #5 was merged, on PostgreSQL 16.15 with a libc `C.UTF-8` database.

| Step | Result |
| --- | --- |
| Backend unit tests | 300 passed |
| Backend e2e on PostgreSQL | 25 passed |
| Web typecheck, unit tests and build | passed, 47 unit tests |
| Browser suite with live authentication and tickets | 31 passed, 1 skipped |
