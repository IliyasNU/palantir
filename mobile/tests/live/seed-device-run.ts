// Prepares one device acceptance run on a disposable test database: accounts, two events, tickets in every
// state the run needs, and each ticket's PDF from the API. Nothing here is a result; it only sets the run up.
//
//   LIVE_API_URL=http://127.0.0.1:8000 LIVE_CONFIRM_TEST_DATABASE=1 \
//   node --experimental-strip-types tests/live/seed-device-run.ts ./device-run
//
// The output folder holds the PDFs and run.md with the test accounts. Keep it out of Git.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.env.LIVE_API_URL ?? '';
const folder = process.argv[2] ?? '';
if (!target || !folder || process.env.LIVE_CONFIRM_TEST_DATABASE !== '1') {
  console.error('Usage: LIVE_API_URL=... LIVE_CONFIRM_TEST_DATABASE=1 node --experimental-strip-types tests/live/seed-device-run.ts <output folder>');
  process.exit(2);
}
mkdirSync(folder, { recursive: true });
const run = randomUUID().slice(0, 6);
const password = `Run-${randomBytes(9).toString('base64url')}`;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(target + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path} -> ${response.status}`);
  return response;
}
async function account(label: string, fullName: string, role = 'attendee') {
  const email = `device-${run}-${label}@example.com`;
  await call('POST', '/auth/register', undefined, { email, full_name: fullName, password, role });
  const tokens: any = await (await call('POST', '/auth/login', undefined, { email, password })).json();
  return { email, fullName, token: tokens.access_token as string };
}
async function event(owner: { token: string }, title: string) {
  const created: any = await (await call('POST', '/events', owner.token, {
    title, date: new Date(Date.now() + 7 * 86400e3).toISOString(), location: 'Device run hall', capacity: 40,
  })).json();
  await call('POST', `/events/${created.id}/publish`, owner.token);
  return { id: created.id as number, title };
}
async function ticket(eventId: number, label: string, fullName: string, file: string) {
  const holder = await account(label, fullName);
  const issued: any = await (await call('POST', `/events/${eventId}/tickets`, holder.token)).json();
  const pdf = Buffer.from(await (await call('GET', `/tickets/${issued.id}/pdf`, holder.token)).arrayBuffer());
  assert.ok(pdf.subarray(0, 5).toString() === '%PDF-', 'the ticket PDF route must return a PDF');
  writeFileSync(join(folder, file), pdf);
  return { id: issued.id as number, file, holder };
}

const organizer = await account('organizer', 'Device Organizer', 'organizer');
const staff = await account('staff', 'Device Staff');
const outsider = await account('outsider', 'Device Outsider');
const main = await event(organizer, `Device run ${run}`);
const other = await event(organizer, `Other event ${run}`);
await call('POST', `/events/${main.id}/staff`, organizer.token, { email: staff.email });

const website = await ticket(main.id, 'website', 'Айгерим Сайтова', '01-website-and-paper.pdf');
const manual = await ticket(main.id, 'manual', 'Әлия Нұрланқызы', '02-manual-search.pdf');
const cancelled = await ticket(main.id, 'cancelled', 'Отмена Билетова', '03-cancelled.pdf');
const refunded = await ticket(main.id, 'refunded', 'Возврат Билетов', '04-refunded.pdf');
const undo = await ticket(main.id, 'undo', 'Қайрат Отменов', '05-undo.pdf');
const lost = await ticket(main.id, 'lost', 'Данияр Повторов', '06-connection-loss.pdf');
const wrong = await ticket(other.id, 'wrong-event', 'Другое Событие', '07-wrong-event.pdf');
const spare = [];
for (const step of ['attendance-refresh', 'undo-offline', 'undo-sign-in-again', 'organizer-check']) {
  spare.push(await ticket(main.id, `spare-${step}`, `Запас ${spare.length + 1}`, `spare-${step}.pdf`));
}
const timing = [];
for (let sample = 1; sample <= 10; sample++) {
  const number = String(sample).padStart(2, '0');
  timing.push(await ticket(main.id, `timing-${number}`, `Замер ${number}`, `timing-${number}.pdf`));
}
// The PDFs above were saved while the tickets were active; these two are closed only now.
await call('POST', `/tickets/${cancelled.id}/cancel`, cancelled.holder.token);
await call('POST', `/tickets/${refunded.id}/refund`, organizer.token);

const row = (item: { id: number; file: string; holder: { fullName: string; email: string } }, note: string) =>
  `| ${item.file} | ${item.id} | ${item.holder.fullName} | ${item.holder.email} | ${note} |`;
writeFileSync(join(folder, 'run.md'), `# Device run ${run}

API: ${target} · created ${new Date().toISOString()}

All accounts use one generated password: \`${password}\`

| Role | E-mail |
| --- | --- |
| Organizer (owns both events, may undo) | ${organizer.email} |
| Staff (assigned to the main event) | ${staff.email} |
| Outsider (not assigned) | ${outsider.email} |

Main event: ${main.title} (id ${main.id}) · other event: ${other.title} (id ${other.id})

| File | Ticket ID | Holder | Holder e-mail | Use |
| --- | --- | --- | --- | --- |
${[
    row(website, 'sign in on the website as this holder for the on-screen QR; print this PDF on A4 in grayscale'),
    row(manual, 'manual search by name in another letter case'),
    row(cancelled, 'cancelled ticket: expect the cancelled-ticket message'),
    row(refunded, 'ticket marked refunded (admission state only): expect the refunded-ticket message'),
    row(undo, 'admit, undo as organizer, admit again'),
    row(lost, 'interrupted connection and retry'),
    row(wrong, 'ticket of the other event: expect an invalid ticket'),
    ...spare.map(item => row(item, 'fresh ticket for the step named in the file')),
    ...timing.map((item, index) => row(item, `timing sample ${index + 1}`)),
  ].join('\n')}

Current admissions of one ticket (read-only):

\`\`\`sql
SELECT id, request_id, checked_in_at, undone_at, undo_request_id FROM check_ins WHERE ticket_id = <ticket id> ORDER BY id;
\`\`\`
`);
console.log(`Device run ${run}: ${7 + spare.length + timing.length} tickets and their PDFs written to ${folder}. Accounts are in ${join(folder, 'run.md')}.`);
