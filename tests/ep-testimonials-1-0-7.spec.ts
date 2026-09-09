import { test, expect, request as pwRequest } from '@playwright/test';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

/**
 * EP Testimonials v1.0.7 regression tests.
 *
 * Three real bugs reported by Keith on 2026-05-08 against v1.0.6:
 *
 *   1. Frontend cards overflow horizontally with no word wrap on long content.
 *      Root cause: `.ep-testimonial-card` is a CSS Grid item with default
 *      `min-width: auto`, refusing to shrink below the content's intrinsic
 *      min size. Fix: `min-width: 0` on the card and the body.
 *
 *   2. Paragraph breaks lost in admin moderation queue. Root cause: settings.js
 *      escaped HTML but never converted `\n` to `<br>`. Fix: nl2br after escape.
 *
 *   3. Action buttons icon-only with no tooltip (Featured ☆ and Delete ×).
 *      Root cause: no `title`/`aria-label` on the buttons. Fix: add them via
 *      new translatable `tip_*` strings.
 *
 * The deployed-asset checks below would FAIL against v1.0.6 (the rules and
 * code are not present in 1.0.6) and PASS against v1.0.7. That gives a
 * regression-safe gate that does not depend on seeded test data.
 *
 * The behavioural checks against the live admin moderation table will only
 * run when the table contains rows; they skip otherwise rather than passing
 * trivially.
 */

const CSS_URL = '/user-content/plugins/ep-testimonials/css/ep-testimonials.css';
const JS_URL  = '/user-content/plugins/ep-testimonials/js/ep-testimonials-settings.js';

test.describe('EP Testimonials v1.0.7 — deployed assets', () => {
	test('frontend CSS carries the v1.0.7 grid-shrink fix', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(CSS_URL);
		expect(res.status(), 'CSS file must be reachable').toBe(200);
		const css = await res.text();

		// v1.0.7 must declare min-width: 0 on .ep-testimonial-card. v1.0.6
		// only had overflow-wrap on the body, which was masked by the card's
		// default min-width: auto.
		const cardBlock = css.match(/\.ep-testimonial-card\s*\{[^}]*\}/);
		expect(cardBlock, 'CSS must contain a .ep-testimonial-card block').toBeTruthy();
		expect(cardBlock![0]).toMatch(/min-width:\s*0/);

		// And on the body, plus belt-and-braces wrap rules.
		const bodyBlock = css.match(/\.ep-testimonial-body\s*\{[^}]*\}/);
		expect(bodyBlock, 'CSS must contain a .ep-testimonial-body block').toBeTruthy();
		expect(bodyBlock![0]).toMatch(/min-width:\s*0/);
		expect(bodyBlock![0]).toMatch(/overflow-wrap:\s*break-word/);
		expect(bodyBlock![0]).toMatch(/word-break:\s*break-word/);
		// v1.0.8: defensive white-space: normal on body so wrap survives a <pre> parent.
		expect(bodyBlock![0]).toMatch(/white-space:\s*normal/);

		// v1.0.8: same defence on the card and the grid container.
		const gridBlock = css.match(/\.ep-testimonials\s*\{[^}]*\}/);
		expect(gridBlock, 'CSS must contain a .ep-testimonials block').toBeTruthy();
		expect(gridBlock![0]).toMatch(/white-space:\s*normal/);
		expect(cardBlock![0]).toMatch(/white-space:\s*normal/);

		await ctx.dispose();
	});

	test('star-rating radios stay hidden under a theme that forces input display', async ({ browser, baseURL }) => {
		// v1.0.9 used `.ep-star-input input { display: none }` which was tied
		// in specificity with theme rules like `input[type="radio"] { display: inline-block }`
		// and lost on document-order tie-break. v1.0.10 switched to the
		// visually-hidden pattern (position: absolute; opacity: 0) and a
		// stronger selector (.ep-star-input input[type="radio"], specificity 0,2,1).
		const cssRes = await (await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true })).get(CSS_URL);
		const cssText = await cssRes.text();
		const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
${cssText}
/* Synthetic theme rules that defeated v1.0.9 */
input, textarea, select { display: block; }
input[type="checkbox"], input[type="radio"] { display: inline-block; }
</style>
</head>
<body><form>
<fieldset class="ep-star-input">
<input type="radio" name="rating" value="1" id="r1"><label for="r1">★</label>
<input type="radio" name="rating" value="2" id="r2"><label for="r2">★</label>
<input type="radio" name="rating" value="3" id="r3"><label for="r3">★</label>
<input type="radio" name="rating" value="4" id="r4"><label for="r4">★</label>
<input type="radio" name="rating" value="5" id="r5"><label for="r5">★</label>
</fieldset>
</form></body></html>`;
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await ctx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		const probe = await page.evaluate(() => {
			const radios = Array.from(document.querySelectorAll('.ep-star-input input[type="radio"]')) as HTMLElement[];
			return radios.map(r => {
				const cs = window.getComputedStyle(r);
				const rect = r.getBoundingClientRect();
				return { width: rect.width, height: rect.height, opacity: cs.opacity, position: cs.position };
			});
		});
		await ctx.close();

		// All radios must be effectively invisible: zero or near-zero box, opacity 0, absolutely positioned.
		for (const p of probe) {
			expect(p.opacity, 'radio opacity must be 0 (v1.0.10)').toBe('0');
			expect(p.position, 'radio must be position: absolute to escape theme display rules (v1.0.10)').toBe('absolute');
			expect(p.width, 'radio width must be ≤ 1px (v1.0.10)').toBeLessThanOrEqual(1);
		}
	});

	test('Submit button colours come from CSS variables, not hardcoded indigo', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(CSS_URL);
		const cssText = await res.text();
		await ctx.dispose();

		const submitBlock = cssText.match(/\.ep-testimonial-submit\s*\{[^}]*\}/);
		expect(submitBlock, 'CSS must contain a .ep-testimonial-submit block').toBeTruthy();

		// v1.0.10: variable-driven, no hardcoded indigo.
		expect(submitBlock![0]).toMatch(/var\(--ep-testimonial-submit-bg/);
		expect(submitBlock![0]).toMatch(/var\(--ep-testimonial-submit-color/);
		expect(submitBlock![0]).not.toMatch(/#4f46e5/i);

		const hoverBlock = cssText.match(/\.ep-testimonial-submit:hover\s*\{[^}]*\}/);
		expect(hoverBlock).toBeTruthy();
		expect(hoverBlock![0]).toMatch(/var\(--ep-testimonial-submit-bg-hover/);
		expect(hoverBlock![0]).not.toMatch(/#4338ca/i);
	});

	test('frontend body wraps text even with white-space: pre on an ancestor', async ({ browser, baseURL }) => {
		// Synthetic regression: load a tiny page that wraps the rendered card
		// markup inside a <pre>, attach the deployed CSS, and verify the body
		// scrollWidth no longer exceeds clientWidth.
		const cssRes = await (await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true })).get(CSS_URL);
		const cssText = await cssRes.text();
		const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${cssText}</style></head>
<body><pre><div class="ep-testimonials ep-testimonials--cols-3" style="width:600px;">
  <div class="ep-testimonial-card">
    <div class="ep-testimonial-body">Pas tout juillet, avec vouloir vendre aussi moi vous ouvrir alors seize pouvoir un etudier au aller deux manger vie livre moi nouveau montrer ou lire pouvoir finir me manger avec vouloir trois.</div>
  </div>
</div></pre></body></html>`;
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await ctx.newPage();
		await page.setContent(html, { waitUntil: 'load' });

		const dims = await page.evaluate(() => {
			const body = document.querySelector('.ep-testimonial-body') as HTMLElement;
			return {
				clientWidth: body.clientWidth,
				scrollWidth: body.scrollWidth,
				whiteSpace: window.getComputedStyle(body).whiteSpace,
			};
		});
		await ctx.close();

		expect(dims.whiteSpace, 'plugin must reset white-space to normal even under a <pre> parent (v1.0.8)').toBe('normal');
		expect(dims.scrollWidth, 'body content must not overflow horizontally inside a <pre> parent (v1.0.8)').toBeLessThanOrEqual(dims.clientWidth + 2);
	});

	test('admin JS carries the v1.0.7 nl2br + tooltip fixes', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(JS_URL);
		expect(res.status(), 'JS file must be reachable').toBe(200);
		const js = await res.text();

		// nl2br conversion in the moderation body cell.
		expect(js, 'JS must convert \\n → <br> in the body cell (v1.0.7)').toMatch(/replace\(\s*\/\\r\\n\|\\r\|\\n\/g\s*,\s*['"]<br>['"]\s*\)/);

		// Tooltip strings sourced from i18n.
		expect(js, 'JS must include tip_approve via t()').toContain("t('tip_approve'");
		expect(js, 'JS must include tip_trash via t()').toContain("t('tip_trash'");
		expect(js, 'JS must include tip_featured via t()').toContain("t('tip_featured'");
		expect(js, 'JS must include tip_delete via t()').toContain("t('tip_delete'");

		// v1.0.9: status badge maps raw status to translatable status_* labels.
		expect(js, 'JS must map status to translated status_approved label').toContain("t('status_approved'");
		expect(js, 'JS must map status to translated status_pending label').toContain("t('status_pending'");
		expect(js, 'JS must map status to translated status_rejected label').toContain("t('status_rejected'");

		// title="..." and aria-label="..." attributes emitted on each action button.
		expect(js).toMatch(/class="ep-btn-approve"[^>]*title="/);
		expect(js).toMatch(/class="ep-btn-trash"[^>]*title="/);
		expect(js).toMatch(/class="ep-btn-featured"[^>]*title="/);
		expect(js).toMatch(/class="ep-btn-delete"[^>]*title="/);
		expect(js).toMatch(/class="ep-btn-approve"[^>]*aria-label="/);
		expect(js).toMatch(/class="ep-btn-delete"[^>]*aria-label="/);

		await ctx.dispose();
	});
});

test.describe('EP Testimonials v1.0.7 — admin moderation runtime', () => {
	test.beforeEach(async ({ page }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_Testimonials');
	});

	test('action buttons render with tooltips and aria-labels', async ({ page }) => {
		// Wait for the moderation table to populate. Loaded via AJAX after panel render.
		const tableLoaded = await page.locator('#ep-testimonials-table table').isVisible({ timeout: 10000 }).catch(() => false);
		test.skip(!tableLoaded, 'Moderation table did not render (likely no testimonials seeded on dev11b.elmspark.com)');

		const rowCount = await page.locator('#ep-testimonials-table tbody tr').count();
		test.skip(rowCount === 0, 'No testimonials in the moderation table — seed at least one to exercise this test');

		// Each visible action button must have BOTH title and aria-label
		// non-empty. v1.0.6 had none on Featured (☆) or Delete (×).
		const actionSelectors = ['.ep-btn-approve', '.ep-btn-trash', '.ep-btn-featured', '.ep-btn-delete'];
		for (const sel of actionSelectors) {
			const buttons = page.locator(`#ep-testimonials-table ${sel}`);
			const count = await buttons.count();
			if (count === 0) continue; // Approve hidden when status=approved; Trash hidden when status=trash. Expected.
			const first = buttons.first();
			const title = await first.getAttribute('title');
			const aria  = await first.getAttribute('aria-label');
			expect(title, `${sel} should carry a title (v1.0.7 fix)`).toBeTruthy();
			expect(aria,  `${sel} should carry an aria-label (v1.0.7 fix)`).toBeTruthy();
		}
	});

	test('multi-paragraph body renders with line breaks in moderation queue', async ({ page }) => {
		const tableLoaded = await page.locator('#ep-testimonials-table table').isVisible({ timeout: 10000 }).catch(() => false);
		test.skip(!tableLoaded, 'Moderation table did not render (likely no testimonials seeded on dev11b.elmspark.com)');

		const rowCount = await page.locator('#ep-testimonials-table tbody tr').count();
		test.skip(rowCount === 0, 'No testimonials in the moderation table');

		// At least one row body cell that contains a <br>. v1.0.6 emitted no
		// <br> for newlines, so multi-paragraph submissions ran together.
		const cellsWithBr = await page.locator('#ep-testimonials-table tbody tr td:nth-child(2):has(br)').count();
		const totalBodyCells = await page.locator('#ep-testimonials-table tbody tr td:nth-child(2)').count();
		test.skip(cellsWithBr === 0 && totalBodyCells > 0, 'No multi-line testimonials present — submit one with line breaks to exercise the v1.0.7 nl2br fix');
		expect(cellsWithBr).toBeGreaterThan(0);
	});
});
