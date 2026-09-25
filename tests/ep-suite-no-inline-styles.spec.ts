import { test, expect, Page } from '@playwright/test';
import { adminLogin } from '../fixtures/auth';

/**
 * EP Suite trait: header without inline styles, brand colour in a Branding section
 * (branch fix/ep-suite-no-inline-styles, PM conventions §11.1 + Kenn's option B).
 *
 * The header no longer carries the brand chip. On a site without the EP Suite page,
 * the brand-home plugin (lowest-order active EP plugin) gets a "Branding" settings
 * group, appended by the trait's _settings(), built like the EP Suite page's own.
 * Checks:
 *  - the new trait is the one loaded (first copy loaded wins site-wide)
 *  - no style attribute in the header or the brand control; no chip in any header
 *  - header's right-hand block (badges) still flush right
 *  - exactly one Branding group, on the home plugin only, after the plugin's own groups
 *  - the group opens, the chip is styled as before, the colour input stays hidden
 *    exactly as the old inline style hid it, and a click on the chip reaches it
 *  - the colour saves: change -> AJAX 200/success -> reload shows it; then restored
 *  - a non-home EP plugin has the same header and no Branding group
 */

const TEST_COLOUR = '#1a7f5a';
const SHOTS = process.env.EP_SHOT_DIR || 'test-results';

async function activeEpPlugins(page: Page): Promise<string[]> {
	await page.goto('/admin/plugins/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	await page.locator('form input[name="plugin"]').first().waitFor({ state: 'attached' });
	const classes = await page.locator('form input[name="plugin"]').evaluateAll(
		els => els.map(e => (e as HTMLInputElement).value));
	return [...new Set(classes.filter(c => /^EP_/.test(c)))];
}

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

async function assertHeaderClean(page: Page, label: string) {
	await expect(page.locator('.ep-suite-header'), `${label}: suite header renders`).toHaveCount(1);
	await expect(page.locator('style#ep-suite-chrome'), `${label}: new trait is the loaded copy`).toHaveCount(1);
	expect(await page.locator('form.pm-options-form').evaluate(f => f.classList.contains('ep-suite')),
		`${label}: .ep-suite scope class applied`).toBe(true);
	await expect(page.locator('.ep-suite-header .ep-brand-ctl'), `${label}: no brand chip in the header`).toHaveCount(0);
	const styled = await page.locator('.ep-suite-header [style], .ep-suite-header[style], .ep-brand-ctl[style], .ep-brand-ctl [style]').count();
	expect(styled, `${label}: no inline style attributes in header or brand control`).toBe(0);

	const geo = await page.evaluate(() => {
		const innerEl = document.querySelector('.ep-suite-header-inner')!;
		const inner = innerEl.getBoundingClientRect();
		const right = document.querySelector('.ep-header-right')!;
		const r = right.getBoundingClientRect();
		const cs = getComputedStyle(right);
		const pad = parseFloat(getComputedStyle(innerEl).paddingRight) || 0;
		return { gapToEdge: Math.round(inner.right - pad - r.right), display: cs.display, alignItems: cs.alignItems, gap: cs.columnGap };
	});
	expect(geo.display, `${label}: header-right is flex`).toBe('flex');
	expect(geo.alignItems).toBe('center');
	expect(geo.gap).toBe('12px');
	expect(Math.abs(geo.gapToEdge), `${label}: header-right flush to the right edge (${geo.gapToEdge}px)`).toBeLessThanOrEqual(2);
}

async function openBrandingGroup(page: Page) {
	await page.waitForTimeout(800);	// core binds the group-toggle handlers from scripts at body end
	const group = page.locator('#group-ep-suite-branding');
	if (!(await page.locator('#group-ep-suite-branding .ep-brand-ctl').isVisible()))
		await group.locator('> label').click();
	await expect(page.locator('#group-ep-suite-branding .ep-brand-ctl'), 'Branding group opens to show the control').toBeVisible();
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
	await page.waitForEvent('load', { timeout: 15000 });	// the control reloads the page 250ms after onload
	await page.locator('.ep-suite-header').waitFor();
}

test.describe('EP Suite header without inline styles, brand in a Branding section', () => {
	test.setTimeout(180000);	// the brand home is found by walking the active EP plugins

	test('brand home: Branding section opens and saves', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await adminLogin(page);

		const plugins = await activeEpPlugins(page);
		expect(plugins.length, 'at least one EP plugin active').toBeGreaterThan(0);
		let home = '';
		for (const cls of plugins) {
			await openSettings(page, cls);
			if (await page.locator('#group-ep-suite-branding').count()) { home = cls; break; }
		}
		expect(home, `Branding group found on one of: ${plugins.join(', ')}`).not.toBe('');
		console.log('brand home:', home);

		await assertHeaderClean(page, home);
		await expect(page.locator('#group-ep-suite-branding'), 'exactly one Branding group').toHaveCount(1);
		const lastIsBranding = await page.evaluate(() => {
			const top = [...document.querySelectorAll('form.pm-options-form .option-group')]
				.filter(g => !g.parentElement!.closest('.option-group'));
			return top.length > 1 && top[top.length - 1].id === 'group-ep-suite-branding';
		});
		expect(lastIsBranding, 'Branding sits after the plugin\'s own groups').toBe(true);
		await expect(page.locator('#group-ep-suite-branding > label')).toContainText('Branding');

		await openBrandingGroup(page);
		const ctl = page.locator('#group-ep-suite-branding .ep-brand-ctl');
		await page.locator('#group-ep-suite-branding').screenshot({ path: `${SHOTS}/ep-suite-branding-group.png` });

		const chip = await ctl.evaluate(el => {
			const cs = getComputedStyle(el);
			return { display: cs.display, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, border: cs.borderTopColor, color: cs.color, weight: cs.fontWeight, ws: cs.whiteSpace };
		});
		expect(chip).toEqual({ display: 'inline-flex', bg: 'rgb(255, 255, 255)', radius: '10px', border: 'rgb(212, 207, 198)', color: 'rgb(90, 83, 71)', weight: '600', ws: 'nowrap' });
		await expect(page.locator('.ep-brand-field-intro')).toContainText('site-wide brand colour');

		// Baseline: a clone carrying the OLD inline style, measured on this page. Core's
		// `input {box-sizing:border-box; padding:7px}` floors both at 16px.
		const { now, was } = await page.locator('.ep-brand-ctl-input').evaluate(el => {
			const m = (e: Element) => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
				return { position: cs.position, opacity: cs.opacity, pe: cs.pointerEvents, w: Math.round(r.width), h: Math.round(r.height) }; };
			const c = el.cloneNode() as HTMLElement; c.className = '';
			c.setAttribute('style', 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;');
			el.parentNode!.appendChild(c); const was = m(c); c.remove();
			return { now: m(el), was };
		});
		expect(now, 'colour input hidden exactly as the old inline style hid it').toEqual(was);
		expect(now.opacity).toBe('0');

		// "Opens": a click on the chip must activate the hidden input (the browser's picker trigger).
		await page.locator('.ep-brand-ctl-input').evaluate(el => {
			(window as any).__epPickerClicks = 0;
			el.addEventListener('click', e => { (window as any).__epPickerClicks++; e.preventDefault(); });
		});
		await ctl.click();
		expect(await page.evaluate(() => (window as any).__epPickerClicks), 'chip click reaches the colour input').toBe(1);

		const original = (await page.locator('.ep-brand-ctl-value').innerText()).trim();
		console.log('original brand:', original);
		const target = original.toLowerCase() === TEST_COLOUR ? '#2c3a44' : TEST_COLOUR;

		try {
			await setBrand(page, target);
			await expect(page.locator('.ep-brand-ctl-value')).toHaveText(target);
			await expect(page.locator('.ep-suite-header .ep-brand-ctl'), 'still no chip in the header after save').toHaveCount(0);
			const sw = await page.locator('.ep-brand-ctl-swatch').evaluate(el => {
				const cs = getComputedStyle(el); return { bg: cs.backgroundColor, w: cs.width, h: cs.height };
			});
			const hex = (s: string) => '#' + s.match(/\d+/g)!.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
			expect(hex(sw.bg), 'swatch shows the saved colour').toBe(target);
			expect(sw.w).toBe('18px'); expect(sw.h).toBe('18px');
			await expect(page.locator('.ep-brand-ctl-input')).toHaveValue(target);
			await openBrandingGroup(page);
			await page.locator('#group-ep-suite-branding').screenshot({ path: `${SHOTS}/ep-suite-branding-group-saved.png` });
		} finally {
			if (/^#[0-9a-f]{6}$/i.test(original)) await setBrand(page, original);
			else await setBrand(page, 'none', true);
			await expect(page.locator('.ep-brand-ctl-value')).toHaveText(/^#[0-9a-f]{6}$/i.test(original) ? original : 'Not set');
			console.log('restored brand:', await page.locator('.ep-brand-ctl-value').innerText());
		}
		await page.locator('.ep-suite-header').screenshot({ path: `${SHOTS}/ep-suite-header-home.png` });
		expect(errors, 'no page errors').toEqual([]);
	});

	test('non-home plugin: same header, no Branding group', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await adminLogin(page);
		const plugins = await activeEpPlugins(page);
		let other = '';
		for (const cls of plugins) {
			await openSettings(page, cls);
			if (await page.locator('.ep-suite-header').count() && !(await page.locator('#group-ep-suite-branding').count())) { other = cls; break; }
		}
		test.skip(other === '', 'only one EP plugin with a suite header is active');
		console.log('non-home plugin:', other);
		await assertHeaderClean(page, other);
		await expect(page.locator('.ep-brand-ctl'), 'no brand control anywhere on a non-home plugin').toHaveCount(0);
		await expect(page.locator('.ep-header-badges')).toBeVisible();
		expect(errors, 'no page errors').toEqual([]);
	});
});
