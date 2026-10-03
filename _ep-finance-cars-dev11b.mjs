/**
 * EP Finance Tax UK 0.1.15 on dev11b: company cars through PageMotor's real settings screen.
 *
 *   K0 logged in; the Tax UK settings show the Company cars section with three car slots
 *   K1 a test car (petrol, 120 g/km, £30,000, company pays private fuel) saves and survives a reload
 *   K2 the panel works it out for 2026-27: 30%, car £9,000.00, fuel £8,760.00 (29,200 x 30%),
 *      Class 1A £2,664.00 (15% of £17,760), reported on the P11D
 *   K3 the 2027-28 table shows £750.00 a month for the car and says the fuel figure is not yet published
 *   K4 at 390px the settings page does not scroll sideways
 *   C  car 1 is put back to how it was; no uncaught JavaScript errors
 *
 * Run: cd ~/Developer/elmspark/tools/playwright-tests && set -a && source ~/.config/elmspark/dev11b-admin.env && set +a && node _ep-finance-cars-dev11b.mjs
 * Screenshots: ~/Developer/elmspark/plugins/ep-finance-tax-uk/test/frontend-proof/
 * Written against the current tax year being 2026-27 (run before 6 April 2027).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'https://dev11b.elmspark.com';
const U = process.env.DEV11B_ADMIN_USER, P = process.env.DEV11B_ADMIN_PASSWORD;
if (!U || !P) { console.error('missing DEV11B creds: set -a; source ~/.config/elmspark/dev11b-admin.env; set +a'); process.exit(2); }
const OUT = process.env.HOME + '/Developer/elmspark/plugins/ep-finance-tax-uk/test/frontend-proof';
mkdirSync(OUT, { recursive: true });
let fail = 0;
const check = (l, c, g = '') => { if (!c) fail++; console.log(`[${c ? 'PASS' : 'FAIL'}] ${l}${g !== '' ? `  (${g})` : ''}`); };
const NAME = 'EPCAR probe Golf';
const FIELDS = ['name', 'reg', 'list_price', 'accessories', 'capital_contribution', 'co2', 'electric_range', 'available_from',
	'available_to', 'unavailable', 'private_use_paid', 'pct_override'];
const SELECTS = ['fuel', 'free_fuel'];
const f = (k) => `[name="EP_Finance_Tax_UK[car1_${k}]"]`;

const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('dialog', d => d.accept());

async function openSettings(cls) {
	await p.goto(BASE + '/admin/plugins/', { waitUntil: 'load' }); await p.waitForTimeout(1200);
	const form = p.locator(`form:has(input[type=hidden][name="plugin"][value="${cls}"])`).first();
	await form.locator('button:has-text("Settings")').first().click();
	await p.waitForLoadState('load'); await p.waitForTimeout(2500);
}
async function save() {
	await p.locator('#save-options, button:has-text("Save Settings")').first().click();
	await p.waitForLoadState('load'); await p.waitForTimeout(3000);
}
async function readCar1() {
	const o = {};
	for (const k of FIELDS) o[k] = await p.locator(f(k)).inputValue().catch(() => null);
	for (const k of SELECTS) o[k] = await p.locator(f(k)).inputValue().catch(() => null);
	return o;
}
async function writeCar1(v) {
	for (const k of FIELDS) if (k in v) await p.locator(f(k)).fill(v[k] ?? '');
	for (const k of SELECTS) if (k in v && v[k] !== null) await p.locator(f(k)).selectOption(v[k]);
}

let prior = null;
try {
	await p.goto(BASE + '/admin/', { waitUntil: 'load' });
	await p.locator('#user').fill(U); await p.locator('#password').fill(P);
	await p.locator('#pm-login-button').click(); await p.waitForTimeout(3500);
	check('K0 logged in', (await p.title()) !== 'PageMotor Login');

	await openSettings('EP_Finance_Tax_UK');
	const slots = await p.locator('[name^="EP_Finance_Tax_UK[car"][name$="_list_price]"]').count();
	check('K0 the Company cars section is there with three car slots', /Company cars/.test(await p.locator('body').innerText()) && slots === 3, `slots ${slots}`);
	prior = await readCar1();

	await writeCar1({ name: NAME, reg: '', list_price: '30000', accessories: '', capital_contribution: '', co2: '120', electric_range: '',
		available_from: '', available_to: '', unavailable: '', private_use_paid: '', pct_override: '', fuel: 'petrol', free_fuel: 'provided' });
	await save();
	await openSettings('EP_Finance_Tax_UK');
	const now = await readCar1();
	check('K1 the car saves and survives a reload', now.name === NAME && now.list_price === '30000' && now.co2 === '120' && now.fuel === 'petrol' && now.free_fuel === 'provided', JSON.stringify(now));

	const panel = await p.locator('.ep-fin-tax-cars').innerText().catch(() => '');
	const t2627 = panel.split('2027-28 tax year')[0];
	const t2728 = panel.split('2027-28 tax year')[1] || '';
	check('K2 2026-27: 30%, car £9,000.00, fuel £8,760.00, Class 1A £2,664.00',
		/2026-27 tax year/.test(t2627) && /30%/.test(t2627) && /£9,000\.00/.test(t2627) && /£8,760\.00/.test(t2627) && /£2,664\.00/.test(t2627), t2627.replace(/\s+/g, ' ').slice(0, 260));
	check('K2b reported on the P11D by 6 July 2027, Class 1A paid by 22 July 2027', /P11D and P11D\(b\) by 6 July 2027/.test(t2627) && /22 July 2027/.test(t2627));
	check('K3 2027-28: £750.00 a month for the car; fuel not yet published', /£750\.00 a month/.test(t2728) && /not yet published/.test(t2728), t2728.replace(/\s+/g, ' ').slice(0, 260));
	await p.screenshot({ path: OUT + '/cars-dev11b-1280.png', fullPage: true });

	await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(800);
	const w = await p.evaluate(() => ({ vw: document.documentElement.clientWidth, docW: document.documentElement.scrollWidth,
		panelRight: Math.round((document.querySelector('.ep-fin-tax-cars') || document.body).getBoundingClientRect().right) }));
	check('K4 at 390px the cars panel fits (no sideways scroll from it)', w.panelRight <= w.vw + 1, JSON.stringify(w));
	await p.screenshot({ path: OUT + '/cars-dev11b-390.png', fullPage: true });
	await p.setViewportSize({ width: 1280, height: 900 });
} catch (e) {
	check('run', false, e.message);
} finally {
	try {
		if (prior) {
			await openSettings('EP_Finance_Tax_UK');
			await writeCar1(prior);
			await save();
			await openSettings('EP_Finance_Tax_UK');
			const back = await readCar1();
			check('C car 1 is put back to how it was', JSON.stringify(back) === JSON.stringify(prior), JSON.stringify(back));
		}
	} catch (e) { check('cleanup', false, e.message); }
	check('P no uncaught JavaScript errors', errs.length === 0, errs.slice(0, 2).join(' | '));
	console.log(fail ? `\nFAILED: ${fail} check(s)` : '\nALL CHECKS PASSED');
	await b.close(); process.exit(fail ? 1 : 0);
}
