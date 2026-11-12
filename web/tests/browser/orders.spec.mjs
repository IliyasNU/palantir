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
