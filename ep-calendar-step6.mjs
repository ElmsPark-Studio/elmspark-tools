// EP Calendar build step 6: settings screen (Status card, Calendar basics, a saved
// setting that persists), the source chips, the service worker and the subscribe block,
// against the local rig (pm-rig -> pm-0.11.5-rig, served at http://127.0.0.1:8911 with
// PHP_CLI_SERVER_WORKERS=4). The calendar page is /calendar/ (page 47), never the root.
//
// Signed in (EP_CAL_COOKIE_FILE: JSON {name, value} holding a rig session cookie minted
// without a password; never printed):
//   settings at 1280 and 390: the Status card renders with sources and the heartbeat
//   line, Calendar basics shows the detected calendar page; at 1280 a changed short app
//   name is saved, the screen re-opened and the value read back, then the old value is
//   restored; no horizontal overflow at 390; no console errors.
//   /calendar/ at 390: the personal-feed line under the subscribe buttons.
// Anonymous, /calendar/ at 390: source chips present; toggling the Events chip removes
//   the live event row and restores it, with sources= in the hash while it is off; a
//   service worker is registered (127.0.0.1 counts as localhost); the manifest link is in
//   <head>; Copy link answers; no overflow; no console errors.
//
// Run:
//   EP_CAL_COOKIE_FILE=/some/private/cookie.json EP_CAL_SHOTS=/some/dir node ep-calendar-step6.mjs

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.EP_CAL_BASE || 'http://127.0.0.1:8911';
const SHOTS = resolve(process.env.EP_CAL_SHOTS || './ep-calendar-shots');
const COOKIE_FILE = process.env.EP_CAL_COOKIE_FILE || '';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const shots = [];
function check(name, pass, detail) {
	results.push({ name, pass: Boolean(pass), detail });
	console.log((pass ? '✓ PASS' : '✗ FAIL') + ' — ' + name + (detail !== undefined && detail !== '' ? '  (' + detail + ')' : ''));
}
async function shot(page, file) {
	const path = join(SHOTS, file);
	await page.screenshot({ path, fullPage: true });
	shots.push(path);
}
function watchConsole(page, bucket) {
	page.on('console', (msg) => { if (msg.type() === 'error') bucket.push(msg.text()); });
	page.on('pageerror', (err) => bucket.push('pageerror: ' + err.message));
}
const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));

// Core opens a Plugin's settings with a POST of plugin=<Class> from the Plugins page.
async function openSettings(page) {
	await page.goto(BASE + '/admin/plugins/', { waitUntil: 'domcontentloaded' });
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		page.click('form.ui-module:has(input[name="plugin"][value="EP_Calendar"]) button.action')
	]);
	await page.waitForSelector('[data-ep-cal-status-panel]', { timeout: 20000 });
	// Settings groups open collapsed; open Calendar basics (core: div#group-<id> > label).
	await page.click('#group-group-basics > label');
	await page.waitForSelector('#group-group-basics .group-fields [data-ep-cal-page]', { state: 'visible', timeout: 10000 });
}

const browser = await chromium.launch();
let cookie = null;
if (COOKIE_FILE && existsSync(COOKIE_FILE)) {
	const c = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
	cookie = { name: c.name, value: c.value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' };
}

// ─── Settings, signed in ──────────────────────────────────────
if (!cookie) {
	console.log('SKIP — signed-in checks: EP_CAL_COOKIE_FILE is not set or does not exist');
}
else {
	for (const vp of [{ name: '1280', width: 1280, height: 900 }, { name: '390', width: 390, height: 844 }]) {
		const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
		await ctx.addCookies([cookie]);
		const page = await ctx.newPage();
		const errors = [];
		watchConsole(page, errors);
		await openSettings(page);

		const status = await page.evaluate(() => {
			const panel = document.querySelector('[data-ep-cal-status-panel]');
			const row = (k) => panel.querySelector('[data-row="' + k + '"] dd');
			return {
				sources: Array.from(panel.querySelectorAll('.ep-cal-status__source')).map((li) => li.textContent.trim()),
				heartbeat: row('heartbeat') ? row('heartbeat').textContent.trim() : '',
				feeds: row('feeds') ? row('feeds').textContent.trim() : '',
				tokens: row('tokens') ? row('tokens').textContent.trim() : '',
				siteFeed: row('site-feed') ? row('site-feed').textContent.trim() : '',
				subscribe: row('subscribe') ? row('subscribe').textContent.trim() : ''
			};
		});
		check(`[${vp.name}] Status card lists sources`, status.sources.length >= 3, status.sources.join(' | '));
		check(`[${vp.name}] Status card heartbeat line`, /heartbeat/i.test(status.heartbeat), status.heartbeat);
		check(`[${vp.name}] Status card feeds, personal links, site feed, shortcode`,
			status.feeds !== '' && /active/.test(status.tokens) && /ep_calendar_feed=site/.test(status.siteFeed) && /\[ep-calendar-subscribe\]/.test(status.subscribe),
			[status.feeds, status.tokens, status.siteFeed].join(' | '));
		const pageLine = await page.evaluate(() => {
			const p = document.querySelector('[data-ep-cal-page] .ep-cal-page__line');
			return p ? { found: p.getAttribute('data-ep-cal-page-found'), text: p.textContent.trim().replace(/\s+/g, ' ') } : null;
		});
		check(`[${vp.name}] Calendar basics names the detected calendar page`, pageLine && pageLine.found !== '0' && /\/calendar\//.test(pageLine.text), pageLine && pageLine.text);

		if (vp.name === '1280') {
			const input = page.locator('input[name$="[pwa_short_name]"], input[name="pwa_short_name"]').first();
			const before = await input.inputValue();
			const value = 'PW Cal ' + String(Date.now()).slice(-4);
			await input.fill(value);
			const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/'), { timeout: 20000 });
			await page.click('#save-options');
			const res = await saved;
			check('[1280] settings save answered', res.ok(), 'HTTP ' + res.status());
			await openSettings(page);
			const after = await page.locator('input[name$="[pwa_short_name]"], input[name="pwa_short_name"]').first().inputValue();
			check('[1280] short app name persisted after re-opening the screen', after === value, JSON.stringify(after));
			const man = await page.evaluate(async () => (await fetch('/calendar/?ep_calendar_manifest=1')).json());
			check('[1280] manifest short_name follows the setting', man.short_name === value, man.short_name);
			// Put it back as it was.
			const input2 = page.locator('input[name$="[pwa_short_name]"], input[name="pwa_short_name"]').first();
			await input2.fill(before);
			const saved2 = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/'), { timeout: 20000 });
			await page.click('#save-options');
			await saved2;
			await openSettings(page);
			const restored = await page.locator('input[name$="[pwa_short_name]"], input[name="pwa_short_name"]').first().inputValue();
			check('[1280] short app name restored to its previous value', restored === before, JSON.stringify(restored));
		}
		else {
			const o = await overflow(page);
			check('[390] settings: no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
		}
		await shot(page, `step6-settings-${vp.name}.png`);
		check(`[${vp.name}] settings: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
		await ctx.close();
	}
}

// ─── /calendar/ anonymous at 390 ──────────────────────────────
{
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const page = await ctx.newPage();
	const errors = [];
	watchConsole(page, errors);
	await page.goto(BASE + '/calendar/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.ep-cal--js .ep-cal__view[data-drawn="1"]', { timeout: 20000 });
	const chips = await page.$$eval('.ep-cal__filter', (bs) => bs.map((b) => b.getAttribute('data-source') + '=' + b.getAttribute('aria-pressed') + ' "' + b.textContent.trim() + '"'));
	check('[anon 390] source chips present, all on', chips.length >= 1 && chips.every((c) => c.includes('=true')), chips.join(', '));
	const eventRows = () => page.$$eval('.ep-cal__view [data-source="ep-events"]', (r) => r.length);
	const before = await eventRows();
	check('[anon 390] live event row shown before toggling', before > 0, before + ' row(s)');
	await page.click('.ep-cal__filter[data-source="ep-events"]');
	const off = await eventRows();
	const hashOff = await page.evaluate(() => location.hash);
	const pressedOff = await page.getAttribute('.ep-cal__filter[data-source="ep-events"]', 'aria-pressed');
	check('[anon 390] Events chip off hides the event rows', off === 0 && pressedOff === 'false', off + ' row(s), aria-pressed=' + pressedOff);
	check('[anon 390] hash carries sources= while a chip is off', /[#&]sources=/.test(hashOff) && !/ep-events/.test(hashOff.split('sources=')[1] || ''), hashOff);
	await shot(page, 'step6-calendar-anon-390-events-off.png');
	await page.click('.ep-cal__filter[data-source="ep-events"]');
	const on = await eventRows();
	const hashOn = await page.evaluate(() => location.hash);
	check('[anon 390] Events chip on restores the rows; hash drops sources=', on === before && !/sources=/.test(hashOn), on + ' row(s), ' + hashOn);
	// Week and month honour the chips too.
	await page.click('.ep-cal__filter[data-source="ep-events"]');
	await page.click('.ep-cal__view-btn[data-view="month"]');
	await page.waitForSelector('.ep-cal__month', { timeout: 15000 });
	const monthEvents = await page.$$eval('.ep-cal__view .ep-cal__chip[data-source="ep-events"]', (r) => r.length);
	check('[anon 390] month view hides the Events source while its chip is off', monthEvents === 0, monthEvents + ' chip(s)');
	await page.click('.ep-cal__filter[data-source="ep-events"]');
	await page.click('.ep-cal__view-btn[data-view="agenda"]');
	await page.waitForSelector('.ep-cal__view .ep-cal__days, .ep-cal__view .ep-cal__empty', { timeout: 15000 });
	// Service worker and manifest.
	let regs = 0;
	for (let i = 0; i < 20 && regs < 1; i++) {
		regs = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1));
		if (regs < 1) await page.waitForTimeout(500);
	}
	const scope = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistrations(); return r.length ? r[0].scope + ' active=' + Boolean(r[0].active || r[0].installing || r[0].waiting) : ''; });
	check('[anon 390] service worker registered (getRegistrations().length === 1)', regs === 1, scope);
	const manifest = await page.evaluate(() => { const l = document.head.querySelector('link[rel="manifest"]'); return l ? l.outerHTML + (l.hasAttribute('data-ep-calendar') ? ' (added by script)' : ' (server)') : ''; });
	check('[anon 390] manifest link in <head>', manifest !== '', manifest);
	// Subscribe block.
	const sub = await page.evaluate(() => {
		const b = document.querySelector('[data-ep-cal-subscribe] [data-ep-cal-copy-url]');
		return { visible: b ? !b.hidden : false, personal: Boolean(document.querySelector('.ep-cal-subscribe__personal')) };
	});
	check('[anon 390] Copy link button shown by the script; no personal-feed line', sub.visible && !sub.personal, JSON.stringify(sub));
	await page.click('[data-ep-cal-copy-url]');
	await page.waitForFunction(() => document.querySelector('[data-ep-cal-copy-status]').textContent.trim() !== '', null, { timeout: 5000 }).catch(() => {});
	const said = await page.evaluate(() => ({ text: document.querySelector('[data-ep-cal-copy-status]').textContent.trim(), box: !document.querySelector('[data-ep-cal-copy-box]').hidden }));
	check('[anon 390] Copy link answers (copied, or the address box with a hint)', said.text !== '', JSON.stringify(said));
	const o = await overflow(page);
	check('[anon 390] /calendar/: no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, 'step6-calendar-anon-390.png');
	check('[anon 390] /calendar/: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
	await ctx.close();
}

// ─── /calendar/ signed in at 390 ──────────────────────────────
if (cookie) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await ctx.addCookies([cookie]);
	const page = await ctx.newPage();
	const errors = [];
	watchConsole(page, errors);
	await page.goto(BASE + '/calendar/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('.ep-cal--js .ep-cal__view[data-drawn="1"]', { timeout: 20000 });
	const line = await page.evaluate(() => {
		const f = document.querySelector('.ep-cal-subscribe__personal');
		return f ? f.getAttribute('action') + ' | ' + f.textContent.trim() : '';
	});
	check('[signed-in 390] personal-feed line under the subscribe buttons', /\/admin\/plugins\/ \| /.test(line), line);
	const chips = await page.$$eval('.ep-cal__filter', (bs) => bs.map((b) => b.getAttribute('data-source')));
	check('[signed-in 390] chips come from the sources list (bookings and calendar entries included)', chips.includes('ep-booking') && chips.includes('ep-calendar'), chips.join(', '));
	const o = await overflow(page);
	check('[signed-in 390] no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, 'step6-calendar-signed-in-390.png');
	check('[signed-in 390] no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
	await ctx.close();
}

await browser.close();
console.log('\nScreenshots:');
for (const p of shots)
	console.log('  ' + p);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
