/**
 * EP Finance 0.8.0 VAT coding on dev11b.elmspark.com, in a real browser through
 * PageMotor's own admin (login, plugins screen, settings Save).
 *
 *   S1 EP Finance settings: the "VAT registration" block, and "VAT is not being
 *      recorded" while the book is not set as VAT registered
 *   S2 setting VAT registered + 2026-04-01 + standard rate and pressing Save
 *      persists after a reload, and the block says VAT is recorded from that date
 *   T1 the New transaction form has a VAT menu with the UK rates
 *   T2 a 120.00 sale dated 2026-08-05 at the standard rate posts (the response
 *      carries the group id)
 *   T3 a VAT rate on an entry dated 2026-03-15 is refused, saying why
 *   X1 the Tax tab's VAT return for Jul to Sep 2026 shows box 1 = £20.00 from that sale
 *   X2 and names dev11b's existing shop orders (Sep 2026, posted gross) as sales
 *      with no VAT code
 *   K  EP Finance Tax UK's VAT scheme is set to standard for the return (dev11b has
 *      none, and a return is never worked out without one), then put back
 *   N1 while it has no scheme, EP Finance's VAT registration block says so
 *   I1 EP Finance Importer: the Rules form has a VAT rate menu; a rule with a VAT
 *      rate is listed with "VAT rate Standard rate 20%"
 *   C  clean up: the probe sale and both probe rules are deleted through the
 *      plugins' own AJAX routes, and the VAT settings are put back to not registered
 *   P  no uncaught JavaScript errors
 *
 * Run (Kenn): set -a; source ~/.config/elmspark/dev11b-admin.env; set +a;
 *             node _ep-finance-vat-dev11b.mjs
 * Screenshots: ~/Developer/elmspark/plugins/ep-finance/test/frontend-proof/vat-dev11b-*.png
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dev11b.elmspark.com';
const U = process.env.DEV11B_ADMIN_USER, P = process.env.DEV11B_ADMIN_PASSWORD;
if (!U || !P) { console.error('missing DEV11B creds: set -a; source ~/.config/elmspark/dev11b-admin.env; set +a'); process.exit(2); }
const OUT = process.env.HOME + '/Developer/elmspark/plugins/ep-finance/test/frontend-proof';
mkdirSync(OUT, { recursive: true });
let fail = 0;
const check = (l, c, g = '') => { if (!c) fail++; console.log(`[${c ? 'PASS' : 'FAIL'}] ${l}${g !== '' ? `  (${g})` : ''}`); };
const TAG = 'EPFIN VAT probe ' + Date.now();

const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('dialog', d => d.accept());

async function openSettings(cls) {
	await p.goto(BASE + '/admin/plugins/', { waitUntil: 'load' }); await p.waitForTimeout(1200);
	const form = p.locator(`form:has(input[type=hidden][name="plugin"][value="${cls}"])`).first();
	await form.locator('button:has-text("Settings")').first().click();
	await p.waitForLoadState('load'); await p.waitForTimeout(2500);
}
async function tab(sel, t) {
	await p.click(`${sel}[data-tab="${t}"]`).catch(() => {});
	await p.waitForTimeout(400);
}
// The plugin's own AJAX route, exactly as its admin JS calls it (CSRF from the page).
async function ajax(plugin, action, data) {
	return p.evaluate(async ({ plugin, action, data }) => {
		const fd = new FormData();
		fd.append('pm_ajax', plugin); fd.append('action', action); fd.append('data[action]', action);
		const t = (document.querySelector('input[name="ep_csrf_token"]') || {}).value;
		if (t) { fd.append('ep_csrf_token', t); fd.append('data[ep_csrf_token]', t); }
		for (const [k, v] of Object.entries(data)) { fd.append(k, v); fd.append('data[' + k + ']', v); }
		const r = await fetch(location.href, { method: 'POST', body: fd, credentials: 'same-origin' });
		const txt = await r.text(); try { return JSON.parse(txt); } catch { return { success: false, raw: txt.slice(0, 200) }; }
	}, { plugin, action, data });
}
async function saveVat(registered, from) {
	await openSettings('EP_Finance');
	await p.locator('select[name="EP_Finance[vat_registered]"]').selectOption(registered);
	await p.locator('input[name="EP_Finance[vat_from]"]').fill(from);
	if (registered) await p.locator('select[name="EP_Finance[vat_sales_band]"]').selectOption('STD');
	await p.locator('#save-options, button:has-text("Save Settings")').first().click();
	await p.waitForLoadState('load'); await p.waitForTimeout(3000);
}
async function pickByText(sel, sub) {
	return p.evaluate(({ sel, sub }) => {
		const s = document.querySelector(sel); if (!s) return '';
		const o = [...s.options].find(o => o.textContent.includes(sub) && o.value && o.value !== '0');
		if (!o) return ''; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.textContent;
	}, { sel, sub });
}

let groupId = 0; const ruleIds = []; let priorScheme = null;
async function setScheme(v) {
	await openSettings('EP_Finance_Tax_UK');
	const sel = p.locator('select[name="EP_Finance_Tax_UK[scheme]"]');
	const was = await sel.inputValue();
	await sel.selectOption(v);
	await p.locator('#save-options, button:has-text("Save Settings")').first().click();
	await p.waitForLoadState('load'); await p.waitForTimeout(3000);
	await openSettings('EP_Finance_Tax_UK');
	return { was, now: await p.locator('select[name="EP_Finance_Tax_UK[scheme]"]').inputValue() };
}
try {
	// ── login ──
	await p.goto(BASE + '/admin/', { waitUntil: 'load' });
	await p.locator('#user').fill(U); await p.locator('#password').fill(P);
	await p.locator('#pm-login-button').click(); await p.waitForTimeout(3500);
	check('logged in', (await p.title()) !== 'PageMotor Login');

	// ── S1 not registered ──
	await openSettings('EP_Finance');
	let body = await p.locator('body').innerText();
	check('S1 the VAT registration block is there', /VAT registration/.test(body) && await p.locator('select[name="EP_Finance[vat_registered]"]').count() === 1);
	check('S1 and it says VAT is not being recorded while the book is not registered', /VAT is not being recorded/.test(body));
	await p.screenshot({ path: OUT + '/vat-dev11b-settings-off.png', fullPage: true });

	// ── S2 register and save ──
	await saveVat('on', '2026-04-01');
	await openSettings('EP_Finance');
	const reg = await p.locator('select[name="EP_Finance[vat_registered]"]').inputValue();
	const from = await p.locator('input[name="EP_Finance[vat_from]"]').inputValue();
	body = await p.locator('body').innerText();
	check('S2 VAT registered + 2026-04-01 persist after Save and reload', reg === 'on' && from === '2026-04-01', `${reg} ${from}`);
	check('S2 the block now says VAT is recorded from 2026-04-01', /VAT is recorded on entries dated 2026-04-01 or later/.test(body));
	// N1 only means something while Tax UK has no scheme (dev11b's state on 2 Oct).
	const schemeNow = await (async () => { await openSettings('EP_Finance_Tax_UK'); return p.locator('select[name="EP_Finance_Tax_UK[scheme]"]').inputValue(); })();
	await openSettings('EP_Finance');
	body = await p.locator('body').innerText();
	if (schemeNow === '') check('N1 with no VAT scheme in Tax UK, the VAT registration block says no return is worked out until one is chosen', /no VAT scheme is chosen/.test(body));
	else console.log('[SKIP] N1 Tax UK already has a scheme (' + schemeNow + ')');

	// ── T: New transaction ──
	await tab('.ep-fin-tab', 'transactions');
	const vopts = await p.locator('#ep-fin-txn-vat option').allInnerTexts();
	check('T1 the form has a VAT menu with the UK rates', vopts.includes('Standard rate 20%') && vopts.includes('Reduced rate 5%'), vopts.join('|'));
	await p.locator('#ep-fin-txn-form [name="txn_date"]').fill('2026-08-05');
	await p.locator('#ep-fin-txn-form [name="description"]').fill(TAG);
	const rows = p.locator('#ep-fin-splits .ep-fin-split');
	await rows.nth(0).locator('.ep-fin-split-amount').fill('120.00');
	await rows.nth(1).locator('.ep-fin-split-amount').fill('-120.00');
	const bankTxt = await pickByText('#ep-fin-splits .ep-fin-split:nth-child(1) .ep-fin-split-account', '(Bank or cash)');
	const revTxt = await pickByText('#ep-fin-splits .ep-fin-split:nth-child(2) .ep-fin-split-account', '(Someone who pays you)');
	await p.locator('#ep-fin-txn-vat').selectOption('STD');
	let rp = p.waitForResponse(r => r.request().method() === 'POST', { timeout: 25000 }).catch(() => null);
	await p.click('#ep-fin-txn-post'); let resp = await rp; await p.waitForTimeout(1200);
	let jb = null; try { jb = JSON.parse(await resp.text()); } catch {}
	groupId = jb && jb.group_id ? Number(jb.group_id) : 0;
	check('T2 a 120.00 sale at the standard rate posts', jb && jb.success === true && groupId > 0, jb ? `${jb.reason || 'ok'} group ${groupId}; ${bankTxt} / ${revTxt}` : 'no json');
	await p.screenshot({ path: OUT + '/vat-dev11b-form.png', fullPage: true });
	await p.locator('#ep-fin-txn-form [name="txn_date"]').fill('2026-03-15');
	await p.locator('#ep-fin-txn-form [name="description"]').fill(TAG + ' early');
	await rows.nth(0).locator('.ep-fin-split-amount').fill('60.00');
	await rows.nth(1).locator('.ep-fin-split-amount').fill('-60.00');
	await pickByText('#ep-fin-splits .ep-fin-split:nth-child(1) .ep-fin-split-account', '(Bank or cash)');
	await pickByText('#ep-fin-splits .ep-fin-split:nth-child(2) .ep-fin-split-account', '(Someone who pays you)');
	await p.locator('#ep-fin-txn-vat').selectOption('STD');
	rp = p.waitForResponse(r => r.request().method() === 'POST', { timeout: 25000 }).catch(() => null);
	await p.click('#ep-fin-txn-post'); resp = await rp; await p.waitForTimeout(1200);
	jb = null; try { jb = JSON.parse(await resp.text()); } catch {}
	const m2 = await p.locator('#ep-fin-txn-msg').innerText();
	check('T3 a VAT rate on an entry dated 2026-03-15 is refused, saying why', jb && jb.reason === 'vat_not_registered' && /before your VAT registration date/.test(m2), m2);
	if (jb && jb.group_id) await ajax('EP_Finance', 'delete-group', { id: String(jb.group_id) });

	// ── K + X: Tax tab ──
	const k = await setScheme('standard'); priorScheme = k.was;
	check('K Tax UK VAT scheme set to standard for the return', k.now === 'standard', `was "${k.was}", now "${k.now}"`);
	await openSettings('EP_Finance');
	await tab('.ep-fin-tab', 'tax');
	await p.selectOption('#ep-fin-tax-period', '2026Q3').catch(() => {});
	await p.click('#ep-fin-tax-view').catch(() => {});
	await p.waitForTimeout(2500);
	const box1 = await p.locator('#ep-fin-tax-return tr', { hasText: 'Box 1' }).first().innerText().catch(() => '');
	const ret = await p.locator('#ep-fin-tax-return').innerText().catch(() => '');
	check('X1 the VAT return for Jul to Sep 2026 shows box 1 = £20.00', /£20\.00/.test(box1), box1.replace(/\s+/g, ' '));
	check('X2 and names the existing shop orders as sales with no VAT code', /of sales \(\d+ transactions?\) dated on or after your VAT registration date carry no VAT code/.test(ret),
		(ret.match(/[^.]*carry no VAT code[^.]*\./) || ['no such note'])[0]);
	await p.screenshot({ path: OUT + '/vat-dev11b-tax-return.png', fullPage: true });

	// ── I: Importer rules ──
	await openSettings('EP_Finance_Importer');
	await tab('.ep-fin-imp-tab', 'rules');
	const iv = await p.locator('#ep-fi-rule-vat option').allInnerTexts().catch(() => []);
	await p.locator('#ep-fi-rule-value').fill('EPFINVATPROBE');
	await pickByText('#ep-fi-rule-category', '(expense)');
	await p.locator('#ep-fi-rule-vat').selectOption('STD');
	rp = p.waitForResponse(r => r.request().method() === 'POST', { timeout: 25000 }).catch(() => null);
	await p.click('#ep-fi-rule-add'); resp = await rp; await p.waitForTimeout(1200);
	jb = null; try { jb = JSON.parse(await resp.text()); } catch {}
	if (jb && jb.id) ruleIds.push(String(jb.id)); if (jb && jb.vat_rule_id) ruleIds.push(String(jb.vat_rule_id));
	const list = await p.locator('#ep-fi-rules').innerText();
	check('I1 the Rules form has a VAT rate menu, and the rule is listed with its rate',
		iv[0] === 'No VAT rate' && jb && jb.vat_rule_id && /VAT rate Standard rate 20%/.test(list), `${iv.join('|')} / ${jb ? JSON.stringify({ id: jb.id, vat: jb.vat_rule_id, r: jb.reason }) : 'no json'}`);
	await p.screenshot({ path: OUT + '/vat-dev11b-importer-rules.png', fullPage: true });
	for (const id of ruleIds) await ajax('EP_Finance_Importer', 'delete-rule', { id });
} catch (e) {
	check('no exception', false, e.message);
} finally {
	// ── C: put dev11b back as found ──
	try {
		await openSettings('EP_Finance');
		if (groupId) { const d = await ajax('EP_Finance', 'delete-group', { id: String(groupId) }); check('C the probe sale is deleted', d && d.success === true, d ? (d.reason || 'ok') : 'no json'); }
		await saveVat('', '');
		await openSettings('EP_Finance');
		const reg = await p.locator('select[name="EP_Finance[vat_registered]"]').inputValue();
		check('C VAT settings put back to not registered', reg === '' && /VAT is not being recorded/.test(await p.locator('body').innerText()), reg);
		if (priorScheme !== null) {
			const r = await setScheme(priorScheme);
			check('C Tax UK VAT scheme put back', r.now === priorScheme, `"${r.now}"`);
		}
		await openSettings('EP_Finance_Importer'); await tab('.ep-fin-imp-tab', 'rules');
		check('C no probe rule is left (' + ruleIds.length + ' made)', !/EPFINVATPROBE/.test(await p.locator('#ep-fi-rules').innerText()));
	} catch (e) { check('cleanup', false, e.message); }
	check('P no uncaught JavaScript errors', errs.length === 0, errs.slice(0, 2).join(' | '));
	console.log(fail ? `\nFAILED: ${fail} check(s)` : '\nALL CHECKS PASSED');
	await b.close(); process.exit(fail ? 1 : 0);
}
