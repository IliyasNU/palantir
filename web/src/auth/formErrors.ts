import { ApiError, getErrorMessage } from '../api/client.ts';
import { current } from '../i18n/index.ts';
import type { ValidationIssue } from '../api/client.ts';
import type { RegistrationInput } from './types.ts';

/** Password rules shared by registration and password reset. */
export function passwordIssues(password: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ([...password].length < 8) issues.push({ field: 'password', message: current().auth.passwordShort });
  if (new TextEncoder().encode(password).length > 72) {
    issues.push({ field: 'password', message: current().auth.passwordLong });
  }
  return issues;
}

export function validateRegistration(input: RegistrationInput): void {
  const issues: ValidationIssue[] = [];
  if (!input.full_name.trim()) issues.push({ field: 'full_name', message: current().auth.nameRequired });
  issues.push(...passwordIssues(input.password));
  if (issues.length) throw new ApiError(current().auth.checkForm, { kind: 'validation', status: 422, issues });
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
