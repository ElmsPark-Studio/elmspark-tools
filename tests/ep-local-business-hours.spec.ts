import { test, expect } from '@playwright/test';
import { adminLogin, openPluginSettings, saveOptions } from '../fixtures/auth';

/**
 * Regression test for the EP Local Business hours-grid persistence bug
 * that took 1.1.3 → 1.1.6 to fix, then had to be fixed AGAIN in 1.1.15
 * for PM 0.11.
 *
 * The carrier changed in 1.1.15, so do not "restore" the hidden input.
 * Up to 1.1.14 the grid's JSON travelled in a hidden input the settings JS
 * injected under an UNDECLARED settings key. PM 0.11 removed the
 * undeclared-key passthrough, so `PM_Options::set()` dropped that key on
 * every save: weekly hours wiped, `openingHoursSpecification` silently
 * emptied out of the LocalBusiness schema. Since 1.1.15 the value travels
 * in a DECLARED `textarea` POAF field, which the settings JS writes to and
 * whose container it hides. With JS off it degrades to a visible JSON box,
 * never to data loss. The JSON shape is unchanged.
 *
 * Four things have to all be true for the grid to work:
 *
 *  1. The settings JS loads AND executes (asserted after the `load` event —
 *     core emits script tags at the end of <body>, so anything sampled
 *     earlier races the parser)
 *  2. Interacting with the grid writes the JSON into the DECLARED textarea
 *     `EP_Local_Business[lb_hours]`
 *  3. The save POST carries that field through PM 0.11's save pipeline
 *  4. The reload reads the saved value back via the `data-saved` attribute
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
		//
		// Reveal `.group-fields` directly rather than adding an `open` class to
		// `.option-group`: core hides `.group-fields` in CSS and its own
		// lib/js/options.js opens a group with jQuery `.toggle()` (an inline
		// display) on the header click. No `open` class exists anywhere in
		// core, so the previous approach silently did nothing and every field
		// stayed invisible.
		await page.evaluate(() => {
			document.querySelectorAll<HTMLElement>('.group-fields')
				.forEach(g => { g.style.display = 'block'; });
		});

		// 1. The settings JS must be loaded AND executed before anything else is
		// asserted.
		//
		// Wait for the `load` event first. Core emits every script tag at the end
		// of <body> (HTML_Body::container_close), so they are parsed AFTER
		// form.pm-options-form appears. Sampling as soon as the form exists
		// catches a partly-parsed page and reports a phantom "JS missing" on a
		// minority of runs — measuring the race, not the product. Waiting for
		// `load` removes it entirely (0/22 vs 2/22, measured).
		await page.waitForLoadState('load');
		const jsReady = await page.evaluate(() => typeof (window as any).pm_options_save !== 'undefined');
		expect(jsReady, 'core settings JS (pm_options_save) must be loaded and executed').toBe(true);

		// 2. Reset Monday to CLOSED and save, so the assertions below prove a
		// real transition rather than re-reading a value a previous run left
		// behind. Without this the test is vacuous: once Monday is saved as
		// open, every later run passes even if the grid is doing nothing at
		// all (verified — deleting the Monday click below still passed).
		await page.locator('label:has(input[type="radio"][data-day="Mo"][value="closed"])').click();
		await saveOptions(page, 'EP Local Business hours');
		await page.reload();
		await expect(page.locator('form.pm-options-form')).toBeVisible();
		await page.evaluate(() => {
			document.querySelectorAll<HTMLElement>('.group-fields')
				.forEach(g => { g.style.display = 'block'; });
		});
		expect(
			await page.locator('.ep-lb-hours').getAttribute('data-saved'),
			'reset phase must leave Monday closed, else the open assertions prove nothing',
		).not.toContain('"opens"');

		// 3. Set the master switch on so save is meaningful
		const enable = page.locator('input[name="EP_Local_Business[enable_localbusiness][enabled]"]');
		await enable.check({ force: true });

		// 4. Set a name (required for schema, also lets us confirm the rest of the form saved)
		const name = page.locator('input[name="EP_Local_Business[lb_name]"]');
		await name.fill('Playwright Test Garage', { force: true } as any);

		// 5. Set Monday to "Open" by clicking its LABEL, as a user does.
		// `.check({force: true})` sets the radio state without driving the
		// handler the grid listens on, so the JSON never gets rewritten and
		// the field stays at its all-closed default — a false failure.
		await page.locator('label:has(input[type="radio"][data-day="Mo"][value="open"])').click();
		await expect(page.locator('input[type="radio"][data-day="Mo"][value="open"]')).toBeChecked();

		// 6. The JS must have written the JSON into the DECLARED textarea
		// (see the header note — a hidden input here is the pre-1.1.15 bug).
		const hours = page.locator('textarea[name="EP_Local_Business[lb_hours]"]');
		await expect(hours).toBeAttached();
		await expect(hours).toHaveValue(/"Mo"/, { timeout: 5000 });
		const beforeValue = await hours.inputValue();
		expect(beforeValue).toContain('"opens"');

		// 7. Click Save Settings
		await saveOptions(page, 'EP Local Business hours');

		// 8. Reload the page (this is where every prior fix attempt failed)
		await page.reload();
		await expect(page.locator('form.pm-options-form')).toBeVisible();
		await page.evaluate(() => {
			document.querySelectorAll<HTMLElement>('.group-fields')
				.forEach(g => { g.style.display = 'block'; });
		});

		// 9. The grid div should now carry data-saved with our JSON. This is the
		// server-side proof that the value survived PM 0.11's save pipeline —
		// the exact thing the undeclared key used to fail silently.
		const grid = page.locator('.ep-lb-hours');
		const dataSaved = await grid.getAttribute('data-saved');
		expect(dataSaved).toBeTruthy();
		expect(dataSaved).toContain('"Mo"');
		expect(dataSaved).toContain('"opens"');

		// 10. The textarea (rehydrated by JS from data-saved) should have the value
		const afterValue = await page.locator('textarea[name="EP_Local_Business[lb_hours]"]').inputValue();
		expect(afterValue).toContain('"Mo"');
		expect(afterValue).toContain('"opens"');

		// 11. The Mon "Open" radio should be checked again (visible proof to the user)
		await expect(page.locator('input[type="radio"][data-day="Mo"][value="open"]')).toBeChecked();
	});
});
