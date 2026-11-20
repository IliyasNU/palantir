# BiletFlow Web

Веб-приложение на React + TypeScript + Vite, React Router в declarative mode и обычном CSS. Реализованы FE01 (регистрация и вход), FE02 (публичный каталог с поиском по названию) и часть FE03 Алиби (загрузка и отображение события). Все исходники, зависимости и результаты сборки находятся внутри `web/`.

Инструкция запуска совместимого backend с отдельной тестовой PostgreSQL, настройка телефона/production и текущий статус проверки: [корневой README](../README.md).

## Запуск

Используйте единую ветку `integration/biletflow-e2e`. Команды запуска PostgreSQL, миграций и API находятся в [корневом README](../README.md). Для web нужны Node.js 22.17+ в ветке 22 либо Node.js 24+ и npm 10+.

```powershell
cd web
if (-not (Test-Path -LiteralPath .env.local)) { Copy-Item .env.example .env.local }
npm ci
npm run dev
```

Frontend доступен на `http://localhost:5173`. Укажите полный базовый HTTP(S) URL API в `VITE_API_URL` без `/auth/register` или `/events`. Пример `http://127.0.0.1:8000` рассчитан на API, запущенный на этом компьютере. Изменение env требует перезапуска Vite. Production build отклоняет отсутствующий или некорректный URL. Для HTTPS-сайта задайте доступный HTTPS API и разрешите точный origin сайта в `CORS_ORIGINS`.

Приоритет настроек Vite от высокого к низкому включает переменные процесса, `.env.[mode].local`, `.env.[mode]`, `.env.local`, `.env`. `VITE_*` доступны браузеру.

## Маршруты и текущая область работы

| Путь | Поведение |
| --- | --- |
| `/` | Перенаправление на `/events` с заменой записи в истории |
| `/events` | Публичный каталог и локальный поиск по названию |
| `/events/:id` | Загрузка события по ID, описание, дата, место, статус и доступность |
| `/login` | Вход по email и паролю, затем получение `/auth/me` |
| `/register` | Регистрация с выбором роли: посетитель (`attendee`, по умолчанию) или организатор (`organizer`), затем переход на login |
| `/forgot-password` | Запрос ссылки для сброса пароля; ответ не раскрывает, есть ли такой email |
| `/reset-password?token=…` | Новый пароль с повтором по ссылке из письма |
| `/verify-email?token=…` | Подтверждение email по ссылке из письма |
| `/tickets` | Список собственных билетов после входа |
| `/tickets/:id` | Собственный билет и QR, если билет действителен; кнопка открывает QR на весь экран |
| `/events/:id/checkout?type=…` | Демо-оплата платного типа билета (P2) |
| `/orders`, `/orders/:id` | Собственные демо-заказы (P2) |
| `/organizer` | Кабинет организатора: свои события |
| `/organizer/events/new`, `/organizer/events/:id/edit` | Создание, редактирование, публикация и отмена события |
| `/organizer/events/:id/ticket-types` | Типы билетов события |
| `/organizer/events/:id/activation` | Демо-активация платных продаж (P2) |
| `/admin`, `/admin/users`, `/admin/events`, `/admin/action-log` | Модерация для администратора; остальным — экран 403 |
| Любой неизвестный путь | Страница 404 со ссылкой на события |

Страницы используют общий layout с навигацией, активными ссылками, ссылкой пропуска навигации и адаптивным CSS. Каталог и страницы событий открыты без обязательного входа. Фиктивной авторизации и автоматического входа после регистрации нет.

## FE02: публичный каталог

`EventsPage.tsx` вызывает существующий `api.request('/events', { signal })` без Bearer token. Контракт `26d0dbd5`: ответ — массив `EventRead[]`, без обёртки, серверного поиска или пагинации. Backend возвращает опубликованные события в порядке даты и ID; frontend сохраняет этот порядок.

Карточка показывает название со ссылкой на `/events/:id`, место и дату. Дата преобразуется из серверной строки в местное время браузера через `Intl.DateTimeFormat`; часовой пояс не фиксируется на UTC или Казахстане.

Поиск работает только по названию: `query.trim().toLowerCase()`. Он фильтрует уже загруженный список и не отправляет `q` или другие параметры серверу. Есть сброс поиска, загрузка, пустой каталог, отсутствие совпадений и ошибка с кнопкой «Повторить». Сетевая/HTTP-ошибка и неверный формат ответа не превращаются в пустой каталог. При уходе со страницы запрос отменяется.

Ввод доступен при загрузке, ошибке и пустом каталоге. «Повторить» сохраняет поисковый запрос. Ответ HTTP 405 означает, что подключённый сервер не поддерживает этот запрос каталога; метод не заменяется на POST, создающий событие.

Mock-режима и резервного списка в приложении нет. Данные в `tests/browser/catalog.spec.mjs` используются только тестами через перехват HTTP. Проверки каталога:

```powershell
npm test
npm run test:browser -- catalog.spec.mjs
npm run build
```

Браузерные проверки покрывают запрос без авторизации и query-параметров, поиск, состояния списка, повтор после ошибок, переход к событию и ширину 375 px. Проверка часового пояса использует `America/New_York`, включая переход на предыдущую календарную дату относительно UTC.

Первоначальный прогон FE02 от 4 ноября 2026: 29 модульных тестов и 6 браузерных сценариев каталога прошли; API тогда был недоступен. После исправления поиска общий прогон составил 35 модульных и 23 успешных браузерных сценария, один opt-in live-сценарий пропущен. Браузерные проверки событий использовали тестовые HTTP-ответы. Позднее на отдельном актуальном backend подтверждён реальный `GET /events` с ответом `200 []` и отображение пустого каталога в Edge на 375 px.

## FE03: загрузка и отображение события

`EventDetailsPage.tsx` загружает `GET /events/{id}`. Контракт прочитан в backend-коммите `26d0dbd5`: ответ — один объект `EventRead`, ID — положительное целое число. Поля: `id`, `organizer_id`, `title`, `description` (строка или `null`), `date`, `location`, `capacity`, `status`, `tickets_issued`, `created_at`, `updated_at`. Статусы: `draft`, `published`, `cancelled`. Опубликованные и отменённые события доступны гостю; черновик — владельцу или администратору, для остальных сервер возвращает 404.

Гость использует существующий `api.request()`, вошедший пользователь — `useAuth().request()`, чтобы сохранить доступ владельца к черновикам и общую обработку 401/403. Смена ID или пользователя сбрасывает данные страницы. `AbortController` отменяет старый запрос; проверка сигнала не даёт позднему ответу подменить новое событие, даже если транспорт не выполнил отмену. Прямой переход и обновление страницы заново загружают событие. Для production нужен SPA fallback на `index.html`.

Показаны название, описание, местное время браузера, место, статус и остаток `Math.max(0, capacity - tickets_issued)`. Для расчёта нужны числовые безопасные целые: `capacity > 0`, `tickets_issued >= 0`. Отсутствующие/некорректные счётчики дают «Доступность неизвестна», без преобразования строк в числа. Есть загрузка, отдельный 404, ошибка с повтором, уведомления об отмене и отсутствии мест. Ссылка гостя ко входу использует существующие `safeReturnTo` и `authLink`, сохраняя событие в цепочке login → register → login.

### Билеты и QR

`src/events/EventActions.tsx` использует существующее место подключения в карточке события. `POST /events/{id}/tickets` выдаёт билет (`201`) или возвращает существующий (`200`). Открыть свой билет можно со страницы события или из «Мои билеты». Список использует `GET /tickets/me`, страница билета использует `GET /tickets/{id}`. Чужой билет возвращает `404`. Отмена события и уже использованный билет оставляют метаданные доступными владельцу и скрывают QR.

У билета есть состояние `status`: `active`, `cancelled` или `refunded` (backend с миграцией `0003`; без неё поле отсутствует и билет считается активным). Отменённый и возвращённый билеты показывают своё состояние, QR и действия скрыты. Это состояние отдельного билета, оно не совпадает с отменой события. Владелец может отменить свой билет кнопкой «Отменить билет» после подтверждения (`POST /tickets/{id}/cancel`); отмена окончательна и освобождает место. «Возвращён» выставляет организатор через API. Билеты бесплатные, платёж не проводится, поэтому это состояние допуска, а не возврат денег.

«Скачать билет в PDF» запрашивает `GET /tickets/{id}/pdf` с токеном сессии и сохраняет файл `biletflow-ticket-{id}.pdf`. PDF формирует сервер, в нём тот же `qr_payload`, поэтому распечатанный билет и билет на экране дают один вход. Для отменённого или возвращённого билета и для отменённого события PDF недоступен.

QR генерируется локально из точного `qr_payload`, который вернул API. Сессия и QR исчезают при выходе. Сервер повторно проверяет права и статус при check-in.

Проверки FE03:

```powershell
npm test
npm run test:browser -- event-details.spec.mjs
npm run build
```

Браузерные тесты используют HTTP-перехват только в тестах. Проверяются прямое открытие и reload, загрузка и поля, 404, повтор после сетевой/HTTP-ошибки, неизвестная доступность, отмена и отсутствие мест, поздний ответ старого ID, возврат через формы, существующая обработка 401/403 и ширина 375 px. Для проверки доступности места подключения используется отдельный тестовый компонент в `tests/browser/fixtures/`; в приложение он не включён.

Первоначальная проверка FE03 от 4 ноября 2026: `npm test` — 35 успешно; браузерные проверки — 22 успешно (из них 12 FE03), один live-сценарий пропущен; build с TypeScript — успешно. Подробности и состояния событий проверены с фикстурами. На реальном API подтверждены health, ранее регистрация/вход FE01 и пустой каталог. Реальные события, их детали и жизненный цикл draft → published → cancelled ещё не проверены: это не полная приёмка FE02–FE04. Этот абзац описывает состояние на момент проверки FE03. Билеты добавлены позже в интеграционной ветке.

## FE01: сессия и формы

- Регистрация отправляет `POST /auth/register` с JSON `{ email, full_name, password, role }`. Роль выбирается на форме: `attendee` (по умолчанию) или `organizer`; другие значения клиент не отправляет, администратор создаётся только на сервере. Успех — пользователь (`201`), после которого открывается login с сообщением «Аккаунт создан…». Автоматического входа нет: новый организатор после входа попадает в `/organizer` (если форма не была открыта с другим `returnTo`), а меню показывает «Мои события».
- Login отправляет `POST /auth/login` с JSON `{ email, password }`, затем вызывает `GET /auth/me` с access token. Сессия становится авторизованной только после успешного получения активного пользователя. Ошибка любого из двух запросов не оставляет частичную сессию.
- **Access token и пользователь хранятся только в памяти. После перезагрузки страницы или открытия новой вкладки требуется повторный вход.** `localStorage`, `sessionStorage` и cookies для сессии не используются. Полученный `refresh_token` не сохраняется; автоматическое обновление токенов отсутствует.
- Единственная реализация состояния — `src/auth/store.ts`, подключённая через один `AuthProvider` в `main.tsx`. Компоненты используют `useAuth()`. Токен не выдаётся компонентам; доступен пользователь и методы сессии.
- «Выйти» очищает token, пользователя и уведомления в памяти, отменяет запросы сессии. Серверный logout не вызывается. Поздний ответ запроса не может восстановить завершённую сессию или очистить более новую.
- Закрытые запросы выполняются через `useAuth().request()`: `401` очищает сессию и показывает предложение войти снова; `403` показывает отсутствие прав и сохраняет сессию. Публичные запросы используют `api.request()`.
- Возврат после входа передаётся в `returnTo`. Разрешены только известные маршруты событий, оформления, билетов, заказов и кабинета организатора с положительными числовыми ID (список — в `src/auth/returnTo.ts`). Внешние URL, protocol-relative URL, обратные слеши, query/hash и остальные маршруты заменяются на `/events`. Адрес сохраняется в ссылках login → register → login, login → forgot-password → login и после успешной регистрации.
- Отправка блокирует поля и кнопку; синхронный guard предотвращает повторный запрос до перерисовки React. При уходе со страницы запрос отменяется. После завершения попытки поле пароля очищается.
- Формы показывают неверные учётные данные, занятый email, отсутствие доступа, сетевые ошибки и FastAPI 422 с названиями полей. Проверяются обязательные поля, длина имени и ограничение пароля в 72 байта UTF-8. Пароли и токены не логируются.

## Типы билетов (P1)

На странице события видны цена и остаток каждого доступного типа. Посетитель выбирает
бесплатный тип перед выдачей. Платные типы показаны для ознакомления, продажа появится
в следующей фазе. Название типа также отображается на странице выданного билета.
При начале и окончании окна продаж страница обновляет доступность без перезагрузки.
Кнопка выдачи проверяет время перед запросом, а окончательное решение принимает API.
Лимит названия и число строк на билете берутся из общего файла
`backend/app/assets/ticket-type-name.json`.

Организатор события и администратор управляют типами по адресу
`/organizer/events/{id}/ticket-types`. Ссылка есть на странице события. Когда появится
кабинет организатора, добавьте эту ссылку к действиям его события.
Первый тип занимает всю вместимость. Уменьшите его количество, чтобы выделить места
другому типу. Скрытые типы сохраняются в уже выданных билетах и учитываются во вместимости.
Журнал внизу страницы показывает изменения, сохранённые сервером.

## API-клиент

`src/api/index.ts` экспортирует общий публичный экземпляр `api`, `ApiError` и `getErrorMessage`. `src/api/client.ts` содержит JSON-клиент на `fetch` без зависимостей от React. Для запроса с сессией в React-компоненте:

```ts
import { useAuth } from './auth/AuthProvider';
import type { User } from './auth/types';

function useCurrentUserRequest() {
  const { request } = useAuth();
  return (signal?: AbortSignal) => request<User>('/auth/me', { signal });
}
// Вызовите возвращённую функцию из обработчика или эффекта с AbortController.
// Обработайте ошибку в UI через getErrorMessage(error).
// AbortError при уходе со страницы или logout показывать не нужно.
```

JSON-тело передаётся как объект: `request('/some-endpoint', { method: 'POST', body: payload })`. По умолчанию запрос — GET. Пользовательские заголовки и `AbortSignal` поддерживаются. `auth.request` добавляет Bearer token и централизованно обрабатывает 401/403. Публичный API-клиент самостоятельно сессией не управляет. Для ответа без тела используйте `request<void>(...)`.

Обработка ошибок:

- `network`: соединение не установлено или оборвалось при чтении ответа. HTTP-статуса нет.
- `timeout`: сервер не ответил за 15 секунд. Форма разблокируется для повторной попытки.
- `http`: неуспешный HTTP-статус, доступный через `error.status`. Строковый `detail` FastAPI сохраняется; не-JSON ответы и ошибки сервера получают понятное общее сообщение.
- `validation`: HTTP 422, `issues` содержит `{ field, message }` из `detail[].loc` и `detail[].msg`. Сообщения полей объединяются в строку; неизвестные объекты не превращаются в `[object Object]`. `input` и `ctx` не выводятся.
- `response`: сервер сообщил об успехе, но вернул некорректный JSON.
- `configuration`: отсутствующий/неверный URL или несериализуемое JSON-тело.

Отмена запроса передаётся вызывающему коду без подмены сетевой ошибкой. Тип `T` описывает ожидаемый ответ для TypeScript, но не выполняет runtime-валидацию схемы ответа.

Подтверждённые контракты backend: `POST /auth/register` принимает `email`, `full_name`, `password`, необязательный `role` (`attendee` / `organizer`) и возвращает пользователя, а `POST /auth/login` принимает `email`, `password` и возвращает пару токенов. `GET /auth/me` требует access token. Пароль регистрации: минимум 8 символов, максимум 72 байта UTF-8; последнее ограничение реализовано валидатором и не полностью выражено в OpenAPI.

## Проверки и production build

Выполнять из `web/`:

```powershell
npm run typecheck
npm test
npm run build
```

`build` также запускает TypeScript-проверку и создаёт `web/dist/`. Модульные тесты используют встроенный `node:test` и удаление TypeScript-типов в Node; на Node 22.17 предупреждение об экспериментальном strip-types ожидаемо. `npm test` подменяет `fetch`, не использует сеть и не создаёт записи в базе. Покрыты API-ошибки, переходы сессии, 401/403, logout, отмена запросов, гонки старой и новой сессии, безопасный возврат и UTF-8-валидация.

### Проверка через HTTP

После проверки, что Compose подключён к вашей локальной базе, выполните:

```powershell
npm run check:auth
```

Скрипт обращается только к `http://localhost:8000`, проверяет health, регистрацию посетителя, login, `/auth/me`, неверный пароль и занятый email. **Создаёт одного нового тестового посетителя в локальной базе при каждом запуске**, не удаляет записи и volumes. Не используйте внешнюю/общую базу за этим адресом. В выводе только маршруты, HTTP-статусы и ID тестового пользователя.

### Браузерные проверки

Используется Playwright с установленным Microsoft Edge в headless-режиме. Для другого установленного браузера можно указать `PLAYWRIGHT_CHANNEL=chrome`; для `chromium` предварительно установите соответствующий браузер Playwright. Dev-сервер запускается на `localhost:5173` с локальным API; уже запущенный сервер используется повторно, поэтому проверьте его конфигурацию.

Текущие тестовые перехваты рассчитаны на `http://localhost:8000`. Если на 5173 уже работает frontend с другим API, остановите только этот dev-сервер перед тестами: Playwright запустит свой с нужным `VITE_API_URL`. Менять адрес рабочего backend или локальный env ради этих тестов не требуется.

```powershell
npm run test:browser
```

По умолчанию запускаются проверки с HTTP-фикстурами, без подготовки записей в БД. Для live используйте [новую инструкцию проверяемой изоляции](LIVE-TESTS.md): runner сверяет Docker-контейнеры, volume, фактическое подключение FastAPI к PostgreSQL и API origin браузера до первого POST. DATABASE_URL оболочки не служит доказательством.

Пример для выделенного локального проекта (подставьте свои проверенные API/project/SHA):

```sh
node scripts/run-live.mjs --api http://localhost:8002 --project biletflow-667-live --backend-ref c5b83a851128c486b1b15cebea94c6df8166308d --mode dev --channel msedge
node scripts/run-live.mjs --api http://localhost:8002 --project biletflow-667-live --backend-ref c5b83a851128c486b1b15cebea94c6df8166308d --mode production --channel msedge
```

Production live всегда строит свежий dist с выбранным API. Порт 8002 приведён только как пример окружения Алиби, не как обязательная настройка команды. Один live-прогон создаёт 5 тестовых аккаунтов, 2 события и 2 билета; существующие данные не удаляются.

Регрессия старого dist на двух локальных HTTP-origin без БД:

```sh
npx playwright test --config playwright.isolation.config.mjs
```

Результаты каждого live запуска сохраняются отдельно в игнорируемом Git `test-results/live/`. Для обычной регрессии без перезаписи live-артефактов: `npm run test:browser -- --output test-results/mock-regression`. Не включайте RUN_LIVE_* для неё.

[Историческая приёмка 7 ноября](667-acceptance.md) и [результаты доработки 8 ноября](667-review-2026-11-08.md) разделены. В [LIVE-TESTS.md](LIVE-TESTS.md) указаны ограничения CI, телефона/хостинга, правила публикации безопасных evidence и стыковка с W1.


### Результат проверки FE01 — 28 октября 2026

- TypeScript и production build: успешно.
- 26 модульных тестов: успешно. Обработка 401/403 закрытых запросов и гонки logout проверены здесь с подменёнными HTTP-ответами; истечение реального токена не ожидалось.
- 5 браузерных сценариев в headless Edge: успешно. Регистрация, login, `/auth/me`, неверный пароль, duplicate email, logout и reload проверены через реальные формы с локальным FastAPI. Ошибки сети/422 и небезопасный returnTo дополнительно проверены в браузере с подменой HTTP; мобильная ширина — 375 px.
- Отдельный HTTP-прогон без браузера: `/health` 200, регистрация 201, login 200, `/auth/me` 200, неверный пароль 401, duplicate email 409. Эти сценарии также покрыты браузерным прогоном; HTTP-only проверка в этом списке — `/health`.
- Созданы два тестовых посетителя (HTTP и браузерный сценарий), оба в локальном PostgreSQL Compose. Внешняя база не использовалась.

Для локального просмотра production-сборки сначала остановите dev-сервер, затем выполните `npm run preview` — он использует тот же `localhost:5173` и `strictPort`. На production-хостинге настройте возврат `index.html` для клиентских маршрутов (например, `/events/123`), поскольку используется `BrowserRouter`.

Для ручной проверки откройте `/events/123`, перейдите ко входу, затем к регистрации. После создания аккаунта войдите и проверьте возврат на `/events/123`. Нажмите «Выйти», повторите вход и обновите страницу: сессия должна исчезнуть. Каталог и страница события остаются доступны без входа.

## Проверка интеграционной версии

Результаты реальных браузерных проверок авторизации, билетов и восстановления API приведены в [отчёте аудита](../docs/integration-audit.md).

## Промокоды и QR акции (P3)

На странице `/organizer/events/{id}/campaigns` владелец события или администратор создаёт скидку, выбирает типы билетов, задаёт срок и лимит. Здесь же можно скачать SVG с надписью «Это не билет», выключить акцию и посмотреть выручку и использования. На страницу ведёт ссылка из управления типами билетов.

Ссылка из QR открывает событие и сохраняется при входе в аккаунт. Можно также ввести код вручную при оформлении платного билета. До резерва посетитель видит подтверждённые сервером промокод, скидку и итог. Если лимит закончился между просмотром и заказом, сервер отказывает, и посетитель может убрать код. Для сканирования с телефона нужно настроить доступный HTTPS-адрес сайта в `CAMPAIGN_WEB_ORIGIN` на API.

## Account, organizer, administration and languages

The header offers Russian, Kazakh and English. The choice persists in localStorage. Session tokens remain in memory, so a full reload requires signing in again. The browser, API and mobile app must use the same backend and database. An account registered as an attendee has no organizer role. The organizer pages read the role returned by `GET /auth/me`.

Account routes are `/forgot-password`, `/reset-password?token=...` and `/verify-email?token=...`. Recovery preserves a validated destination through the login link. A reset requires matching passwords. Each link has its own state, and a new link clears an earlier success or refusal; a request still pending for an earlier link is cancelled.

Forgot-password never shows whether an email exists (`forgotPasswordOutcome` in `src/account/model.ts`):

| Answer | Page shows |
| --- | --- |
| `2xx`, and any other refusal that could depend on the account (`400`, `401`, `403`, `409`, …) | The same neutral "if this email is registered, we sent a link" text |
| `5xx`, `404` (the endpoint is missing until backend PR #21), no connection, timeout | The same retryable technical failure for every address |
| `429` | "Too many requests, try a little later" (the API limits per address, registered or not) |
| `422` | "Check the email address": about the format typed, never about an account |

The verification banner disables "send again" for a minute after each attempt. That is a client courtesy, not a server contract: the backend's own limit (PR #21) answers `429`, which the banner reports as too many requests.

**Deferred: server logout.** The account endpoints and `POST /auth/logout` come with backend PR #21, which is not merged into integration. Until it is, "Sign out" clears only the memory session (token, user, notices) and cancels its requests; no logout request is sent, and a browser test checks that. Calling `POST /auth/logout` with the refresh token is a follow-up for after PR #21. Account browser tests use mocked HTTP. Live validation of email links and server logout remains pending.

**Deviation: 403 instead of 404 for admin pages.** A signed-in non-admin who opens `/admin/...` sees a "403 — access denied" screen rather than the 404 page. The routes are public in the bundle anyway, and the screen says why nothing is shown. The API refuses every admin request with 403 regardless.

Organizers open `/organizer`, `/organizer/events/new` and `/organizer/events/{id}/edit`. Admins open `/admin/users`, `/admin/events` and `/admin/action-log`. The server checks roles and event ownership on every request. The web refuses non-admin navigation locally, and signed-out admin navigation returns through the public catalog. Mutation controls require confirmation. Administrator accounts have no suspension controls in the UI, and the activity log is read only.

The language switch covers these pages, the public event and ticket flow, dates and API errors. Errors and notices already on screen follow a switch without a new request: pages keep the error itself (or a notice key) and translate it while rendering, and `ApiError` carries a `Localized` text instead of a fixed string. Server wording (FastAPI `detail`, `422` issues) is English and is replaced by translated texts. Prices use the selected locale and omit decimals for whole tenge. Kazakh dates and numbers are written out by `src/i18n/format.ts`, so a browser without Kazakh ICU data (Edge printed "2030 M11 15") still shows "15 қараша 2030, 17:00". Ticket-type management and the P2 checkout, order and activation text still need a separate translation pass. Kazakh text needs native review before the defense.

## Accessibility

`tests/browser/accessibility.spec.mjs` runs axe-core (dev dependency `@axe-core/playwright` 4.14.0) with the WCAG 2.1/2.2 A and AA rules on the catalogue, event, sign-in, registration, password pages, 404, my tickets, a ticket with its full-screen QR, the organizer cabinet and editor, and the three admin sections, at 375 and 1280 px, and on the catalogue and registration in all three languages. Any violation fails the browser suite. The same file checks the keyboard paths axe cannot see: the skip link, the visible focus ring, and confirmation steps that take focus on the safe answer and give it back when closed. The full-screen ticket QR is a native modal dialog (Esc, focus trap, focus returned to its button).

The language switch shows each language's own name ("Қазақша", "Русский", "English") as its visible text, so the accessible name matches what is seen (WCAG 2.5.3). axe does not judge Kazakh wording; native review is still needed.

## Возвраты и бесплатные регистрации (P5)

Условия возврата настраиваются при создании или редактировании события. Посетитель видит их
на странице события и при оформлении заказа.

Ссылка «Заказы и возвраты» в кабинете открывает `/organizer/events/{id}/orders`. Организатор
может отменить бесплатную регистрацию или подтвердить полный демо-возврат оплаченного
заказа. Для отменённого события есть массовое действие. Если по билету уже прошли на входе,
перед возвратом нужно отменить отметку. Во вкладке «Мои заказы» посетитель видит сумму и дату
возврата, а в сводке активации обновляются возвраты и расчёт выплаты.

## P2 demo checkout

Paid types on activated events lead from `/events/:id` to `/events/:id/checkout?type=:typeId`,
then `/orders/:id`. `/orders` lists the authenticated buyer's orders. The server computes
prices and fees; the browser never adds a surcharge. Every payment screen says
«Демонстрационная оплата, деньги не списываются». Success and failure buttons call the
simulated provider endpoint. Retries reuse the order or creation request UUID. A definitive
422 allows correcting the form; uncertain delivery preserves the original request payload.

Organizers use `/organizer/events/:id/activation`, linked from ticket type management, for
the demo checklist and sales summary. Profile identity/payout confirmations apply to their
own profile. The payout form accepts only a four-character demo suffix, never real account
details. Admins can suspend/restore paid sales from this page. Financial refunds belong to P5.

P2 uses the existing authenticated API client, strict response readers and plain CSS classes.
It adds no dependencies. `npm test` covers contract readers, amount invariants, safe return
URLs and availability. `tests/browser/orders.spec.mjs` covers success/failure checkout and
activation with HTTP fixtures; run it as part of `npm run test:browser`.
