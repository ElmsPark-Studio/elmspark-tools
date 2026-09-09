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
