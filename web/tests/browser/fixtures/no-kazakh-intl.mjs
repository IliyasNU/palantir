/**
 * Emulates a browser without Kazakh ICU data, as the #25 review saw in Edge: Kazakh dates fall back to the
 * ICU root locale ("2030 M11 15 17:00") and Kazakh numbers to root symbols ("1,000.5"). Other languages
 * are untouched. Self-contained, so it runs both in Node and as a Playwright init script.
 */
export function withoutKazakhLocaleData(scope = globalThis) {
  const kazakh = (locales) => [locales].flat().some((tag) => typeof tag === 'string' && /^kk(?:-|$)/i.test(tag));
  const pad = (value) => String(value).padStart(2, '0');
  const root = (value) => {
    const date = new Date(value ?? Date.now());
    return `${date.getFullYear()} M${pad(date.getMonth() + 1)} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const NativeDateTimeFormat = scope.Intl.DateTimeFormat;
  const NativeNumberFormat = scope.Intl.NumberFormat;
  function DateTimeFormat(locales, options) {
    if (!kazakh(locales)) return new NativeDateTimeFormat(locales, options);
    const fallback = new NativeDateTimeFormat('en-US', options);
    return {
      format: (value) => root(value),
      formatToParts: (value) => [{ type: 'literal', value: root(value) }],
      resolvedOptions: () => ({ ...fallback.resolvedOptions(), locale: 'und' }),
    };
  }
  DateTimeFormat.supportedLocalesOf = (locales) => NativeDateTimeFormat.supportedLocalesOf(locales).filter((tag) => !kazakh(tag));
  function NumberFormat(locales, options) {
    return new NativeNumberFormat(kazakh(locales) ? 'en-US' : locales, options);
  }
  NumberFormat.supportedLocalesOf = (locales) => NativeNumberFormat.supportedLocalesOf(locales).filter((tag) => !kazakh(tag));
  scope.Intl.DateTimeFormat = DateTimeFormat;
  scope.Intl.NumberFormat = NumberFormat;
  const natives = {};
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const native = natives[name] = scope.Date.prototype[name];
    scope.Date.prototype[name] = function (locales, options) { return kazakh(locales) ? root(this) : native.call(this, locales, options); };
  }
  const nativeNumber = scope.Number.prototype.toLocaleString;
  scope.Number.prototype.toLocaleString = function (locales, options) { return nativeNumber.call(this, kazakh(locales) ? 'en-US' : locales, options); };
  return () => {
    scope.Intl.DateTimeFormat = NativeDateTimeFormat;
    scope.Intl.NumberFormat = NativeNumberFormat;
    Object.assign(scope.Date.prototype, natives);
    scope.Number.prototype.toLocaleString = nativeNumber;
  };
}
