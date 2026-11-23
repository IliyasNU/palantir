import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client.ts';
import { safeReturnTo } from '../src/auth/returnTo.ts';
import { messages } from '../src/i18n/messages.ts';
import {
  caseListPath, casePayload, caseSourcePath, messageBody, parseSupportId, readCase, readCaseList, readMessages,
  readOpenCase, supportError,
} from '../src/support/model.ts';

const date = '2030-01-01T00:00:00Z';
const summary = { id: 11, kind: 'attendee', category: 'payment', subject: 'Help with payment', status: 'open',
  requester: { id: 4, full_name: 'Visitor', masked_email: 'v***@example.com' }, assignee: null,
  event_title: 'Workshop', last_message_at: date, last_message_by: 'requester' };
const first = { id: 10, case_id: 11, author_name: 'Visitor', author_side: 'requester', body: 'Could you help me?', created_at: date };
const detail = { ...summary, can_manage: false, viewer_side: 'requester',
  context: { event: { id: 42, title: 'Workshop' }, order: { id: 9, total_tiyn: 10050 }, ticket: null }, messages: [first] };

test('support creation retains exactly the context from its source page through login', () => {
  for (const type of ['event', 'order', 'ticket']) {
    const path = caseSourcePath(type, 42);
    assert.equal(safeReturnTo(path), path);
    const open = readOpenCase(new URLSearchParams(path.split('?')[1]));
    assert.deepEqual(casePayload(open, 'payment', ' Help with payment ', ' A message '), {
      kind: 'attendee', category: 'payment', subject: 'Help with payment', message: 'A message', [`${type}_id`]: 42,
    });
  }
  for (const query of ['', 'event=0', 'ticket=2147483648', 'event=42&order=43', 'event=42&event=42', 'kind=attendee', 'redirect=https://example.com']) {
    assert.equal(readOpenCase(new URLSearchParams(query)), null, query);
    assert.equal(safeReturnTo('/support/new?' + query), '/events', query);
  }
  assert.equal(safeReturnTo('/admin/support'), '/admin/support');
  assert.equal(safeReturnTo('/organizer/events/9/support'), '/organizer/events/9/support');
  assert.equal(safeReturnTo('/support/cases/17'), '/support/cases/17');
});

test('platform cases guard categories and count Unicode characters after trimming', () => {
  const open = readOpenCase(new URLSearchParams('kind=organizer'));
  assert.deepEqual(casePayload(open, 'activation', ' 🪪🪪🪪 ', ' Платный билет '), {
    kind: 'organizer', category: 'activation', subject: '🪪🪪🪪', message: 'Платный билет',
  });
  assert.throws(() => casePayload(open, 'ticket_delivery', 'Subject', 'Message'), ApiError);
  assert.throws(() => casePayload(open, 'technical', '🪪🪪', 'Message'), ApiError);
  assert.throws(() => casePayload(open, 'technical', 'x'.repeat(201), 'Message'), ApiError);
  assert.equal(messageBody('🎟'.repeat(4000)), '🎟'.repeat(4000));
  assert.throws(() => messageBody('🎟'.repeat(4001)), ApiError);
  assert.throws(() => messageBody(' \n\t '), ApiError);
  assert.equal(parseSupportId('2147483647'), 2147483647);
});

test('queues send the API status and optional kind, and case reads verify IDs, enum values and dates', () => {
  assert.equal(caseListPath('/support/cases/mine', 0, '', ''), '/support/cases/mine?limit=21&offset=0');
  assert.equal(caseListPath('/admin/support-cases', 20, 'in_progress', 'organizer'),
    '/admin/support-cases?limit=21&offset=20&status=in_progress&kind=organizer');
  assert.deepEqual(readCaseList([summary]), [summary]);
  assert.deepEqual(readCase(detail, 11), detail);
  assert.throws(() => readCase(detail, 12), ApiError);
  assert.throws(() => readCase({ ...detail, can_manage: 'false' }), ApiError);
  assert.throws(() => readCaseList([{ ...summary, status: 'waiting' }]), ApiError);
  assert.throws(() => readCaseList([{ ...summary, last_message_at: 'not a date' }]), ApiError);
  assert.throws(() => readCaseList(Array(22).fill(summary)), ApiError);
});

test('message batches cannot mix cases, duplicate IDs or predate the requested cursor', () => {
  const reply = { ...first, id: 12, author_side: 'staff', author_name: 'Organizer', body: 'Yes' };
  assert.deepEqual(readMessages([reply], 11, 10), [reply]);
  assert.throws(() => readMessages([reply, first], 11), ApiError);
  assert.throws(() => readMessages([first, first], 11), ApiError);
  assert.throws(() => readMessages([reply], 12), ApiError);
  assert.throws(() => readMessages([first], 11, 10), ApiError);
});

test('support errors show localized API codes without leaking server wording', () => {
  const error = new ApiError('private diagnostic message', { kind: 'validation', status: 422, code: 'INVALID_ASSIGNEE' });
  for (const locale of ['ru', 'kk', 'en']) {
    assert.equal(supportError(error, messages[locale].support), messages[locale].support.errors.INVALID_ASSIGNEE);
  }
});
