import { ApiError, getErrorMessage } from '../api/client.ts';
import type { Messages } from '../i18n/messages.ts';

export const caseKinds = ['attendee', 'organizer'] as const;
export const caseStatuses = ['open', 'in_progress', 'waiting_for_customer', 'resolved'] as const;
export const categories = {
  attendee: ['ticket_delivery', 'payment', 'refund', 'seating', 'event_information', 'check_in', 'account', 'technical'],
  organizer: ['account', 'activation', 'payment', 'technical'],
} as const;
export const pageSize = 20;
export const messageLimit = 500;
const contextKeys = ['event', 'order', 'ticket'] as const;
const sides = ['requester', 'staff'] as const;
const categoryKeys = [...categories.attendee, ...categories.organizer];
const errorCodes = ['CASE_NOT_FOUND', 'CONTEXT_REQUIRED', 'CONTEXT_MISMATCH', 'CATEGORY_NOT_ALLOWED',
  'INVALID_ASSIGNEE', 'EVENT_NOT_FOUND', 'ORDER_NOT_FOUND', 'TICKET_NOT_FOUND', 'FORBIDDEN'] as const;

export type CaseKind = typeof caseKinds[number];
export type CaseStatus = typeof caseStatuses[number];
export type Category = typeof categoryKeys[number];
export type CaseErrorCode = typeof errorCodes[number];
type Side = typeof sides[number];
type ContextKey = typeof contextKeys[number];
type Person = { id: number; full_name: string };
type Requester = Person & { masked_email: string };
type CaseSource = { type: ContextKey; id: number };
type CaseContext = {
  event: { id: number; title: string } | null;
  order: { id: number; total_tiyn: number } | null;
  ticket: { id: number } | null;
};
type CaseSummary = {
  id: number; kind: CaseKind; category: Category; subject: string; status: CaseStatus;
  requester: Requester; assignee: Person | null; event_title: string | null;
  last_message_at: string; last_message_by: Side;
};
type CaseMessage = { id: number; case_id: number; author_name: string; author_side: Side; body: string; created_at: string };
export type SupportCase = CaseSummary & { viewer_side: Side; can_manage: boolean; context: CaseContext; messages: CaseMessage[] };
export type CaseUpdate = { status: CaseStatus } | { assignee_id: number | null };
export type OpenCase = { kind: 'attendee'; source: CaseSource } | { kind: 'organizer'; source: null };

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => value === candidate);
}

function resourceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function parseSupportId(value: string | null | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return resourceId(id) ? id : null;
}

export function caseSourcePath(type: ContextKey, id: number): string {
  return `/support/new?${type}=${id}`;
}

export function readOpenCase(query: URLSearchParams): OpenCase | null {
  const entries = [...query.entries()];
  const [entry] = entries;
  if (!entry || entries.length !== 1) return null;
  const [key, value] = entry;
  if (key === 'kind' && value === 'organizer') return { kind: 'organizer', source: null };
  const id = parseSupportId(value);
  return isOneOf(contextKeys, key) && id !== null ? { kind: 'attendee', source: { type: key, id } } : null;
}

function invalidInput(message: (text: Messages) => string): never {
  throw new ApiError(message, { kind: 'validation' });
}

export function messageBody(value: string): string {
  const text = value.trim();
  if (text.length === 0 || Array.from(text).length > 4000) return invalidInput(t => t.support.invalidMessage);
  return text;
}

export function casePayload(open: OpenCase, category: string, subject: string, message: string) {
  if (!isOneOf<Category>(categories[open.kind], category)) return invalidInput(t => t.support.errors.CATEGORY_NOT_ALLOWED);
  const title = subject.trim();
  const length = Array.from(title).length;
  if (length < 3 || length > 200) return invalidInput(t => t.support.invalidSubject);
  const context = open.source ? { [`${open.source.type}_id`]: open.source.id } : {};
  return { kind: open.kind, category, subject: title, message: messageBody(message), ...context };
}

export function caseListPath(endpoint: string, offset: number, status: CaseStatus | '', kind: CaseKind | ''): string {
  const params = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) });
  if (status) params.set('status', status);
  if (kind) params.set('kind', kind);
  return `${endpoint}?${params}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPerson(value: unknown): value is Person {
  return record(value) && resourceId(value.id) && typeof value.full_name === 'string';
}

function isContext(value: unknown): value is CaseContext {
  return record(value)
    && (value.event === null || (record(value.event) && resourceId(value.event.id) && typeof value.event.title === 'string'))
    && (value.order === null || (record(value.order) && resourceId(value.order.id) && typeof value.order.total_tiyn === 'number'
      && Number.isSafeInteger(value.order.total_tiyn) && value.order.total_tiyn >= 0))
    && (value.ticket === null || (record(value.ticket) && resourceId(value.ticket.id)));
}

function dateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalidResponse(): never {
  throw new ApiError(t => t.support.invalidResponse, { kind: 'response' });
}

function isSummary(value: unknown): value is CaseSummary {
  return record(value) && resourceId(value.id) && isOneOf(caseKinds, value.kind)
    && isOneOf<Category>(categories[value.kind], value.category) && typeof value.subject === 'string'
    && isOneOf(caseStatuses, value.status) && record(value.requester) && typeof value.requester.masked_email === 'string'
    && isPerson(value.requester) && (value.assignee === null || isPerson(value.assignee))
    && (value.event_title === null || typeof value.event_title === 'string')
    && dateTime(value.last_message_at) && isOneOf(sides, value.last_message_by);
}

export function readCaseList(value: unknown): CaseSummary[] {
  if (!Array.isArray(value) || value.length > pageSize + 1 || !value.every(isSummary)) return invalidResponse();
  return value;
}

export function readMessages(value: unknown, caseId: number, afterId = 0): CaseMessage[] {
  if (!Array.isArray(value) || value.length > messageLimit) return invalidResponse();
  let previousId = afterId;
  return value.map((message: unknown) => {
    if (!record(message) || !resourceId(message.id) || message.id <= previousId || message.case_id !== caseId
      || typeof message.author_name !== 'string' || !isOneOf(sides, message.author_side)
      || typeof message.body !== 'string' || !dateTime(message.created_at)) return invalidResponse();
    previousId = message.id;
    return { id: message.id, case_id: caseId, author_name: message.author_name, author_side: message.author_side,
      body: message.body, created_at: message.created_at };
  });
}

export function readCase(value: unknown, expectedId?: number): SupportCase {
  if (!record(value) || !isSummary(value) || (expectedId !== undefined && value.id !== expectedId)
    || !('viewer_side' in value) || !isOneOf(sides, value.viewer_side)
    || !('can_manage' in value) || typeof value.can_manage !== 'boolean'
    || !('context' in value) || !isContext(value.context)
    || !('messages' in value)) return invalidResponse();
  return { ...value, viewer_side: value.viewer_side, can_manage: value.can_manage, context: value.context,
    messages: readMessages(value.messages, value.id) };
}

export function supportError(error: unknown, text: Messages['support']): string {
  if (error instanceof ApiError && isOneOf(errorCodes, error.code)) return text.errors[error.code];
  return getErrorMessage(error);
}
