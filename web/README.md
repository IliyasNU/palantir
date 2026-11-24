# BiletFlow Web

We built the web client with React, TypeScript, Vite, React Router in declarative mode, and plain CSS. FE01 introduced registration and sign-in. FE02 added a public catalog with title search. Alibi’s part of FE03 covered loading and displaying an event. The source, dependencies and build output are under `web/`.

The [root README](../README.md) describes the compatible backend, isolated PostgreSQL test database, phone and production configuration, and verification status.

## Local setup

Use the `integration/biletflow-e2e` integration branch. Follow the [root README](../README.md) to start PostgreSQL, apply migrations and run the API. The web client requires Node.js 22.17+ in the 22 series or Node.js 24+, and npm 10+.

```powershell
cd web
if (-not (Test-Path -LiteralPath .env.local)) { Copy-Item .env.example .env.local }
npm ci
npm run dev
```

Open `http://localhost:5173`. Set `VITE_API_URL` to the full HTTP(S) base URL of the API, without an endpoint such as `/auth/register` or `/events`. Use `http://127.0.0.1:8000` for an API on this computer. Restart Vite after changing the environment. A production build rejects a missing or invalid URL. For an HTTPS site, use a reachable HTTPS API and include the exact site origin in `CORS_ORIGINS`.

Vite reads settings in descending order of precedence from process variables, `.env.[mode].local`, `.env.[mode]`, `.env.local` and `.env`. The browser can read `VITE_*` values.

## Routes and access

| Path | Behavior |
| --- | --- |
| `/` | Redirects to `/events` and replaces the current history entry |
| `/events` | Public catalog with local title search |
| `/events/:id` | Loads an event by ID and shows its description, date, venue, status and availability |
| `/login` | Signs in with email and password, then requests `/auth/me` |
| `/register` | Registers an attendee (`attendee`, default) or organizer (`organizer`), then opens sign-in |
| `/forgot-password` | Requests a reset link without disclosing whether the email is registered |
| `/reset-password?token=…` | Sets and confirms a new password through the emailed link |
| `/verify-email?token=…` | Verifies an email address through the emailed link |
| `/tickets` | Lists the signed-in attendee’s tickets |
| `/tickets/:id` | Shows an owned ticket and, if valid, its QR code with a full-screen option |
| `/events/:id/checkout?type=…` | Simulated checkout for a paid ticket type (P2) |
| `/orders`, `/orders/:id` | Lists the buyer’s simulated orders or opens one order (P2) |
| `/organizer` | Lists the organizer’s own events |
| `/organizer/events/new`, `/organizer/events/:id/edit` | Creates, edits, publishes and cancels events |
| `/organizer/events/:id/history` | Shows tickets, orders (including refunded orders), admissions and the activity log for completed and cancelled events |
| `/organizer/events/:id/ticket-types` | Manages ticket types for the event |
| `/organizer/events/:id/activation` | Activates simulated paid sales (P2) |
| `/admin`, `/admin/users`, `/admin/events`, `/admin/action-log` | Admin moderation. Other signed-in users see a 403 screen |
| Any unknown path | Displays a 404 page with a link to the catalog |

Pages share a responsive layout, navigation with active links, and a skip link. Guests can open the catalog and event pages. The application uses real authentication and requires sign-in after registration.

## FE02 public catalog

`EventsPage.tsx` calls `api.request('/events', { signal })` without a bearer token. At commit `26d0dbd5`, the response was an unwrapped `EventRead[]` array without server-side search or pagination. The client retains the server’s order of published events by date and ID.

Each card links the title to `/events/:id` and shows the venue and date. `Intl.DateTimeFormat` renders the server timestamp in the browser’s local time zone, which may differ from UTC or Kazakhstan time.

Title search applies `query.trim().toLowerCase()` to the loaded list. It sends no `q` or other query parameters. The catalog supports clearing a search and distinguishes loading, an empty catalog, no matches and errors. Network failures, HTTP errors and malformed responses offer “Повторить” (Retry). Leaving the page cancels the request.

The search field remains available during loading, after an error and when the catalog is empty. “Повторить” (Retry) preserves the query. HTTP 405 indicates that the server does not support the catalog request. Retrying it as a POST would create an event.

Only the tests intercept HTTP and supply fixtures from `tests/browser/catalog.spec.mjs`. The application has no mock mode or fallback catalog.

```powershell
npm test
npm run test:browser -- catalog.spec.mjs
npm run build
```

Browser tests cover anonymous requests without query parameters, search, list states, error recovery, event navigation and a 375 px viewport. The time-zone test uses `America/New_York`, including a timestamp that falls on the previous local calendar date relative to UTC.

On 4 November 2026, 29 unit tests and 6 catalog browser scenarios passed. The API was unavailable. After the search fix, 35 unit tests and 23 browser scenarios passed, and one opt-in live scenario was skipped. Event tests used HTTP fixtures. A later run against a separate, up-to-date backend confirmed that `GET /events` returned `200 []` and that Edge displayed an empty catalog at 375 px.

## FE03 event details

`EventDetailsPage.tsx` requests `GET /events/{id}`. At backend commit `26d0dbd5`, a positive integer ID identified one `EventRead` object with fields `id`, `organizer_id`, `title`, `description` (string or `null`), `date`, `location`, `capacity`, `status`, `tickets_issued`, `created_at` and `updated_at`. Guests could read `published` and `cancelled` events. Only the owner or an admin could read a `draft`. Other callers received 404.

Guests use `api.request()`. Signed-in users use `useAuth().request()` so owners retain access to drafts and all authenticated requests share 401/403 handling. A change of ID or user clears the page data. `AbortController` cancels the previous request, and a signal check prevents late responses from replacing the current event even if the transport ignores cancellation. Direct navigation and reload fetch the event again. Production hosting needs an SPA fallback to `index.html`.

The page shows the title, description, browser-local time, venue, status and remaining seats, calculated as `Math.max(0, capacity - tickets_issued)`. Counters must be safe integers with `capacity > 0` and `tickets_issued >= 0`. Invalid or missing values show “Доступность неизвестна” (Availability unknown). The client does not coerce strings to numbers. The page distinguishes loading, 404, retryable errors, cancellation and sold-out events. The guest sign-in link uses `safeReturnTo` and `authLink` to retain the event through sign-in, registration and return to sign-in.

### Tickets and QR codes

`src/events/EventActions.tsx` supplies the ticket controls on the event page. `POST /events/{id}/tickets` issues a ticket (`201`) or returns an existing one (`200`). Attendees can open their tickets from the event or “Мои билеты” (My tickets). The list uses `GET /tickets/me`, and details use `GET /tickets/{id}`. Another attendee’s ticket returns `404`. After event cancellation or check-in, the owner can still read the metadata, but the QR code is hidden.

Migration `0003` introduced ticket `status` values `active`, `cancelled` and `refunded`. The client treats a missing field on an older backend as active. Cancelled and refunded tickets display their state and hide the QR code and actions. The ticket state is independent of event cancellation. The holder can confirm “Отменить билет” (Cancel ticket) to call `POST /tickets/{id}/cancel`. Cancellation is final and releases a seat. For a free ticket, the organizer can set “Возвращён” (Refunded) through the API. This changes admission status without a payment.

“Скачать билет в PDF” (Download the ticket as PDF) requests `GET /tickets/{id}/pdf` with the session token and saves `biletflow-ticket-{id}.pdf`. The server uses the same `qr_payload` as the screen, so the printed and displayed copies allow one admission between them. The PDF is unavailable for a cancelled or refunded ticket or a cancelled event.

The client generates the QR code locally from the exact `qr_payload` returned by the API. Signing out clears the session and QR code. The server checks permissions and ticket status again at check-in.

Run the FE03 checks from the web directory.

```powershell
npm test
npm run test:browser -- event-details.spec.mjs
npm run build
```

Browser tests use HTTP interception to cover direct navigation and reload, loading and fields, 404, retries after network and HTTP errors, unknown availability, cancelled and sold-out events, late responses for a previous ID, return through account forms, 401/403 handling and a 375 px viewport. A component in `tests/browser/fixtures/` tests the accessibility of the event action area. It is excluded from the application.

On 4 November 2026, `npm test` passed 35 tests. The browser run passed 22 scenarios, including 12 for FE03, and skipped one live scenario. The TypeScript build passed. Event details and states used fixtures. Live checks had confirmed health, FE01 registration and sign-in, and an empty catalog. At that stage, live event details and the draft → published → cancelled lifecycle still awaited testing, so the run covered only part of FE02–FE04. Tickets were added later on the integration branch.

## FE01 sessions and forms

Registration sends `POST /auth/register` with `{ email, full_name, password, role }`. The form offers `attendee` (default) and `organizer`. Admin accounts are created on the server. On success (`201` and a user), the client opens sign-in with “Аккаунт создан…” (Account created…). A new organizer signs in and lands on `/organizer` unless the form has another validated `returnTo`. The menu shows “Мои события” (My events).

Sign-in sends `POST /auth/login` with `{ email, password }`, then requests `GET /auth/me` with the access token. Both requests must succeed and the account must be active before a session begins.

The web client keeps the access token and user in memory. Reloading the page or opening a new tab requires sign-in. The session uses neither `localStorage`, `sessionStorage` nor cookies. The client retains the `refresh_token` in memory for explicit sign-out and does not renew the session automatically.

A single `AuthProvider` in `main.tsx` connects to `src/auth/store.ts`. Components use `useAuth()` for the user and session methods. They have no direct access to the token.

“Выйти” (Sign out) submits the refresh token to `POST /auth/logout`, clears the local session and cancels pending session requests even if the server is unavailable. A late response cannot restore a closed session or clear a newer one.

Protected requests use `useAuth().request()`. A `401` clears the session and prompts for sign-in. A `403` reports insufficient permission and retains the session. Public requests use `api.request()`.

The `returnTo` parameter retains a destination through sign-in, registration, password recovery and return to sign-in, including after successful registration. `src/auth/returnTo.ts` lists accepted event, checkout, ticket, order and organizer routes with positive numeric IDs where required. External and protocol-relative URLs, backslashes, unapproved query strings or fragments, and unknown routes fall back to `/events`.

While submitting, the form disables its fields and button. A synchronous guard prevents a second request before React renders. Leaving the page cancels the request. The password field clears after each attempt.

Forms report invalid credentials, an email already in use, insufficient permissions, network failures and FastAPI 422 responses with field names. Validation checks required fields, name length and the 72-byte UTF-8 password limit. Passwords and tokens are excluded from logs.

## Ticket types (P1)

The event page shows the price and remaining quantity of each available ticket type. Attendees select a free type before claiming a ticket. At the P1 milestone, paid types were visible and sales were deferred to the next phase. The issued ticket displays its type name. Availability updates when a sales window opens or closes, without a page reload. The claim button checks the time before submitting, and the API is the source of truth for availability. The name length and display line limits come from `backend/app/assets/ticket-type-name.json`.

Event owners and admins manage ticket types at `/organizer/events/{id}/ticket-types`. The P1 event page linked to this route, and the integration branch also links to it from the organizer’s event actions. The first ticket type receives the entire capacity. Reduce its allocation before assigning seats to another type. Hidden types remain on issued tickets and count toward capacity. The log at the bottom of the page shows changes recorded by the server.

## API client

`src/api/index.ts` exports the shared public `api` instance, `ApiError` and `getErrorMessage`. The fetch-based JSON client in `src/api/client.ts` is independent of React. A React component can obtain an authenticated request function as follows.

```ts
import { useAuth } from './auth/AuthProvider';
import type { User } from './auth/types';

function useCurrentUserRequest() {
  const { request } = useAuth();
  return (signal?: AbortSignal) => request<User>('/auth/me', { signal });
}
// Call the returned function from a handler or effect with an AbortController.
// Use getErrorMessage(error) to display errors in the UI.
// Suppress AbortError when navigating away or signing out.
```

Pass a JSON body as an object, for example `request('/some-endpoint', { method: 'POST', body: payload })`. GET is the default method. The client accepts custom headers and an `AbortSignal`. The authenticated wrapper `auth.request` adds the bearer token and handles 401/403. The public client has no session state. Use `request<void>(...)` for a response without a body.

The client distinguishes six failure modes.

- `network` indicates that the connection failed or was interrupted while reading the response. No HTTP status is available.
- `timeout` indicates that the server did not respond within 15 seconds. The form becomes available for a retry.
- `http` exposes the unsuccessful status in `error.status`. The client retains a FastAPI string `detail` and supplies a general message for server errors or non-JSON responses.
- `validation` represents HTTP 422. The client builds `issues` entries of the form `{ field, message }` from `detail[].loc` and `detail[].msg`. It joins field messages and avoids rendering unknown objects as `[object Object]`. It omits `input` and `ctx`.
- `response` indicates a successful HTTP response containing invalid JSON.
- `configuration` indicates a missing or invalid URL or a body that cannot be serialized as JSON.

Cancellation propagates to the caller. TypeScript’s `T` describes the expected response at compile time. Runtime schema validation requires a separate check.

Under the backend contract, `POST /auth/register` accepts `email`, `full_name`, `password` and optional `role` (`attendee` or `organizer`) and returns a user. `POST /auth/login` accepts `email` and `password` and returns a token pair. `GET /auth/me` requires an access token. The registration password must contain at least 8 characters and fit in 72 UTF-8 bytes. OpenAPI only partly expresses the byte limit enforced by the validator.

## Verification and production build

Run these commands from `web/`.

```powershell
npm run typecheck
npm test
npm run build
```

The `build` script checks TypeScript and writes to `web/dist/`. Unit tests use `node:test` and Node’s TypeScript type stripping. Node 22.17 emits an experimental strip-types warning. `npm test` replaces `fetch` and runs without network or database writes. It covers API errors, session transitions, 401/403 responses, logout, cancellation, races between sessions, safe return paths and UTF-8 validation.

### HTTP checks

Confirm that Compose points to your local database before running the authentication check.

```powershell
npm run check:auth
```

The script contacts only `http://localhost:8000`. It checks health, attendee registration, sign-in, `/auth/me`, an incorrect password and a duplicate email. Each run creates one local test attendee and retains all records and volumes. Use a dedicated local database behind this address. Output consists of routes, HTTP statuses and the test user ID.

### Browser checks

Playwright uses installed Microsoft Edge in headless mode. For Chrome, set `PLAYWRIGHT_CHANNEL=chrome`. For `chromium`, install the corresponding Playwright browser first. The development server uses `localhost:5173` and a local API. Playwright can reuse a running server, so check its configuration.

The HTTP fixtures target `http://localhost:8000`. If a frontend on port 5173 uses another API, stop that development server before testing. Playwright then starts its own server with the required `VITE_API_URL`. The working backend and local environment file can retain their settings.

```powershell
npm run test:browser
```

The default browser suite uses HTTP fixtures without preparing database records. For live tests, follow the [isolation procedure](LIVE-TESTS.md). Before the first POST, the runner verifies the Docker containers, volume, FastAPI database connection and browser API origin. The shell’s `DATABASE_URL` alone cannot establish which database serves the request.

For a dedicated local project, substitute the verified API address, Compose project and backend SHA in these commands.

```sh
node scripts/run-live.mjs --api http://localhost:8002 --project biletflow-667-live --backend-ref c5b83a851128c486b1b15cebea94c6df8166308d --mode dev --channel msedge
node scripts/run-live.mjs --api http://localhost:8002 --project biletflow-667-live --backend-ref c5b83a851128c486b1b15cebea94c6df8166308d --mode production --channel msedge
```

Production live tests build a fresh dist for the selected API. Port 8002 was specific to Alibi’s environment. Each live run creates 5 test accounts, 2 events and 2 tickets and retains existing data.

To test the stale-dist regression, use two local HTTP origins. This check requires no database.

```sh
npx playwright test --config playwright.isolation.config.mjs
```

Each live run writes separately to the Git-ignored `test-results/live/` directory. Run `npm run test:browser -- --output test-results/mock-regression` with `RUN_LIVE_*` flags disabled to preserve live artifacts during an ordinary regression run.

The [7 November acceptance record](667-acceptance.md) and [8 November review](667-review-2026-11-08.md) document separate runs. [LIVE-TESTS.md](LIVE-TESTS.md) describes CI, phone and hosting limitations, rules for publishing evidence safely, and integration with W1.


### FE01 verification on 28 October 2026

TypeScript and the production build passed. All 26 unit tests passed. Mock HTTP responses exercised protected requests returning 401/403 and logout races without waiting for a real token to expire.

Five browser scenarios passed in headless Edge. Real forms exercised registration, sign-in, `/auth/me`, incorrect passwords, duplicate email addresses, logout and reload against local FastAPI. HTTP fixtures covered network errors, 422 and unsafe `returnTo` values. The mobile viewport was 375 px wide.

A separate HTTP run returned 200 for `/health`, 201 for registration, 200 for sign-in and `/auth/me`, 401 for an incorrect password and 409 for a duplicate email. Only `/health` was exclusive to the HTTP run. The HTTP and browser runs each created one attendee in the local Compose PostgreSQL database. Neither used an external database.

For a local production preview, stop the development server and run `npm run preview`. It uses the same `localhost:5173` address and `strictPort`. When deploying, configure the host to return `index.html` for client routes such as `/events/123` because the application uses `BrowserRouter`.

For a manual check, open `/events/123`, follow the sign-in and registration links, create an account and sign in. Verify that the form returns to `/events/123`. Select “Выйти” (Sign out), sign in again and reload. The session should end. Guests can still access the catalog and event page.

## Integration branch verification

The [integration audit](../docs/integration-audit.md) records live browser checks for authentication, tickets and API recovery.

## Promo codes and campaign QR codes (P3)

At `/organizer/events/{id}/campaigns`, the owner or an admin creates a discount, selects eligible ticket types and sets its validity period and usage limit. The same page shows revenue and usage, allows the campaign to be disabled, and provides an SVG marked “Это не билет” (This is not a ticket). Ticket type management links to this page.

A campaign QR opens the event and preserves the campaign through sign-in. Attendees can also enter the code manually at paid checkout. Before reservation, the server confirms the code, discount and total. If the quota expires between preview and order creation, the server refuses the order and the attendee can remove the code. For scanning from a phone, set the API’s `CAMPAIGN_WEB_ORIGIN` to the reachable HTTPS origin of the site.

## Account, organizer, administration and languages

The header offers Russian, Kazakh and English. The browser stores the language choice in `localStorage`. Session tokens remain in memory, so a full reload requires signing in again. The browser, API and mobile app must use the same backend and database. An account registered as an attendee has no organizer role. The organizer pages read the role returned by `GET /auth/me`.

Account routes are `/forgot-password`, `/reset-password?token=...` and `/verify-email?token=...`. Recovery preserves a validated destination through the login link. A reset requires matching passwords. Each link has its own state, and a new link clears an earlier success or refusal; a request still pending for an earlier link is cancelled.

Forgot-password never shows whether an email exists (`forgotPasswordOutcome` in `src/account/model.ts`):

| Answer | Page shows |
| --- | --- |
| `2xx`, and any other refusal that could depend on the account (`400`, `401`, `403`, `409`, …) | The same neutral "if this email is registered, we sent a link" text |
| `5xx`, `404` (for example, a backend predating PR #21 lacks the endpoint), no connection, timeout | The same retryable technical failure for every address |
| `429` | "Too many requests, try a little later" (the API limits per address, registered or not) |
| `422` | "Check the email address": about the format typed, never about an account |

The verification banner disables “send again” for one minute after each attempt. The backend independently enforces the limit introduced in PR #21. The banner displays a rate-limit message when it receives `429`.

The backend added the account endpoints and `POST /auth/logout` in PR #21. The web account milestone deferred server logout until after that integration. In v1.0, “Sign out” clears the token, user and notices from memory and cancels session requests. In v1.1 browser tests cover both successful server logout and local sign-out after a failed request. Account browser tests use HTTP fixtures. At that milestone, live validation of email links and server logout was still pending.

A signed-in user without the admin role sees “403 — access denied” at `/admin/...`. We used 403 rather than the generic 404 page because the route names are already public in the client bundle. The API also checks the role and returns 403 for unauthorized admin requests.

Organizers open `/organizer`, `/organizer/events/new` and `/organizer/events/{id}/edit`. Admins open `/admin/users`, `/admin/events` and `/admin/action-log`. The server checks roles and event ownership on every request. The web refuses non-admin navigation locally, and signed-out admin navigation returns through the public catalog. Mutation controls require confirmation. Administrator accounts have no suspension controls in the UI, and the activity log is read only.

The language switch covers these pages, the public event and ticket flow, dates and API errors. Errors and notices already on screen follow a switch without a new request: pages keep the error itself (or a notice key) and translate it while rendering, and `ApiError` carries a `Localized` text instead of a fixed string. Server wording (FastAPI `detail`, `422` issues) is English and is replaced by translated texts. Prices use the selected locale and omit decimals for whole tenge. Kazakh dates and numbers are written out by `src/i18n/format.ts`, so a browser without Kazakh ICU data (Edge printed "2030 M11 15") still shows “15 қараша 2030, 17:00” (15 November 2030, 17:00). At the language-switch milestone, ticket type management and the P2 checkout, order and activation text awaited a separate translation pass. Kazakh text needs native review before the defense.

## Accessibility

`tests/browser/accessibility.spec.mjs` uses axe-core (`@axe-core/playwright` 4.14.0, a development dependency) to check WCAG 2.1/2.2 A and AA rules at widths of 375 and 1280 px. It covers the catalog, event details, sign-in, registration, password pages, 404, My tickets, ticket details and the full-screen QR, the organizer dashboard and editor, and the three admin sections. It checks the catalog and registration in all three languages. A violation fails the suite. Separate keyboard checks cover the skip link, visible focus, and dialogs that initially focus the safe response and restore focus on close. The full-screen QR uses a native modal dialog that traps focus, closes on Esc and returns focus to its button.

The language switch uses “Қазақша” (Kazakh), “Русский” (Russian) and “English” as its visible labels and accessible names (WCAG 2.5.3). Assessing the Kazakh wording requires a native speaker.

## Organizer analytics (P6)

“Аналитика” (Analytics) links the organizer dashboard and event page to `/organizer/events/{id}/analytics`. Filters accept UTC dates and a ticket type. The summary shows capacity, available seats, valid tickets, financial totals and attendance. SVG charts and tables show sales by day and ticket type. A separate table shows redemptions, tickets and net revenue by campaign.

## Refunds and free registrations (P5)

Organizers set the refund policy when creating or editing an event. Attendees see it on the event page and at checkout.

“Заказы и возвраты” (Orders and refunds) opens `/organizer/events/{id}/orders` from the organizer dashboard. The organizer can cancel a free registration or confirm a full simulated refund of a paid order. A cancelled event supports bulk refunds. If the attendee has checked in, the organizer must undo the check-in first. Free registrations appear in My orders as zero-value receipts. Organizers cancel their tickets from the free registrations list. “Мои заказы” (My orders) shows the attendee the refund amount and date. The activation summary updates the refund total and estimated payout.

## P2 demo checkout

Paid types on activated events lead from `/events/:id` to `/events/:id/checkout?type=:typeId`,
then `/orders/:id`. `/orders` lists the authenticated buyer's orders. The server computes
prices and fees; the browser never adds a surcharge. Every payment screen says
“Демонстрационная оплата, деньги не списываются” (Simulated payment, no money is charged). Success and failure buttons call the
simulated provider endpoint. Retries reuse the order or creation request UUID. A definitive
422 allows correcting the form; uncertain delivery preserves the original request payload.

Organizers use `/organizer/events/:id/activation`, linked from ticket type management, for
the demo checklist and sales summary. Profile identity/payout confirmations apply to their
own profile. The payout form accepts only a four-character demo suffix, never real account
details. Admins can suspend/restore paid sales from this page. Financial refunds belong to P5.

P2 uses the existing authenticated API client, strict response readers and plain CSS classes.
It adds no dependencies. `npm test` covers contract readers, amount invariants, safe return
URLs and availability. `tests/browser/orders.spec.mjs` covers success/failure checkout and
activation with HTTP fixtures; run it as part of `npm run test:browser`.
