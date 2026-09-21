import { Page, expect } from '@playwright/test';

/**
 * Log into PageMotor admin as the configured admin user. Reads from
 * DEV_ADMIN_USER / DEV_ADMIN_PASSWORD env vars (typically sourced from
 * ~/.config/elmspark/dev11b-admin.env).
 *
 * Errors loudly if either env var is missing — never falls back to a
 * default and never accepts a hardcoded credential.
 */
export async function adminLogin(page: Page): Promise<void> {
	const user = process.env.DEV_ADMIN_USER;
	const password = process.env.DEV_ADMIN_PASSWORD;
	if (!user || !password)
		throw new Error('Set DEV_ADMIN_USER and DEV_ADMIN_PASSWORD before running tests. Source from ~/.config/elmspark/dev11b-admin.env (NOT dev-admin.env, which holds the retired dev.elmspark.com password and is silently rejected by dev11b).');

	await page.goto('/admin/', { waitUntil: 'networkidle' });

	// The login form is inside the same admin URL. PM uses an AJAX login
	// flow that POSTs `pm_ajax=pm-log-in` + `form=user=...&password=...`,
	// then the JS reads `redirect` from the response and does
	// window.location = redirect. We wait for that navigation explicitly.
	await page.fill('input[name="user"]', user);
	await page.fill('input[name="password"]', password);
	await Promise.all([
		page.waitForURL('**/admin/**', { waitUntil: 'networkidle', timeout: 15000 }),
		page.click('#pm-login-button'),
	]);

	// At this point we should NOT see the login form any more.
	await expect(page.locator('#pm-login')).toHaveCount(0, { timeout: 10000 });
}

/**
 * Open the settings page for a specific plugin by class name.
 */
export async function openPluginSettings(page: Page, pluginClass: string): Promise<void> {
	await page.goto('/admin/plugins/');
	// PM renders one form per active plugin; clicking the form's Settings
	// button POSTs back with `plugin=<ClassName>` to render that plugin's
	// settings.
	const form = page.locator(`form:has(input[name="plugin"][value="${pluginClass}"])`);
	await form.locator('button.action').click();
	// Wait for the plugin settings form to render.
	await expect(page.locator('form.pm-options-form')).toBeVisible({ timeout: 10000 });
}

/**
 * Click a PageMotor options form's Save button and assert the SERVER said the
 * save worked.
 *
 * TWO separate races have to be closed here, and the second is the one that
 * made the EP YouTube round-trip test flaky.
 *
 * 1. Do not click before lib/js/options-save.js has BOUND its handler.
 *    That handler ends in `return false`, which is the only thing suppressing
 *    the form's native submit. Click a moment too early and the browser does a
 *    native multipart POST of the whole form instead of the AJAX save: the
 *    response is a 43KB HTML page rather than JSON, the page navigates, and no
 *    #options-saved toast is ever painted. Observed directly on dev11b.
 *    `pm_options_save.form` is only set inside init(), so it is a precise
 *    readiness signal rather than an arbitrary sleep.
 *
 * 2. Do not assert on `#options-saved`. That toast is appended only once the
 *    POST returns, then `fadeOut(3000)` runs and its callback REMOVES it. It
 *    therefore exists for roughly a three-second window that opens whenever
 *    the server happens to answer, so waiting for it races server latency
 *    instead of checking that anything saved. Worse, it is absent in exactly
 *    the case above, where the save genuinely did not happen the intended way,
 *    so the old assertion reported the right outcome for the wrong reason.
 *
 * Matching the AJAX POST specifically (pm_ajax in the body) keeps a stray
 * native submit from being mistaken for a successful save.
 */
export async function saveOptions(page: Page, label = 'settings'): Promise<void> {
	// 1. The save handler must be bound before we click.
	await page.waitForFunction(
		() => !!(window as any).pm_options_save && !!(window as any).pm_options_save.form,
		undefined,
		{ timeout: 15000 });

	// 2. Match the AJAX save specifically, never a native multipart submit.
	const saved = page.waitForResponse(
		r => r.request().method() === 'POST'
			&& (r.request().postData() || '').includes('pm_ajax='),
		{ timeout: 30000 });

	await page.locator('button#save-options, button.save:has-text("Save")').first().click();

	const res = await saved;
	expect(res.status(), `the ${label} save POST must return 200`).toBe(200);

	const raw = await res.text();
	let body: any = {};
	try { body = JSON.parse(raw); } catch { /* handled by the assertion below */ }
	expect(body.success,
		`PageMotor must report ${label} as saved (response was: ${raw.slice(0, 200)})`).toBe(true);
}
