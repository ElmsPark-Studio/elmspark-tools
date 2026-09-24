import { test, expect, Page } from '@playwright/test';
import { adminLogin, openPluginSettings, saveOptions } from '../fixtures/auth';

/**
 * EP Agent 1.1.0 (sidecar) settings UI, WIP branch wip/ep-agent-1.1.0-sidecar.
 *
 * Two phases, chosen with EPA_PHASE, because the page shows different panels:
 *  - auth-failing (default): needs a sidecar on EPA_SIDECAR_URL / EPA_SIDECAR_TOKEN
 *    whose Claude CLI is found but NOT signed in, and NO saved EP_Agent settings
 *    row, so the token save round trip is real and the only failing prerequisite
 *    afterwards is authentication ("One more step" panel).
 *  - signed-in: same sidecar, CLI now reports signed in; all prerequisites pass,
 *    so the Authentication group (method selector + guides) renders.
 * (Run 2026-09-24 with the real ep-agent-sidecar.mjs and a stand-in claude binary,
 * as nobody on 127.0.0.1:18770, switched by a flag file between the phases.)
 *
 * Verifies the four review blockers from the UI side:
 *  - both auth panels point at /etc/ep-agent/sidecar.env + restarting the sidecar,
 *    and no PHP-FPM pool advice is left anywhere on the page
 *  - the install help gives the root-only copy + checksum route, never
 *    `sudo bash install.sh` from the plugin folder
 *  - the credential help no longer claims "PHP never sees it"
 * plus the sidecar URL + token save -> reload round trip.
 */

const PHASE = process.env.EPA_PHASE || 'auth-failing';
const URL_ = process.env.EPA_SIDECAR_URL || 'http://127.0.0.1:18770';
const TOKEN = process.env.EPA_SIDECAR_TOKEN || '';
const PLUGIN_DIR = '/var/www/dev11b.elmspark.com/user-content/plugins/ep-agent/sidecar';

// Open every collapsed settings group the way a user does: click its header.
// Core hides `.group-fields` in CSS and toggles it on the header click; there
// is no `open` class, so adding one does nothing (see ep-local-business spec).
async function expandAll(page: Page) {
	await page.waitForLoadState('load');
	await page.waitForTimeout(800); // PM binds its handlers from scripts at body end
	const groups = page.locator('.option-group');
	const n = await groups.count();
	for (let i = 0; i < n; i++) {
		const g = groups.nth(i);
		const fields = g.locator('> .group-fields');
		if ((await fields.count()) && !(await fields.first().isVisible())) {
			await g.locator('> label').first().click();
			await expect(fields.first()).toBeVisible({ timeout: 5000 });
		}
	}
}

async function activateEpAgent(page: Page) {
	await page.goto('/admin/plugins/', { waitUntil: 'networkidle' });
	const already = await page.locator('form input[name="plugin"][value="EP_Agent"]').count();
	if (already) return;
	await page.evaluate(() => {
		const f = document.createElement('form'); f.method = 'POST'; f.action = location.href;
		const i = document.createElement('input'); i.type = 'hidden'; i.name = 'manage'; i.value = '1';
		f.appendChild(i); document.body.appendChild(f); f.submit();
	});
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(1000);
	const box = page.locator('input[type="checkbox"][name="plugins[EP_Agent]"]');
	await expect(box, 'EP_Agent must be listed on the manage screen').toHaveCount(1);
	if (!(await box.isChecked())) await box.check();
	await page.locator('button:has-text("Save Plugins"), input[value*="Save Plugins"]').first().click();
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(2500);
	await page.goto('/admin/plugins/', { waitUntil: 'networkidle' });
	await expect(page.locator('form input[name="plugin"][value="EP_Agent"]'),
		'EP_Agent must be active (has a settings form) after Save Plugins').toHaveCount(1);
}

test.describe.serial('EP Agent 1.1.0 sidecar settings UI', () => {
	test.setTimeout(120000);

	test('activate, render, save sidecar settings, One more step panel points at the sidecar', async ({ page }) => {
		test.skip(PHASE !== 'auth-failing', 'auth-failing phase only');
		expect(TOKEN, 'set EPA_SIDECAR_TOKEN').not.toBe('');

		const jsErrors: string[] = [];
		page.on('pageerror', e => jsErrors.push(String(e)));
		page.on('console', m => { if (m.type() === 'error') jsErrors.push(m.text()); });

		await adminLogin(page);
		await activateEpAgent(page);

		// ---- 1. Fresh settings page, no token yet
		await openPluginSettings(page, 'EP_Agent');
		await page.waitForTimeout(1500);
		await expandAll(page);

		await expect(page.locator('input[name="EP_Agent[sidecar_url]"]')).toBeAttached();
		const tokenField = page.locator('input[name="EP_Agent[sidecar_token]"]');
		await expect(tokenField).toBeAttached();
		expect(await tokenField.getAttribute('type'), 'token field must be a password input').toBe('password');

		const body1 = await page.locator('body').innerText();
		expect(body1).toContain('No sidecar token set.');

		// Install help: root-only copy + checksum route, with this site's real plugin path
		const help = page.locator('pre', { hasText: '/root/ep-agent-sidecar' });
		await expect(help).toHaveCount(1);
		const helpText = await help.innerText();
		expect(helpText).toContain(`sudo cp -rL ${PLUGIN_DIR} /root/ep-agent-sidecar`);
		expect(helpText).toContain('sudo chown -R root:root /root/ep-agent-sidecar');
		expect(helpText).toContain('cat install.sh ep-agent-sidecar.mjs ep-agent-sidecar.service | sha256sum');
		expect(helpText).toContain('sudo bash /root/ep-agent-sidecar/install.sh');
		expect(helpText, 'must never tell root to run install.sh from the plugin folder').not.toMatch(/cd user-content\/plugins\/ep-agent\/sidecar/);
		expect(body1).toContain('Sidecar checksum');
		expect(body1).toContain('which only root can read');
		expect(body1).not.toContain('PHP never sees it');

		// ---- 2. Save URL + token, reload, assert both persisted
		await page.fill('input[name="EP_Agent[sidecar_url]"]', URL_);
		await page.fill('input[name="EP_Agent[sidecar_token]"]', TOKEN);
		await saveOptions(page, 'EP Agent sidecar settings');

		await openPluginSettings(page, 'EP_Agent');
		await page.waitForTimeout(2500);
		await expandAll(page);
		expect(await page.locator('input[name="EP_Agent[sidecar_url]"]').inputValue(), 'sidecar URL persisted').toBe(URL_);
		// Core never echoes a saved secret back to the browser; the proof that the
		// token persisted (and decrypts) is the prerequisite check below.
		expect(await page.locator('input[name="EP_Agent[sidecar_token]"]').inputValue(), 'saved token must not be echoed into the page').toBe('');
		expect(await page.content(), 'the token must not appear anywhere in the page').not.toContain(TOKEN);

		// ---- 3. Prereqs now come from the real sidecar: everything passes except auth
		const body2 = await page.locator('body').innerText();
		expect(body2).toContain('Sidecar token is configured');
		expect(body2).toMatch(/Sidecar 1\.0\.0 responding on http:\/\/127\.0\.0\.1:18770/);
		expect(body2).toContain('Claude CLI available to the sidecar');
		expect(body2).toContain('2.1.280 (Claude Code)');

		// ---- 4. "One more step" panel (only auth failing) points at the sidecar
		await expect(page.getByText('One more step: connect Claude to your account')).toBeVisible();
		const panel = page.locator('div', { has: page.getByText('One more step: connect Claude to your account') }).last();
		const panelText = await panel.innerText();
		expect(panelText).toContain('/etc/ep-agent/sidecar.env');
		expect(panelText).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-PASTE-YOUR-TOKEN-HERE');
		expect(panelText).toContain('ANTHROPIC_API_KEY=sk-ant-PASTE-YOUR-KEY-HERE');
		expect((panelText.match(/sudo systemctl restart ep-agent-sidecar/g) || []).length,
			'both options end with restarting the sidecar').toBeGreaterThanOrEqual(2);
		// Copy buttons carry the exact commands
		await expect(page.locator('button.ep-agent-copy[data-copy="sudo nano /etc/ep-agent/sidecar.env"]')).toHaveCount(2);
		await expect(page.locator('button.ep-agent-copy[data-copy="sudo systemctl restart ep-agent-sidecar"]')).toHaveCount(2);
		await panel.screenshot({ path: 'test-results/ep-agent-1-1-0-auth-panel.png' });

		// ---- 6. No FPM pool advice anywhere on the rendered page (visible or hidden)
		const html = await page.content();
		for (const stale of ['fpm/pool.d', 'env[ANTHROPIC_API_KEY]', 'env[CLAUDE_CODE_OAUTH_TOKEN]', 'systemctl reload php', 'pool config', 'lsphp'])
			expect(html, `stale FPM advice "${stale}" must be gone`).not.toContain(stale);

		expect(jsErrors, 'no JS errors on the settings page').toEqual([]);
	});

	test('signed in: all prerequisites pass, Authentication guides point at the sidecar', async ({ page }) => {
		test.skip(PHASE !== 'signed-in', 'signed-in phase only');

		const jsErrors: string[] = [];
		page.on('pageerror', e => jsErrors.push(String(e)));
		page.on('console', m => { if (m.type() === 'error') jsErrors.push(m.text()); });

		await adminLogin(page);
		await openPluginSettings(page, 'EP_Agent');
		await page.waitForTimeout(2500);
		await expandAll(page);

		const body = await page.locator('body').innerText();
		expect(body).toContain('All prerequisites met. EP Agent is ready to use.');
		expect(body).toContain('Connected to your Max plan subscription.');
		// With everything passing, the prereq table folds into a closed <details>.
		await page.getByText('Show details').first().click();
		await expect(page.getByText('Sidecar token is configured')).toBeVisible();
		await expect(page.getByText('One more step: connect Claude to your account')).toHaveCount(0);

		const sel = page.locator('select[name="EP_Agent[auth_method]"]');
		await expect(sel, 'Authentication group renders once every prerequisite passes').toBeAttached();
		await sel.selectOption('api_key');
		await expect(page.locator('#ep-agent-guide-api_key')).toBeVisible();
		await expect(page.locator('#ep-agent-guide-max_plan')).toBeHidden();
		const apiGuide = await page.locator('#ep-agent-guide-api_key').innerText();
		expect(apiGuide).toContain('sudo nano /etc/ep-agent/sidecar.env');
		expect(apiGuide).toContain('ANTHROPIC_API_KEY=sk-ant-your-key-here');
		expect(apiGuide).toContain('sudo systemctl restart ep-agent-sidecar');
		await sel.selectOption('max_plan');
		await expect(page.locator('#ep-agent-guide-max_plan')).toBeVisible();
		await expect(page.locator('#ep-agent-guide-api_key')).toBeHidden();
		const maxGuide = await page.locator('#ep-agent-guide-max_plan').innerText();
		expect(maxGuide).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-paste-your-token-here');
		expect(maxGuide).toContain('sudo systemctl restart ep-agent-sidecar');
		await page.locator('#ep-agent-guide-max_plan').screenshot({ path: 'test-results/ep-agent-1-1-0-max-guide.png' });

		const html = await page.content();
		for (const stale of ['fpm/pool.d', 'env[ANTHROPIC_API_KEY]', 'env[CLAUDE_CODE_OAUTH_TOKEN]', 'systemctl reload php', 'pool config', 'lsphp'])
			expect(html, `stale FPM advice "${stale}" must be gone`).not.toContain(stale);

		expect(jsErrors, 'no JS errors on the settings page').toEqual([]);
	});
});
