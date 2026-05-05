# ElmsPark Playwright UI tests

End-to-end browser-driven verification for ElmsPark plugins on dev.elmspark.com.

## Why this exists

Real bugs we shipped because we read code instead of running it:

- `ep-local-business 1.1.3 → 1.1.6`: hours grid silently failed to persist. Three patch releases were needed because each "fix" was based on code review, not actual save+reload tests in a browser. The 1.1.5 fix even passed a static-DOM test in jsdom but failed against the real server (`$this->settings` isn't populated when `settings()` runs during plugin bootstrap, so reading from it returned empty).
- `ep-seo 1.5.3`: OG image upload silently failed. Field declared `'method'` but PM 0.8.3b's `image-upload` field type expects `'action'`. The field looked working in the UI (in-progress display flashed the filename) but the AJAX never reached the handler.

Both classes of bug are invisible from code review. Both are caught instantly by a "save → reload → assert" test in a real browser.

**Rule of thumb:** if a code change touches plugin admin JS, settings forms, or the save/AJAX flow, it must pass a Playwright test before being shipped to a tester or to production.

## Setup (one-time, per Mac)

```bash
cd ~/Developer/elmspark/tools/playwright-tests
npm install
npx playwright install chromium
```

Then create the credentials file:

```bash
mkdir -p ~/.config/elmspark
chmod 700 ~/.config/elmspark
cat > ~/.config/elmspark/dev-admin.env <<EOF
DEV_ADMIN_USER=claude_code
DEV_ADMIN_PASSWORD=<paste current claude_code password from Apple Passwords>
EOF
chmod 600 ~/.config/elmspark/dev-admin.env
```

This file is sourced at test time only. It is gitignored everywhere and never written to logs or shared.

## Running tests

```bash
./run-tests.sh                    # all tests
./run-tests.sh tests/ep-local*    # subset
./run-tests.sh --headed           # show the browser
./run-tests.sh --ui               # Playwright UI runner
```

Reports land in `playwright-report/`. Open with `npm run report`.

## Writing tests

Pattern: import the auth helpers, log in, exercise the UI, assert what's in the DOM.

```ts
import { test, expect } from '@playwright/test';
import { adminLogin, openPluginSettings } from '../fixtures/auth';

test('my plugin field saves and reloads', async ({ page }) => {
  await adminLogin(page);
  await openPluginSettings(page, 'EP_My_Plugin');
  // ... interact, save, reload, assert
});
```

If the form fields you need to fill are inside `.option-group` collapsibles, expand them first:

```ts
await page.evaluate(() => {
  document.querySelectorAll('.option-group').forEach(g => g.classList.add('open'));
});
```

PageMotor uses `'name' => $this->_class` for plugin settings, so input names look like `EP_Local_Business[lb_field_name]` (literal class name, not lowercased).

## When to run

**Always**, before shipping any patch that touches:

- Plugin settings JS or PHP `settings()` arrays
- `image-upload`, `upload`, or any custom field type
- AJAX handlers in `fetch()`
- Save round-trip (especially anything reading `$this->settings` in render code)

**Whenever a tester reports a UI bug**, write the failing test first, then fix.

## Layout

```
tools/playwright-tests/
├── package.json
├── playwright.config.ts
├── run-tests.sh              # wrapper that sources creds + runs tests
├── fixtures/
│   └── auth.ts               # adminLogin(), openPluginSettings()
└── tests/
    └── ep-local-business-hours.spec.ts
```

Add new tests under `tests/`, named `<plugin-name>-<feature>.spec.ts`.
