import { ApiError, getErrorMessage } from '../api/client.ts';
import type { RegistrationInput } from './types.ts';

export function validateRegistration(input: RegistrationInput): void {
  const issues = [];
  if (!input.full_name.trim()) issues.push({ field: 'full_name', message: 'Укажите имя.' });
  if ([...input.password].length < 8) issues.push({ field: 'password', message: 'Пароль должен содержать минимум 8 символов.' });
  if (new TextEncoder().encode(input.password).length > 72) {
    issues.push({ field: 'password', message: 'Пароль слишком длинный: максимум 72 байта UTF-8. Сократите его.' });
  }
  if (issues.length) throw new ApiError('Проверьте заполнение формы.', { kind: 'validation', status: 422, issues });
}

export function authErrorMessage(error: unknown, mode: 'login' | 'register'): string {
  if (error instanceof ApiError) {
    if (error.status === 401 && mode === 'login') return 'Неверный email или пароль. Проверьте данные и попробуйте снова.';
    if (error.status === 409 && mode === 'register') return 'Этот email уже зарегистрирован. Войдите или укажите другой адрес.';
    if (error.status === 403) return 'Доступ к аккаунту запрещён. Возможно, аккаунт отключён.';
    if (error.status === 422) return 'Проверьте заполнение формы.';
  }
  return getErrorMessage(error);
}
