# BiletFlow Staff

Iliyas's part of Team Palantir's project. Three screens: sign in, choose an event, scan a ticket. This is a small Expo + TypeScript client, with no offline admission or payment features.

## Current status

- Use the backend from [`feature/temirlan-tickets-checkin`](https://github.com/IliyasNU/palantir/tree/26d0dbd58aaea5fc44d63144155d14fdeb8ad67a/backend) or an integration branch that includes it. It implements the staff event list, ticket issuance and idempotent check-in described in [API.md](API.md). The backend bundled in `recovery/backend` is too old for this flow.
- Sign-in confirms the staff account through `GET /auth/me`. The token and account ID stay in memory. After restarting the app, sign in again.
- Only a matching `CHECKED_IN` receipt confirms admission. A lost response or a server error leaves the scan unconfirmed and keeps its QR and request ID in memory for a retry. A retry after a 401 requires the same staff account.
- A 403 preserves the session. If the event is unavailable or access is denied on the first attempt, return to the event list to reload it. If an earlier attempt is still unconfirmed, ask the organizer to verify it before admitting the attendee.
- The interface supports Russian and Kazakh through the header buttons. Russian is the default; the choice lasts for the current app session. Switching language leaves the scan and its retry ID intact.
- Before signing in, use the connection button to check the real `/health` response, including database readiness. Camera permission is checked again when the app returns from Settings; a camera failure offers a retry.
- Physical-phone testing and the full web ticket → mobile check-in flow are pending.

## Integration still needed

The frontend in [`feature/frontend` at `e41c821`](https://github.com/IliyasNU/palantir/tree/e41c821eaea181bf1648cdd88934c27a740186b7/web) now has a public event catalog and event details. Ticket issuance and the attendee QR page are still awaiting frontend integration. Until those are available, the backend team can issue a test ticket through the API and render its exact `qr_payload` as a QR. Use the same backend and database for the web and mobile demo.

The current backend has no API for the SRS manual attendee search/check-in, undoing a check-in, or registered/checked-in totals. These features remain open integration work. This version does not display fabricated participant lists or counts.

## Run on a phone

Use Node.js 22.18+ or 24 LTS and npm. The project uses Expo SDK 57.

```bash
cd mobile
npm ci
cp .env.example .env
# Edit .env before starting Expo.
npm start
```

Set `EXPO_PUBLIC_API_URL` to the team's shared HTTPS backend address. For local development, use the computer's actual Wi-Fi address, for example `http://192.168.1.100:8000`. The example address is a placeholder, not a running server. The phone and computer need to be on the same network; the backend must listen on `0.0.0.0` and its port must be reachable. Do not use `localhost`: on the phone that refers to the phone itself. An Expo tunnel does not also expose the backend.

Open the Expo QR with a compatible Expo Go app. Allow camera access. Restart Expo after changing `.env`. Ask the organizer to publish a test event and assign your account through `POST /events/{event_id}/staff`. Use a separate attendee account to claim a test ticket through `POST /events/{event_id}/tickets`. The QR must encode exactly the returned `qr_payload` string. Both clients must use the same API and database.

Use HTTPS for the shared server. `EXPO_PUBLIC_*` values are included in the app, so put only the API address there, never passwords or tokens. The app does not save or log ticket QR payloads.

## Check the code

```bash
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo export --platform android --platform ios
```

The tests cover API requests, health response validation, errors, invalid receipts, repeated camera callbacks, retry IDs, account matching and localized error handling. Export checks the Android and iOS JavaScript bundles; it does not produce an installable app. Use the checklist below for camera and device behavior.

## Phone / integration checklist

Run this with the backend team on a test database. Record the device, backend commit, date and actual results.

1. Set the API address and tap “Проверить соединение” / “Байланысты тексеру”. A healthy API and database should be reported. Stop the server and verify it reports a failure. Sign in and also try a wrong password.
2. Assign the account to one event. Verify only permitted events are listed. An unassigned account should see an empty list.
3. Allow the camera, then separately test denying access, enabling it in Settings and returning to the app. Verify the preview returns. If camera startup fails, use the camera retry button.
4. Open a real ticket QR issued by the API. Use the attendee web page for the final demo. Select the correct event and scan it. Check for `CHECKED_IN` and one backend check-in record.
5. Leave the QR in front of the camera: only one request should be sent. Tap “Следующий билет” / “Келесі билет” and scan it again: expect an already-used-ticket rejection (`ALREADY_CHECKED_IN`).
6. Try another event's ticket and an unrelated QR: expect `INVALID_TICKET`. Revoke the staff assignment: check-in must be denied.
7. Disable Wi-Fi/mobile data and scan. It must not show green. Switch RU/KZ and verify the message changes while the displayed request ID stays the same. Reconnect and retry. Also simulate a lost response after the backend committed, then retry and verify only one record exists.
8. Expire the token during an unconfirmed scan. A different staff account must be rejected without sending a retry. The original account must be able to retry the same request. Check that the camera pauses when the app is backgrounded, and test Back and sign-out.

The operating system can terminate the app, which discards a pending retry ID. Do not admit the attendee after an unconfirmed result; ask the organizer to verify it on the server. There is no offline queue or recovery after restart in this version.

## Code map

- `src/app/`: the three screens and Expo Router layout.
- `src/api.ts`: HTTP requests and response checks.
- `src/scanner.ts`: scan lock and retry ID.
- `src/session.tsx`: the current account and login token.
- `src/language.tsx` and `src/messages.ts`: language choice and Russian/Kazakh screen text.
- `tests/`: small API and scanner tests.

Built from the official blank TypeScript template. Camera and UUID APIs follow the [Expo Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/) and [Expo Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/) documentation. `LICENSE` covers the supplied Expo template.
