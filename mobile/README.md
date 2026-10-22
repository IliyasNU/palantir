# BiletFlow Staff — first mobile version

Iliyas's part of Team Palantir's project. Three screens: sign in, choose an event, scan a ticket. This is a small Expo + TypeScript client, with no offline admission or payment features.

## Current status

The repository had no mobile source in `main` or `recovery/backend` at commit `09881b7` on 22 October 2026. This folder starts a new client; it does not claim to recover an earlier mobile implementation.

- Login calls the existing `POST /auth/login` JSON endpoint.
- Event selection and check-in call the proposed endpoints in [API.md](API.md). They are **not implemented in the inspected backend**. A missing endpoint shows an error; the app does not substitute mock success.
- QR scanning uses the phone camera. Multiple camera frames cannot submit the same scan repeatedly.
- Only a valid backend `CHECKED_IN` receipt produces a green result. A connection failure is unconfirmed, never successful.
- “Retry this check-in” reuses the request ID. “Scan next ticket” starts a new request. Backend idempotency still needs implementation and integration testing.
- Tokens stay in memory. Restarting the app or an expired token requires signing in again. No automatic refresh in this first version.
- Physical-phone testing and the full web-ticket → mobile-check-in flow are still pending.

Backend code, migrations, web pages and CI are outside this change.

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

Open the Expo QR with a compatible Expo Go app. Allow camera access. Restart Expo after changing `.env`. Use an existing backend account; the organizer must assign it to an event once that API exists. Staff membership is event-specific, not a new global login role.

Use HTTPS for the shared server. `EXPO_PUBLIC_*` values are included in the app, so put only the API address there, never passwords or tokens. The app does not save or log ticket QR payloads.

## Check the code

```bash
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo export --platform android --platform ios
```

The tests cover API requests, error handling, invalid success responses, repeated camera callbacks and retry IDs. Export checks that the JavaScript bundles compile; it is not a native device test.

Verified on 22 October 2026: TypeScript, lint, all 11 tests, SDK dependency compatibility, and Android/iOS JavaScript export passed. The client's login was also checked over HTTP against the actual FastAPI backend with a temporary SQLite database: login and `/auth/me` succeeded, a wrong password was rejected, and the missing staff/check-in routes were reported as unavailable. No shared database or deployed server was used.

## Phone / integration checklist

Run this with the backend team after they implement the agreed contract. Record the device, backend commit, date and actual results; don't mark these as passed based on unit tests.

1. Open the backend's `/health` URL in the phone browser. Sign in using the same backend in the app. Try a wrong password too.
2. Assign the account to one event. Verify only permitted events are listed. An unassigned account should see an empty list.
3. Allow the camera, then separately test denying camera access and reopening Settings.
4. Open a real ticket QR in the attendee web app. Select the correct event and scan it. Check for `CHECKED_IN` and one backend check-in record.
5. Leave the QR in front of the camera: only one request should be sent. Tap “Scan next ticket” and scan it again: expect `ALREADY_CHECKED_IN`.
6. Try another event's ticket and an unrelated QR: expect `INVALID_TICKET`. Revoke the staff assignment: check-in must be denied.
7. Disable Wi-Fi/mobile data and scan. It must not show green. Reconnect and retry; the request ID must stay the same. Also simulate a lost response after the backend committed, then retry and verify only one record exists.
8. Background the app and return; the camera should stop while it is not visible. Test the Back button and sign-out. Never admit an attendee while the result is unconfirmed.

Closing the scanner/app discards a pending retry ID. Resolve an uncertain check-in before leaving that screen; there is no offline queue or recovery after restart in this version.

## Next work, kept small

- 23–24 October: review the three-screen client and agree on `API.md` with Temirlan / Code U.
- 25–29 October: try login on the shared server and check the camera on a physical phone; adjust the client contract if needed.
- 30 October–2 November: connect the finished staff/check-in endpoints and run the checklist together.
- 3–5 November: fix demo-blocking bugs and record verified results for the report.

These are planned work windows, not claims of work completed on those dates. A new navigation system, offline mode, analytics, and persistent authentication can wait.

## Code map

- `src/app/`: the three screens and Expo Router layout.
- `src/api.ts`: HTTP requests and response checks.
- `src/scanner.ts`: scan lock and retry ID.
- `src/session.tsx`: the current login token.
- `tests/`: small API and scanner tests.

Built from the official blank TypeScript template. Camera and UUID APIs follow the [Expo Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/) and [Expo Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/) documentation. `LICENSE` covers the supplied Expo template.
