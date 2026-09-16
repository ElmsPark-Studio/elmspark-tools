import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

/**
 * EP Email 1.10.55 — "SMTP selected, no password saved" admin notice.
 *
 * Forum topic 717 (MarkieSparky, 2026-09-16): after the PM 0.11.3/0.11.4 secret
 * move left every SMTP password reading as empty, contact forms failed for days
 * with nothing in the admin to say so. 1.10.55 adds two surfaces for that state:
 *
 *   1. PM 0.11+: a condition-driven admin notification (owner EP_Email, code
 *      smtp_password_missing) raised by early_notifications() on every admin
 *      render and cleared the moment a password is saved or the transport changes.
 *   2. Every core: the Transport status card on the EP Email settings page goes
 *      red with the same message.
 *
 * State is seeded straight into the dev11b options row over ssh (the row did not
 * exist before this test and is removed afterwards), because the point is the
 * stored state, not the form that produces it.
 */

const DB = process.env.DEV11B_DB_NAME || 'dev11b_pm';
const PFX = process.env.DEV11B_DB_PREFIX || 'pm_';
const TABLE = `${DB}.${PFX}options`;

function sql(q: string): string {
	return execSync(`ssh ionos-ts ${JSON.stringify(`mysql -N -e ${JSON.stringify(q)}`)}`, { encoding: 'utf8' }).trim();
}
function seed(row: Record<string, string>) {
	const json = JSON.stringify(row).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	sql(`INSERT INTO ${TABLE} (name, value) VALUES ('EP_Email', '${json}') ON DUPLICATE KEY UPDATE value = VALUES(value)`);
}
const SMTP_NO_PASSWORD = {
	transport: 'smtp', smtp_host: 'smtp.example.test', smtp_port: '465', smtp_encryption: 'ssl',
	smtp_auth: 'login', smtp_username: 'probe@example.test', smtp_password: '', smtp_password_enc: '',
	from_name: 'Probe', from_email: 'probe@example.test',
};

const NOTICE = '.ui-notification[data-owner="EP_Email"][data-code="smtp_password_missing"]';

test.describe.configure({ mode: 'serial' });

test.describe('EP Email 1.10.55 — SMTP password notice', () => {
	test.beforeAll(() => {
		expect(sql(`SELECT COUNT(*) FROM ${TABLE} WHERE name='EP_Email'`), 'EP_Email row must not pre-exist on dev11b').toBe('0');
	});
	test.afterAll(() => {
		sql(`DELETE FROM ${TABLE} WHERE name='EP_Email'`);
	});

	test('raises the notice and reddens the Transport card when SMTP has auth but no password', async ({ page }) => {
		seed(SMTP_NO_PASSWORD);
		await adminLogin(page);
		await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
		const notice = page.locator(NOTICE);
		await expect(notice).toHaveCount(1);
		await expect(notice.locator('.ui-notification-message')).toContainText('no SMTP password is saved');
		await expect(notice.locator('.ui-notification-cta a')).toHaveText('Enter the SMTP password');
		// The stored row now carries the condition-driven entry too.
		expect(sql(`SELECT JSON_EXTRACT(value, '$.EP_Email.smtp_password_missing.type') FROM ${TABLE} WHERE name='notifications'`)).toBe('"warning"');

		await openPluginSettings(page, 'EP_Email');
		const card = page.locator('.ep-status-card--red', { hasText: 'SMTP' });
		await expect(card).toHaveCount(1);
		await expect(card).toContainText('No SMTP password saved');
	});

	test('clears itself once the transport no longer needs a password', async ({ page }) => {
		seed({ ...SMTP_NO_PASSWORD, transport: 'mail' });
		await adminLogin(page);
		await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
		await expect(page.locator(NOTICE)).toHaveCount(0);
		expect(sql(`SELECT COUNT(*) FROM ${TABLE} WHERE name='notifications' AND value LIKE '%smtp_password_missing%'`)).toBe('0');

		await openPluginSettings(page, 'EP_Email');
		await expect(page.locator('.ep-status-card--red')).toHaveCount(0);
	});

	test('stays quiet for SMTP without authentication', async ({ page }) => {
		seed({ ...SMTP_NO_PASSWORD, smtp_auth: '' });
		await adminLogin(page);
		await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
		await expect(page.locator(NOTICE)).toHaveCount(0);
	});
});
