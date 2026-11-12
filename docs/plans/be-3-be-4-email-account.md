# BE-3 and BE-4: account emails, email verification, password reset and logout

Status: implemented and verified (2026-11-12); not yet in a PR. Owner: Temirlan. Consumer: FE-A3 (Alibi). Deadline: 2026-11-14.

## Scope

BE-3 sends email.
BE-4 adds email verification, password reset and server-side logout on top of it.

The task document was not in the repository, so the scope below is inferred from the request and the existing auth code.
Ticket and event notification emails are out of scope until the document asks for them.

## Decisions

- Email goes through stdlib `smtplib` when `SMTP_HOST` is set.
Without it, development and test print the message to the log, and production logs only that nothing was sent, so no link with a token leaves through logs.
- Sending runs in FastAPI `BackgroundTasks`, so a slow or failing SMTP server never fails or delays the request.
- Verification and reset links are signed JWTs with their own `type`, so no token table is needed.
Links point to `FRONTEND_URL` + `/verify-email?token=` and `/reset-password?token=`.
- `users.token_version` is embedded as `ver` in every token.
A password reset increments it, which signs out every session at once and makes the reset link single use.
Tokens issued before this change have no `ver` and count as version 0.
- Logout revokes only the presented refresh token (`revoked_tokens` table keyed by `jti`), so signing out of the web does not sign the same account out of the scanner.
The access token still works until it expires (30 minutes); the client discards it.
- Unverified accounts can still sign in and use the app; `email_verified` is exposed on `/auth/me` for FE-A3 to prompt.
- `forgot-password` and `resend-verification` answer 202 whether or not the address exists, so the API does not reveal which emails are registered.

## API

| Method & path | Access | Result |
|---|---|---|
| `POST /auth/register` | public | as before; also emails a verification link |
| `POST /auth/verify-email` `{token}` | public | `200` user; `400 INVALID_TOKEN` |
| `POST /auth/resend-verification` | logged in | `202`; no email when already verified |
| `POST /auth/forgot-password` `{email}` | public | `202` always |
| `POST /auth/reset-password` `{token, new_password}` | public | `204`; all sessions end; `400 INVALID_TOKEN` |
| `POST /auth/logout` `{refresh_token}` | public | `204`; that refresh token stops working |

## Steps

1. Settings, `app/email.py`, email templates.
2. Model and migration `0006`: `users.email_verified_at`, `users.token_version`, table `revoked_tokens`.
3. Token helpers and checks in `get_current_user` and `/auth/refresh`.
4. Endpoints and tests.
5. README API table, `.env.example`, compose variables.

## Merge note

This branch starts from `feature/admin-suspension-action-history` (migration `0005`).
`feature/srs-p2-checkout-orders` also adds a `0006`; whichever merges second renumbers its migration to `0007`.

## Verification

- `pytest` in `backend/` (SQLite).
- Migration upgrade, drift and downgrade test.
- Manual run against the API with the console email backend: register, open link, forgot, reset, old token rejected, logout, refresh rejected.

Results on 2026-11-12: 466 SQLite tests and 43 PostgreSQL 16 e2e tests passed; `0006` upgrades, downgrades and re-applies on PostgreSQL; the manual flow above behaved as specified.

## Known limits

- No rate limit on `forgot-password` and `resend-verification`.
- Refresh tokens are not rotated, so logout revokes only the latest refresh token of that session.
