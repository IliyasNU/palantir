import { dateLocale, getLocale } from './index.ts';

const kazakhMonths = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];

/**
 * Date and time in the current language, in the browser's time zone (no timeZone override).
 * Kazakh is written out here: a browser without Kazakh ICU data falls back to the root locale and
 * prints "2030 M11 15 17:00" (seen in Edge), so Kazakh output must not depend on that data.
 */
export function formatDateTime(value: string | number | Date, style: 'long' | 'medium' = 'long'): string {
  const date = new Date(value);
  if (getLocale() === 'kk') {
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    return `${date.getDate()} ${kazakhMonths[date.getMonth()]} ${date.getFullYear()}, ${time}`;
  }
  return new Intl.DateTimeFormat(dateLocale(), { dateStyle: style, timeStyle: 'short' }).format(date);
}

/**
 * Number in the current language. Kazakh uses the same digits, comma and non-breaking-space grouping
 * as Russian (CLDR), so Russian data is used and a browser without Kazakh data still groups correctly.
 */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(getLocale() === 'kk' ? 'ru-RU' : dateLocale(), options).format(value);
}
