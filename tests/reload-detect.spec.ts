import { test, expect } from '@playwright/test';

test('detect page reloads', async ({ page }) => {
  let reloadCount = 0;
  const consoleMsgs: { type: string; text: string }[] = [];
  
  page.on('load', () => {
    reloadCount++;
    console.log(`[RELOAD ${reloadCount}] page loaded`);
  });
  
  page.on('console', msg => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
    if (msg.text().includes('Error handler installed')) {
      console.log(`[CYCLE ${reloadCount}] Error handler installed`);
    }
  });

  console.log('Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  console.log('First load complete, observing for 15s...');
  await page.waitForTimeout(15000);

  console.log('\n=== RESULTS ===');
  console.log(`Total page loads: ${reloadCount}`);
  
  const errorHandlerCount = consoleMsgs.filter(m => m.text === 'Error handler installed').length;
  console.log(`"Error handler installed" appearances: ${errorHandlerCount}`);
  
  const counts: Record<string, number> = {};
  for (const m of consoleMsgs) {
    counts[m.text] = (counts[m.text] || 0) + 1;
  }
  for (const [text, count] of Object.entries(counts)) {
    console.log(`  [${count}x] ${text}`);
  }

  if (reloadCount > 2) {
    console.log('\n*** CONFIRMED: Page is reloading excessively ***');
  } else {
    console.log('\n*** No excessive reloads detected ***');
  }
});
