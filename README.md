# BiletFlow / Palantir

Проект команды Palantir, CSCI 361, Nazarbayev University. Веб-клиент: React + TypeScript + Vite; API: FastAPI + PostgreSQL.

## Проверенные версии

На 7 ноября 2026 frontend находится в `feature/frontend` (`e41c821eaea181bf1648cdd88934c27a740186b7`), backend с билетами и check-in — в `feature/temirlan-tickets-checkin` (`26d0dbd58aaea5fc44d63144155d14fdeb8ad67a`). `recovery/backend` и backend внутри frontend-ветки старее. Исправления подключения находятся в `fix/web-api-connection`. Ветки не объединяются автоматически. Мобильный код не меняется.

Подробности компонентов и существующих проверок: [web/README.md](web/README.md).

## Запуск для Санжара: отдельная тестовая база

Нужны Git, Docker Desktop с запущенным Docker Engine, Node.js 22.17+ (ветка 22) либо 24+, npm 10+. Следующие команды PowerShell создают два отдельных checkout в свободной рабочей папке. Если имена папок уже заняты, выберите другие; существующие checkout и env не перезаписывайте.

```powershell
git clone --branch fix/web-api-connection https://github.com/IliyasNU/palantir.git biletflow-web
git clone --branch feature/temirlan-tickets-checkin https://github.com/IliyasNU/palantir.git biletflow-api-test
cd biletflow-api-test
git checkout --detach 26d0dbd58aaea5fc44d63144155d14fdeb8ad67a
$env:POSTGRES_USER = "biletflow_test"
$env:POSTGRES_DB = "biletflow_test"
$env:POSTGRES_PASSWORD = [guid]::NewGuid().ToString("N")
$env:JWT_SECRET_KEY = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$env:ENVIRONMENT = "test"
$env:DB_PORT = "55432"
$env:BACKEND_PORT = "8000"
$env:CORS_ORIGINS = "http://localhost:5173"
docker compose -p biletflow-auth-test up --build -d
docker compose -p biletflow-auth-test ps
docker compose -p biletflow-auth-test exec backend alembic current
Invoke-RestMethod http://localhost:8000/health
```

Имя Compose-проекта выделяет отдельный volume `biletflow-auth-test_postgres_data`. Используйте новый проект для этой проверки. Не подключайте к нему рабочую базу. Compose сначала ждёт PostgreSQL через `pg_isready`, затем выполняет `alembic upgrade head` (миграции 0001 и 0002) и запускает API. У `alembic current` ожидается `0002 (head)`; `/health` должен вернуть `status: ok`, `database: up`. Health проверяет соединение с БД, но не заменяет проверку миграций. При ошибке смотрите `docker compose -p biletflow-auth-test logs backend db`.

Пароль БД и JWT secret генерируются только в окружении этой консоли. Сохраните её открытой для последующих Compose-команд; не выводите секреты и не добавляйте их в Git. Compose читает переменные процесса или корневой `.env`, а не `backend/.env`. Для повторного использования существующего volume нужны его прежние учётные данные. Не удаляйте volumes для исправления подключения. Если 8000 занят, выберите свободный `BACKEND_PORT` и тот же порт во frontend; встроенные live-тесты рассчитаны именно на 8000.

В другой консоли, из рабочей папки:

```powershell
cd biletflow-web/web
Copy-Item .env.example .env.local
# Убедитесь: VITE_API_URL=http://localhost:8000
npm ci
npm run dev
```

Откройте `http://localhost:5173/register`. `VITE_API_URL` — реальный базовый адрес доступного API, без `/auth/register` или `/events`; пример localhost относится только к API, запущенному выше на этом компьютере. Vite не подбирает порт API и не переключается автоматически на 80. После изменения env перезапустите Vite. Для production задайте адрес до сборки, пересоберите и опубликуйте новую сборку. Проверьте переопределения из переменных процесса и файлов `.env.[mode].local`, `.env.[mode]`, `.env.local`, `.env` (в этом порядке). Секреты в `VITE_*` запрещены: они видны браузеру.

## Localhost, телефон и опубликованный сайт

- На том же компьютере используйте `http://localhost:5173` и фактический адрес API. `http://127.0.0.1:5173` — другой origin; добавляйте его в `CORS_ORIGINS` только если действительно используете его.
- На телефоне `localhost` означает телефон. В одной доверенной LAN используйте действительный LAN-адрес компьютера для frontend и API; frontend запускайте `npm run dev -- --host 0.0.0.0`. Задайте в `VITE_API_URL` доступный с телефона LAN-адрес API с его портом, в `CORS_ORIGINS` — точный origin фронтенда с портом 5173. Затем перезапустите оба сервера. Адрес LAN здесь намеренно не выдумывается.
- Для опубликованного HTTPS frontend нужен доступный HTTPS API; HTTP API браузер может заблокировать как mixed content. `localhost` компьютера разработчика с опубликованного сайта недоступен другим пользователям. В `CORS_ORIGINS` укажите точный опубликованный origin (схема, хост, порт; без пути и завершающего `/`). Адрес API должен предоставить владелец сервера.

Не заменяйте CORS на `*` и не отключайте авторизацию. Backend уже принимает `CORS_ORIGINS` через окружение; править его код без известного origin не требуется. OPTIONS проверяйте в браузере вместе с POST, в том числе разрешение `content-type` и `authorization`.

## Диагностика регистрации

В DevTools откройте Network и Console, очистите список, отправьте форму. Не сохраняйте HAR с паролями и токенами.

| Наблюдение | Что проверять |
| --- | --- |
| Ошибка настройки API, POST отсутствует | `VITE_API_URL` отсутствует или некорректен; ошибка возникает до fetch. Новые сообщения различают эти случаи и указывают перезапуск/сборку. |
| POST /auth/register | Request URL должен быть фактический API + `/auth/register`; JSON поля: `email`, `full_name`, `password`, `role: "attendee"`. Не публикуйте значения пароля. |
| 201 | Ответ — UserRead, не токены; форма переводит на login. |
| 409 | `detail: "A user with this email already exists"`; UI сообщает о занятом email. |
| 422 | Серверная валидация, смотрите безопасные `detail`/`loc`/`msg`; пароль от 8 символов, не более 72 UTF-8 байт. |
| Нет HTTP-статуса / Failed to fetch | Проверьте `/health`, доступность адреса с данного устройства, OPTIONS/CORS и Console на mixed content. Это не доказательство ошибки полей регистрации. |
| 5xx | Проверьте логи backend, PostgreSQL и миграции. |

Вход: POST `/auth/login` с JSON `{email,password}` → 200 с парой токенов, затем GET `/auth/me` с Bearer access token → пользователь. Неверный пароль → 401 `Incorrect email or password`. Сессия становится активной после `/auth/me`. «Выйти» очищает сессию в памяти; серверного `/auth/logout` нет, reload тоже сбрасывает сессию.

## Проверки

Из `biletflow-web/web`:

```powershell
npm run typecheck
npm test
npm run build
npm run check:auth
$env:RUN_LIVE_AUTH = "1"
npm run test:browser
Remove-Item Env:RUN_LIVE_AUTH
```

Для browser-тестов по умолчанию нужен установленный Edge. Альтернатива: `npx playwright install chromium` и `$env:PLAYWRIGHT_CHANNEL = "chromium"`. Перед live-тестами подтвердите, что localhost:8000 обслуживает именно выделенную тестовую базу. Они создают тестовых посетителей. Модульные и обычные browser-тесты используют изолированные HTTP-ответы; только opt-in live-сценарии проверяют настоящий API.

Ручной прогон: новый посетитель → занятый email → пустое имя/короткий пароль → неправильный пароль → правильный пароль и `/auth/me` → выход. Для недоступного API выполните `docker compose -p biletflow-auth-test stop backend` в первой консоли, повторите регистрацию: должна быть сетевая ошибка, без ложного успеха. Выполните `docker compose -p biletflow-auth-test start backend`, дождитесь health и повторите форму с тем же ещё не зарегистрированным email; пароль после попытки нужно ввести снова.

Workflow [.github/workflows/web-api-integration.yml](.github/workflows/web-api-integration.yml) запускает отдельный PostgreSQL service, checkout backend строго по SHA, миграции, health/CORS, существующие backend unit-тесты, frontend tests/typecheck/build и реальный HTTP/browser auth. Настоящие секреты и локальные env он не использует.

## Статус проверки 7 ноября 2026

Код, ветки, конфигурация и контракты изучены через браузер. Адрес frontend/API разработчик не предоставил; локальные `localhost:5173` и `localhost:8000/health` вернули `ERR_CONNECTION_REFUSED`. Конкретный runtime POST проблемного frontend и его env недоступны.

[Попытка GitHub Actions](https://github.com/IliyasNU/palantir/actions/runs/42281332789) остановлена **до выполнения job**: `The job was not started because your account is locked due to a billing issue.` Поэтому новые тесты, TypeScript, сборка, миграции и live-интеграция в этой проверке не подтверждены. Исторические успешные проверки в web/README относятся к прежним датам.

Для завершения нужен работающий тестовый frontend и API с доступом к запуску/логам либо восстановленный GitHub Actions runner. От владельца окружения нужны URL, фактический frontend origin, версия backend и подтверждение отдельной тестовой БД; пароли и токены в чат не присылайте.
