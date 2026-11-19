import { ApiError, getErrorMessage, issueMessage, localIssue } from '../api/client.ts';
import { current } from '../i18n/index.ts';
import type { ValidationIssue } from '../api/client.ts';
import type { RegistrationInput } from './types.ts';

/** Known local validation stays specific; server validation (English FastAPI text) uses a translated safe fallback. */
export const validationIssueMessage = issueMessage;

/** Password rules shared by registration and password reset. */
export function passwordIssues(password: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ([...password].length < 8) issues.push(localIssue('password', (m) => m.auth.passwordShort));
  if (new TextEncoder().encode(password).length > 72) {
    issues.push(localIssue('password', (m) => m.auth.passwordLong));
  }
  return issues;
}

export function validateRegistration(input: RegistrationInput): void {
  const issues: ValidationIssue[] = [];
  if (!input.full_name.trim()) issues.push(localIssue('full_name', (m) => m.auth.nameRequired));
  issues.push(...passwordIssues(input.password));
  if (issues.length) throw new ApiError((m) => m.auth.checkForm, { kind: 'validation', status: 422, issues });
}

export function authErrorMessage(error: unknown, mode: 'login' | 'register'): string {
  if (error instanceof ApiError) {
    if (error.status === 401 && mode === 'login') return current().auth.wrongCredentials;
    if (error.status === 409 && mode === 'register') return current().auth.emailTaken;
    if (error.status === 403) return current().auth.accountForbidden;
    if (error.status === 422) return current().auth.checkForm;
  }
  return getErrorMessage(error);
}
