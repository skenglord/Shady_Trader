import dotenv from 'dotenv';
import { chromium } from 'playwright';

dotenv.config();

if (process.env.UI_AUDIT_ISOLATED !== '1') {
  throw new Error('Set UI_AUDIT_ISOLATED=1 only when UI_AUDIT_URL points to a disposable database instance.');
}

const baseUrl = process.env.UI_AUDIT_URL || 'http://127.0.0.1:3000';
const adminToken = process.env.API_ADMIN_TOKEN;
const traderToken = process.env.API_TRADER_TOKEN;
if (!adminToken || !traderToken) throw new Error('API_ADMIN_TOKEN and API_TRADER_TOKEN are required.');

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(4000);
const failures = [];
const dialogs = [];
const pageErrors = [];
let checksPassed = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('dialog', async (dialog) => {
  dialogs.push(`${dialog.type()}: ${dialog.message()}`);
  if (dialog.type() === 'confirm') await dialog.accept();
  else if (dialog.type() === 'prompt') await dialog.accept('1');
  else await dialog.dismiss();
});

async function check(name, fn) {
  try {
    await fn();
    checksPassed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    for (const closeName of ['Close settings', 'Close strategy config', 'Close ML dashboard', 'Close Freqtrade panel', 'Close balance modal']) {
      const closeButton = page.getByRole('button', { name: closeName });
      if (await closeButton.count().catch(() => 0)) await closeButton.click({ force: true }).catch(() => undefined);
    }
  }
}

async function clickButton(name, exact = true) {
  await page.getByRole('button', { name, exact }).click();
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const tokenInputs = page.locator('input[type="password"]');
  if (await tokenInputs.count()) {
    await tokenInputs.nth(0).fill(adminToken);
    await tokenInputs.nth(1).fill(traderToken);
    await clickButton(/Enter Dashboard/i, false);
  }
  await page.getByText('Live Market Data', { exact: true }).waitFor();

  for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) {
    await check(`select ${symbol}`, () => clickButton(symbol));
  }
  for (const timeframe of ['1m', '5m', '15m', '1h', '4h']) {
    await check(`select ${timeframe} chart`, () => clickButton(timeframe));
  }
  for (const indicator of ['EMA 9', 'EMA 21', 'EMA 50', 'VWAP', 'Bollinger Bands']) {
    await check(`toggle ${indicator}`, () => page.getByRole('button', { name: new RegExp(indicator) }).click());
  }
  for (const marker of ['Show signal markers on chart', 'Show trade markers on chart']) {
    await check(`toggle ${marker}`, async () => {
      const checkbox = page.getByRole('checkbox', { name: marker });
      const original = await checkbox.isChecked();
      await checkbox.setChecked(!original);
      await checkbox.setChecked(original);
    });
  }
  await check('reset chart zoom', () => page.getByRole('button', { name: 'Reset chart zoom and pan' }).click());

  await check('market data refresh', () => clickButton('Refresh Market Data'));
  await check('open and close ML dashboard', async () => {
    await page.getByRole('button', { name: 'Open ML monitoring dashboard' }).click();
    await page.getByText('ML Monitoring', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close ML dashboard' }).click();
  });

  await check('exercise settings and conditional strategy fields', async () => {
    await page.getByRole('button', { name: 'Open settings' }).click();
    const modal = page.getByText('System Settings', { exact: true });
    await modal.waitFor();
    const settingsModal = page.locator('div.fixed').filter({ hasText: 'System Settings' }).last();
    const fields = settingsModal.locator('select:visible, input:visible, textarea:visible');
    const fieldCount = await fields.count();
    if (fieldCount < 10) throw new Error(`Expected configurable fields, found ${fieldCount}`);
    const selects = settingsModal.locator('select:visible');
    for (let i = 0; i < await selects.count(); i++) {
      const select = selects.nth(i);
      const original = await select.inputValue();
      const options = await select.locator('option').evaluateAll((xs) => xs.map((x) => x.value));
      const alternate = options.find((value) => value && value !== original);
      if (alternate) {
        await select.selectOption(alternate);
        await select.selectOption(original);
      }
    }
    const strategy = settingsModal.locator('select').filter({ has: page.locator('option[value="shotgun"]') });
    const oldStrategy = await strategy.inputValue();
    for (const strategyName of ['shotgun', 'alt_chaser', 'chasing_dragons', oldStrategy]) {
      await strategy.selectOption(strategyName);
      await page.waitForTimeout(50);
    }
    const settingInputs = settingsModal.locator('input:visible:not([type="checkbox"]), textarea:visible');
    for (let i = 0; i < await settingInputs.count(); i++) {
      const field = settingInputs.nth(i);
      await field.focus();
      const value = await field.inputValue();
      await field.fill(value);
      await field.blur();
    }
    const originalChecks = await settingsModal.locator('input[type="checkbox"]:visible').evaluateAll((xs) => xs.map((x) => x.checked));
    for (let i = 0; i < originalChecks.length; i++) {
      const box = settingsModal.locator('input[type="checkbox"]:visible').nth(i);
      const toggle = box.locator('xpath=..');
      await toggle.click();
      await toggle.click();
    }
    await page.getByRole('button', { name: 'Save Changes' }).click();
  });

  await check('stop and restart paper engine', async () => {
    const button = page.getByRole('button', { name: /^(Stop|Start) Engine$/ });
    const original = await button.innerText();
    await button.click();
    await page.getByRole('button', { name: original === 'Stop Engine' ? 'Start Engine' : 'Stop Engine' }).waitFor();
    await page.getByRole('button', { name: original === 'Stop Engine' ? 'Start Engine' : 'Stop Engine' }).click();
    await page.getByRole('button', { name: original }).waitFor();
  });

  await check('manual paper entry controls', async () => {
    await clickButton('Enter High');
    await page.waitForTimeout(150);
    await clickButton('Enter Low');
    await page.waitForTimeout(150);
  });

  await check('balance actions and modal fields', async () => {
    await clickButton('+ Allocate');
    const amount = page.locator('input[type="number"]:visible').last();
    await amount.fill('1');
    await clickButton('Cancel');
    await clickButton('- Withdraw');
    await page.locator('input[type="number"]:visible').last().fill('1');
    await clickButton('Cancel');
    await clickButton('x2 Balance');
    await clickButton('1/2 Balance');
  });

  await check('risk configuration fields and actions', async () => {
    await clickButton('Configure');
    const inputs = page.locator('input[type="number"]:visible');
    if (!(await inputs.count())) throw new Error('Risk fields did not open');
    for (let i = 0; i < await inputs.count(); i++) {
      const input = inputs.nth(i);
      const value = await input.inputValue();
      if (value) await input.fill(value);
    }
    await clickButton('Reset');
    await clickButton('Save Configuration');
  });

  await check('trade history filter', async () => {
    const filter = page.getByRole('textbox', { name: 'Filter closed trades by mode or side' });
    await filter.fill('BTC');
    await filter.fill('');
  });

  await check('Freqtrade data, backtest, and validate tabs', async () => {
    await page.getByRole('button', { name: 'Open Freqtrade sidecar' }).click();
    await page.getByText('Freqtrade Sidecar', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    for (const tab of ['data', 'backtest', 'validate']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      if (!(await page.locator('input:visible, select:visible').count())) throw new Error(`${tab} form fields missing`);
      const controls = page.locator('input:visible, select:visible');
      for (let i = 0; i < await controls.count(); i++) {
        const control = controls.nth(i);
        if (await control.evaluate((x) => x.tagName === 'SELECT')) {
          const value = await control.inputValue();
          const option = await control.locator('option').evaluateAll((xs) => xs.map((x) => x.value).find((v) => v && v !== value));
          if (option) {
            await control.selectOption(option);
            await control.selectOption(value);
          }
        } else {
          const value = await control.inputValue();
          await control.fill(value);
        }
      }
      if (tab === 'data') {
        const dates = page.locator('input[type="date"]:visible');
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        await dates.nth(0).fill(start.toISOString().slice(0, 10));
        await dates.nth(1).fill(end.toISOString().slice(0, 10));
        const dialogCount = dialogs.length;
        await page.getByRole('button', { name: 'Download Historical Data' }).click();
        await page.waitForTimeout(1500);
        const newDialogs = dialogs.slice(dialogCount).join(' ');
        if (/Download failed|Download error/.test(newDialogs)) throw new Error(newDialogs);
      } else if (tab === 'backtest') {
        const dates = page.locator('input[type="date"]:visible');
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        await dates.nth(0).fill(start.toISOString().slice(0, 10));
        await dates.nth(1).fill(end.toISOString().slice(0, 10));
        await page.getByRole('button', { name: 'Run Backtest' }).click();
        await page.waitForTimeout(1000);
      } else {
        const dates = page.locator('input[type="date"]:visible');
        const end = new Date();
        const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        await dates.nth(0).fill(start.toISOString().slice(0, 10));
        await dates.nth(1).fill(end.toISOString().slice(0, 10));
        await page.getByRole('button', { name: 'Run Validation' }).click();
        await page.waitForTimeout(1000);
      }
    }
    const close = page.getByRole('button', { name: 'Close Freqtrade panel' });
    await close.click();
  });

  await page.screenshot({ path: process.env.UI_AUDIT_SCREENSHOT || '/tmp/shady-ui-audit.png', fullPage: true });
} finally {
  await browser.close();
}

console.log(`Browser page errors: ${pageErrors.length}`);
if (pageErrors.length) console.error(pageErrors.join('\n'));
console.log(`Dialogs observed: ${dialogs.length}`);
if (failures.length || pageErrors.length) process.exitCode = 1;
console.log(JSON.stringify({ checksPassed, failures, pageErrors, dialogs }, null, 2));
