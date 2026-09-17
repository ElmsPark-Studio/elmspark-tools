import { test, expect, request as pwRequest } from '@playwright/test';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

/**
 * EP YouTube v1.0.0 smoke test.
 *
 * Three tiers of verification:
 *
 *   1. Deployed-asset checks — confirm the CSS/JS files are reachable and
 *      contain the v1.0.0 fingerprints (youtube-nocookie literal,
 *      object-fit on the placeholder, etc).
 *
 *   2. Synthetic browser test — load a static page that pulls the deployed
 *      CSS+JS, drop in a .youtube box, verify the JS paints a thumbnail
 *      and that clicking builds an iframe pointing at youtube-nocookie.com.
 *      Doesn't depend on the plugin being activated in PM admin.
 *
 *   3. Admin round-trip — log in, activate EP_YouTube if not already,
 *      flip Self-Host Thumbnails on, save, reload, confirm the setting
 *      persisted. The reload step is the one that catches the whole
 *      class of "renders fine but doesn't read back" bugs that bit
 *      EP Local Business 1.1.3 → 1.1.6.
 */

const CSS_URL = '/user-content/plugins/ep-youtube/css/ep-youtube.css';
const JS_URL  = '/user-content/plugins/ep-youtube/js/ep-youtube.js';
const TEST_VIDEO_ID = 'dQw4w9WgXcQ';

test.describe('EP YouTube v1.0.0 — deployed assets', () => {
	test('CSS file is reachable and carries the v1.0.0 styles', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(CSS_URL);
		expect(res.status(), 'CSS file must be reachable').toBe(200);
		const css = await res.text();

		// Aspect-ratio padding-top hack: 16:9 → 56.25%
		expect(css, 'must declare 16:9 default aspect via padding-top hack').toMatch(/padding-top:\s*56\.25%/);

		// object-fit: cover on the thumbnail (so it fills the box without distortion)
		expect(css, 'thumbnail must use object-fit: cover').toMatch(/object-fit:\s*cover/);

		// Play button styling
		expect(css, 'play button must use red background').toMatch(/background-color:\s*#ff1616/);

		await ctx.dispose();
	});

	test('JS file is reachable and carries the v1.0.0 features', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(JS_URL);
		expect(res.status(), 'JS file must be reachable').toBe(200);
		const js = await res.text();

		// No-Cookie Mode is the headline upgrade over Chris's original
		expect(js, 'JS must reference youtube-nocookie.com host').toContain('youtube-nocookie.com');

		// Self-host pre-cache wiring
		expect(js, 'JS must call cache_thumb action when self-host is on').toContain("'cache_thumb'");

		// Reads window.EPYouTube config
		expect(js, 'JS must read window.EPYouTube config').toContain('window.EPYouTube');

		// Selects boxes by class
		expect(js, 'JS must query .youtube[data-embed]').toContain('.youtube[data-embed]');

		// decoding=async on the thumbnail (we don't use loading=lazy because
		// the whole .youtube box IS the lazy-load and detached Image() with
		// loading=lazy defers the load event indefinitely)
		expect(js, 'thumbnail must use decoding=async').toContain("decoding = 'async'");

		await ctx.dispose();
	});
});

test.describe('EP YouTube v1.0.0 — synthetic browser test', () => {
	test('JS paints thumbnail and builds youtube-nocookie iframe on click', async ({ browser, baseURL }) => {
		// Pull the deployed assets and stitch them into a self-contained page.
		// This proves the JS works against any DOM that has .youtube[data-embed]
		// markup, including hand-written HTML carried over from a Thesis port.
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const cssText = await (await ctx.get(CSS_URL)).text();
		const jsText  = await (await ctx.get(JS_URL)).text();
		await ctx.dispose();

		const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<style>${cssText}</style>
</head>
<body style="width:800px;">
<script>window.EPYouTube={nocookie:true,res:'sd',selfHost:false,plugin:'EP_YouTube'};</script>
<div class="youtube" data-embed="${TEST_VIDEO_ID}" data-alt="Synthetic test"><div class="play"></div></div>
<script>${jsText}</script>
</body></html>`;

		const browserCtx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await browserCtx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		// Wait for the thumbnail image to be appended (JS appends on Image.load).
		// Browsers will actually fetch i.ytimg.com here; if offline this awaits forever.
		await page.waitForFunction(() => {
			const box = document.querySelector('.youtube');
			return box && box.querySelector('img');
		}, { timeout: 10000 });

		const thumb = page.locator('.youtube img');
		await expect(thumb, 'thumbnail must be appended to the .youtube box').toBeAttached();
		const thumbSrc = await thumb.getAttribute('src');
		expect(thumbSrc, 'default thumbnail comes from i.ytimg.com').toContain('i.ytimg.com');
		expect(thumbSrc, 'sd resolution by default').toContain('sddefault');
		expect(thumbSrc, 'thumbnail URL must include the video ID').toContain(TEST_VIDEO_ID);

		const altAttr = await thumb.getAttribute('alt');
		expect(altAttr, 'data-alt must propagate to the img alt attribute').toBe('Synthetic test');

		// Click the box. The play button has pointer-events:none so the click
		// reaches the .youtube box itself. After click, the JS replaces innerHTML
		// with an iframe. There must be no img any more, and the iframe src
		// must point at youtube-nocookie.com (the v1.0.0 GDPR upgrade over Chris's original).
		await page.locator('.youtube').click();

		const iframe = page.locator('.youtube iframe');
		await expect(iframe, 'iframe must replace the placeholder on click').toBeAttached();

		const iframeSrc = await iframe.getAttribute('src');
		expect(iframeSrc, 'iframe must use youtube-nocookie.com (GDPR upgrade)').toContain('youtube-nocookie.com');
		expect(iframeSrc, 'iframe must reference the embed path').toContain(`/embed/${TEST_VIDEO_ID}`);
		expect(iframeSrc, 'iframe must include autoplay=1').toContain('autoplay=1');
		expect(iframeSrc, 'iframe must include rel=0 to suppress related videos').toContain('rel=0');

		await browserCtx.close();
	});

	test('custom data-thumb overrides YouTube CDN', async ({ browser, baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const jsText  = await (await ctx.get(JS_URL)).text();
		await ctx.dispose();

		// Use a tiny inline data: URL as a "custom thumbnail" so the test
		// doesn't depend on any external host.
		const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

		const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>.youtube{width:200px;height:120px;}</style></head>
<body>
<script>window.EPYouTube={nocookie:true,res:'sd',selfHost:false,plugin:'EP_YouTube'};</script>
<div class="youtube custom-thumb" data-embed="${TEST_VIDEO_ID}" data-thumb="${tinyPng}" data-alt="Custom"><div class="play"></div></div>
<script>${jsText}</script>
</body></html>`;

		const browserCtx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await browserCtx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		await page.waitForFunction(() => {
			const box = document.querySelector('.youtube');
			return box && box.querySelector('img');
		}, { timeout: 5000 });

		const thumbSrc = await page.locator('.youtube img').getAttribute('src');
		expect(thumbSrc, 'custom data-thumb must be used instead of YouTube CDN').toBe(tinyPng);
		expect(thumbSrc, 'must NOT fall back to i.ytimg.com when data-thumb is set').not.toContain('i.ytimg.com');

		await browserCtx.close();
	});

	test('title attribute renders a heading overlay that disappears on click (v1.0.2)', async ({ browser, baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const cssText = await (await ctx.get(CSS_URL)).text();
		const jsText  = await (await ctx.get(JS_URL)).text();
		await ctx.dispose();

		const title = 'Reynolds Fishing UK — Day on the Lake';
		const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body style="width:800px;">
<script>window.EPYouTube={nocookie:true,res:'sd',selfHost:false,plugin:'EP_YouTube'};</script>
<div class="youtube has-title" data-embed="${TEST_VIDEO_ID}" data-alt="Test">
  <div class="youtube-title">${title}</div>
  <div class="play"></div>
</div>
<script>${jsText}</script>
</body></html>`;

		const browserCtx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await browserCtx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		// Title overlay must be visible before any click
		const titleEl = page.locator('.youtube .youtube-title');
		await expect(titleEl, 'title overlay must render').toHaveCount(1);
		await expect(titleEl).toBeVisible();
		await expect(titleEl).toHaveText(title);

		// Confirm CSS positions it as an overlay (absolute, with gradient)
		const css = await titleEl.evaluate(el => {
			const cs = window.getComputedStyle(el);
			return { position: cs.position, top: cs.top, color: cs.color, background: cs.background };
		});
		expect(css.position, 'title must be absolutely positioned').toBe('absolute');
		expect(css.top, 'title must be at the top').toBe('0px');
		expect(css.color, 'title text must be white').toMatch(/rgb\(255,\s*255,\s*255\)/);
		expect(css.background, 'title must have the dark gradient').toContain('gradient');

		// Wait for thumb to paint
		await page.waitForFunction(() => !!document.querySelector('.youtube img'), { timeout: 10000 });

		// Click the box - title overlay must be gone after the iframe swap
		await page.locator('.youtube').click();
		await expect(page.locator('.youtube iframe'), 'iframe must replace placeholder on click').toBeAttached();
		await expect(page.locator('.youtube .youtube-title'), 'title overlay must be removed when iframe takes over').toHaveCount(0);

		await browserCtx.close();
	});

	test('nocookie:false config switches the iframe back to youtube.com', async ({ browser, baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const cssText = await (await ctx.get(CSS_URL)).text();
		const jsText  = await (await ctx.get(JS_URL)).text();
		await ctx.dispose();

		const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body style="width:800px;">
<script>window.EPYouTube={nocookie:false,res:'sd',selfHost:false,plugin:'EP_YouTube'};</script>
<div class="youtube" data-embed="${TEST_VIDEO_ID}" data-alt="Test"><div class="play"></div></div>
<script>${jsText}</script>
</body></html>`;

		const browserCtx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await browserCtx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		await page.waitForFunction(() => !!document.querySelector('.youtube img'), { timeout: 10000 });
		await page.locator('.youtube').click();

		const iframeSrc = await page.locator('.youtube iframe').getAttribute('src');
		expect(iframeSrc, 'with nocookie:false, iframe must use youtube.com').toContain('://www.youtube.com/embed/');
		expect(iframeSrc, 'and NOT youtube-nocookie.com').not.toContain('youtube-nocookie.com');

		await browserCtx.close();
	});
});

test.describe('EP YouTube v1.0.0 — admin activation + settings round-trip', () => {
	test('plugin can be activated and Self-Host setting persists across reload', async ({ page }) => {
		await adminLogin(page);
		await page.goto('/admin/plugins/');

		// If EP_YouTube doesn't already have a settings form on the landing page,
		// activate it via the Manage Plugins view. PM's manage view uses checkboxes
		// named "plugins[<class>]" (note plural). Saving updates the `plugins`
		// option in the DB.
		const settingsForm = page.locator('form:has(input[name="plugin"][value="EP_YouTube"])');
		const alreadyActive = await settingsForm.count();

		if (alreadyActive === 0) {
			// Open Manage Plugins
			await page.locator('button[name="manage"][value="1"]').click();
			await expect(page.locator('h2:has-text("Manage Plugins")')).toBeVisible({ timeout: 10000 });

			// Tick the EP_YouTube checkbox
			const checkbox = page.locator('input.plugin-select#EP_YouTube');
			await expect(checkbox, 'EP_YouTube must appear in the Manage Plugins list').toHaveCount(1);
			await checkbox.check({ force: true });

			// Save Plugins (PM's save is AJAX; wait for the save indicator to clear)
			await page.locator('button#save-plugins').click();
			// PM uses a "Saving Plugins..." action alert that appears then disappears
			await page.waitForLoadState('networkidle');
			// Reload to land back on the settings landing view with EP_YouTube now active
			await page.goto('/admin/plugins/');
			await expect(page.locator('form:has(input[name="plugin"][value="EP_YouTube"])'), 'EP_YouTube must now have a settings form').toHaveCount(1, { timeout: 10000 });
		}

		// Now open EP_YouTube settings via the standard helper
		await openPluginSettings(page, 'EP_YouTube');

		// Expand collapsed groups so fields are interactable
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach(g => g.classList.add('open'));
		});

		// Toggle Self-Host Thumbnails on. PM names checkbox inputs
		// "<ClassName>[<key>][<option>]". The checkbox is hidden under a
		// custom toggle UI so we set the state programmatically and fire
		// the change event PM's serializer listens for.
		const selfHostName = 'EP_YouTube[self_host_thumbs][enabled]';
		await expect(page.locator(`input[name="${selfHostName}"]`), 'Self-Host Thumbnails checkbox must exist').toHaveCount(1);
		await page.evaluate(name => {
			const cb = document.querySelector(`input[name="${name}"]`) as HTMLInputElement;
			cb.checked = true;
			cb.dispatchEvent(new Event('change', { bubbles: true }));
			cb.dispatchEvent(new Event('input', { bubbles: true }));
		}, selfHostName);

		// Set default aspect to 4:3 so we can verify a non-default value round-trips
		const aspect = page.locator('select[name="EP_YouTube[default_aspect]"]');
		await expect(aspect, 'default aspect select must exist').toHaveCount(1);
		await page.evaluate(() => {
			const sel = document.querySelector('select[name="EP_YouTube[default_aspect]"]') as HTMLSelectElement;
			sel.value = '4:3';
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		});

		// Save
		await page.locator('button#save-options, button.save:has-text("Save")').first().click();
		await expect(page.locator('#options-saved')).toBeVisible({ timeout: 10000 });

		// RELOAD — the step that catches read-back-on-render bugs
		await page.reload();
		await expect(page.locator('form.pm-options-form')).toBeVisible();

		// Re-expand groups
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach(g => g.classList.add('open'));
		});

		// Self-Host should still be checked
		const selfHostAfter = page.locator('input[type="checkbox"][name="EP_YouTube[self_host_thumbs][enabled]"]');
		await expect(selfHostAfter, 'Self-Host Thumbnails must still be checked after reload').toBeChecked();

		// Aspect should still be 4:3
		const aspectAfter = page.locator('select[name="EP_YouTube[default_aspect]"]');
		await expect(aspectAfter, 'default aspect must still be 4:3 after reload').toHaveValue('4:3');
	});
});

test.describe('EP YouTube v1.0.3 — translations', () => {
	test('switching to German renders the Self-Host label in German', async ({ page }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_YouTube');

		// English baseline: Self-Host label exists as "Self-Host Thumbnails"
		const englishLabel = await page.locator('label.list-label:has-text("Self-Host Thumbnails")').count();
		expect(englishLabel, 'English default label should be present pre-switch').toBeGreaterThanOrEqual(1);

		// Switch the EP Suite language picker to German via the AJAX it uses.
		// (The picker is a <select> in the suite header; triggering its change
		// event posts ep_suite_set_language which writes the ep_suite_language
		// option and reloads.)
		await page.evaluate(() => {
			const sel = document.querySelector('select.ep-suite-lang-select') as HTMLSelectElement;
			sel.value = 'de';
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		});

		// The picker's change handler reloads the page after a short delay.
		// Wait for the new page to settle, then re-open the EP YouTube settings.
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(500);
		await openPluginSettings(page, 'EP_YouTube');

		// German label should now appear
		const germanLabel = page.locator('label.list-label:has-text("Thumbnails selbst hosten")');
		await expect(germanLabel, 'German Self-Host label must render after language switch').toHaveCount(1);

		// Tagline should also be translated
		const tagline = await page.locator('.ep-brand-tagline').textContent();
		expect(tagline, 'tagline should be German').toContain('DSGVO-konforme YouTube-Einbettungen');

		// Switch back to English so subsequent test runs start clean
		await page.evaluate(() => {
			const sel = document.querySelector('select.ep-suite-lang-select') as HTMLSelectElement;
			sel.value = 'en';
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await page.waitForLoadState('networkidle');
	});
});

test.describe('EP YouTube v1.0.0 — public page integration', () => {
	test('homepage carries window.EPYouTube config and ep-youtube.js when active', async ({ page }) => {
		// Independent of activation: if not active, this test will be skipped
		// (no script tag → no inline config → skip rather than fail loudly).
		await page.goto('/');
		const html = await page.content();

		const hasInlineConfig = /window\.EPYouTube\s*=\s*\{/.test(html);
		test.skip(!hasInlineConfig, 'EP_YouTube does not appear active on /. Run the activation test first.');

		// nocookie default is on
		const cfgMatch = html.match(/window\.EPYouTube\s*=\s*(\{[^<]+?\});/);
		expect(cfgMatch, 'inline config must be parseable').toBeTruthy();
		const cfg = JSON.parse(cfgMatch![1]);
		expect(cfg.nocookie, 'nocookie default must be true').toBe(true);
		expect(cfg.plugin, 'plugin class must be EP_YouTube').toBe('EP_YouTube');

		// Frontend JS is enqueued
		expect(html, 'ep-youtube.js must be enqueued sitewide').toContain('/user-content/plugins/ep-youtube/js/ep-youtube.js');
	});
});

/**
 * v1.0.12 — poster fallback ladder.
 *
 * YouTube does not generate sddefault.jpg for every upload. Two real ids from
 * the ANZCA 2024 video-interviews page (iVnrGB66_3Y, vBZQVkD7Wdc) 404 on
 * sddefault and maxresdefault and 200 on hqdefault, probed 2026-09-17. The
 * synthetic tests below pull the DEPLOYED JS from dev11b and let a real
 * browser hit i.ytimg.com, so they prove the fallback end to end rather than
 * against a mocked error event.
 */
const NO_SD_VIDEO_ID  = 'iVnrGB66_3Y';
const NO_SD_VIDEO_ID2 = 'vBZQVkD7Wdc';

async function syntheticPoster(browser: any, baseURL: string | undefined, id: string, res: string) {
	const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
	const cssText = await (await ctx.get(CSS_URL)).text();
	const jsText  = await (await ctx.get(JS_URL)).text();
	await ctx.dispose();

	const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body style="width:800px;">
<script>window.EPYouTube={nocookie:true,res:'${res}',selfHost:false,plugin:'EP_YouTube'};</script>
<div class="youtube" data-embed="${id}" data-alt="Fallback test"><div class="play"></div></div>
<script>${jsText}</script>
</body></html>`;

	const browserCtx = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await browserCtx.newPage();
	await page.setContent(html, { waitUntil: 'load' });
	await page.waitForFunction(() => !!document.querySelector('.youtube img'), { timeout: 15000 });
	const info = await page.locator('.youtube img').evaluate((img: HTMLImageElement) => ({
		src: img.currentSrc || img.src,
		naturalWidth: img.naturalWidth,
		naturalHeight: img.naturalHeight,
		complete: img.complete,
		boxW: (img.parentElement as HTMLElement).getBoundingClientRect().width,
		boxH: (img.parentElement as HTMLElement).getBoundingClientRect().height,
		imgW: img.getBoundingClientRect().width,
		imgH: img.getBoundingClientRect().height,
	}));
	await browserCtx.close();
	return info;
}

test.describe('EP YouTube v1.0.12 — poster fallback when sddefault is missing', () => {
	test('deployed JS carries the maxres -> sd -> hq ladder', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const js = await (await ctx.get(JS_URL)).text();
		await ctx.dispose();
		expect(js, 'must step sddefault down to hqdefault').toContain("replace('sddefault', 'hqdefault')");
		expect(js, 'must still step maxresdefault down to sddefault').toContain("replace('maxresdefault', 'sddefault')");
	});

	test('sd tier: a video with no sddefault gets the hqdefault poster', async ({ browser, baseURL }) => {
		const info = await syntheticPoster(browser, baseURL, NO_SD_VIDEO_ID, 'sd');
		expect(info.src, 'poster must have stepped down to hqdefault').toContain(`/vi/${NO_SD_VIDEO_ID}/hqdefault.jpg`);
		expect(info.naturalWidth, 'poster must be a real decoded image').toBeGreaterThan(0);
		expect(info.complete).toBe(true);
	});

	test('maxres tier: a video with neither maxres nor sd walks down to hqdefault', async ({ browser, baseURL }) => {
		const info = await syntheticPoster(browser, baseURL, NO_SD_VIDEO_ID2, 'maxres');
		expect(info.src, 'poster must have walked maxres -> sd -> hq').toContain(`/vi/${NO_SD_VIDEO_ID2}/hqdefault.jpg`);
		expect(info.naturalWidth).toBeGreaterThan(0);
	});

	test('fallback poster keeps the box dimensions (fills the 16:9 box)', async ({ browser, baseURL }) => {
		const info = await syntheticPoster(browser, baseURL, NO_SD_VIDEO_ID, 'sd');
		expect(info.boxW, 'box must be laid out').toBeGreaterThan(0);
		expect(Math.round(info.boxW / info.boxH * 100) / 100, 'box stays 16:9').toBeCloseTo(1.78, 1);
		expect(Math.abs(info.imgW - info.boxW), 'poster fills the box width').toBeLessThan(2);
		expect(Math.abs(info.imgH - info.boxH), 'poster fills the box height').toBeLessThan(2);
	});

	test('no regression: a video that has sddefault keeps it', async ({ browser, baseURL }) => {
		const info = await syntheticPoster(browser, baseURL, TEST_VIDEO_ID, 'sd');
		expect(info.src, 'sddefault must still be used when it exists').toContain(`/vi/${TEST_VIDEO_ID}/sddefault.jpg`);
		expect(info.naturalWidth).toBeGreaterThan(0);
	});

	test('front-end JS is cache-busted on a core that does not stamp it (dev11b is 0.11.2)', async ({ page }) => {
		await page.goto('/');
		const html = await page.content();
		test.skip(!/window\.EPYouTube\s*=\s*\{/.test(html), 'EP_YouTube not active on /. Run the activation test first.');
		const m = html.match(/<script src="([^"]*\/ep-youtube\/js\/ep-youtube\.js[^"]*)"/);
		expect(m, 'ep-youtube.js must be enqueued').toBeTruthy();
		const src = m![1];
		const stamps = (src.match(/\?v=/g) || []).length;
		expect(stamps, `script src must carry exactly one ?v= stamp, got: ${src}`).toBe(1);
		expect(src, 'stamp must be the plugin version').toContain('?v=1.0.12');
	});
});
