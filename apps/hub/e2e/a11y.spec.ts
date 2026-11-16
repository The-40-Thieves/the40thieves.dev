import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// P2-06 acceptance: axe reports zero serious or critical violations on the first-cut pages.
const pages = ['/', '/codecalc/', '/404', '/design/library/', '/alexandria/try/'];

for (const path of pages) {
  test(`axe finds no serious or critical violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(
      blocking.map(
        (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
      ),
    ).toEqual([]);
  });
}

test('the 404 route answers with status 404', async ({ page }) => {
  const response = await page.goto('/nope');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not found');
});
