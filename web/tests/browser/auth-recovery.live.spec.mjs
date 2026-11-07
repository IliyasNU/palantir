import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('real unavailable API recovers on the same registration form', async ({ page, request }) => {
  test.skip(process.env.RUN_LIVE_RECOVERY !== '1' || process.env.CI !== 'true', 'Explicit isolated-CI opt in only; the workflow must first stop its own API process.');
  test.setTimeout(90000);
  const database = new URL(process.env.DATABASE_URL ?? '');
  expect(process.env.ENVIRONMENT).toBe('test');
  expect(['127.0.0.1', 'localhost']).toContain(database.hostname);
  expect(database.pathname).toBe('/biletflow_test');
  const base = 'http://localhost:8000';
  let unreachable = false;
  try { await request.get(`${base}/health`, { timeout: 1500 }); } catch { unreachable = true; }
  expect(unreachable, 'Do not stop or replace an unknown API process').toBe(true);

  const email = `recovery-${randomUUID()}@example.com`;
  const password = randomUUID();
  const fill = async () => {
    await page.getByLabel('Имя', { exact: true }).fill('Recovery Visitor');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
  };
  await page.goto('/register');
  await fill();
  const failed = page.waitForEvent('requestfailed', { predicate: req => req.method() === 'POST' && req.url() === `${base}/auth/register` });
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await failed;
  await expect(page.getByRole('alert')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByRole('button', { name: 'Создать аккаунт', exact: true })).toBeEnabled();

  let startupFailure;
  const child = spawn(process.env.BILETFLOW_TEST_PYTHON || 'python', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: resolve(process.cwd(), '../backend'), env: process.env, stdio: 'ignore',
  });
  child.on('error', error => { startupFailure = error; });
  const exited = new Promise(done => child.once('exit', done));
  try {
    await expect.poll(async () => {
      if (startupFailure) throw startupFailure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned test API exited before becoming ready');
      try {
        const response = await request.get(`${base}/health`, { timeout: 1000 });
        return response.ok() && (await response.json()).database === 'up';
      } catch { return false; }
    }, { timeout: 25000 }).toBe(true);
    await fill();
    const registered = page.waitForResponse(response => response.url() === `${base}/auth/register` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    expect((await registered).status()).toBe(201);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/login');
    await expect(page.getByRole('status')).toContainText('Аккаунт создан');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    const me = page.waitForResponse(response => response.url() === `${base}/auth/me`);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    expect((await me).status()).toBe(200);
    await expect(page.getByRole('navigation')).toContainText('Recovery Visitor');
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByRole('navigation')).not.toContainText('Recovery Visitor');
  } finally {
    if (!startupFailure && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(done => setTimeout(done, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise(done => setTimeout(done, 2000))]);
      }
    }
  }
});
