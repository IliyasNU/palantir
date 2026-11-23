# BiletFlow Mobile

We built the mobile client around four entry points. **Attendee** opens the catalog, orders and tickets, including full-screen QR codes and ticket PDFs. **Organizer** provides event management, publication, ticket types and simulated sales activation. **Administrator** gives admins access to moderation and the action log. These three sections embed the BiletFlow web client. **Staff** gives check-in staff a native camera scanner, attendance totals, manual search and check-in reversal.

Sign in with an account authorized for the selected section. The server determines its permissions. The embedded web client and native scanner maintain separate sessions and must connect to the same running backend and database.

## Session behavior and verification status

The [device results](DEVICE-RESULTS.md) cover the staff client from [PR #26](https://github.com/IliyasNU/palantir/pull/26). Use the phone checklist below to verify the newer home screen and embedded web pages. Start the backend from the same integration checkout using the [root setup](../README.md) and [API contract](API.md).

At sign-in, the scanner confirms the account through `GET /auth/me`. The tokens and account ID remain in memory, so restarting the app requires a new sign-in. The default access-token lifetime is 30 minutes. While the app is in the foreground, it schedules renewal before expiry. Event loading and scanning can recover from a 401 using the refresh token. Attendance totals, search and undo also offer session recovery. Renewal must match the current account. A late response from an older session cannot clear a newer sign-in. An explicit refusal requires sign-in again, whereas a network failure leaves the session status uncertain.

Only a matching `CHECKED_IN` receipt confirms admission. After a lost response or server error, the scanner retains the QR payload and request ID in memory so staff can retry the original request. After a 401, it first renews the session and retries automatically. If the server refuses renewal, the retry prompts for the same staff account’s password. A 403 preserves the session. If the first attempt reports an unavailable event or denied access, return to the event list to reload it. If an earlier attempt remains unconfirmed, ask the organizer to verify the record before admitting the attendee.

The header switch “РУС · ҚАЗ · ENG” (Russian, Kazakh, English) defaults to Russian. The choice lasts for the current app session. A language change preserves the scan and its retry ID. Before sign-in, the connection button checks the live `/health` response, including database readiness. Returning from Settings triggers a new camera permission check. A camera failure offers a retry.

Our automated tests exercised the API and admission logic. Iliyas reported that a physical iPhone admitted a printed ticket and rejected its second scan. He subsequently confirmed the ticket-state and manual-search checks. These observations cover part of the device checklist. The database count was not independently observed. The [device results](DEVICE-RESULTS.md) identify the remaining checks.

## Attendance and manual admission

An attendee can claim a ticket and display its QR code in the integrated web client. Use the same backend and database for the web and mobile demo.

Use the integration backend with the attendance routes in [API.md](API.md) and the [W2 PostgreSQL locale setup](../backend/README.md#w2-postgresql-16-locale-and-acceptance). The scanner reports the number of checked-in attendees against the number of tickets issued and displays capacity separately. It refreshes on return and after a confirmed check-in or undo. Tap “Обновить посещаемость” (Refresh attendance) to read the totals again, for example after another phone admitted someone. The time of the last successful read is shown; if a refresh fails, the last totals stay with a note that they are outdated.

Open “Найти вручную” (Search manually) to search by name or email using at least three characters. Each match shows a masked email. A fresh ticket can be marked through the same check-in and retry flow as a camera scan. An admitted ticket shows its check-in time. A cancelled or refunded ticket shows its state and cannot be marked. Basic manual admission has user-reported iPhone coverage; the broader language, camera-permission and cross-device attendance checks remain in the device checklist.

## Cancelled and refunded tickets, undo

Use the backend in the same integration checkout and apply `alembic upgrade head` before testing. Ticket states and undo were introduced in migration `0003`. The server PDF route and web download action are also present.

- A cancelled ticket and a refunded ticket each get their own rejection message, different from the message for a cancelled event. Neither can be admitted. For a free ticket, “Refunded” is an admission state set by the organizer. Changing it involves no payment.
- The organizer of the event, or an admin, sees “Отменить вход” (Undo check-in) on an admitted search result and on a fresh confirmation. It asks for confirmation, then removes the admission. The ticket can be scanned again afterwards. Assigned staff do not see the action, and the server refuses it for them.
- If the undo response is lost, the scanner lists the undo as unconfirmed and “Повторить отмену” (Retry undo) repeats the same request, so the entry is reversed once. The request is kept for the whole app session: if the retry needs a new sign-in, the same account finds it again on the event list and in the scanner and repeats it under the new token. Another account never sees or sends it.
- If an earlier scan result was unknown and the retry reports a cancelled ticket, a refunded ticket or an undone check-in, the app treats the attempt as settled and not admitted. Other rejections still leave it unconfirmed.

## Run on a phone

Use Node.js 22.18+ or 24 LTS and npm. The project uses Expo SDK 58.

1. Start the API as described in the [root setup](../README.md#2-запустить-postgresql-и-api). For a phone on the same Wi-Fi, bind the API to the LAN, and add the exact web origin (for example, `http://192.168.1.100:5173`) to the API's `CORS_ORIGINS`. Retain existing origins needed by other clients.
2. From `web/`, set `VITE_API_URL` in `.env.local` to the phone-reachable API URL. Run `npm ci` and `npm run dev -- --host 0.0.0.0`. Open that web address in the phone's browser once to verify it is reachable.
3. Set both addresses in `mobile/.env`. For example, `EXPO_PUBLIC_WEB_URL=http://192.168.1.100:5173` and `EXPO_PUBLIC_API_URL=http://192.168.1.100:8000`. Substitute your actual LAN IP. When using a published web app, set `EXPO_PUBLIC_WEB_URL` to its root HTTPS origin. The release build requires HTTPS for the web origin.

```bash
cd mobile
npm ci
cp .env.example .env
# Edit .env before starting Expo.
npm start
```

Set `EXPO_PUBLIC_API_URL` to the team's shared HTTPS backend address. For local development, use the computer's actual Wi-Fi address, for example `http://192.168.1.100:8000`. The example address is a placeholder, not a running server. The phone and computer need to be on the same network; the backend must listen on `0.0.0.0` and its port must be reachable. Do not use `localhost`: on the phone that refers to the phone itself. An Expo tunnel does not also expose the backend.

Keep the API port in the address: with the default setup, omitting `:8000` sends requests to the wrong port even on the same Wi-Fi. Before signing in, open `http://<computer-LAN-IP>:8000/health` in the phone's browser and check for `status: ok` and `database: up`. If it is unreachable, check the running backend, IP address and firewall, then restart Expo after correcting `.env`.

Open the Expo QR with Expo Go that supports SDK 58. Restart Expo after changing `.env`. In **Organizer**, publish a test event. Assign a test staff account through `POST /events/{event_id}/staff`. On the first phone, use **Attendee** to claim a ticket, open its full-screen QR, and confirm that the PDF opens the native share sheet. On the second phone, use **Staff** to sign in, grant camera access, open the event, and scan the first phone's QR twice. Confirm one admission and one duplicate refusal. Use **Administrator** with a test admin account to check the moderation screen, and with an attendee account to check that access is denied.

Use HTTPS for the shared web and API servers. `EXPO_PUBLIC_*` values are included in the app, so put only service addresses there. The QR scanner does not store scanned QR payloads on disk. The PDF button writes the print-ready file to the app cache for the system share sheet.

## Check the code

```bash
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo export --platform android --output-dir dist/android
npx expo export --platform ios --output-dir dist/ios
```

The tests cover API requests, health response validation, errors, invalid receipts, repeated camera callbacks, retry IDs, account matching, session renewal, ticket states, undo retries, localized error handling and the same text keys in all three languages. Export checks the Android and iOS JavaScript bundles; it does not produce an installable app. Use the checklist below for camera and device behavior.

## Run the client against a real API

`tests/live/staff-flow.live.ts` drives the app's own API client, scanner and undo logic over HTTP: staff access, search with Kazakh letter case, camera and manual admission, duplicates, a response lost after the commit, cancelled and refunded tickets, and undo including a lost response followed by a new sign-in. With `LIVE_PSQL_URL` it also compares the result with the `check_ins` and `tickets` rows. It also renews a session with the real refresh token. It registers accounts and events, so use a disposable test database with migration `0003` or later.

```bash
LIVE_API_URL=http://127.0.0.1:8000 \
LIVE_PSQL_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/biletflow_test \
LIVE_CONFIRM_TEST_DATABASE=1 \
node --experimental-strip-types tests/live/staff-flow.live.ts
```

It does not exercise the screens, the camera or a phone. Those are in the checklist below.

## Phone and integration acceptance criteria

Use the [short device run](DEVICE-QUICK-RUN.md) at the phone: it lists the steps in order and `tests/live/seed-device-run.ts` prepares its accounts, tickets and PDFs. [Device acceptance](DEVICE-ACCEPTANCE.md) explains each check, including web and printed QR, Android, and camera-to-result timing. Record device results separately from JS exports and HTTP checks.

Run this with the backend team on a test database. Record the device, backend commit, date and actual results.

1. Set the API address and tap “Проверить соединение” (Check connection) / “Байланысты тексеру” (Check connection). A healthy API and database should be reported. Stop the server and verify it reports a failure. Sign in and also try a wrong password.
2. Assign the account to one event. Verify only permitted events are listed. An unassigned account should see an empty list.
3. Allow the camera, then separately test denying access, enabling it in Settings and returning to the app. Verify the preview returns. If camera startup fails, use the camera retry button.
4. Open a real ticket QR issued by the API. Use the attendee web page for the final demo. Select the correct event and scan it. Check for `CHECKED_IN` and one backend check-in record.
5. Leave the QR in front of the camera: only one request should be sent. Tap “Следующий билет” (Next ticket) / “Келесі билет” (Next ticket) and scan it again: expect an already-used-ticket rejection (`ALREADY_CHECKED_IN`).
6. Try another event's ticket and an unrelated QR: expect `INVALID_TICKET`. Revoke the staff assignment: check-in must be denied.
7. Disable Wi-Fi/mobile data and scan. It must not show green. Switch RU/KZ and verify the message changes while the displayed request ID stays the same. Reconnect and retry. Also simulate a lost response after the backend committed, then retry and verify only one record exists.
8. Expire the access token during an unconfirmed scan: a valid refresh token should renew the session and retry with the same request ID. Separately make refresh unavailable for authentication (not merely offline) to reach the password form: another account must be rejected without sending a retry, while the original account can authenticate and retry. Check that the camera pauses when the app is backgrounded, and test Back and sign-out.
9. Open “Найти вручную” (Search manually) while the camera sees a test QR. The preview pauses and only an intentional tap on “Отметить вход” (Check in) admits a search result. Switch back and verify the camera resumes. Search by name and email, compare masked addresses and check-in times, and confirm an admitted result has no action. Repeat after denying camera access.
10. Compare the attendance totals with the API before entry and after a confirmed manual or camera check-in. After “Следующий билет” (Next ticket), the same search should show the updated check-in time. A duplicate or a successful replay must not add an entry. Return to the scanner and confirm it fetches current totals.
11. Admit an attendee on a second phone, then tap “Обновить посещаемость” (Refresh attendance) on the first. The total and its time change. Turn the network off and tap it again: the last total stays, marked as outdated.
12. Scan a cancelled ticket and a refunded ticket. Each shows its own message in RU and KZ and neither admits. Search shows both states without an admission action.
13. Sign in as the organizer, find an admitted attendee and tap “Отменить вход” (Undo check-in). Cancel the dialog first, then confirm. The attendee becomes unadmitted and the total drops. Scan the ticket again: it is admitted again. As assigned staff the action is not shown.
14. Session renewal (not yet run on a phone). Start the test API with `ACCESS_TOKEN_EXPIRE_MINUTES=3`, sign in and keep the scanner open for five minutes: totals, search and a scan keep working without a password prompt. Then put the app in the background for five minutes, return and scan: the ticket is admitted once, with no sign-in form. Finally disable the account on the server (or wait out the refresh token) and scan: the sign-in form appears and nobody is admitted.
15. English (not yet run on a phone). Switch from “РУС” (Russian) to “ҚАЗ” (Kazakh) to “ENG” (English) on each screen: titles, buttons, results and dates change, the three options fit in the header beside the title on a small phone, and a displayed request ID stays the same.

If replay cannot confirm the result, give the displayed request ID to the organizer. Once the organizer has checked the record, choose “Выйти после сверки с организатором” (Exit after verification with the organizer) and confirm to return to the event list. Cancelling the dialog keeps the request on screen. The app does not show admission success from this action.

The operating system can terminate the app, which discards a pending retry ID. Do not admit the attendee after an unconfirmed result; ask the organizer to verify it on the server as described in [device acceptance](DEVICE-ACCEPTANCE.md#how-the-organizer-verifies-the-record). Do not rescan the ticket to find out: if the lost request did not commit, the rescan admits the attendee. There is no offline queue or recovery after restart in this version.

## Code map

- `src/app/`: the Expo Router screens and layout, including the three native staff screens.
- `src/api.ts`: HTTP requests and response checks.
- `src/attendance.tsx`: event totals, manual attendee search and the undo action.
- `src/loading.ts`: state of a reloadable value (totals with the last good read).
- `src/scanner.ts`: scan lock and retry ID.
- `src/undo.ts`: undo requests kept per account, event and check-in until the server answers.
- `src/session.tsx`: the current account, its tokens and the renewal timer.
- `src/renewal.ts`: when to renew an access token and one shared renewal request per session.
- `src/language.tsx` and `src/messages.ts`: language choice and Russian/Kazakh/English screen text.
- `tests/`: small API and scanner tests.
- `tests/live/`: a run of the same client against a real API and database (see the live API procedure above).

We started from the official blank TypeScript template. Camera and UUID APIs follow the [Expo Camera](https://docs.expo.dev/versions/v58.0.0/sdk/camera/) and [Expo Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/) documentation. `LICENSE` covers the supplied Expo template.
