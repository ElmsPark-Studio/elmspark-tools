# ElmsPark Playwright UI tests

End-to-end browser-driven verification for ElmsPark plugins on **dev11b.elmspark.com**.

> **Host note.** `dev.elmspark.com` was **retired 2026-08-20** and now only 301-redirects
> to `dev11b.elmspark.com`. The redirect is why the old name kept *looking* right: a test
> pointed at the dead host still reaches a live server, so nothing fails until you try to
> log in. Never reintroduce the old name.

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

Then create the credentials file. **The file is `dev11b-admin.env`.**

```bash
mkdir -p ~/.config/elmspark
chmod 700 ~/.config/elmspark
cat > ~/.config/elmspark/dev11b-admin.env <<EOF
# Canonical keys, used by the one-off _*.mjs probe scripts
DEV11B_ADMIN_USER=claude_code
DEV11B_ADMIN_PASSWORD=<current dev11b.elmspark.com claude_code password from Apple Passwords>

# Compat aliases, SAME values. run-tests.sh, fixtures/auth.ts and the tests/
# suite all read these. Omit them and run-tests.sh exits 1 on its own guard.
DEV_ADMIN_USER=claude_code
DEV_ADMIN_PASSWORD=<same password again>
EOF
chmod 600 ~/.config/elmspark/dev11b-admin.env
```

This file is sourced at test time only. It is gitignored everywhere and never written to logs or shared.

### ⚠ Do not use `~/.config/elmspark/dev-admin.env`

There are two near-identically named files in `~/.config/elmspark/`, and **the key
names inside them are identical**, so nothing but the filename tells them apart:

| File | Holds | Status |
|---|---|---|
| `dev11b-admin.env` | dev11b password, plus DB and API values | **current — use this** |
| `dev-admin.env` | the retired `dev.elmspark.com` password | **stale, do not use** |

`dev11b` rejects the stale password. Probed 2026-09-09, both files against
`https://dev11b.elmspark.com/admin/`:

```
dev11b-admin.env: user=claude_code  #pm-login count = 0  => LOGIN OK
                  body: "PageMotor Admin KJs Claude Code 7 Updates Available View Site …"

dev-admin.env:    user=claude_code  #pm-login count = 1  => LOGIN REJECTED
                  body: "PageMotor Login Invalid username or password. …"
```

Both files carry the same username (`claude_code`); only the password differs. The
failure is a **silent rejection at the login form**, which surfaces downstream as a
confusing `#pm-login still present` assertion failure in `fixtures/auth.ts` rather than
as a login error — so it reads like a broken test, not a stale credential. That cost a
debugging cycle on 2026-09-09. `run-tests.sh` now names the file explicitly and guards
against empty values so the mistake fails loudly.

## Running tests

```bash
./run-tests.sh                    # all tests
./run-tests.sh tests/ep-local*    # subset
./run-tests.sh --headed           # show the browser
./run-tests.sh --ui               # Playwright UI runner
```

`run-tests.sh` sources the credentials and exports
`DEV_BASE_URL=https://dev11b.elmspark.com`. Override the host by exporting
`DEV_BASE_URL` before calling it.

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

### Login selectors (confirmed on dev11b, 2026-09-09)

```
#user             username / email field
#password         password field
#pm-login-button  submit
#pm-login         the login form itself — assert count 0 to prove you got in
```

PM uses an AJAX login that POSTs `pm_ajax=pm-log-in`, then the JS reads `redirect` from
the response and sets `window.location`. Wait for that navigation explicitly rather than
assuming the click is synchronous.

### PM trap 1 — the per-plugin Settings route is POST-only

There is no GET route to a plugin's settings. `/admin/plugins/?plugin=EP_My_Plugin`
just returns the plugins **list**, which looks like the settings page failed to render.
The real route is a form on the plugins screen carrying a hidden `plugin=<Class>` input.
Drive that form; never fabricate the GET:

```ts
const form = page.locator(
  'form:has(input[type=hidden][name="plugin"][value="EP_My_Plugin"])'
).first();
await form.locator('button:has-text("Settings")').first().click();
```

### PM trap 2 — activation lives behind "Manage Plugins"

The checkboxes are not on the plugins screen until you open that panel. They are named
`plugins[<Class>]` and are committed by a **"Save Plugins"** submit:

```ts
await page.goto('/admin/plugins/');
await page.locator('button:has-text("Manage Plugins")').first().click();
const cb = page.locator('input[name="plugins[EP_My_Plugin]"]').first();
if (await cb.count() && !(await cb.isChecked())) await cb.check();
await page.locator('button:has-text("Save Plugins")').first().click();
```

A working end-to-end example of both traps — activate, reach settings, click the control,
assert the AJAX response — is `_efs-instructor-button.mjs`.

### Collapsible option groups

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
├── tests/                    # the committed suite
│   └── ep-local-business-hours.spec.ts
└── _*.mjs                    # one-off scratch probes, not part of the suite
```

Add new tests under `tests/`, named `<plugin-name>-<feature>.spec.ts`. Throwaway
investigation scripts go at the top level with a `_` prefix so the suite stays readable
and sweeps can skip them.
