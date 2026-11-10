# BiletFlow

Интеграционная версия команды Palantir для CSCI 361. FastAPI и PostgreSQL обслуживают React-клиент посетителя и Expo-клиент сотрудника.

- Web. Публичные события, регистрация и вход, получение бесплатного билета, список своих билетов и QR.
- Backend. JWT, роли, публикация и отмена событий, выдача билетов, назначение сотрудников и идемпотентный check-in.
- Mobile. Вход сотрудника, список доступных событий, сканирование QR и повтор запроса с тем же `request_id` после неопределённого ответа в открытой сессии.

Результаты проверок и список оставшихся рисков находятся в [отчёте аудита](docs/integration-audit.md). Сценарии для показа и ручной приёмки собраны в [чек-листе команды](docs/manual-acceptance.md).

## 1. Скачать единую версию

Установите Node.js 24 и npm. Для запуска backend используйте Docker Compose или локальную PostgreSQL с Python 3.12+. Команды ниже рассчитаны на PowerShell.

```powershell
git clone --branch integration/biletflow-e2e https://github.com/IliyasNU/palantir.git biletflow
cd biletflow
```

## 2. Запустить PostgreSQL и API

Из корня нового checkout. Блок создаёт локальный `.env` только при его отсутствии. Данные проекта Compose `biletflow-test` хранятся в отдельном томе. Если имя уже используется, выберите новое и используйте его во всех командах.

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  $biletflowDbPassword = node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
  $biletflowJwtSecret = node -e "console.log(require('node:crypto').randomBytes(64).toString('hex'))"
  $biletflowConfig = Get-Content -LiteralPath .env.example -Raw
  $biletflowConfig = $biletflowConfig.Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$biletflowDbPassword")
  $biletflowConfig = $biletflowConfig.Replace('JWT_SECRET_KEY=', "JWT_SECRET_KEY=$biletflowJwtSecret")
  Set-Content -LiteralPath .env -Value $biletflowConfig -Encoding ascii
}
docker compose -p biletflow-test up --build -d
docker compose -p biletflow-test ps
docker compose -p biletflow-test exec backend alembic current
Invoke-RestMethod http://127.0.0.1:8000/health
```

Ожидается `0003 (head)` и `{"status":"ok","database":"up"}`. Compose запускает PostgreSQL, ждёт `pg_isready` и применяет `alembic upgrade head` перед стартом API. Если контейнер backend ещё запускается, дождитесь окончания миграций и повторите `/health` перед открытием форм. При ошибке смотрите `docker compose -p biletflow-test logs backend db`. Для остановки используйте `docker compose -p biletflow-test stop`, чтобы сохранить данные.

При прямом запуске создайте отдельную PostgreSQL `biletflow_test` с собственным пользователем и паролем. В `backend/.env` укажите реальный `DATABASE_URL` в формате `postgresql+psycopg://USER:PASSWORD@127.0.0.1:5432/biletflow_test`, созданный `JWT_SECRET_KEY` и `CORS_ORIGINS=http://localhost:5173`. Используйте фактический порт PostgreSQL. Спецсимволы в имени и пароле URI должны быть закодированы. pgAdmin управляет PostgreSQL через интерфейс.

```powershell
cd backend
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Отредактируйте backend/.env перед запуском.
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m alembic current
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Для production задайте `ENVIRONMENT=production` и случайный ключ. Допустимы `HS256`, `HS384`, `HS512` с минимумом 32, 48 и 64 байт соответственно. Пустые и известные примерные ключи отклоняются при запуске. Храните секреты только в локальном `.env` или менеджере секретов окружения.

## 3. Запустить web

В отдельной консоли из корня checkout.

```powershell
cd web
if (-not (Test-Path -LiteralPath .env.local)) { Copy-Item .env.example .env.local }
npm ci
npm run dev
```

Откройте `http://localhost:5173/register`. В `web/.env.local` задайте `VITE_API_URL=http://127.0.0.1:8000`, если API запущен на этом компьютере. Для другого окружения подставьте реальный базовый URL и перезапустите Vite. `VITE_API_URL` нужен также при `npm run build`. Опубликованному HTTPS-сайту нужен доступный HTTPS API, его точный frontend origin должен быть разрешён в `CORS_ORIGINS`.

На тестовой базе создайте организатора через `POST /auth/register` с ролью `organizer`. Откройте `http://127.0.0.1:8000/docs`, войдите как организатор, создайте событие через `POST /events` и опубликуйте через `POST /events/{id}/publish`. Зарегистрируйте отдельного сотрудника и назначьте его через `POST /events/{id}/staff` с JSON `{"email":"адрес-тестового-сотрудника"}`. В web зарегистрируйте посетителя, войдите, откройте событие и нажмите «Получить бесплатный билет». Билет также открывается из «Мои билеты». Сессия web хранится в памяти, после обновления страницы войдите снова.

## 4. Запустить mobile и проверить телефон

Для LAN-теста запустите API с привязкой к LAN-интерфейсу. Для Compose задайте `API_BIND_HOST=0.0.0.0` в локальном `.env` и повторите `up -d`. Для прямого запуска укажите `--host 0.0.0.0`. На доверенной тестовой сети проверьте с телефона `http://<IP-компьютера>:8000/health`. `127.0.0.1` на телефоне указывает на сам телефон.

```powershell
cd mobile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Замените пример EXPO_PUBLIC_API_URL на фактический адрес API в mobile/.env.
npm ci
npm start
```

Используйте Expo Go с поддержкой SDK 58 или сборку для устройства. На физическом iPhone войдите в Expo CLI и Expo Go одним аккаунтом. Для входа в CLI из Windows PowerShell используйте `npx.cmd expo login` в папке `mobile`. Подробные проверки камеры, двух сканов, доступа и восстановления после потери ответа описаны в [инструкции mobile](mobile/README.md). Переменные `VITE_*` и `EXPO_PUBLIC_*` входят в клиентские сборки и содержат только адрес API.

## Проверки

| Компонент | Команды из папки компонента |
| --- | --- |
| Backend | `python -m pytest -q tests` |
| PostgreSQL | `python -m pytest -q e2e` с явной тестовой конфигурацией из [инструкции backend](backend/README.md#end-to-end-tests-against-postgresql) |
| Web | `npm test`, `npm run typecheck`, `npm run build`, `npm run test:browser` |
| Mobile | `npm test`, `npm run typecheck`, `npm run lint`, `npx expo export --platform android`, `npx expo export --platform ios` |

Browser-проверки с настоящим API создают тестовые аккаунты и события. Флаги и порядок реального прогона описаны в [отчёте аудита](docs/integration-audit.md).
