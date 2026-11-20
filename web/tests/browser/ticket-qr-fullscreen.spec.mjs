import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { eventDetails } from './event-fixture.mjs';

const base = 'http://localhost:8000';
const ticket = { id: 21, event_id: 42, attendee_id: 1, qr_payload: 'exact server opaque ticket value', created_at: '2030-01-01T00:00:00Z', checked_in_at: null,
  status: 'active', event: { id: 42, title: eventDetails.title, date: eventDetails.date, location: eventDetails.location, status: 'published' } };
const largeName = 'Крупный QR-код билета для проверки на входе';

test.beforeEach(async ({ page }) => {
  await page.route((url) => url.origin === base, (route) => route.abort('failed'));
  await page.route(`${base}/auth/login`, (route) => route.fulfill({ json: { access_token: 'test-token', token_type: 'bearer' } }));
  await page.route(`${base}/auth/me`, (route) => route.fulfill({ json: { id: 1, email: 'fixture@example.com', full_name: 'Ticket Visitor', role: 'attendee',
    is_active: true, created_at: ticket.created_at } }));
  await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: ticket }));
});

async function openTicket(page) {
  await page.goto('/login?returnTo=%2Ftickets%2F21');
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/tickets/21');
  await expect(page.getByRole('img', { name: 'QR-код билета для проверки на входе' })).toBeVisible();
  return page.getByRole('button', { name: 'Открыть QR-код на весь экран' });
}

async function decode(image) {
  const png = PNG.sync.read(Buffer.from((await image.getAttribute('src')).split(',')[1], 'base64'));
  const pixels = new Set();
  for (let index = 0; index < png.data.length; index += 4) pixels.add(`${png.data[index]},${png.data[index + 1]},${png.data[index + 2]}`);
  return { data: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, width: png.width, pixels: [...pixels].sort() };
}

for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 800 }]) {
  test(`at ${viewport.width} px the full-screen QR is large, pure black on white, and closes with Esc or the button`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const opener = await openTicket(page);
    await expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Билет №21' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(eventDetails.title);
    const close = dialog.getByRole('button', { name: 'Закрыть', exact: true });
    await expect(close).toBeVisible();
    await expect(close).toBeFocused();
    const image = dialog.getByRole('img', { name: largeName });
    await expect(image).toBeVisible();
    // The exact payload, generated at a higher resolution, and only black and white pixels.
    const qr = await decode(image);
    expect(qr.data).toBe(ticket.qr_payload);
    expect(qr.width).toBeGreaterThanOrEqual(1024);
    expect(qr.pixels).toEqual(['0,0,0', '255,255,255']);
    // It fills the screen: the dialog covers the viewport, the code uses the space, nothing scrolls sideways.
    const box = await dialog.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
    const shown = await image.boundingBox();
    expect(shown.width).toBeGreaterThanOrEqual(Math.min(viewport.width - 32, viewport.height - 190) - 1);
    expect(shown.width).toBeGreaterThan(320);
    expect(shown.x).toBeGreaterThanOrEqual(0);
    expect(shown.x + shown.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Every text in the dialog is black on white.
    const colours = await dialog.evaluate((element) => [element, ...element.querySelectorAll('h2, p, button')]
      .map((node) => `${getComputedStyle(node).color} on ${getComputedStyle(element).backgroundColor}`));
    expect(new Set(colours)).toEqual(new Set(['rgb(0, 0, 0) on rgb(255, 255, 255)']));
    // Focus stays in the dialog: the page behind is inert.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const active = document.activeElement;
      return active === document.body || Boolean(active?.closest('dialog'));
    })).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    // The small QR is still there and unchanged.
    expect((await decode(page.getByRole('img', { name: 'QR-код билета для проверки на входе' }))).data).toBe(ticket.qr_payload);
  });
}

test('the full-screen view is translated and has no button when the ticket gives no entry', async ({ page }) => {
  const opener = await openTicket(page);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Show the QR code full screen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ticket No. 21' });
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(dialog.getByRole('img', { name: 'Large ticket QR code for the entrance check' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await expect(opener).toBeVisible();
  await page.unroute(`${base}/tickets/21`);
  await page.route(`${base}/tickets/21`, (route) => route.fulfill({ json: { ...ticket, status: 'cancelled' } }));
  await page.goto('/login?returnTo=%2Ftickets%2F21');
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Билет отменён. Он не даёт права на вход.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть QR-код на весь экран' })).toHaveCount(0);
});
