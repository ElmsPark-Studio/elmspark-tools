import { test, expect, Page } from '@playwright/test';
import { adminLogin } from '../fixtures/auth';

/**
 * EP Suite Settings 0.1.1: the brand field on the EP Suite page renders from the
 * trait's ep_brand_field_html() with no inline styles (PM conventions §11.1), and
 * while that page is active it is the ONLY home of the brand control: the trait's
 * fallback Branding group stays off every other EP plugin.
 *
 * Needs EP_Suite_Settings active on the site; skips cleanly when it is not, so the
 * suite stays meaningful on a rig without it (where ep-suite-no-inline-styles.spec.ts
 * covers the fallback group instead).
 */

async function openSettings(page: Page, cls: string) {
	// A goto straight after a POST-rendered settings page can report ERR_ABORTED
	// although the page loads; wait for the list rather than trusting it.
	await page.goto('/admin/plugins/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	await page.locator('form input[name="plugin"]').first().waitFor({ state: 'attached' });
	await page.evaluate(c => {
		const f = document.createElement('form');
		f.method = 'post'; f.action = '/admin/plugins/';
		const i = document.createElement('input');
		i.type = 'hidden'; i.name = 'plugin'; i.value = c;
		f.appendChild(i); document.body.appendChild(f); f.submit();
	}, cls);
	await page.waitForURL('**/admin/plugins/**', { waitUntil: 'load' });
	await page.locator('form.pm-options-form').waitFor({ timeout: 15000 });
}

async function suiteSettingsActive(page: Page): Promise<boolean> {
	await page.goto('/admin/plugins/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	await page.locator('form input[name="plugin"]').first().waitFor({ state: 'attached' });
	return (await page.locator('form input[name="plugin"][value="EP_Suite_Settings"]').count()) > 0;
}

async function setBrand(page: Page, value: string, asText = false) {
	const saved = page.waitForResponse(r => r.request().method() === 'POST'
		&& (r.request().postData() || '').includes('ep_suite_set_brand'), { timeout: 20000 });
	await page.locator('.ep-brand-ctl-input').evaluate((el, a) => {
		const i = el as HTMLInputElement;
		if (a.asText) i.type = 'text';	// only way to send the "clear" value through the real handler
		i.value = a.value;
		i.dispatchEvent(new Event('change', { bubbles: true }));
	}, { value, asText });
	const res = await saved;
	expect(res.status(), 'brand save POST returns 200').toBe(200);
	const body = JSON.parse(await res.text());
	expect(body.success, `brand save reports success (${JSON.stringify(body)})`).toBe(true);
	await page.waitForEvent('load', { timeout: 15000 });
	await page.locator('.ep-suite-header').waitFor();
}

test.describe('EP Suite Settings: brand field without inline styles', () => {
	test.setTimeout(120000);

	test('EP Suite page renders the trait field, class-styled, and saves', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await adminLogin(page);
		test.skip(!(await suiteSettingsActive(page)), 'EP_Suite_Settings is not active on this site');

		await openSettings(page, 'EP_Suite_Settings');
		await expect(page.locator('style#ep-suite-chrome'), 'trait stylesheet present').toHaveCount(1);
		await expect(page.locator('.ep-suite-header .ep-brand-ctl'), 'no chip in the header').toHaveCount(0);
		await expect(page.locator('#group-ep-suite-branding'), 'no trait fallback group on the inline host').toHaveCount(0);

		const field = page.locator('.ep-brand-field');
		await expect(field, 'exactly one brand field').toHaveCount(1);
		const styled = await page.locator('.ep-brand-field[style], .ep-brand-field [style], .ep-suite-header [style]').count();
		expect(styled, 'no inline style attributes in the brand field or header').toBe(0);

		// Open the group that holds the field if core rendered it collapsed.
		await page.waitForTimeout(800);
		if (!(await page.locator('.ep-brand-ctl').isVisible()))
			await page.locator('.option-group:has(.ep-brand-field) > label').first().click();
		await expect(page.locator('.ep-brand-ctl')).toBeVisible();

		const look = await page.evaluate(() => {
			const f = document.querySelector('.ep-brand-field')!, p = document.querySelector('.ep-brand-field-intro')!;
			const fc = getComputedStyle(f), pc = getComputedStyle(p);
			return { maxWidth: fc.maxWidth, pColor: pc.color, pSize: pc.fontSize, pMarginBottom: pc.marginBottom, pLineHeight: (parseFloat(pc.lineHeight) / parseFloat(pc.fontSize)).toFixed(1) };
		});
		expect(look, 'classes reproduce the old inline styles').toEqual({ maxWidth: '640px', pColor: 'rgb(90, 83, 71)', pSize: '13px', pMarginBottom: '14px', pLineHeight: '1.6' });
		await expect(page.locator('.ep-brand-field-intro')).toContainText('site-wide brand colour');
		expect(await page.locator('.ep-brand-field-intro').innerText(), 'intro carries no em dashes').not.toContain('—');
		await page.locator('.option-group:has(.ep-brand-field)').first().screenshot({ path: `${process.env.EP_SHOT_DIR || 'test-results'}/ep-suite-page-branding.png` });

		const original = (await page.locator('.ep-brand-ctl-value').innerText()).trim();
		const target = original.toLowerCase() === '#1a7f5a' ? '#2c3a44' : '#1a7f5a';
		try {
			await setBrand(page, target);
			await expect(page.locator('.ep-brand-ctl-value')).toHaveText(target);
		} finally {
			if (/^#[0-9a-f]{6}$/i.test(original)) await setBrand(page, original);
			else await setBrand(page, 'none', true);
			await expect(page.locator('.ep-brand-ctl-value')).toHaveText(/^#[0-9a-f]{6}$/i.test(original) ? original : 'Not set');
		}
		expect(errors, 'no page errors').toEqual([]);
	});

	test('with the EP Suite page active, other EP plugins get no brand control', async ({ page }) => {
		await adminLogin(page);
		test.skip(!(await suiteSettingsActive(page)), 'EP_Suite_Settings is not active on this site');
		for (const cls of ['EP_Email', 'EP_Booking']) {
			await openSettings(page, cls);
			await expect(page.locator('.ep-suite-header'), `${cls}: header renders`).toHaveCount(1);
			await expect(page.locator('#group-ep-suite-branding'), `${cls}: no fallback Branding group`).toHaveCount(0);
			await expect(page.locator('.ep-brand-ctl'), `${cls}: no brand control`).toHaveCount(0);
		}
	});
});
