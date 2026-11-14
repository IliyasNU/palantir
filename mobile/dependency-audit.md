# Mobile: проверка зависимостей SDK 58 (W8.3)

Дата: 7 ноября 2026 года. Проверенный код: `c5b83a851128c486b1b15cebea94c6df8166308d` (`demo-v1`, `integration/biletflow-e2e`). Этот документ добавлен позже; проверки не приписываются новому коммиту документации.

## Решение

Зависимости сохранены. `npx expo install --check` сообщает, что версии соответствуют SDK 58; Expo Doctor прошёл 20/20 проверок. `npm outdated --json` не нашёл обновлений внутри заданных в package.json диапазонов (`wanted == current`). Принудительная смена major-версий транзитивных зависимостей не выполнялась.

В npm доступны React/React DOM 19.3.1 и worklets 0.13.1, но SDK сейчас рекомендует закреплённые 19.3.0 и 0.13.0. Наличие более новой версии само по себе не подтверждает совместимость с нативной частью Expo Go. TypeScript 7, ESLint 10 и @types/node 26 также не включены: это новые major-версии вне текущих диапазонов.

Сверена [документация именно SDK 58](https://docs.expo.dev/versions/v58.0.0/): React Native 0.88 и React 19.3.0. При следующем обновлении использовать `npx expo install`, затем повторить проверки и прогон на устройстве.

## Оставшийся audit

`npm audit --json` завершился с кодом 1: 12 записей Moderate, 0 High, 0 Critical, 0 Low. Это две исходные advisory и связанные с ними зависимые пакеты, а не двенадцать независимых уязвимостей. Риск остаётся открытым. Отсутствие High не доказывает безопасность приложения.

| Пакет в lockfile | Где используется | Подтверждённая проблема |
| --- | --- | --- |
| `glob@13.0.7` | `expo@58.0.23 → @expo/cli@58.1.19`; также `@expo/fingerprint@0.21.9` | [GHSA-3g3m-2fjr-6pw4](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4): обход отмены обхода файлов после AbortSignal, лишняя работа CPU/файловой системы. Исправление опубликовано в 14.0.2. |
| Три копии `minimatch@10.2.6` | `glob`; `@expo/fingerprint`; `@typescript-eslint/typescript-estree@8.72.1` через ESLint | [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249): рост CPU/памяти при специально сформированном glob-шаблоне и optimizationLevel >= 2. Исправление опубликовано в 11.0.1. |

Все 12 отмеченных npm пакетов: `expo`, `@expo/cli`, `@expo/fingerprint`, `glob`, `minimatch`, `eslint-config-expo`, `eslint-plugin-expo`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils`. В lockfile также есть `minimatch@3.1.5`; эти две advisory его не отмечают.

Родительские пакеты требуют `glob ^13.0.0` и/или `minimatch ^10.2.2`. Указанные исправленные версии выходят за эти major-диапазоны. Предложенный npm путь исправления — `expo@52.0.49` и `eslint-config-expo@6.0.0` с `isSemVerMajor: true`; это откат относительно SDK 58. `npm audit fix --force`, overrides и подавление проверок не применялись.

По цепочкам lockfile риск относится к CLI, fingerprint и линтеру. Прямых импортов glob/minimatch в mobile/src не найдено. Это вывод по зависимостям и исходникам, а не доказательство недостижимости уязвимости: PoC, анализ всех транзитивных путей и проверка эксплуатации на устройстве не проводились. Метка npm prod/dev сама по себе не определяет, что выполняется в нативном приложении.

До совместимого upstream-обновления обрабатывать только доверенные исходники и glob-шаблоны в сборке/CLI; инструменты разработки не публиковать как открытый сервис. Владелец mobile повторяет audit перед заморозкой и при обновлении Expo/ESLint, сверяет устранение обеих advisory и выполняет проверку устройства. Этот документ фиксирует риск, а не согласование его принятия всей командой.

## Фактически выполненные проверки

Windows, Node.js 24.21.0, npm 11.19.0. Использован установленный node_modules текущего снимка; чистый npm ci в W8.3 не повторялся. Секреты и локальный .env в документ не включены.

| Команда из mobile/ | Результат 07.11.2026 |
| --- | --- |
| `npm audit --json` | Код 1, 12 Moderate; подробности выше |
| `npm outdated --json` | Код 1 из-за доступных версий; для всех показанных пакетов wanted == current |
| `npx expo install --check` | Код 0, Dependencies are up to date |
| `npx expo-doctor` | Код 0, 20/20 checks passed |
| `npm run typecheck` | Код 0 |
| `npm run lint` | Код 0 |
| `npm test` | 26 passed, 0 failed, 0 skipped |
| `npx expo export --platform android` | Код 0, один Android JS/Hermes bundle |
| `npx expo export --platform ios` | Код 0, один iOS JS/Hermes bundle |

На Windows при блокировке PowerShell-скриптов использовать `npm.cmd` / `npx.cmd`. Экспорт выполнялся в отдельные локальные каталоги через `--output-dir`; результаты экспорта не добавляются в Git.

Экспорт JS/Hermes не является сборкой APK/IPA или проверкой камеры. В W8.3 физические iPhone и Android, установка нативной сборки, производительность скана и сквозной живой сценарий на телефоне не проверялись повторно. Для них остаются W7 и отдельная ручная приёмка. Backend, PostgreSQL и web в этом пакете не менялись и повторно не тестировались.

## Идентификация конфигурации

- Expo `~58.0.23`, React Native `0.88.1`, React `19.3.0`.
- SHA-256 `mobile/package.json`: `d7d853de11bf14e75080c456c66df2de411d6de685914d4869bdd3dbff473245`.
- SHA-256 `mobile/package-lock.json`: `00be3c3f7321dc580d3d5e05ed63bbb3b6043a7ac3996097eb46a33f29098f13`.
- Числа прежнего аудита SDK 52 в docs/integration-audit.md относятся к его историческому SHA; они не являются результатом этой проверки.
