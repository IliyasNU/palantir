import { useSyncExternalStore } from 'react';
import { locales, messages } from './messages.ts';
import type { Locale, Messages } from './messages.ts';

export { locales, messages };
export type { Locale, Messages };

const STORAGE_KEY = 'biletflow.locale';
export const DEFAULT_LOCALE: Locale = 'ru';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}

function stored(): Locale {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE; // storage can be blocked; the interface still works in the default language
  }
}

let locale: Locale = stored();
const listeners = new Set<() => void>();

function apply() {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}
apply();

export function getLocale(): Locale {
  return locale;
}

/** Switches the interface language and remembers the choice in this browser. */
export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === locale) return;
  locale = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch { /* the choice then lasts until the page is closed */ }
  apply();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Texts of the current language for code outside React: models and API errors read it when they run. */
export function current(): Messages {
  return messages[locale];
}

/** BCP 47 tag for dates and times in the current language. */
export function dateLocale(): string {
  return locales.find((item) => item.locale === locale)?.tag ?? 'ru-RU';
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE);
}

/** Texts of the current language. The component renders again when the language changes. */
export function useT(): Messages {
  return messages[useLocale()];
}
