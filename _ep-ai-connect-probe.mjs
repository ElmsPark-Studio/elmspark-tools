// EP AI Connect: end-to-end check on dev11b.
// Signs in, opens the signed-in user's OWN Edit User page, waits for the readiness
// check, asserts the verdict + Claude link, then opens ANOTHER user's page (must show
// the "personal" note, no buttons), saves own profile (panel must survive the AJAX
// re-render), and opens the plugin settings page. Screenshots to ./ep-ai-connect-*.png.
import { chromium } from 'playwright';
const BASE = 'https://dev11b.elmspark.com';
const U = process.env.DEV11B_ADMIN_USER, P = process.env.DEV11B_ADMIN_PASSWORD;
if (!U || !P) { console.error('source ~/.config/elmspark/dev11b-admin.env first'); process.exit(1); }
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', e => errors.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.locator('input[name="user"]').first().fill(U);
await p.locator('input[name="password"]').first().fill(P);
await p.locator('#pm-login-button').click();
await p.waitForTimeout(3000);

// Users screen: every user row is a POST form carrying edit_user + id.
await p.goto(BASE + '/admin/users/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
const rows = await p.evaluate(() => [...document.querySelectorAll('form')].map(f => {
  const id = f.querySelector('input[name=id]'); const eu = f.querySelector('input[name=edit_user]');
  return eu && id ? { id: id.value, text: f.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) } : null;
}).filter(Boolean));
console.log('user forms:', JSON.stringify(rows));
const mine = rows.find(r => r.text.includes(U));
const other = rows.find(r => r.id !== mine.id);
ok(!!mine, 'found own user row');

async function openUser(id) {
  await p.evaluate(id => {
    const f = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name=edit_user]') && f.querySelector('input[name=id]')?.value === id);
    f.submit();
  }, id);
  await p.waitForLoadState('domcontentloaded');
  await p.waitForTimeout(1500);
}

// 1. Own profile
await openUser(mine.id);
const panel = p.locator('.epaic[data-epaic]');
ok(await panel.count() === 1, 'own Edit User page shows the panel');
await p.waitForFunction(() => document.querySelector('.epaic')?.getAttribute('data-verdict'), null, { timeout: 60000 }).catch(() => {});
const verdict = await panel.getAttribute('data-verdict');
const vtitle = (await p.locator('.epaic-vtitle').textContent().catch(() => '')) || '';
console.log('verdict:', verdict, '|', vtitle.trim());
const rowsOut = await p.evaluate(() => [...document.querySelectorAll('.epaic-row')].map(r => ({
  label: r.querySelector('.epaic-label')?.textContent, st: r.className.replace('epaic-row ', ''),
  detail: r.querySelector('.epaic-detail')?.textContent || '' })));
rowsOut.forEach(r => console.log('   ', r.st.padEnd(12), r.label, '|', r.detail.slice(0, 150)));
ok(verdict === 'pass', 'readiness verdict is pass on dev11b');
const href = await p.locator('a.epaic-claude').getAttribute('href');
console.log('claude href:', href);
const u = new URL(href);
ok(u.origin === 'https://claude.ai' && u.pathname === '/customize/connectors' && u.searchParams.get('modal') === 'add-custom-connector', 'Claude link opens the add-custom-connector modal');
ok(u.searchParams.get('connectorUrl') === BASE + '/mcp/', 'Claude link carries this site\'s /mcp/ address');
ok(/^[a-z0-9-]+$/.test(u.searchParams.get('connectorName') || ''), 'connector name is lowercase-hyphen: ' + u.searchParams.get('connectorName'));
ok((await p.locator('a.epaic-gpt').getAttribute('href')) === 'https://chatgpt.com/plugins', 'ChatGPT link');
await p.locator('.epaic').screenshot({ path: 'ep-ai-connect-own-profile.png' });
await p.screenshot({ path: 'ep-ai-connect-own-profile-page.png', fullPage: true });

// Copy button must not submit the user form.
const urlBefore = p.url();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await p.locator('.epaic-copy').click();
await p.waitForTimeout(500);
ok(p.url() === urlBefore && (await p.locator('.epaic').count()) === 1, 'Copy button does not submit the form');
const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ''));
ok(clip === BASE + '/mcp/', 'clipboard holds the /mcp/ address (' + clip + ')');

// 2. Save own profile: core re-renders the form over AJAX; the panel must come back wired.
const save = p.locator('#user-edit button.save, #user-edit .save, button:has-text("Save")').first();
if (await save.count()) {
  await save.click();
  await p.waitForTimeout(4000);
  const n = await p.locator('.epaic[data-epaic]').count();
  const ready = await p.locator('.epaic[data-ready]').count();
  ok(n === 1 && ready === 1, `panel present and re-wired after save (count ${n}, ready ${ready})`);
  await p.waitForFunction(() => document.querySelector('.epaic')?.getAttribute('data-verdict'), null, { timeout: 60000 }).catch(() => {});
  ok(!!(await p.locator('.epaic').getAttribute('data-verdict')), 'check re-ran after save');
} else console.log('SKIP no save button found');

// 3. Someone else's profile
if (other) {
  await p.goto(BASE + '/admin/users/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1000);
  await openUser(other.id);
  const txt = await p.locator('body').textContent();
  ok((await p.locator('.epaic[data-epaic]').count()) === 0 && /AI connections are personal/.test(txt), 'another user\'s page shows the personal note, no buttons');
} else console.log('SKIP only one user on the site');

// 4. Plugin settings page
await p.goto(BASE + '/admin/plugins/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1000);
const opened = await p.evaluate(() => {
  const f = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name=plugin][value=EP_AI_Connect]'));
  if (f) { f.submit(); return true; } return false;
});
if (opened) {
  await p.waitForLoadState('domcontentloaded'); await p.waitForTimeout(1500);
  ok((await p.locator('.epaic[data-epaic]').count()) === 1, 'settings page shows the panel');
  await p.waitForFunction(() => document.querySelector('.epaic')?.getAttribute('data-verdict'), null, { timeout: 60000 }).catch(() => {});
  await p.screenshot({ path: 'ep-ai-connect-settings.png', fullPage: true });
} else console.log('SKIP could not find the EP_AI_Connect settings form on /admin/plugins/');

// 5. Phone width
await p.setViewportSize({ width: 390, height: 844 });
await p.goto(BASE + '/admin/users/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
await openUser(mine.id);
await p.waitForFunction(() => document.querySelector('.epaic')?.getAttribute('data-verdict'), null, { timeout: 60000 }).catch(() => {});
const overflow = await p.evaluate(() => { const e = document.querySelector('.epaic'); return e ? e.scrollWidth - e.clientWidth : -1; });
ok(overflow <= 0, 'no horizontal overflow in the panel at 390px (' + overflow + ')');
await p.locator('.epaic').screenshot({ path: 'ep-ai-connect-phone.png' });

console.log(errors.length ? 'JS errors:\n  ' + errors.join('\n  ') : 'no JS errors');
if (errors.some(e => /epaic|EPAIC/i.test(e))) fails++;
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails ? 1 : 0);
