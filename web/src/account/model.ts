import { ApiError, getErrorMessage } from '../api/client.ts';
import { passwordIssues } from '../auth/formErrors.ts';
import { current } from '../i18n/index.ts';

/** The same password rules as registration, checked before the request is sent. */
export function validateNewPassword(password: string): void {
  const issues = passwordIssues(password);
  if (issues.length) throw new ApiError((m) => m.account.reset.checkForm, { kind: 'validation', status: 422, issues });
}

/** True for the API's answer to a verification or reset link that is invalid, expired or already used. */
export function isInvalidLink(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && error.code === 'INVALID_TOKEN';
}

export function linkErrorMessage(error: unknown): string {
  if (isInvalidLink(error)) return current().account.invalidLink;
  if (error instanceof ApiError && error.status === 422) return current().account.reset.checkForm;
  return getErrorMessage(error);
}

/**
 * What the forgot-password page says after a request. The API answers 202 for every address, so the
 * page must never show whether an account exists:
 * - `sent`: 2xx, and every other refusal that could depend on the account (400, 401, 403, 409, …);
 *   they all get the same neutral text as a success;
 * - `retry`: the service failed (5xx, 404 while the endpoint is missing, network, timeout, bad answer);
 *   the same retryable text for every address;
 * - `tooMany`: 429, which the API gives per address whether or not it is registered;
 * - `invalidEmail`: 422, about the format of what was typed, never about an account.
 */
export type ForgotPasswordOutcome = 'sent' | 'retry' | 'tooMany' | 'invalidEmail';

export function forgotPasswordOutcome(error: unknown): ForgotPasswordOutcome {
  if (error === null || error === undefined) return 'sent';
  if (!(error instanceof ApiError) || error.status === undefined) return 'retry';
  if (error.status === 429) return 'tooMany';
  if (error.status === 422) return 'invalidEmail';
  if (error.status >= 500 || error.status === 404) return 'retry';
  return 'sent';
}

/** The text for a failed outcome, in the current language. */
export function forgotPasswordError(outcome: Exclude<ForgotPasswordOutcome, 'sent'>, error: unknown): string {
  if (outcome === 'tooMany') return current().api.tooMany;
  if (outcome === 'invalidEmail') return current().account.forgot.invalidEmail;
  // Network, timeout and configuration keep their own retryable text; HTTP failures get the server one.
  return error instanceof ApiError && error.status !== undefined ? current().api.server : getErrorMessage(error);
}

/**
 * A courtesy limit of the banner, not a server contract: the button waits a minute after each attempt.
 * The backend's own limit (PR #21) answers 429, which is shown as "too many requests".
 */
export const RESEND_INTERVAL_MS = 60_000;

/** How long the "send again" button stays disabled after the last request. */
export function resendWaitMs(lastSentAt: number | null, now: number): number {
  if (lastSentAt === null) return 0;
  return Math.max(0, Math.min(RESEND_INTERVAL_MS, lastSentAt + RESEND_INTERVAL_MS - now));
}
