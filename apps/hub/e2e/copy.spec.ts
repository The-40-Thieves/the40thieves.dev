import { expect, test } from '@playwright/test';

// P2-06 acceptance: each install snippet copies exactly, for every client the project offers.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('every copy button on /codecalc/ writes its snippet to the clipboard', async ({ page }) => {
  await page.goto('/codecalc/');
  const snippets = page.locator('[data-snippet]');
  const count = await snippets.count();
  expect(count).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < count; i += 1) {
    const snippet = snippets.nth(i);
    const expected = await snippet.locator('code').innerText();
    // Located by attribute, not by name: the label flips to "Copied" after the click.
    const button = snippet.locator('button[data-copy]');
    await expect(button).toHaveText('Copy');
    await button.click();
    await expect(button).toHaveText('Copied');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(expected);
    await expect(button).toHaveText('Copy', { timeout: 5000 });
  }
});

test('the Claude Code snippet is the one-line claude mcp add command', async ({ page }) => {
  await page.goto('/codecalc/');
  const code = page.locator('[data-snippet="claude-code"] code');
  await expect(code).toContainText('claude mcp add codecalc');
});
