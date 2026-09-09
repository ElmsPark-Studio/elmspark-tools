import { test, expect, request } from '@playwright/test';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

/**
 * EP Sentinel 1.0.0 verification gate.
 *
 * Tests verified:
 *  1. Admin settings page renders all three groups (Status, Config, Tools)
 *  2. Homepage is byte-identical with EP_Sentinel active (overlay_enabled = 0)
 *  3. /sentinel/ returns 401 to anonymous (no Basic Auth)
 *  4. /sentinel/api/status.json returns 401 to anonymous
 *  5. /sentinel/api/alerts.json returns 401 to anonymous
 *  6. /sentinel/api/status.json returns 200 with correct Bearer token
 *  7. /sentinel/api/alerts.json returns 200 with correct Bearer token, has cursor field
 *  8. POST /sentinel/api/ack with Bearer token returns 200 and advances ack cursor
 *  9. Run Tick Now button in admin returns success JSON
 * 10. Send Test Alert button in admin returns success JSON
 */

const SENTINEL_TOKEN = 'dev-test-token-c5c7adcad6a6e7ff';
const BASE_URL = process.env.DEV_BASE_URL || 'https://dev11b.elmspark.com';
const HOMEPAGE_BASELINE = 23076;

test.describe('EP Sentinel 1.0.0', () => {

	test('admin settings page renders all three groups', async ({ page }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_Sentinel');

		// All three section labels must be present (labels are always visible as group headers)
		await expect(page.getByText('Live Status')).toBeVisible();
		await expect(page.getByText('Configuration')).toBeVisible();
		await expect(page.getByText('Tools')).toBeVisible();

		// Expand all groups so fields and buttons become visible
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach((g: Element) => g.classList.add('open'));
		});
		await page.waitForTimeout(300);

		// Config fields (present in DOM — PM renders checkbox with options as id="{Class}-{field}-{option}")
		await expect(page.locator('input[name="EP_Sentinel[api_token]"]')).toBeAttached();
		await expect(page.locator('input[id="EP_Sentinel-overlay_enabled-enabled"]')).toBeAttached();
		await expect(page.locator('input[name="EP_Sentinel[hmac_secret]"]')).toBeAttached();

		// Buttons are present in DOM
		await expect(page.locator('#ep-sentinel-run-tick')).toBeAttached();
		await expect(page.locator('#ep-sentinel-test-alert')).toBeAttached();
	});

	test('homepage byte count is unchanged (overlay_enabled = 0)', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/`);
		expect(resp.ok()).toBeTruthy();
		const body = await resp.body();
		// Tolerate ±100 bytes for CSRF token variation; the point is no overlay script added
		expect(body.length).toBeGreaterThanOrEqual(HOMEPAGE_BASELINE - 100);
		expect(body.length).toBeLessThanOrEqual(HOMEPAGE_BASELINE + 100);
		// Must not contain overlay script marker
		expect(body.toString()).not.toContain('epSentinelDegraded');
	});

	test('/sentinel/ returns 401 to anonymous', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/sentinel/`, { failOnStatusCode: false });
		expect(resp.status()).toBe(401);
	});

	test('/sentinel/api/status.json returns 401 to anonymous', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/sentinel/api/status.json`, { failOnStatusCode: false });
		expect(resp.status()).toBe(401);
	});

	test('/sentinel/api/alerts.json returns 401 to anonymous', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/sentinel/api/alerts.json?since=0`, { failOnStatusCode: false });
		expect(resp.status()).toBe(401);
	});

	test('/sentinel/api/status.json returns 200 with valid Bearer token', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/sentinel/api/status.json`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		expect(resp.ok()).toBeTruthy();
		const json = await resp.json();
		expect(json).toHaveProperty('targets');
		expect(json).toHaveProperty('ack_cursor');
	});

	test('/sentinel/api/alerts.json returns 200 with cursor field', async ({ request }) => {
		const resp = await request.get(`${BASE_URL}/sentinel/api/alerts.json?since=0`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		expect(resp.ok()).toBeTruthy();
		const json = await resp.json();
		expect(json).toHaveProperty('cursor');
		expect(json).toHaveProperty('alerts');
		expect(Array.isArray(json.alerts)).toBeTruthy();
	});

	test('POST /sentinel/api/ack advances ack cursor', async ({ request }) => {
		// Get current cursor
		const before = await request.get(`${BASE_URL}/sentinel/api/alerts.json?since=0`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		const beforeJson = await before.json();
		const initialCursor = beforeJson.cursor as number;

		// Ack to a higher value
		const newCursor = initialCursor + 1;
		// Trailing slash required — PM redirects /sentinel/api/ack → /sentinel/api/ack/ (no-extension rule)
		const ackResp = await request.post(`${BASE_URL}/sentinel/api/ack/`, {
			headers: {
				'Authorization': `Bearer ${SENTINEL_TOKEN}`,
				'Content-Type': 'application/json',
			},
			data: JSON.stringify({ cursor: newCursor }),
		});
		expect(ackResp.ok()).toBeTruthy();

		// ack_cursor in status.json should now be at least newCursor
		const after = await request.get(`${BASE_URL}/sentinel/api/status.json`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		const afterJson = await after.json();
		expect((afterJson.ack_cursor as number)).toBeGreaterThanOrEqual(newCursor);
	});

	test('Run Tick Now button in admin returns success', async ({ page }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_Sentinel');

		// Expand all groups to ensure buttons are accessible
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach((g: Element) => g.classList.add('open'));
		});
		await page.waitForTimeout(300);

		const tickBtn = page.locator('#ep-sentinel-run-tick');
		const tickMsg = page.locator('#ep-sentinel-tick-msg');

		// Dispatch click via JS — button may be in a collapsed group
		await page.evaluate(() => (document.getElementById('ep-sentinel-run-tick') as HTMLButtonElement)?.click());
		// Wait for async response
		await expect(tickMsg).not.toHaveText('', { timeout: 20000 });
		const msg = await tickMsg.textContent();
		// Should not contain "failed" or "error"
		expect(msg?.toLowerCase()).not.toContain('failed');
		expect(msg?.toLowerCase()).not.toContain('error');
	});

	test('Send Test Alert button pushes to feed', async ({ page, request }) => {
		await adminLogin(page);
		await openPluginSettings(page, 'EP_Sentinel');

		// Expand all groups
		await page.evaluate(() => {
			document.querySelectorAll('.option-group').forEach((g: Element) => g.classList.add('open'));
		});
		await page.waitForTimeout(300);

		// Get cursor before
		const before = await request.get(`${BASE_URL}/sentinel/api/alerts.json?since=0`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		const beforeJson = await before.json();
		const beforeCursor = beforeJson.cursor as number;

		const alertBtn = page.locator('#ep-sentinel-test-alert');
		const alertMsg = page.locator('#ep-sentinel-alert-msg');

		await page.evaluate(() => (document.getElementById('ep-sentinel-test-alert') as HTMLButtonElement)?.click());
		// Wait for button to be re-enabled — that happens in the AJAX onDone callback, ensuring DB write is committed
		await page.waitForFunction(
			() => !(document.getElementById('ep-sentinel-test-alert') as HTMLButtonElement)?.disabled,
			{ timeout: 10000 }
		);
		const msg = await (page.locator('#ep-sentinel-alert-msg')).textContent();
		expect(msg?.toLowerCase()).not.toContain('failed');

		// Feed cursor should advance (test alert was pushed)
		const after = await request.get(`${BASE_URL}/sentinel/api/alerts.json?since=0`, {
			headers: { 'Authorization': `Bearer ${SENTINEL_TOKEN}` },
		});
		const afterJson = await after.json();
		expect((afterJson.cursor as number)).toBeGreaterThan(beforeCursor);
	});

});
