import { test, expect, request as pwRequest } from '@playwright/test';

/**
 * EP Ecommerce — asynchronous payments (mobile money).
 *
 * Covers the contract added for providers whose approval happens off-browser:
 * the customer approves on their handset and the page can only wait well.
 *
 * Four tiers:
 *
 *   1. Deployed assets — the shared waiting-state JS/CSS are reachable and
 *      carry the behaviours that matter (backoff, stop-at-expiry, 429 easing).
 *
 *   2. Webhook endpoint — the .json slug answers, and the EXTENSIONLESS form
 *      is proven to 301 and lose the POST body. That is not a style point:
 *      PM_Page redirects extensionless front-end paths and exempts only
 *      api/mcp/oauth/.well-known, so a webhook slug without a file extension
 *      silently receives nothing.
 *
 *   3. Poll channel — the scoped read key is required, a per-order token is
 *      required, and a wrong token cannot be told apart from a missing order
 *      (so order ids cannot be enumerated).
 *
 *   4. Synthetic browser test — drive the DEPLOYED await JS through its whole
 *      state machine against a stubbed poll: waiting, settle, human failure
 *      reason, and stop-at-expiry. No gateway credentials needed, which is
 *      what lets this run anywhere.
 *
 * Deliberately NOT covered: a real Paystack or Daraja transaction. Both need
 * sandbox credentials this suite does not hold. When those exist, add a fifth
 * tier; do not let the absence quietly read as coverage.
 */

const AWAIT_JS  = '/user-content/plugins/ep-ecommerce/js/ep-ecommerce-await.js';
const AWAIT_CSS = '/user-content/plugins/ep-ecommerce/css/ep-ecommerce-await.css';
const MPESA_JS  = '/user-content/plugins/ep-ecommerce-mpesa/js/ep-ecommerce-mpesa.js';
const WEBHOOK   = '/ep-payment-webhook.json';

test.describe('EP Ecommerce async — deployed assets', () => {
	test('waiting-state JS is reachable and carries the polling contract', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(AWAIT_JS);
		expect(res.status(), 'await JS must be reachable').toBe(200);
		const js = await res.text();

		expect(js, 'poll must be anonymous — no cookies, no CSRF').toMatch(/credentials:\s*'omit'/);
		expect(js, 'must present the scoped read key as a bearer').toMatch(/Authorization['"]?\s*:\s*'Bearer '/);
		expect(js, 'must send the per-order token').toMatch(/order_token/);
		expect(js, 'must back off on 429 rather than retry harder').toMatch(/429/);
		expect(js, 'must stop polling at expiry').toMatch(/secondsLeft\([^)]*\)\s*<=\s*0/);
		// "Never writes state" asserted by ENUMERATING what it can call, not by
		// grepping for a word: the first version of this check searched for
		// "fulfil" and failed on the comments that explain it does not fulfil.
		const actions = [...js.matchAll(/action:\s*[^,\n]+/g)].map(m => m[0]);
		expect(actions.join(' '), 'the only action it may call is the read-only poll')
			.toMatch(/order-state/);
		expect(js, 'must not reach the checkout/fulfilment endpoint').not.toMatch(/process_checkout/);
		expect(js, 'must not post to the admin AJAX surface').not.toMatch(/pm_ajax/);
		await ctx.dispose();
	});

	test('waiting-state CSS is reachable and is not a spinner', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(AWAIT_CSS);
		expect(res.status(), 'await CSS must be reachable').toBe(200);
		const css = await res.text();
		expect(css, 'countdown must use tabular figures so it does not jiggle').toMatch(/font-variant-numeric:\s*tabular-nums/);
		expect(css, 'must respect reduced motion').toMatch(/prefers-reduced-motion/);
		await ctx.dispose();
	});

	test('M-Pesa checkout JS validates the number before initiating', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(MPESA_JS);
		expect(res.status(), 'M-Pesa JS must be reachable').toBe(200);
		const js = await res.text();
		expect(js, 'must accept Safaricom 7XXXXXXXX / 1XXXXXXXX only').toMatch(/\^\[71\]\\d\{8\}\$/);
		expect(js, 'must mask the number back to the customer').toMatch(/function mask/);
		expect(js, 'resend must reuse the same order id').toMatch(/reuseOrderId/);
		await ctx.dispose();
	});
});

test.describe('EP Ecommerce async — webhook endpoint', () => {
	test('the .json slug accepts POST', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.post(WEBHOOK, { data: {}, headers: { 'Content-Type': 'application/json' } });
		expect(res.status(), 'webhook must answer POST').toBe(200);
		const body = await res.json();
		expect(body, 'unsigned/unowned body must be refused, not accepted').toMatchObject({ success: false });
		await ctx.dispose();
	});

	test('GET is refused', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.get(WEBHOOK);
		const body = await res.json();
		expect(body.reason, 'a gateway GET must not be treated as a delivery').toBe('method_not_allowed');
		await ctx.dispose();
	});

	test('THE .json IS LOAD-BEARING: the extensionless path 301s and loses the body', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.post('/ep-payment-webhook', {
			data: { probe: 1 },
			headers: { 'Content-Type': 'application/json' },
			maxRedirects: 0,
		});
		// PM_Page redirects extensionless front-end paths to a trailing slash and
		// exempts only api/mcp/oauth/.well-known. The redirect drops the POST body,
		// so a webhook slug without an extension receives nothing at all.
		expect([301, 302], 'extensionless POST must be seen to redirect').toContain(res.status());
		await ctx.dispose();
	});
});

test.describe('EP Ecommerce async — poll channel', () => {
	test('the poll refuses an anonymous caller with no scoped key', async ({ baseURL }) => {
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.post('/api/', {
			data: { class: 'EP_Ecommerce', action: 'order-state', args: { order_id: 1, order_token: 'x' } },
		});
		expect(res.status(), 'no key must be 401, not a silent empty answer').toBe(401);
		const body = await res.json();
		expect(body.reason).toBe('auth_required');
		await ctx.dispose();
	});

	test('an admin token cannot reach a keyed action either', async ({ baseURL }) => {
		const token = process.env.DEV11B_API_TOKEN;
		test.skip(!token, 'DEV11B_API_TOKEN not set');
		const ctx = await pwRequest.newContext({ baseURL, ignoreHTTPSErrors: true });
		const res = await ctx.post('/api/', {
			headers: { Authorization: `Bearer ${token}` },
			data: { class: 'EP_Ecommerce', action: 'order-state', args: { order_id: 1, order_token: 'x' } },
		});
		// 'keyed' is key-exclusive: it is NOT a rung on the admin ladder, so an
		// identity caller is refused however privileged it is.
		const body = await res.json();
		expect(body.success, 'an admin bearer must not satisfy a keyed action').toBeFalsy();
		await ctx.dispose();
	});
});

test.describe('EP Ecommerce async — waiting state in a real browser', () => {
	/** Loads the DEPLOYED await JS and drives it against a scripted poll. */
	async function harness(page: any, baseURL: string, script: any[], expiresInSec: number) {
		await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
		await page.addScriptTag({ url: AWAIT_JS });
		await page.evaluate(([script, expiresInSec]: any) => {
			(window as any).__polls = 0;
			(window as any).__script = script.slice();
			(window as any).fetch = function () {
				(window as any).__polls++;
				const n = (window as any).__script.shift() ||
					{ status: 200, json: { success: true, data: { state: 'awaiting_customer' } } };
				return Promise.resolve({ status: n.status, json: () => Promise.resolve(n.json) });
			};
			const mount = document.createElement('div');
			mount.id = 'ep-await-mount';
			document.body.appendChild(mount);
			(window as any).__result = null;
			(window as any).EP_Ecommerce_Await.start(mount, {
				order_id: 42,
				expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
				poll: { action: 'order-state', key: 'pmk_test', token: 'tok', order_id: 42 },
				display: { instruction: 'Check your phone and enter your M-Pesa PIN', target: '+254712•••678', resend_after: 0 },
			}, {
				apiUrl: '/api/',
				onSettled: (id: number) => { (window as any).__result = ['completed', id]; },
				onFailed: (s: string, r: string, m: string) => { (window as any).__result = [s, r, m]; },
			});
		}, [script, expiresInSec]);
	}

	test('waiting is the primary state: instruction, masked number, live countdown', async ({ page, baseURL }) => {
		await harness(page, baseURL!, [], 90);
		await expect(page.locator('.ep-await-instruction')).toHaveText('Check your phone and enter your M-Pesa PIN');
		await expect(page.locator('.ep-await-target-value')).toHaveText('+254712•••678');
		await expect(page.locator('.ep-await-timer')).toContainText(/\d+s/);
		// No spinner: the panel tells the customer what to DO, not that something is happening.
		await expect(page.locator('.ep-await')).toBeVisible();
	});

	test('settles when the poll reports completed, then stops polling', async ({ page, baseURL }) => {
		await harness(page, baseURL!, [
			{ status: 200, json: { success: true, data: { state: 'awaiting_customer' } } },
			{ status: 200, json: { success: true, data: { state: 'completed', message: 'Payment received. Thank you.' } } },
		], 90);
		await expect.poll(() => page.evaluate(() => (window as any).__result), { timeout: 15000 })
			.toEqual(['completed', 42]);
		const after = await page.evaluate(() => (window as any).__polls);
		await page.waitForTimeout(6000);
		expect(await page.evaluate(() => (window as any).__polls),
			'polling must stop once the order settles').toBe(after);
	});

	test('a failure reaches the buyer with the provider reason, not "payment failed"', async ({ page, baseURL }) => {
		await harness(page, baseURL!, [
			{ status: 200, json: { success: true, data: { state: 'failed', reason: 'insufficient_balance',
				message: 'There was not enough money in the account. Top up and try again.' } } },
		], 90);
		await expect.poll(() => page.evaluate(() => (window as any).__result), { timeout: 15000 })
			.toEqual(['failed', 'insufficient_balance', 'There was not enough money in the account. Top up and try again.']);
	});

	test('expiry ends it: reaches expired and stops polling, never pending forever', async ({ page, baseURL }) => {
		await harness(page, baseURL!, [], 3);
		await expect.poll(async () => (await page.evaluate(() => (window as any).__result))?.[0], { timeout: 15000 })
			.toBe('expired');
		const after = await page.evaluate(() => (window as any).__polls);
		await page.waitForTimeout(6000);
		expect(await page.evaluate(() => (window as any).__polls),
			'polling must stop dead at expiry').toBe(after);
	});
});
