# Short device run

One pass per phone: about 30 minutes, plus the ten timing samples. Do it once on the iPhone and once on a physical Android phone. The full reasoning behind each check is in [device acceptance](DEVICE-ACCEPTANCE.md); the row numbers below are the rows of [device results](DEVICE-RESULTS.md).

Write a row as `passed` or `failed` only after doing it on the phone. Anything not done stays `pending` with the reason.

## Prepare (on the computer)

1. Check out the candidate and note its full SHA. Start PostgreSQL 16 (ICU `und`, UTF8), the API and the website as in the [root setup](../README.md). `alembic current` must print `0003 (head)` and `GET /health` must report `ok` and `up`.
2. Create the run's accounts, tickets and PDFs:

   ```bash
   LIVE_API_URL=http://127.0.0.1:8000 LIVE_CONFIRM_TEST_DATABASE=1 \
   node --experimental-strip-types tests/live/seed-device-run.ts ./device-run
   ```

   `device-run/run.md` lists the organizer, staff and outsider accounts, their one generated password, and which PDF is for which step. Keep the folder out of Git.
3. Print `01-website-and-paper.pdf` on A4 in grayscale at 100% scale, without “fit to page”. Open the other PDFs on the computer screen when a step asks for them.
4. Set `EXPO_PUBLIC_API_URL` in `mobile/.env` to the computer's LAN address and run `npx expo start --go --lan`. Open the app in Expo Go on the phone.
5. In the results file fill in the date, phone and OS, Expo Go version, network, the SHAs, and the PostgreSQL version and locale.

## Run (on the phone)

| Step | Do | Expect | Row |
| --- | --- | --- | --- |
| A | Sign in as the outsider. | The event list is empty. Sign out. | 3 |
| B | Sign in as staff, open the main event, allow the camera. On the website sign in as the holder of ticket 01 and open the ticket. Scan the QR on the website. | “Вход подтверждён”. The total goes up by one. One `check_ins` row for the ticket. | 1 |
| C | Tap “Следующий билет” and scan the printed page of the same ticket. | “Этот билет уже использован.” Still one row. The paper is readable from a normal scanning distance. | 2, 8 |
| D | Scan `07-wrong-event.pdf`, then any QR that is not a ticket. | “Этот QR не является билетом на выбранное событие.” both times. | 3 |
| E | Scan `03-cancelled.pdf`, then `04-refunded.pdf`. Switch to ҚАЗ and scan both again. | Two different messages, one for a cancelled ticket and one for a refunded ticket, in both languages. Neither is the cancelled-event message. No row for either ticket. | 10 |
| F | Open “Найти вручную”. Search `әлия`, then `ӘЛИЯ`, then part of the e-mail of ticket 02. Tap “Отметить вход”. Tap “Следующий билет” and search again. Repeat one search in ҚАЗ. | Each search finds the one visitor with a masked e-mail. After the entry the result shows the entry time and no admission action. Searching the holders of tickets 03 and 04 shows their state and no action. | 4, 10 |
| G | In iOS or Android settings deny the camera for Expo Go, return to the app, use manual search, re-enable the camera in settings, return. Send the app to the background and bring it back. | Manual search works without the camera. The camera preview returns. Nothing is scanned while the app is in the background. | 5 |
| H | Turn the phone's network off. Scan `06-connection-loss.pdf`. Switch language. Turn the network on and tap “Повторить этот запрос”. | No green result while offline; the request number stays the same across the language change; after the retry the entry is confirmed and the ticket has one row. | 6 |
| I | On a second phone, or in the API docs as staff, admit `spare-attendance-refresh.pdf`. On the first phone tap “Обновить посещаемость”. Turn the network off and tap it again. | The total and its time change. Offline, the last total stays with a note that it could not be refreshed. | 9 |
| J | Still as staff, find the holder of ticket 02 in manual search. | No “Отменить вход” action. Sign out. | 11 |
| K | Sign in as the organizer and open the main event. Find the holder of ticket 02, tap “Отменить вход”, choose “Не отменять”. Tap it again and confirm. | The first dialog changes nothing. After confirming, the result shows no entry time, the total drops by one, and the ticket's row has `undone_at` set. | 11 |
| L | Scan `05-undo.pdf`. On the result tap “Отменить вход” and confirm. Tap “Следующий билет” and scan the same PDF again. | “Вход отменён”, then “Вход подтверждён” again. Two rows for the ticket, one with `undone_at` empty. | 12 |
| M | Scan `spare-undo-offline.pdf`. Turn the network off, tap “Отменить вход” and confirm. Turn the network on and tap “Повторить отмену”. | The scanner shows “Отмена входа не подтверждена” with a request number, then the undo is confirmed. The row's `undo_request_id` equals the number on the phone. | 13 |
| N | Restart the API with `ACCESS_TOKEN_EXPIRE_MINUTES=1`. Sign in as the organizer, scan `spare-undo-sign-in-again.pdf`, turn the network off, undo and confirm, turn the network on, wait two minutes, tap “Повторить отмену”, then “Войти снова”. Sign in as staff, look at the list, sign out. Sign in as the organizer, open the marked event and tap “Повторить отмену”. | The retry asks to sign in. Staff see no unconfirmed undo. The organizer sees the event marked and the same request number, and the retry is confirmed. One row, undone once. Restart the API without the one-minute setting. | 14 |
| O | Sign in as staff. Turn the network off and scan `spare-organizer-check.pdf`. Turn the network on. As the organizer remove the staff assignment in the API docs (`DELETE /events/{id}/staff/{user_id}`). On the phone tap “Повторить этот запрос”. Have the organizer look the ticket up as described under “How the organizer verifies the record”, then tap “Выйти после сверки с организатором” and confirm. Assign the staff account again. | After the retry the app reports no access and still shows the request as unconfirmed with its number. It never shows a green result. Leaving returns to the event list and writes nothing: the ticket has no row. | 7 |

## Timing (row “Scan latency”)

Use the ten `timing-*.pdf` tickets, one per sample, shown on the computer screen at the same size. Film the phone and the code with a second camera, or record the phone's screen with the system recorder.

1. For each sample start with the scanner open and the code out of frame.
2. Move the code fully into the frame. That frame is the start.
3. The end is the first frame where “Вход подтверждён” is visible.
4. Write the seconds for each sample with its ticket ID. A rejected or failed sample is written with its reason and replaced by another fresh ticket if one is left.
5. Report the median and the maximum, the network used (Wi-Fi name or LTE, and whether the API is on the LAN), and compare the median with the two-second target.

Run the seed script again for a second phone: every phone needs its own fresh tickets.

## Record

For every row write the result, the ticket ID used, and one line of evidence: the message seen and the row count from the query at the end of `run.md`. Do not copy passwords, tokens or QR payloads into the results file.
