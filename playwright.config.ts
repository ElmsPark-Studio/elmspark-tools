import { defineConfig, devices } from '@playwright/test';

/**
 * ElmsPark plugin verification test config.
 *
 * Tests run against dev11b.elmspark.com by default. Override via DEV_BASE_URL
 * env var if you need to test against another install.
 *
 * NB dev.elmspark.com was retired 2026-08-20 and only 301-redirects here, so a
 * stale default reaches a live server and fails at login instead of at DNS.
 *
 * Admin credentials are read from $DEV_ADMIN_USER / $DEV_ADMIN_PASSWORD.
 * Source them from ~/.config/elmspark/dev11b-admin.env (NOT dev-admin.env,
 * which holds the retired host's password and is rejected by dev11b):
 *
 *   set -a; source ~/.config/elmspark/dev11b-admin.env; set +a
 *   npm test
 *
 * Or run the wrapper: ./run-tests.sh
 */
export default defineConfig({
	testDir: './tests',
	timeout: 30000,
	fullyParallel: false,  // Tests share the same admin session and DB; run serially.
	forbidOnly: !!process.env.CI,
	retries: 0,
	workers: 1,
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL: process.env.DEV_BASE_URL || 'https://dev11b.elmspark.com',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		ignoreHTTPSErrors: true,
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
