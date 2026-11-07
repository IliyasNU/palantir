import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { liveApiUrl, requireTestDatabase } from './live-api.mjs';

test('667 live: public lifecycle, returnTo, own ticket, failures and production deep links at 375px', async ({ page, request }, testInfo) => {
  test.skip(process.env.RUN_LIVE_667 !== '1', 'Requires explicitly verified isolated API and database; retains created test records.');
  test.setTimeout(180000);
  requireTestDatabase();
  const base = liveApiUrl();
  const run = randomUUID();
  const password = randomUUID();
  const ownerEmail = `667-owner-${run}@example.com`;
  const visitorEmail = `667-visitor-${run}@example.com`;
  const observations = [];
  const mark = (scenario, evidence) => observations.push({ scenario, evidence });
  const call = async (method, path, data, headers = {}, expected = 200) => {
    const response = await request.fetch(base + path, { method, data, headers });
    expect(response.status(), `${method} ${path}`).toBe(expected);
    return response.json();
  };
  const login = async () => {
    await page.getByLabel('Email', { exact: true }).fill(visitorEmail);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  };
  const fits = async () => {
    expect(await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth })))
      .toEqual({ width: 375, content: 375 });
  };
  const screenshot = async (name) => {
    await fits();
    await page.screenshot({ path: testInfo.outputPath(name + '.png'), fullPage: true });
  };

  // API setup only: unique organizer and a draft event, never shared/team events.
  const organizer = await call('POST', '/auth/register',
    { email: ownerEmail, password, full_name: '667 Test Organizer', role: 'organizer' }, {}, 201);
  const ownerSession = await call('POST', '/auth/login', { email: ownerEmail, password });
  const ownerHeaders = { Authorization: `Bearer ${ownerSession.access_token}` };
  const event = await call('POST', '/events', {
    title: `667 Live Concert ${run}`, description: 'Реальное тестовое событие для приёмки Алиби. Только выделенная БД.',
    date: '2030-11-07T12:30:00Z', location: 'Тестовый зал 667', capacity: 1,
  }, ownerHeaders, 201);
  const eventPath = `/events/${event.id}`;
  const eventLink = page.getByRole('link', { name: event.title, exact: true });
  expect(event.status).toBe('draft');
  expect((await call('GET', '/events')).some(item => item.id === event.id)).toBe(false);
  await page.goto('/events');
  await expect(page.getByRole('status')).not.toContainText('Загружаем');
  await expect(eventLink).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await fits();
  mark(1, { api: 'public GET /events excludes draft', ui: 'catalog has no draft link', eventId: event.id });

  // Publication is API preparation, its visibility is verified in the browser.
  await call('POST', eventPath + '/publish', undefined, ownerHeaders);
  const serverEvent = await call('GET', eventPath);
  await page.reload();
  await expect(eventLink).toBeVisible();
  const catalogCard = page.getByRole('article').filter({ has: eventLink });
  await expect(catalogCard).toContainText(serverEvent.location);
  await expect(catalogCard.locator('time')).toHaveAttribute('datetime', serverEvent.date);
  mark(2, { api: 'publish 200', ui: 'published link visible to guest' });

  const publicRequests = [];
  page.on('request', req => {
    if (req.url().startsWith(base + '/events')) publicRequests.push({ url: req.url(), method: req.method(), auth: !!req.headers().authorization });
  });
  const search = page.getByLabel('Поиск по названию', { exact: true });
  await search.fill('  ' + run.slice(0, 12).toUpperCase() + '  ');
  await expect(eventLink).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Найдено событий: 1');
  await search.fill('no-matching-event-' + randomUUID());
  await expect(page.getByRole('heading', { name: 'Ничего не найдено', exact: true })).toBeVisible();
  await expect(eventLink).toHaveCount(0);
  await fits();
  await page.getByRole('button', { name: 'Сбросить поиск' }).click();
  await expect(eventLink).toBeVisible();
  expect(publicRequests).toHaveLength(0); // Search is local: no q or additional requests.
  mark(4, { ui: 'trimmed uppercase partial title matches; separate no-results state; no search HTTP requests' });

  await eventLink.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(serverEvent.title);
  const article = page.getByRole('article');
  await expect(article).toContainText(serverEvent.description);
  await expect(article).toContainText(serverEvent.location);
  await expect(article).toContainText('Опубликовано');
  await expect(article).toContainText('Осталось мест: ' + Math.max(0, serverEvent.capacity - serverEvent.tickets_issued));
  await expect(article.locator('time')).toHaveAttribute('datetime', serverEvent.date);
  const localTime = await page.evaluate(date => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(date)), serverEvent.date);
  await expect(article.locator('time')).toHaveText(localTime);
  expect(publicRequests.every(req => req.method === 'GET' && !req.auth && !new URL(req.url).search)).toBe(true);
  await screenshot('published-details-375');
  mark(3, { id: event.id, title: serverEvent.title, description: serverEvent.description, location: serverEvent.location, date: serverEvent.date, localTime, status: serverEvent.status, capacity: serverEvent.capacity, ticketsIssued: serverEvent.tickets_issued });

  await page.goto(eventPath);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(event.title);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(event.title);
  await fits();
  mark(5, { ui: 'direct event URL and reload load the real event' });
  await page.goto('/events/2147483647');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Событие не найдено');
  await fits();
  const abort = route => route.abort('failed');
  await page.route(base + '/events', abort);
  await page.goto('/events');
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить события');
  await expect(page.getByRole('heading', { name: 'Событий пока нет', exact: true })).toHaveCount(0);
  await search.fill(run.slice(0, 12));
  await expect(search).toHaveValue(run.slice(0, 12));
  await page.unroute(base + '/events', abort);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(eventLink).toBeVisible();
  await expect(search).toHaveValue(run.slice(0, 12));
  await page.route(base + eventPath, abort);
  await eventLink.click();
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить событие');
  await page.unroute(base + eventPath, abort);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(event.title);
  mark(6, { api: 'unknown ID 404', faultInjection: 'browser abort only for catalog/details; retry resumes real API; query retained' });

  // Visitor registration and ticket claim happen through the actual UI.
  await page.getByRole('link', { name: 'Войти, чтобы получить билет', exact: true }).click();
  await fits();
  await page.getByRole('link', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(page).toHaveURL('/register?returnTo=' + encodeURIComponent(eventPath));
  await page.getByLabel('Имя', { exact: true }).fill('667 Live Visitor');
  await page.getByLabel('Email', { exact: true }).fill(visitorEmail);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await fits();
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(page).toHaveURL('/login?returnTo=' + encodeURIComponent(eventPath));
  await expect(page.getByRole('status')).toContainText('Аккаунт создан');
  await login();
  await expect(page).toHaveURL(eventPath);
  await expect(page.getByRole('navigation')).toContainText('667 Live Visitor');
  const claimResponse = page.waitForResponse(response => response.url() === base + eventPath + '/tickets' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Получить бесплатный билет', exact: true }).click();
  const claimed = await claimResponse;
  expect(claimed.status()).toBe(201);
  const ticket = await claimed.json();
  const ticketPath = '/tickets/' + ticket.id;
  await expect(page).toHaveURL(ticketPath);
  await expect(page.getByRole('article')).toContainText('Билет №' + ticket.id);
  await expect(page.getByRole('img', { name: 'QR-код билета для проверки на входе' })).toBeVisible();
  await fits(); // Do not persist screenshots of usable QR codes.
  mark(7, { ui: 'event → login → register → login → same event', visitorId: ticket.attendee_id });
  const visitorSession = await call('POST', '/auth/login', { email: visitorEmail, password });
  const visitorHeaders = { Authorization: `Bearer ${visitorSession.access_token}` };
  const repeated = await call('POST', eventPath + '/tickets', undefined, visitorHeaders);
  expect(repeated.id).toBe(ticket.id);
  expect((await call('GET', '/tickets/me', undefined, visitorHeaders)).filter(item => item.event_id === event.id)).toHaveLength(1);
  expect((await call('GET', eventPath)).tickets_issued).toBe(1);
  mark(8, { ui: 'claim 201 opens real ticket and QR', httpOnly: 'repeat 200 returns same ID; one own ticket and tickets_issued=1', ticketId: ticket.id });

  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await expect(article).toContainText('Осталось мест: 0');
  await expect(page.getByRole('link', { name: 'Открыть мой билет', exact: true })).toBeVisible();
  await screenshot('sold-out-owner-375');
  await page.getByRole('link', { name: 'Открыть мой билет', exact: true }).click();
  await expect(page).toHaveURL(ticketPath);

  // A malformed bearer reaches the real API and produces 401; no successful response is mocked.
  const invalidBearer = route => route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer invalid-667-test-token' } });
  await page.route(base + '/tickets/me', invalidBearer);
  const unauthorizedResponse = page.waitForResponse(response => response.url() === base + '/tickets/me' && response.status() === 401);
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await unauthorizedResponse;
  await expect(page.getByRole('link', { name: 'Войти снова', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0);
  await page.unroute(base + '/tickets/me', invalidBearer);
  await page.getByRole('link', { name: 'Войти снова', exact: true }).click();
  await login();
  await expect(page).toHaveURL(eventPath);
  await expect(page.getByRole('link', { name: 'Открыть мой билет', exact: true })).toBeVisible();

  // Ticket routes allow any active user, so 403 cannot naturally occur here.
  // Replay the real API's denial of attendee publication into the ticket lookup.
  // It exercises frontend handling without changing accounts or creating fake successful data.
  await page.getByRole('link', { name: 'Открыть мой билет', exact: true }).click();
  const forbidden = await request.post(base + eventPath + '/publish', { headers: visitorHeaders });
  expect(forbidden.status()).toBe(403);
  const replayForbidden = route => route.fulfill({ response: forbidden });
  await page.route(base + '/tickets/me', replayForbidden);
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'У вас нет прав для этого действия с билетом.' })).toBeVisible();
  await expect(page.getByRole('navigation')).toContainText('667 Live Visitor');
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  await fits();
  await page.unroute(base + '/tickets/me', replayForbidden);
  await page.getByRole('button', { name: 'Проверить мои билеты', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Открыть мой билет', exact: true })).toBeVisible();
  mark(11, { real401: 'invalid bearer → server401 → logout → login returns to event', real403: 'attendee publish denied by server403', injected403: 'replayed into ticket lookup; readable error, session retained, retry restores own ticket' });

  await call('POST', eventPath + '/cancel', undefined, ownerHeaders);
  // SPA navigation refreshes event data and retains the in-memory session.
  await page.getByRole('link', { name: 'Открыть мой билет', exact: true }).click();
  await expect(page).toHaveURL(ticketPath);
  await expect(page.getByRole('status')).toContainText('Событие отменено');
  await expect(page.getByRole('img', { name: 'QR-код билета для проверки на входе' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Открыть событие', exact: true }).click();
  await expect(article).toContainText('Событие отменено');
  await expect(article).toContainText('Осталось мест: 0');
  await expect(page.getByRole('link', { name: 'Открыть мой билет', exact: true })).toBeVisible();
  await screenshot('cancelled-owner-375');
  await page.getByRole('link', { name: 'Открыть мой билет', exact: true }).click();
  await expect(page).toHaveURL(ticketPath);
  await expect(page.getByRole('status')).toContainText('Событие отменено');
  mark(9, { ui: 'own ticket opens for full and cancelled event; cancellation is explicit and QR hidden' });
  await page.getByRole('navigation').getByRole('link', { name: 'События', exact: true }).click();
  await expect(page.getByRole('status')).not.toContainText('Загружаем');
  await expect(eventLink).toHaveCount(0);
  expect((await call('GET', '/events')).some(item => item.id === event.id)).toBe(false);
  mark(10, { api: 'cancelled absent in public GET /events', ui: 'no cancelled link' });

  await page.goto(eventPath); // Memory session is deliberately lost.
  await expect(article).toContainText('Событие отменено');
  await expect(page.getByRole('link', { name: 'Войти и проверить мои билеты', exact: true })).toBeVisible();
  await page.goto(ticketPath);
  await expect(page.getByRole('link', { name: 'Войти и открыть билет', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: 'Войти и открыть билет', exact: true }).click();
  await login();
  await expect(page).toHaveURL(ticketPath);
  await expect(page.getByRole('status')).toContainText('Событие отменено');
  await fits();
  mark(12, { browser: 'Edge headless', viewport: '375x812', ui: 'catalog, details, login, registration, ticket and transitions; no horizontal overflow', phone: 'not tested' });
  mark(13, { mode: process.env.BILETFLOW_PRODUCTION_PREVIEW === '1' ? 'production vite preview' : 'Vite dev', eventAndTicketDirectLinks: true, reload: true, hosting: 'external hosting / production SPA fallback not tested' });
  const evidence = {
    run, completedAt: new Date().toISOString(), api: base,
    frontendBase: process.env.BILETFLOW_FRONTEND_SHA || 'record separately',
    frontendState: 'uncommitted acceptance changes; see report fingerprint',
    backendSha: process.env.BILETFLOW_BACKEND_SHA || 'record separately',
    organizerId: organizer.id, eventId: event.id, ticketId: ticket.id,
    observations: observations.sort((a, b) => a.scenario - b.scenario),
  };
  await writeFile(testInfo.outputPath('evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('667 live evidence:', JSON.stringify(evidence));
});
