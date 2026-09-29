/**
 * EP Email 1.10.63: the DNS check must find IONOS's DKIM (s1-ionos / s2-ionos).
 * Logs into dev11b as the rig admin (creds from ~/.config/elmspark/dev11b-admin.env,
 * never printed), opens EP Email's settings through the real plugins-list form,
 * types the domain into the DNS box, presses "Check DNS Records" and reads the
 * DKIM card. Exit 1 unless DKIM is Pass with an -ionos selector.
 *   DOMAIN=conversationswithtonymobley.com node _ep-email-dns-ionos.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const env = Object.fromEntries(readFileSync(homedir() + '/.config/elmspark/dev11b-admin.env', 'utf8').split('\n').filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const BASE = (env.DEV11B_BASE_URL || 'https://dev11b.elmspark.com').replace(/\/$/, '');
const DOMAIN = process.env.DOMAIN || 'elmspark.com';
const OUT = process.env.OUT || '.';
const errors = [];
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
p.on('pageerror', e => errors.push(e.message));
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.fill('input[name="user"]', env.DEV11B_ADMIN_USER); await p.fill('input[name="password"]', env.DEV11B_ADMIN_PASSWORD);
await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), p.keyboard.press('Enter')]);
await p.goto(BASE + '/admin/plugins/', { waitUntil: 'networkidle' });
const form = p.locator('form:has(input[name="plugin"][value="EP_Email"])').first();
if (await form.count() === 0) { console.log('FAIL: EP_Email not on the plugins list'); process.exit(1); }
// submitting navigates, so wait for the navigation rather than for evaluate() to return
await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle' }), form.evaluate(f => f.submit())]).catch(() => {});
await p.waitForLoadState('networkidle');
const version = await p.evaluate(() => (document.body.innerText.match(/EP Email\s+v?(1\.\d+\.\d+)/) || [])[1] || null);
console.log('settings page version:', version);
// the DNS check sits in the collapsed Deliverability group: open it the way a user does, by its header
const group = p.locator('#ep-email-check-dns').locator('xpath=ancestor::div[contains(@class,"option-group")]').first();
await group.locator(':scope > :not(.group-fields)').first().click();
await p.waitForSelector('#ep-email-check-dns', { state: 'visible', timeout: 20000 });
// The domain box only renders when the rig cannot detect a sending domain. dev11b can, so
// send the button's own request (same URL, same fields) with data.domain set, which the
// handler reads first (handle_check_dns), and ALSO press the real button for the detected
// domain so the panel's rendering is exercised on this build.
const hasBox = await p.locator('#ep-email-dns-domain').count();
let data;
if (hasBox) {
  await p.fill('#ep-email-dns-domain', DOMAIN);
  await p.click('#ep-email-check-dns');
  await p.waitForSelector('#ep-email-dns-results .ep-dns-card', { timeout: 60000 });
  data = await p.evaluate(() => window.__epLastDns || null);
} else {
  data = await p.evaluate(async (domain) => {
    const body = new URLSearchParams();
    body.set('pm_ajax', 'EP_Email'); body.set('action', 'admin');
    body.set('data[action]', 'check_dns'); body.set('data[ep_csrf_token]', document.querySelector('[name="ep_csrf_token"]').value); body.set('data[domain]', domain);
    const r = await fetch(window.location.href, { method: 'POST', body, credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
  }, DOMAIN);
  console.log('button request for', DOMAIN, '->', JSON.stringify({ success: data.success, domain: data.domain, dkim: data.dkim && { status: data.dkim.status, selector: data.dkim.selector, record: data.dkim.record }, spf: data.spf && data.spf.status, dmarc: data.dmarc && data.dmarc.status }));
  // and the real button, for whatever domain the rig detected
  await p.click('#ep-email-check-dns');
  await p.waitForSelector('#ep-email-dns-results .ep-dns-card', { timeout: 60000 });
}
await p.waitForTimeout(400);
const cards = await p.$$eval('#ep-email-dns-results .ep-dns-card', els => els.map(e => ({ name: e.querySelector('.ep-dns-name')?.childNodes[0]?.textContent.trim(), status: [...e.classList].find(c => c.startsWith('ep-dns-card--'))?.slice(13), record: e.querySelector('.ep-dns-record code')?.textContent })));
const shown = await p.locator('#ep-email-dns-results').innerText();
console.log('panel rendered for:', (shown.match(/for\s+(\S+)/) || [])[1] || '(see cards)', '|', cards.map(c => `${c.name}=${c.status}${c.record ? '[' + c.record + ']' : ''}`).join('  '));
await p.screenshot({ path: `${OUT}/dns-${DOMAIN}.png`, fullPage: true });
const dkim = data && data.dkim;
const ok = !!(data && data.success && dkim && dkim.status === 'pass' && /-ionos$/.test(dkim.selector || '') && cards.length === 3);
console.log('page errors:', errors.length);
console.log(ok ? `PASS: DKIM found for ${DOMAIN} via selector ${dkim.selector} (${dkim.record}); panel renders ${cards.length} cards on this build` : `FAIL: ${JSON.stringify({ dkim, cards: cards.length })}`);
await b.close(); process.exit(ok && errors.length === 0 ? 0 : 1);
