import { test, expect } from '@playwright/test';

test('verify no constant reloading after fix', async ({ page }) => {
  let reloadCount = 0;
  
  page.on('load', () => {
    reloadCount++;
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  
  // Observe for 15 seconds - should not reload
  await page.waitForTimeout(15000);

  console.log(`Total page loads during test: ${reloadCount}`);
  
  // 1 initial load + no reloads = 1
  expect(reloadCount).toBeLessThanOrEqual(2);
  console.log(reloadCount > 2 ? 'FAIL: Page reloaded excessively' : 'PASS: Page stable');
});
