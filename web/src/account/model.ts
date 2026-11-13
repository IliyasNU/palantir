import { ApiError, getErrorMessage } from '../api/client.ts';
import { passwordIssues } from '../auth/formErrors.ts';
import { current } from '../i18n/index.ts';

/** The same password rules as registration, checked before the request is sent. */
export function validateNewPassword(password: string): void {
  const issues = passwordIssues(password);
  if (issues.length) throw new ApiError(current().account.reset.checkForm, { kind: 'validation', status: 422, issues });
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

/** The API answers 202 whether or not the address exists; any HTTP answer shows the same text. */
export function forgotPasswordAnswered(error: unknown): boolean {
  return error instanceof ApiError && error.status !== undefined;
}

export const RESEND_INTERVAL_MS = 60_000;

/** How long the "send again" button stays disabled after the last request. */
export function resendWaitMs(lastSentAt: number | null, now: number): number {
  if (lastSentAt === null) return 0;
  return Math.max(0, Math.min(RESEND_INTERVAL_MS, lastSentAt + RESEND_INTERVAL_MS - now));
}
