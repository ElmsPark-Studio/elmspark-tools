// EP Calendar acceptance (build step 7): the SIGNED-IN view and settings on
// dev11b.elmspark.com, through PageMotor's own admin login. Written by Claude, run by Kenn
// (memory dev11b_admin_playwright_is_kenns_to_run): Claude never types a password into a
// non-local site.
//
// Run (Kenn):
//   cd ~/Developer/elmspark/tools/playwright-tests && set -a && source ~/.config/elmspark/dev11b-admin.env && set +a && node ep-calendar-dev11b.mjs
//
// Reads DEV11B_ADMIN_USER and DEV11B_ADMIN_PASSWORD from the environment (never printed).
// Screenshots: EP_CAL_SHOTS, default ./ep-calendar-dev11b-shots.
//
// Self-cleaning: the entry it creates is deleted, the feed link it creates is revoked, and
// nothing else on dev11b is changed. Expects the step 7 seed: /calendar/ with
// [ep-calendar] + [ep-calendar-subscribe], "ACCEPT private entry" and "ACCEPT public
// entry" on 2026-10-03, and the public external feed "Irish public holidays".
//
// At 390x844 and at 1280x900:
//   /calendar/: the Add button is there, private rows show ("ACCEPT private entry"), the
//   root carries data-csrf, the personal-feed line sits under the subscribe buttons;
//   create "PW dev11b entry" through the dialog, see it in the agenda and the JSON; edit it to
//   "PW dev11b edited"; delete it and see it gone; no horizontal overflow at 390; no console
//   errors.
//   Settings (EP Calendar, opened the way core opens it): the Status card lists the sources
//   and the background-refresh (heartbeat) line; Personal feed creates a link named
//   "PW dev11b <width>", the link answers as a calendar carrying the private entry, it is
//   revoked through the table's Revoke button, and the same link then answers 404; the
//   External feeds table shows "Irish public holidays" with a last-updated time; no
//   horizontal overflow at 390; no console errors.
// Final line: ALL CHECKS PASSED, or the failure count.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = 'https://dev11b.elmspark.com';
const PAGE = BASE + '/calendar/';
const U = process.env.DEV11B_ADMIN_USER, P = process.env.DEV11B_ADMIN_PASSWORD;
if (!U || !P) {
	console.error('Missing DEV11B_ADMIN_USER / DEV11B_ADMIN_PASSWORD. Run: set -a && source ~/.config/elmspark/dev11b-admin.env && set +a');
	process.exit(2);
}
const SHOTS = resolve(process.env.EP_CAL_SHOTS || './ep-calendar-dev11b-shots');
mkdirSync(SHOTS, { recursive: true });
const PRIVATE_TITLE = 'ACCEPT private entry';
const FEED_LABEL = 'Irish public holidays';
const VIEWPORTS = [{ name: '390', width: 390, height: 844 }, { name: '1280', width: 1280, height: 900 }];

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
async function drawn(page, selector) {
	await page.waitForSelector('.ep-cal--js .ep-cal__view[data-drawn="1"]', { timeout: 20000 });
	await page.waitForFunction(() => !document.querySelector('.ep-cal[aria-busy="true"]'), null, { timeout: 20000 });
	if (selector)
		await page.waitForSelector('.ep-cal__view ' + selector, { timeout: 20000 });
}
const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
async function json(page, from, to) {
	return page.evaluate(async ([f, t]) => {
		const root = document.querySelector('[data-ep-calendar]');
		const u = new URL(root.dataset.endpoint, location.href);
		const res = await fetch(u.pathname + u.search + '&from=' + f + '&to=' + t, { credentials: 'same-origin' });
		return res.json();
	}, [from, to]);
}
async function today(page) {
	return page.evaluate(() => {
		const tz = document.querySelector('[data-ep-calendar]').dataset.tz || 'UTC';
		const p = {};
		for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()))
			p[x.type] = x.value;
		return p.year + '-' + p.month + '-' + p.day;
	});
}

// PageMotor's own login form. A click, never form.submit() (memory
// pm_login_form_direct_submit_silently_reloads).
async function login(page) {
	await page.goto(BASE + '/admin/', { waitUntil: 'load' });
	await page.locator('#user').fill(U);
	await page.locator('#password').fill(P);
	await page.locator('#pm-login-button').click();
	await page.waitForTimeout(3500);
	return (await page.title()) !== 'PageMotor Login';
}

// Core opens a Plugin's settings with a POST of plugin=<Class> from the Plugins page.
async function openSettings(page) {
	await page.goto(BASE + '/admin/plugins/', { waitUntil: 'load' });
	await page.waitForTimeout(1000);
	const form = page.locator('form:has(input[type=hidden][name="plugin"][value="EP_Calendar"])').first();
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'load' }),
		form.locator('button:has-text("Settings"), button.action').first().click()
	]);
	await page.waitForSelector('[data-ep-cal-status-panel]', { timeout: 20000 });
}
async function openGroup(page, id, inner) {
	const visible = await page.locator(`#group-${id} ${inner}`).first().isVisible().catch(() => false);
	if (!visible)
		await page.click(`#group-${id} > label`);
	await page.waitForSelector(`#group-${id} ${inner}`, { state: 'visible', timeout: 10000 });
}

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
	const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
	const page = await context.newPage();
	const errors = [];
	watchConsole(page, errors);
	let acceptDialogs = false;
	page.on('dialog', async (d) => {
		if (acceptDialogs) { await d.accept(); return; }
		errors.push('unexpected window dialog: ' + d.message());
		await d.dismiss();
	});
	const tag = 'signed in ' + vp.name;

	check(tag + ': logged in', await login(page));

	// ─── /calendar/ ───────────────────────────────────────────
	await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
	await drawn(page, null);
	const day = await today(page);
	check(tag + ': Add button present', (await page.locator('.ep-cal__btn--add').count()) === 1);
	check(tag + ': private rows present (' + PRIVATE_TITLE + ')', (await page.locator('.ep-cal__view .ep-cal__entry--private', { hasText: PRIVATE_TITLE }).count()) >= 1);
	check(tag + ': root carries data-csrf', (await page.locator('[data-ep-calendar][data-csrf]').count()) === 1);
	const line = await page.evaluate(() => { const f = document.querySelector('.ep-cal-subscribe__personal'); return f ? f.getAttribute('action') + ' | ' + f.textContent.trim() : ''; });
	check(tag + ': personal-feed line under the subscribe buttons', /\/admin\/plugins\/ \| /.test(line), line);
	let o = await overflow(page);
	if (vp.width === 390) check(tag + ': calendar has no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, `dev11b-signed-in-agenda-${vp.name}.png`);

	const title = 'PW dev11b entry ' + vp.name;
	const edited = 'PW dev11b edited ' + vp.name;
	await page.click('.ep-cal__btn--add');
	await page.waitForSelector('dialog.ep-cal__dialog[open]');
	if (vp.width === 390) {
		const dlg = await page.evaluate(() => { const r = document.querySelector('dialog.ep-cal__dialog').getBoundingClientRect(); return { w: r.width, left: r.left }; });
		check(tag + ': dialog fits the phone', dlg.left >= 0 && dlg.left + dlg.w <= 390, `width ${dlg.w}, left ${dlg.left}`);
	}
	check(tag + ': new entry defaults to private', await page.isChecked('dialog.ep-cal__dialog input[name="visibility"][value="private"]'));
	await page.fill('dialog.ep-cal__dialog input[name="title"]', title);
	await page.fill('dialog.ep-cal__dialog input[name="date"]', day);
	await page.fill('dialog.ep-cal__dialog input[name="end_date"]', day);
	await page.fill('dialog.ep-cal__dialog input[name="start_time"]', '20:00');
	await page.fill('dialog.ep-cal__dialog input[name="end_time"]', '21:00');
	await shot(page, `dev11b-signed-in-dialog-${vp.name}.png`);
	await page.click('dialog.ep-cal__dialog button[type="submit"]');
	await page.waitForFunction(() => { const s = document.querySelector('.ep-cal__status'); return s && s.dataset.error === '0' && s.textContent !== '' && !document.querySelector('dialog.ep-cal__dialog[open]'); }, null, { timeout: 20000 });
	await drawn(page, null);
	check(tag + ': "' + title + '" in the agenda', (await page.locator('.ep-cal__view .ep-cal__entry', { hasText: title }).count()) === 1);
	let j = await json(page, day, day);
	const created = (j.data.entries || []).find((e) => e.title === title);
	check(tag + ': "' + title + '" in the JSON, private, editable', created && created.visibility === 'private' && created.editable === true, created ? 'entry_id ' + created.entry_id : 'missing');

	const row = page.locator('.ep-cal__view .ep-cal__entry', { hasText: title }).first();
	await row.locator('.ep-cal__actions button').first().click();
	await page.waitForSelector('dialog.ep-cal__dialog[open]');
	await page.waitForFunction((t) => document.querySelector('dialog.ep-cal__dialog input[name="title"]').value === t, title, { timeout: 20000 });
	check(tag + ': edit dialog loads the stored times', (await page.inputValue('dialog.ep-cal__dialog input[name="start_time"]')) === '20:00' && (await page.inputValue('dialog.ep-cal__dialog input[name="end_time"]')) === '21:00');
	await page.fill('dialog.ep-cal__dialog input[name="title"]', edited);
	await page.click('dialog.ep-cal__dialog button[type="submit"]');
	await page.waitForFunction(() => !document.querySelector('dialog.ep-cal__dialog[open]'), null, { timeout: 20000 });
	await drawn(page, null);
	await page.waitForFunction((t) => document.querySelector('.ep-cal__view').innerText.includes(t), edited, { timeout: 20000 });
	j = await json(page, day, day);
	const titles = (j.data.entries || []).map((e) => e.title);
	check(tag + ': JSON has the edited title, not the old one', titles.includes(edited) && !titles.includes(title));

	const row2 = page.locator('.ep-cal__view .ep-cal__entry', { hasText: edited }).first();
	await row2.locator('.ep-cal__actions button.ep-cal__btn--danger').click();
	await page.waitForSelector('dialog.ep-cal__dialog[open] .ep-cal__confirm:not([hidden])');
	await page.click('dialog.ep-cal__dialog .ep-cal__confirm .ep-cal__btn--danger');
	await page.waitForFunction(() => !document.querySelector('dialog.ep-cal__dialog[open]'), null, { timeout: 20000 });
	await drawn(page, null);
	j = await json(page, day, day);
	check(tag + ': "PW dev11b" gone from the JSON after delete', !(j.data.entries || []).some((e) => /PW dev11b/.test(e.title)));

	// ─── Settings ─────────────────────────────────────────────
	await openSettings(page);
	const status = await page.evaluate(() => {
		const panel = document.querySelector('[data-ep-cal-status-panel]');
		const row = (k) => panel.querySelector('[data-row="' + k + '"] dd');
		return {
			sources: Array.from(panel.querySelectorAll('.ep-cal-status__source')).map((li) => li.textContent.trim().replace(/\s+/g, ' ')),
			heartbeat: row('heartbeat') ? row('heartbeat').textContent.trim().replace(/\s+/g, ' ') : ''
		};
	});
	check(tag + ': Status card lists the sources', status.sources.length >= 3 && status.sources.some((s) => s.startsWith(FEED_LABEL)), status.sources.join(' | '));
	check(tag + ': Status card heartbeat line, no warning', /^Last heartbeat /.test(status.heartbeat) && !/more than 30 minutes|not active|has not run/.test(status.heartbeat), status.heartbeat);

	// Personal feed: create, prove, revoke, prove refused. The link is printed only as its last 6 characters.
	await openGroup(page, 'group-personal-feed', '[data-ep-cal-create]');
	const label = 'PW dev11b ' + vp.name;
	await page.fill('#ep-cal-feed-label', label);
	await page.click('[data-ep-cal-create]');
	await page.waitForSelector('[data-ep-cal-result]:not([hidden])', { timeout: 20000 });
	const link = await page.inputValue('[data-ep-cal-url="https"]');
	const tail = link.slice(-6);
	check(tag + ': Personal feed link created and shown once', /\?ep_calendar_feed=personal&token=[0-9a-f]{64}$/.test(link), '…' + tail);
	check(tag + ': the new link is listed in the table', (await page.locator('[data-ep-cal-rows] tr', { hasText: label }).count()) === 1);
	const live = await page.request.get(link, { maxRedirects: 0 });
	const liveBody = await live.text();
	check(tag + ': the link answers as a calendar carrying the private entry', live.status() === 200 && /text\/calendar/.test(live.headers()['content-type'] || '') && liveBody.includes('SUMMARY:' + PRIVATE_TITLE) && /private, no-store/.test(live.headers()['cache-control'] || ''), 'HTTP ' + live.status());
	acceptDialogs = true;
	await page.locator('[data-ep-cal-rows] tr', { hasText: label }).locator('[data-ep-cal-revoke]').click();
	await page.waitForFunction((l) => {
		const r = Array.from(document.querySelectorAll('[data-ep-cal-rows] tr')).find((tr) => tr.textContent.includes(l));
		return r && !r.querySelector('[data-ep-cal-revoke]');
	}, label, { timeout: 20000 });
	acceptDialogs = false;
	check(tag + ': Revoke marks the link revoked', (await page.locator('[data-ep-cal-rows] tr.ep-cal-feeds__revoked', { hasText: label }).count()) === 1);
	const dead = await page.request.get(link, { maxRedirects: 0 });
	check(tag + ': the revoked link answers 404', dead.status() === 404, 'HTTP ' + dead.status());

	// External feeds table.
	await openGroup(page, 'group-external-feeds', '[data-ep-cal-ext-rows]');
	const ext = await page.evaluate((lbl) => {
		const r = Array.from(document.querySelectorAll('[data-ep-cal-ext-rows] tr')).find((tr) => tr.textContent.includes(lbl));
		if (!r) return null;
		const w = r.querySelector('.ep-cal-ext__when');
		return { when: w ? w.textContent.trim() : '', text: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) };
	}, FEED_LABEL);
	check(tag + ': External feeds shows "' + FEED_LABEL + '" with a last-updated time', ext && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ext.when), ext ? ext.text : 'row missing');

	o = await overflow(page);
	if (vp.width === 390) check(tag + ': settings have no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, `dev11b-signed-in-settings-${vp.name}.png`);
	check(tag + ': no console errors', errors.length === 0, errors.join(' | ').slice(0, 300));
	await context.close();
}

await browser.close();
console.log('\nScreenshots:');
for (const p of shots)
	console.log('  ' + p);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
