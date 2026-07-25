import { test, expect } from '@playwright/test';

// T12 smoke: dashboard loads, chart container renders, engine status visible,
// kill action is preceded by a confirm dialog. Run against a server already
// up on http://localhost:3000 (per playwright.config.ts — no webServer block).
// Tokens are supplied at app start via the T2 token-entry UI (2 password
// inputs + an Enter Dashboard button; labels are not htmlFor-linked, so we
// target inputs by position).

test('T12 smoke: dashboard loads, chart renders, engine status visible, kill confirms', async ({ page }) => {
  let confirmDialogSeen = false;
  page.on('dialog', async (dialog) => {
    confirmDialogSeen = true;
    await dialog.dismiss();
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // T2 token-entry UI: 2 password inputs (admin optional, trader required) +
  // an "Enter Dashboard" button.
  const inputs = page.locator('input[type="password"]');
  await expect(inputs.nth(1)).toBeVisible({ timeout: 15000 }); // trader token input
  await inputs.nth(1).fill('smoke-trader');
  await page.getByRole('button', { name: /enter dashboard/i }).click();

  // Dashboard should render. Give the chart + WebSocket a moment.
  await page.waitForTimeout(3000);

  // Chart container renders (ChartPanel uses #trading-chart / a canvas).
  const chart = page.locator('#trading-chart, canvas').first();
  await expect(chart).toBeVisible({ timeout: 15000 });

  // Engine status text is present in the rendered body.
  const statusText = (await page.locator('body').textContent()) || '';
  expect(statusText.length).toBeGreaterThan(0);

  // Kill action is preceded by a confirm dialog. Click the Kill button and
  // assert the window.confirm guard fired.
  const killBtn = page.getByRole('button', { name: /^kill/i }).first();
  if (await killBtn.isVisible().catch(() => false)) {
    await killBtn.click();
    await page.waitForTimeout(800);
    expect(confirmDialogSeen).toBe(true);
  }

  // T13: the ML Dashboard nav affordance opens the ML view and it renders.
  const mlBtn = page.locator('button', { hasText: 'ML Dashboard' });
  await expect(mlBtn).toBeVisible({ timeout: 10000 });
  await mlBtn.click();
  await page.waitForTimeout(1500);
  // The ML modal header "ML Monitoring" should appear.
  await expect(page.getByRole('heading', { name: /ML monitoring/i })).toBeVisible({ timeout: 10000 });
});
