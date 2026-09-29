/**
 * EP Email 1.10.64: the DNS check is transport-aware. With Mailgun selected it must read
 * DKIM and SPF on the Mailgun sending domain, not the From domain, and the Gmail heads-up
 * after "Send Test Email" must follow that verdict.
 *
 * Logs into dev11b as the rig admin (creds from ~/.config/elmspark/dev11b-admin.env, never
 * printed), opens EP Email's settings, presses the real "Check DNS Records" button and reads
 * its response and cards. Then presses the real "Send Test Email" button with a Gmail address;
 * ONLY the test_email request is answered by the test ({success:true}) so no mail is sent,
 * while the check_dns request that follows goes to the server and the real warning code runs.
 *
 *   EXPECT=pass EXPECT_DOMAIN=mg.elmspark.com node _ep-email-dns-transport.mjs   (positive)
 *   EXPECT=fail EXPECT_DOMAIN=mg.example.com  node _ep-email-dns-transport.mjs   (negative control)
 * The rig's EP_Email / EP_Email_Mailgun rows must already name that Mailgun domain.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const env = Object.fromEntries(readFileSync(homedir() + '/.config/elmspark/dev11b-admin.env', 'utf8').split('\n').filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const BASE = (env.DEV11B_BASE_URL || 'https://dev11b.elmspark.com').replace(/\/$/, '');
const EXPECT = process.env.EXPECT || 'pass';
const EXPECT_DOMAIN = process.env.EXPECT_DOMAIN || 'mg.elmspark.com';
const OUT = process.env.OUT || '.';
const errors = [];
const isDns = r => r.request().method() === 'POST' && /check_dns/.test(decodeURIComponent(r.request().postData() || ''));

const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on('pageerror', e => errors.push(e.message));
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.fill('input[name="user"]', env.DEV11B_ADMIN_USER); await p.fill('input[name="password"]', env.DEV11B_ADMIN_PASSWORD);
await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.keyboard.press('Enter')]);
await p.goto(BASE + '/admin/plugins/', { waitUntil: 'networkidle' });
const form = p.locator('form:has(input[name="plugin"][value="EP_Email"])').first();
if (await form.count() === 0) { console.log('FAIL: EP_Email not on the plugins list'); process.exit(1); }
await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), form.evaluate(f => f.submit())]).catch(() => {});
await p.waitForLoadState('networkidle');
console.log('settings page version:', await p.evaluate(() => (document.body.innerText.match(/EP Email\s+v?(1\.\d+\.\d+)/) || [])[1] || null));

// 1. the real Check DNS Records button
const group = p.locator('#ep-email-check-dns').locator('xpath=ancestor::div[contains(@class,"option-group")]').first();
await group.locator(':scope > :not(.group-fields)').first().click();
await p.waitForSelector('#ep-email-check-dns', { state: 'visible', timeout: 20000 });
const [resp] = await Promise.all([p.waitForResponse(isDns, { timeout: 60000 }), p.click('#ep-email-check-dns')]);
const data = await resp.json();
await p.waitForSelector('#ep-email-dns-results .ep-dns-card', { timeout: 30000 });
const cards = await p.$$eval('#ep-email-dns-results .ep-dns-card', els => els.map(e => ({ name: e.querySelector('.ep-dns-name')?.childNodes[0]?.textContent.trim(), status: [...e.classList].find(c => c.startsWith('ep-dns-card--'))?.slice(13), record: e.querySelector('.ep-dns-record code')?.textContent })));
const panel = await p.locator('#ep-email-dns-results').innerText();
console.log('check_dns response:', JSON.stringify({ domain: data.domain, transport: data.transport, spf: data.spf && [data.spf.status, data.spf.record], dkim: data.dkim && [data.dkim.status, data.dkim.selector, data.dkim.record], dmarc: data.dmarc && data.dmarc.status }));
console.log('dkim message:', (data.dkim && data.dkim.message || '').replace(/<[^>]+>/g, ''));
console.log('cards:', cards.map(c => `${c.name}=${c.status}${c.record ? '[' + c.record + ']' : ''}`).join('  '));
console.log('panel transport line:', (panel.match(/Sending through[^\n]*/) || ['(none)'])[0]);
await p.screenshot({ path: `${OUT}/dns-transport-${EXPECT}.png`, fullPage: true });

// 2. Send Test Email to a Gmail address: only test_email is answered here, check_dns is real
await p.route('**/*', route => {
  const body = decodeURIComponent(route.request().postData() || '');
  if (route.request().method() === 'POST' && /data\[action\]=test_email/.test(body))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: 'Test email sent (answered by the test, nothing was sent).' }) });
  return route.continue();
});
const testGroup = p.locator('#ep-email-send-test').locator('xpath=ancestor::div[contains(@class,"option-group")]').first();
if (!(await p.locator('#ep-email-send-test').isVisible())) await testGroup.locator(':scope > :not(.group-fields)').first().click();
await p.fill('#ep-email-test-address', 'dns-probe@gmail.com');
const [resp2] = await Promise.all([p.waitForResponse(isDns, { timeout: 60000 }), p.click('#ep-email-send-test')]);
const data2 = await resp2.json();
await p.waitForTimeout(800);
const warnings = await p.$$eval('.ep-dns-gmail-warning', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
console.log('after Send Test Email: check_dns dkim =', data2.dkim && data2.dkim.status, '| Gmail warnings shown:', warnings.length, warnings.length ? '| ' + warnings[0] : '');
await p.screenshot({ path: `${OUT}/dns-transport-${EXPECT}-gmail.png`, fullPage: true });

const t = data.transport || {};
let ok;
if (EXPECT === 'pass')
  ok = data.success && t.domain === EXPECT_DOMAIN && data.dkim.status === 'pass' && new RegExp('\\._domainkey\\.' + EXPECT_DOMAIN.replace(/\./g, '\\.') + '$').test(data.dkim.record || '')
    && cards.length === 3 && /Sending through/.test(panel) && warnings.length === 0;
else
  ok = data.success && t.domain === EXPECT_DOMAIN && data.dkim.status === 'fail' && warnings.length === 1 && /DKIM/.test(warnings[0]);
console.log('page errors:', errors.length, errors.slice(0, 3));
console.log(ok ? `PASS (${EXPECT}): transport ${t.provider} on ${t.domain}, DKIM ${data.dkim.status}, Gmail warning ${warnings.length ? 'shown' : 'not shown'}` : `FAIL (${EXPECT})`);
await b.close(); process.exit(ok && errors.length === 0 ? 0 : 1);
