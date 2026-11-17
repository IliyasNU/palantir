import { test, expect } from '@playwright/test';
import { eventDetails, timedTicketType } from './event-fixture.mjs';

const base = 'http://localhost:8000';
async function login(page, destination, role = 'attendee') {
  await page.route(`${base}/auth/login`, (r) => r.fulfill({ json: { access_token: 'fixture-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (r) => r.fulfill({ json: { id: 7, role, full_name: 'Demo User', email: 'demo@example.com', is_active: true, created_at: '2030-01-01T00:00:00Z' } }));
  await page.goto(`/login?returnTo=${encodeURIComponent(destination)}`);
  await page.getByLabel('Email', { exact: true }).fill('demo@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(destination);
}

for (const outcome of ['success', 'failure']) {
  test(`paid buy flow ${outcome} has server totals and simulation labels`, async ({ page }) => {
    const kind = { ...timedTicketType, price_tiyn: 10050, sales_start: null, sales_end: null };
    let order;
    await page.route(`${base}/tickets/me`, (r) => r.fulfill({ json: [] }));
    await page.route(`${base}/events/42`, (r) => r.fulfill({ json: { ...eventDetails, ticket_types: [kind], paid_sales_available: true } }));
    await page.route(`${base}/events/42/orders`, (r) => {
      const body = r.request().postDataJSON();
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      order = { ...body, id: 81, event_id: 42, buyer_id: 7, status: 'pending', subtotal_tiyn: 10050,
        processing_fee_tiyn: 302, total_tiyn: 10050, ticket_id: null, expires_at: '2030-01-01T10:00:00Z', simulation: true };
      return r.fulfill({ status: 201, json: order });
    });
    await page.route(`${base}/orders/81`, (r) => r.fulfill({ json: order }));
    await page.route(`${base}/orders/81/pay`, (r) => {
      expect(r.request().postDataJSON()).toEqual({ outcome });
      order = { ...order, status: outcome === 'success' ? 'paid' : 'failed', ticket_id: outcome === 'success' ? 91 : null };
      return r.fulfill({ json: order });
    });
    await login(page, '/events/42');
    await page.getByRole('button', { name: 'Купить', exact: true }).click();
    await expect(page).toHaveURL('/events/42/checkout?type=1');
    await expect(page.getByText('Демонстрационная оплата, деньги не списываются', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить к оплате' }).click();
    await expect(page).toHaveURL('/orders/81');
    await expect(page.getByText(/Итого покупателю/)).toContainText('100,50');
    await expect(page.getByText(/Комиссия из выручки/)).toContainText('3,02');
    await page.getByRole('button', { name: outcome === 'success' ? 'Имитировать успешную оплату' : 'Имитировать отказ оплаты' }).click();
    if (outcome === 'success') await expect(page.getByRole('link', { name: 'Открыть билет' })).toHaveAttribute('href', '/tickets/91');
    else { await expect(page.getByRole('heading', { name: /Оплата отклонена/ })).toBeVisible(); await expect(page.getByRole('link', { name: 'Открыть билет' })).toHaveCount(0); }
  });
}

test('campaign link survives sign-in and checkout uses the quoted promo code', async ({ page }) => {
  const token = 'pc_' + 'a'.repeat(32);
  const code = 'BF-ABCDEF123456';
  const path = '/events/42?campaign=' + token;
  const kind = { ...timedTicketType, price_tiyn: 10050, sales_start: null, sales_end: null };
  await page.route(base + '/events/42', r => r.fulfill({json: {...eventDetails, paid_sales_available: true, ticket_types: [kind]}}));
  await page.route(base + '/tickets/me', r => r.fulfill({json: []}));
  await page.route(base + '/events/42/campaigns/quote', r => {
    const body = r.request().postDataJSON();
    expect(body.token).toBe(token);
    const pricing = body.ticket_type_id === null
      ? {ticket_type_id: null, subtotal_tiyn: null, discount_tiyn: null, total_tiyn: null}
      : {ticket_type_id: 1, subtotal_tiyn: 10050, discount_tiyn: 2513, total_tiyn: 7537};
    return r.fulfill({json: {code, ...pricing}});
  });
  let order;
  await page.route(base + '/events/42/orders', r => {
    const body = r.request().postDataJSON();
    expect(body.promo_code).toBe(code);
    expect(body).not.toHaveProperty('total_tiyn');
    expect(body).not.toHaveProperty('discount_tiyn');
    order = {...body, id: 81, event_id: 42, buyer_id: 7, status: 'pending', campaign_id: 5,
      subtotal_tiyn: 10050, discount_tiyn: 2513, total_tiyn: 7537, processing_fee_tiyn: 226,
      ticket_id: null, expires_at: '2030-01-01T10:00:00Z', simulation: true};
    return r.fulfill({status: 201, json: order});
  });
  await page.route(base + '/orders/81', r => r.fulfill({json: order}));
  await page.goto(path);
  await expect(page.getByRole('status').filter({hasText: code})).toBeVisible();
  const signIn = page.getByRole('link', {name: 'Войти, чтобы получить билет'});
  const returnTo = new URL(await signIn.getAttribute('href'), page.url()).searchParams.get('returnTo');
  expect(returnTo).toBe(path);
  await login(page, returnTo);
  await page.getByRole('button', { name: 'Купить', exact: true }).click();
  await expect(page.getByRole('status').filter({hasText: code})).toContainText('75,37');
  await page.getByRole('button', {name: 'Продолжить к оплате'}).click();
  await expect(page).toHaveURL('/orders/81');
  await expect(page.getByText(/Итого покупателю/)).toContainText('75,37');
});

test('organizer creates a campaign, downloads its QR and disables it', async ({page}) => {
  let campaign;
  const endpoint = base + '/events/42/campaigns';
  await page.route(base + '/events/42/ticket-types/manage', r => r.fulfill({json: [{...timedTicketType, price_tiyn: 10050}]}));
  await page.route(endpoint, r => {
    if (r.request().method() === 'GET') return r.fulfill({json: campaign ? [campaign] : []});
    const input = r.request().postDataJSON();
    expect(input).toMatchObject({kind: 'percent', value: 25, max_uses: 2, ticket_type_ids: []});
    campaign = {...input, id: 5, code: 'BF-ABCDEF123456', link: 'https://demo.example/events/42?campaign=pc_' + 'a'.repeat(32),
      enabled: true, redemptions: 0, orders: 0, tickets_sold: 0, gross_tiyn: 0, discount_tiyn: 0, net_sales_tiyn: 0, organizer_net_tiyn: 0};
    return r.fulfill({status: 201, json: campaign});
  });
  await page.route(endpoint + '/5', r => {
    expect(r.request().postDataJSON()).toEqual({enabled: false});
    campaign.enabled = false;
    return r.fulfill({json: campaign});
  });
  await page.route(endpoint + '/5/qr.svg', r => r.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>'}));
  await login(page, '/organizer/events/42/campaigns', 'organizer');
  await page.getByLabel('Название').fill('Spring');
  await page.getByLabel('Скидка, %').fill('25');
  await page.getByLabel('Лимит использований').fill('2');
  await page.getByRole('button', {name: 'Создать кампанию'}).click();
  await expect(page.getByRole('heading', {name: 'Spring'})).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: /Скачать QR акции/}).click();
  expect((await download).suggestedFilename()).toBe('campaign-5.svg');
  await page.getByRole('button', {name: 'Выключить кампанию'}).click();
  await expect(page.getByRole('button', {name: 'Включить кампанию'})).toBeVisible();
});

test('organizer completes the demo activation checklist', async ({ page }) => {
  const done = { paid_type: true, identity: false, payout: false, terms: false, fee: false };
  const state = () => ({ event_id: 42, activated: Object.values(done).every(Boolean), paid_sales_suspended: false,
    activation_fee_tiyn: 500000, simulation: true, steps: Object.fromEntries(Object.entries(done).map(([k, v]) => [k, { done: v }])) });
  await page.route(`${base}/events/42/activation`, (r) => r.fulfill({ json: state() }));
  await page.route(`${base}/events/42/orders/summary`, (r) => r.fulfill({ json: { simulation: true, gross_sales_tiyn: 0, processing_fees_tiyn: 0, refunds_tiyn: 0, estimated_payout_tiyn: 0 } }));
  for (const [path, key] of [['/organizer-profiles/me/confirm-identity', 'identity'], ['/organizer-profiles/me/payout-details', 'payout'], ['/events/42/activation/terms', 'terms'], ['/events/42/activation/fee', 'fee']]) {
    await page.route(base + path, (r) => { done[key] = true; return r.fulfill({ json: state() }); });
  }
  await login(page, '/organizer/events/42/activation', 'organizer');
  await page.getByRole('button', { name: 'Подтвердить личность (демо)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Подтвердить личность (демо)', exact: true })).toBeDisabled();
  await page.getByLabel('Последние 4 символа демо-реквизита').fill('D123');
  await page.getByRole('button', { name: 'Сохранить демо-реквизит' }).click();
  await page.getByRole('button', { name: 'Принять условия' }).click();
  await expect(page.getByRole('button', { name: 'Принять условия' })).toBeDisabled();
  await page.getByRole('button', { name: /Имитировать оплату сбора/ }).click();
  await expect(page.getByRole('heading', { name: 'Активация завершена' })).toBeVisible();
});

test('checkout allows correcting a definitive validation refusal', async ({ page }) => {
  await page.route(`${base}/events/42`, (r) => r.fulfill({ json: { ...eventDetails, paid_sales_available: true,
    ticket_types: [{ ...timedTicketType, price_tiyn: 10050, sales_start: null, sales_end: null }] } }));
  const requests = [];
  await page.route(`${base}/events/42/orders`, (r) => {
    requests.push(r.request().postDataJSON());
    return r.fulfill({ status: 422, json: { detail: [{ loc: ['body', 'attendee_name'], msg: 'Проверьте имя' }] } });
  });
  await login(page, '/events/42/checkout?type=1');
  await page.getByRole('button', { name: 'Продолжить к оплате' }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте имя');
  await expect(page.getByLabel('Имя посетителя')).toBeEnabled();
  await page.getByLabel('Имя посетителя').fill('Исправленное имя');
  await page.getByRole('button', { name: 'Продолжить к оплате' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0].request_id).not.toBe(requests[1].request_id);
  expect(requests[1].attendee_name).toBe('Исправленное имя');
});
