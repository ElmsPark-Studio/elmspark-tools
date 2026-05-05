import { test, expect } from '@playwright/test';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

/**
 * Regression test for the EP Local Business hours-grid persistence bug
 * that took 1.1.3 → 1.1.6 to actually fix. Three things have to all be
 * true for the grid to work:
 *
 *  1. JS injects a hidden form input with the right name (`EP_Local_Business[lb_hours]`)
 *  2. The save POST includes that input
 *  3. The reload reads the saved value back via the `data-saved` attribute
 *
 * If any of these regress, this test will fail.
 */
test.describe('EP Local Business hours grid', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_Local_Business');
	});

	test('Mon hours persist across save and reload', async ({ page }) => {
		// PM admin renders settings groups closed by default. Expand them
		// all so every field is interactable.
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach(g => g.classList.add('open'));
		});

		// 1. Set the master switch on so save is meaningful
		const enable = page.locator('input[name="EP_Local_Business[enable_localbusiness][enabled]"]');
		await enable.check({ force: true });

		// 2. Set a name (required for schema, also lets us confirm the rest of the form saved)
		const name = page.locator('input[name="EP_Local_Business[lb_name]"]');
		await name.fill('Playwright Test Garage', { force: true } as any);

		// 3. Set Monday to "Open"
		const monOpen = page.locator('input[type="radio"][data-day="Mo"][value="open"]');
		await monOpen.check({ force: true });

		// 4. Confirm the JS injected the hidden input AND populated the value
		const hidden = page.locator('input[type="hidden"][name="EP_Local_Business[lb_hours]"]');
		await expect(hidden).toBeAttached();
		const beforeValue = await hidden.inputValue();
		expect(beforeValue).toContain('"Mo"');
		expect(beforeValue).toContain('"opens"');

		// 5. Click Save Settings
		await page.locator('button#save-options, button.save:has-text("Save")').first().click();
		await expect(page.locator('#options-saved')).toBeVisible({ timeout: 10000 });

		// 6. Reload the page (this is where every prior fix attempt failed)
		await page.reload();
		await expect(page.locator('form.pm-options-form')).toBeVisible();

		// 7. The grid div should now carry data-saved with our JSON
		const grid = page.locator('.ep-lb-hours');
		const dataSaved = await grid.getAttribute('data-saved');
		expect(dataSaved).toBeTruthy();
		expect(dataSaved).toContain('"Mo"');
		expect(dataSaved).toContain('"opens"');

		// 8. The hidden input (rehydrated by JS from data-saved) should have the value
		const hiddenAfter = page.locator('input[type="hidden"][name="EP_Local_Business[lb_hours]"]');
		const afterValue = await hiddenAfter.inputValue();
		expect(afterValue).toContain('"Mo"');
		expect(afterValue).toContain('"opens"');

		// 9. The Mon "Open" radio should be checked again (visible proof to the user)
		await expect(page.locator('input[type="radio"][data-day="Mo"][value="open"]')).toBeChecked();
	});
});
