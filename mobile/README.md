# BiletFlow Staff

Iliyas's part of Team Palantir's project. Three screens: sign in, choose an event, scan a ticket. The scan screen also holds the attendance totals, manual search and the undo action. This is a small Expo + TypeScript client, with no offline admission or payment features.

## Current status

- Start the backend in the same integration checkout. Follow the [root setup](../README.md) and [API contract](API.md).
- Sign-in confirms the staff account through `GET /auth/me`. The tokens and account ID stay in memory. After restarting the app, sign in again.
- The access token lasts 30 minutes on the server. The app renews it with the refresh token about two minutes before it expires while the app is in front, and again after any 401, so a shift is not interrupted by a password prompt. A renewal is accepted only for the same account. The password is asked again only when the server refuses the refresh token (after 7 days, or for a disabled account).
- Only a matching `CHECKED_IN` receipt confirms admission. A lost response or a server error leaves the scan unconfirmed and keeps its QR and request ID in memory for a retry. After a 401 the app first renews the session and repeats the same request by itself; if that is refused, the retry asks for the password of the same staff account.
- A 403 preserves the session. If the event is unavailable or access is denied on the first attempt, return to the event list to reload it. If an earlier attempt is still unconfirmed, ask the organizer to verify it before admitting the attendee.
- The interface supports Russian, Kazakh and English through the header switch (РУС · ҚАЗ · ENG). Russian is the default; the choice lasts for the current app session. Switching language leaves the scan and its retry ID intact.
- Before signing in, use the connection button to check the real `/health` response, including database readiness. Camera permission is checked again when the app returns from Settings; a camera failure offers a retry.
- The browser ticket QR and PostgreSQL check-in API passed separate integration checks. On a physical iPhone with Expo Go SDK 58, a staff account signed in, selected its assigned event and scanned a QR generated from a real API ticket. A second scan was rejected and PostgreSQL held one check-in. The web-to-phone QR flow and extended device checks are in the [manual acceptance checklist](../docs/manual-acceptance.md).

## Attendance and manual admission

The visitor can claim a ticket and display its QR on the integrated web client. Use the same backend and database for the web and mobile demo.

Use the integration backend with the attendance routes in [API.md](API.md) and the [W2 PostgreSQL locale setup](../backend/README.md#w2-postgresql-16-locale-and-acceptance). The scanner shows checked-in visitors out of issued tickets and displays capacity separately. It refreshes on return and after a confirmed check-in or undo. Tap “Обновить посещаемость” to read the totals again, for example after another phone admitted someone. The time of the last successful read is shown; if a refresh fails, the last totals stay with a note that they are outdated.

Open “Найти вручную” to search by name or email using at least three characters. Each match shows a masked email. A fresh ticket can be marked through the same check-in and retry flow as a camera scan. An admitted ticket shows its check-in time. A cancelled or refunded ticket shows its state and cannot be marked. The new attendance and search screens still need the physical-phone checks below.

## Cancelled and refunded tickets, undo

These need the backend from [PR #10](https://github.com/IliyasNU/palantir/pull/10). Without it the app works as before and offers no undo.

- A cancelled ticket and a refunded ticket each get their own rejection message, different from the message for a cancelled event. Neither can be admitted. “Refunded” is an admission state set by the organizer; tickets are free and no payment is involved.
- The organizer of the event, or an admin, sees “Отменить вход” on an admitted search result and on a fresh confirmation. It asks for confirmation, then removes the admission. The ticket can be scanned again afterwards. Assigned staff do not see the action, and the server refuses it for them.
- If the undo response is lost, the scanner lists the undo as unconfirmed and “Повторить отмену” repeats the same request, so the entry is reversed once. The request is kept for the whole app session: if the retry needs a new sign-in, the same account finds it again on the event list and in the scanner and repeats it under the new token. Another account never sees or sends it.
- If an earlier scan result was unknown and the retry reports a cancelled ticket, a refunded ticket or an undone check-in, the app treats the attempt as settled and not admitted. Other rejections still leave it unconfirmed.

## Run on a phone

Use Node.js 22.18+ or 24 LTS and npm. The project uses Expo SDK 58.

```bash
cd mobile
npm ci
cp .env.example .env
# Edit .env before starting Expo.
npm start
```

Set `EXPO_PUBLIC_API_URL` to the team's shared HTTPS backend address. For local development, use the computer's actual Wi-Fi address, for example `http://192.168.1.100:8000`. The example address is a placeholder, not a running server. The phone and computer need to be on the same network; the backend must listen on `0.0.0.0` and its port must be reachable. Do not use `localhost`: on the phone that refers to the phone itself. An Expo tunnel does not also expose the backend.

Open the Expo QR with a compatible Expo Go app. Allow camera access. Restart Expo after changing `.env`. Ask the organizer to publish a test event and assign your account through `POST /events/{event_id}/staff`. Use a separate attendee account to claim a test ticket in the web interface. The QR must encode exactly the returned `qr_payload` string. Both clients must use the same API and database.

Use HTTPS for the shared server. `EXPO_PUBLIC_*` values are included in the app, so put only the API address there, never passwords or tokens. The app does not save or log ticket QR payloads.

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

## Phone / integration checklist

Use the [short device run](DEVICE-QUICK-RUN.md) at the phone: it lists the steps in order and `tests/live/seed-device-run.ts` prepares its accounts, tickets and PDFs. [Device acceptance](DEVICE-ACCEPTANCE.md) explains each check, including web and printed QR, Android, and camera-to-result timing. Record device results separately from JS exports and HTTP checks.

Run this with the backend team on a test database. Record the device, backend commit, date and actual results.

1. Set the API address and tap “Проверить соединение” / “Байланысты тексеру”. A healthy API and database should be reported. Stop the server and verify it reports a failure. Sign in and also try a wrong password.
2. Assign the account to one event. Verify only permitted events are listed. An unassigned account should see an empty list.
3. Allow the camera, then separately test denying access, enabling it in Settings and returning to the app. Verify the preview returns. If camera startup fails, use the camera retry button.
4. Open a real ticket QR issued by the API. Use the attendee web page for the final demo. Select the correct event and scan it. Check for `CHECKED_IN` and one backend check-in record.
5. Leave the QR in front of the camera: only one request should be sent. Tap “Следующий билет” / “Келесі билет” and scan it again: expect an already-used-ticket rejection (`ALREADY_CHECKED_IN`).
6. Try another event's ticket and an unrelated QR: expect `INVALID_TICKET`. Revoke the staff assignment: check-in must be denied.
7. Disable Wi-Fi/mobile data and scan. It must not show green. Switch RU/KZ and verify the message changes while the displayed request ID stays the same. Reconnect and retry. Also simulate a lost response after the backend committed, then retry and verify only one record exists.
8. Expire the token during an unconfirmed scan. A different staff account must be rejected without sending a retry. The original account must be able to retry the same request. Check that the camera pauses when the app is backgrounded, and test Back and sign-out.
9. Open “Найти вручную” while the camera sees a test QR. The preview pauses and only an intentional tap on “Отметить вход” admits a search result. Switch back and verify the camera resumes. Search by name and email, compare masked addresses and check-in times, and confirm an admitted result has no action. Repeat after denying camera access.
10. Compare the attendance totals with the API before entry and after a confirmed manual or camera check-in. After “Следующий билет”, the same search should show the updated check-in time. A duplicate or a successful replay must not add an entry. Return to the scanner and confirm it fetches current totals.
11. Admit a visitor on a second phone, then tap “Обновить посещаемость” on the first. The total and its time change. Turn the network off and tap it again: the last total stays, marked as outdated.
12. Scan a cancelled ticket and a refunded ticket. Each shows its own message in RU and KZ and neither admits. Search shows both states without an admission action.
13. Sign in as the organizer, find an admitted visitor and tap “Отменить вход”. Cancel the dialog first, then confirm. The visitor becomes unadmitted and the total drops. Scan the ticket again: it is admitted again. As assigned staff the action is not shown.
14. Session renewal (not yet run on a phone). Start the test API with `ACCESS_TOKEN_EXPIRE_MINUTES=3`, sign in and keep the scanner open for five minutes: totals, search and a scan keep working without a password prompt. Then put the app in the background for five minutes, return and scan: the ticket is admitted once, with no sign-in form. Finally disable the account on the server (or wait out the refresh token) and scan: the sign-in form appears and nobody is admitted.
15. English (not yet run on a phone). Switch РУС → ҚАЗ → ENG on each screen: titles, buttons, results and dates change, the three options fit in the header beside the title on a small phone, and a displayed request ID stays the same.

If replay cannot confirm the result, give the displayed request ID to the organizer. Once the organizer has checked the record, choose “Выйти после сверки с организатором” and confirm to return to the event list. Cancelling the dialog keeps the request on screen. The app does not show admission success from this action.

The operating system can terminate the app, which discards a pending retry ID. Do not admit the attendee after an unconfirmed result; ask the organizer to verify it on the server as described in [device acceptance](DEVICE-ACCEPTANCE.md#how-the-organizer-verifies-the-record). Do not rescan the ticket to find out: if the lost request did not commit, the rescan admits the visitor. There is no offline queue or recovery after restart in this version.

## Code map

- `src/app/`: the three screens and Expo Router layout.
- `src/api.ts`: HTTP requests and response checks.
- `src/attendance.tsx`: event totals, manual attendee search and the undo action.
- `src/loading.ts`: state of a reloadable value (totals with the last good read).
- `src/scanner.ts`: scan lock and retry ID.
- `src/undo.ts`: undo requests kept per account, event and check-in until the server answers.
- `src/session.tsx`: the current account, its tokens and the renewal timer.
- `src/renewal.ts`: when to renew an access token and one shared renewal request per session.
- `src/language.tsx` and `src/messages.ts`: language choice and Russian/Kazakh/English screen text.
- `tests/`: small API and scanner tests.
- `tests/live/`: a run of the same client against a real API and database (see below).

Built from the official blank TypeScript template. Camera and UUID APIs follow the [Expo Camera](https://docs.expo.dev/versions/v58.0.0/sdk/camera/) and [Expo Crypto](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/) documentation. `LICENSE` covers the supplied Expo template.
