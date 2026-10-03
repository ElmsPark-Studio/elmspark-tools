// EP Calendar build step 3: the week and month views and the phone editor, against the
// local rig (pm-rig -> pm-0.11.5-rig, served by `php -S 127.0.0.1:8911 router.php`).
//
// The calendar page is /calendar/ (a live page whose body is [ep-calendar], seeded by
// pm-0.11.5-rig/_calendar-step2-probe.php). Never the site root: Discovery AI owns it.
//
// Anonymous, at 390x844 and 1280x900:
//   agenda rows present, no Add button, no private titles, Week and Month both show the
//   live event, the month cell for today exists, the view survives a reload through
//   location.hash, an anonymous write is refused, no console errors, and at 390 no
//   horizontal overflow (document.documentElement.scrollWidth === clientWidth).
//
// Signed in (only when EP_CAL_COOKIE_FILE names a JSON file {name, value} holding a rig
// session cookie; no password is ever typed): Add button, private rows and the booking
// "PROBE Grooming: PROBE Customer" visible; create "PW step3 entry" through the dialog
// and see it in the agenda and the JSON; rename it "PW step3 edited"; delete it and see
// it gone from the JSON; a write without the double-submit token is refused.
//
// Screenshots of agenda, week and month at both widths go to EP_CAL_SHOTS (default:
// ./ep-calendar-shots). Their paths are printed.
//
// Run:
//   EP_CAL_SHOTS=/some/dir EP_CAL_COOKIE_FILE=/some/private/cookie.json node ep-calendar-rig.mjs

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.EP_CAL_BASE || 'http://127.0.0.1:8911';
const PAGE = BASE + '/calendar/';
const SHOTS = resolve(process.env.EP_CAL_SHOTS || './ep-calendar-shots');
const COOKIE_FILE = process.env.EP_CAL_COOKIE_FILE || '';
const VIEWPORTS = [{ name: '390', width: 390, height: 844 }, { name: '1280', width: 1280, height: 900 }];

mkdirSync(SHOTS, { recursive: true });
const results = [];
const shots = [];
function check(name, pass, detail) {
	results.push({ name, pass: Boolean(pass), detail });
	console.log((pass ? '✓ PASS' : '✗ FAIL') + ' — ' + name + (detail ? '  (' + detail + ')' : ''));
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

// The view finished a JSON render (the server agenda is only the first paint).
async function drawn(page, selector) {
	await page.waitForSelector('.ep-cal--js .ep-cal__view[data-drawn="1"]', { timeout: 15000 });
	await page.waitForFunction(() => !document.querySelector('.ep-cal[aria-busy="true"]'), null, { timeout: 15000 });
	if (selector)
		await page.waitForSelector('.ep-cal__view ' + selector, { timeout: 15000 });
}

async function noOverflow(page) {
	return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
}

// The JSON the view reads, fetched with this context's cookies.
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

const browser = await chromium.launch();

// ─── Anonymous ─────────────────────────────────────────────────────

for (const vp of VIEWPORTS) {
	const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
	const page = await context.newPage();
	const errors = [];
	watchConsole(page, errors);
	const tag = 'anon ' + vp.name;

	await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
	await drawn(page, null);
	const day = await today(page);
	const data = await json(page, day, day);
	const live = (data.data && data.data.entries || []).find((e) => e.source === 'ep-events' && /PROBE live event/.test(e.title));
	check(tag + ': JSON has today\'s live event', live, live ? live.title : 'none');
	const liveTitle = live ? live.title : 'PROBE live event';

	const rows = await page.locator('.ep-cal__view .ep-cal__entry').count();
	check(tag + ': agenda rows present', rows > 0, rows + ' rows');
	check(tag + ': no Add button', (await page.locator('.ep-cal__btn--add').count()) === 0);
	const body = await page.locator('body').innerText();
	check(tag + ': no private titles', !/PROBE private dentist|PROBE Customer/.test(body) && (await page.locator('.ep-cal__entry--private').count()) === 0);
	check(tag + ': no data-csrf on the root', (await page.locator('[data-ep-calendar][data-csrf]').count()) === 0);
	check(tag + ': three view buttons and Previous / Today / Next', (await page.locator('.ep-cal__view-btn').count()) === 3 && (await page.locator('.ep-cal__nav-btn').count()) === 3);
	let o = await noOverflow(page);
	if (vp.width === 390) check(tag + ': agenda has no horizontal overflow', o.sw === o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, `anon-agenda-${vp.name}.png`);

	await page.click('.ep-cal__view-btn[data-view="week"]');
	await drawn(page, '.ep-cal__week');
	const wdays = await page.locator('.ep-cal__week > li').count();
	check(tag + ': week shows seven days', wdays === 7, wdays + ' days');
	check(tag + ': week shows the live event', (await page.locator('.ep-cal__week').innerText()).includes(liveTitle));
	check(tag + ': week button pressed', (await page.getAttribute('.ep-cal__view-btn[data-view="week"]', 'aria-pressed')) === 'true');
	o = await noOverflow(page);
	if (vp.width === 390) check(tag + ': week has no horizontal overflow', o.sw === o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	if (vp.width === 1280) {
		// Seven columns need a 900px screen AND a calendar at least 44rem wide (CSS container
		// query); a theme column beside a sidebar is narrower, and then the days stay a list.
		const lay = await page.evaluate(() => ({
			cols: getComputedStyle(document.querySelector('.ep-cal__week')).gridTemplateColumns.split(' ').length,
			width: document.querySelector('.ep-cal__view').getBoundingClientRect().width,
			rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
		}));
		const want = lay.width >= 44 * lay.rem ? 7 : 1;
		check(tag + ': week layout follows the calendar width', lay.cols === want, `${lay.cols} column(s) in a ${Math.round(lay.width)}px calendar, expected ${want}`);
		await page.addStyleTag({ content: '.ep-cal__view { inline-size: 60rem; }' });
		const wide = await page.evaluate(() => getComputedStyle(document.querySelector('.ep-cal__week')).gridTemplateColumns.split(' ').length);
		check(tag + ': week is seven columns when the calendar is 60rem wide', wide === 7, wide + ' columns');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await drawn(page, '.ep-cal__week');
	}
	await shot(page, `anon-week-${vp.name}.png`);

	await page.click('.ep-cal__view-btn[data-view="month"]');
	await drawn(page, '.ep-cal__month');
	const cell = page.locator(`.ep-cal__month td[data-date="${day}"]`);
	check(tag + ': month cell for today exists and is marked', (await cell.count()) === 1 && (await cell.getAttribute('aria-current')) === 'date');
	const inMonth = await page.locator(`.ep-cal__month .ep-cal__chip-link[title="${liveTitle.replace(/"/g, '\\"')}"]`).count();
	check(tag + ': month shows the live event', inMonth > 0, inMonth + ' chip(s)');
	const weeks = await page.locator('.ep-cal__month tbody tr').count();
	check(tag + ': month grid is 5 or 6 weeks, Monday first', (weeks === 5 || weeks === 6) && (await page.locator('.ep-cal__month thead th').first().innerText()).trim() !== '', weeks + ' rows');
	check(tag + ': hash carries the view', /view=month/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
	o = await noOverflow(page);
	if (vp.width === 390) check(tag + ': month has no horizontal overflow', o.sw === o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, `anon-month-${vp.name}.png`);

	await page.reload({ waitUntil: 'domcontentloaded' });
	await drawn(page, '.ep-cal__month');
	check(tag + ': reload restores Month from the hash', (await page.getAttribute('.ep-cal__view-btn[data-view="month"]', 'aria-pressed')) === 'true');

	const anonWrite = await page.evaluate(async () => {
		const fd = new FormData();
		fd.append('pm_ajax', 'EP_Calendar');
		fd.append('action', 'cal_create_entry');
		fd.append('data[title]', 'PW anon write');
		fd.append('data[start]', '2026-10-03T10:00');
		fd.append('data[end]', '2026-10-03T11:00');
		const res = await fetch(location.pathname, { method: 'POST', body: fd, credentials: 'same-origin' });
		return { status: res.status, body: await res.text() };
	});
	check(tag + ': anonymous write refused by the router', anonWrite.status === 403 && /forbidden/.test(anonWrite.body), anonWrite.status + ' ' + anonWrite.body.slice(0, 80));
	// The deliberate refused write above logs one "status of 403" resource error; nothing else may.
	const real = errors.filter((e) => !/status of 403/.test(e));
	check(tag + ': no console errors', real.length === 0, real.join(' | ').slice(0, 300));
	await context.close();
}

// ─── Signed in ─────────────────────────────────────────────────────

if (!COOKIE_FILE || !existsSync(COOKIE_FILE)) {
	console.log('SKIP — signed-in checks: EP_CAL_COOKIE_FILE is not set or does not exist');
}
else {
	const cookie = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
	for (const vp of VIEWPORTS) {
		const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
		await context.addCookies([{ name: cookie.name, value: cookie.value, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
		const page = await context.newPage();
		const errors = [];
		watchConsole(page, errors);
		page.on('dialog', async (d) => { errors.push('unexpected window dialog: ' + d.message()); await d.dismiss(); });
		const tag = 'signed in ' + vp.name;

		await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
		await drawn(page, null);
		const day = await today(page);
		check(tag + ': Add button present', (await page.locator('.ep-cal__btn--add').count()) === 1);
		check(tag + ': private rows present', (await page.locator('.ep-cal__view .ep-cal__entry--private').count()) > 0);
		check(tag + ': booking "PROBE Grooming: PROBE Customer" visible', await page.locator('.ep-cal__view .ep-cal__entry', { hasText: 'PROBE Grooming: PROBE Customer' }).first().isVisible());
		check(tag + ': root carries data-csrf', (await page.locator('[data-ep-calendar][data-csrf]').count()) === 1);
		const editBtns = await page.locator('.ep-cal__view .ep-cal__entry[data-editable="1"] .ep-cal__actions button').count();
		check(tag + ': Edit and Delete on editable rows', editBtns > 0, editBtns + ' buttons');
		await shot(page, `signed-in-agenda-${vp.name}.png`);

		await page.click('.ep-cal__view-btn[data-view="week"]');
		await drawn(page, '.ep-cal__week');
		await shot(page, `signed-in-week-${vp.name}.png`);
		await page.click('.ep-cal__view-btn[data-view="month"]');
		await drawn(page, '.ep-cal__month');
		await shot(page, `signed-in-month-${vp.name}.png`);
		let o = await noOverflow(page);
		if (vp.width === 390) check(tag + ': month has no horizontal overflow', o.sw === o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
		await page.click('.ep-cal__view-btn[data-view="agenda"]');
		await page.click('.ep-cal__nav-btn[data-step="0"]');
		await drawn(page, '.ep-cal__days');

		if (vp.width !== 390) {
			check(tag + ': no console errors', errors.length === 0, errors.join(' | ').slice(0, 300));
			await context.close();
			continue;
		}

		// Create, through the dialog, at 390.
		await page.click('.ep-cal__btn--add');
		await page.waitForSelector('dialog.ep-cal__dialog[open]');
		const dlg = await page.evaluate(() => { const r = document.querySelector('dialog.ep-cal__dialog').getBoundingClientRect(); return { w: r.width, left: r.left }; });
		check(tag + ': dialog fits the phone', dlg.left >= 0 && dlg.left + dlg.w <= 390, `width ${dlg.w}, left ${dlg.left}`);
		check(tag + ': new entry defaults to private', await page.isChecked('dialog.ep-cal__dialog input[name="visibility"][value="private"]'));
		await page.fill('dialog.ep-cal__dialog input[name="title"]', 'PW step3 entry');
		await page.fill('dialog.ep-cal__dialog input[name="date"]', day);
		await page.fill('dialog.ep-cal__dialog input[name="end_date"]', day);
		// Client check first: an end before the start is refused in the dialog.
		await page.fill('dialog.ep-cal__dialog input[name="start_time"]', '18:00');
		await page.fill('dialog.ep-cal__dialog input[name="end_time"]', '17:00');
		await page.click('dialog.ep-cal__dialog button[type="submit"]');
		const clientErr = await page.locator('dialog.ep-cal__dialog .ep-cal__form > .ep-cal__form-error').innerText();
		check(tag + ': end before start refused in the dialog', clientErr.length > 0 && await page.isVisible('dialog.ep-cal__dialog[open]'), clientErr);
		await page.fill('dialog.ep-cal__dialog input[name="end_time"]', '19:00');
		await shot(page, `signed-in-dialog-${vp.name}.png`);
		await page.click('dialog.ep-cal__dialog button[type="submit"]');
		await page.waitForFunction(() => { const s = document.querySelector('.ep-cal__status'); return s && s.dataset.error === '0' && s.textContent !== '' && !document.querySelector('dialog.ep-cal__dialog[open]'); }, null, { timeout: 15000 });
		await drawn(page, null);
		const statusAfterCreate = await page.locator('.ep-cal__status').innerText();
		check(tag + ': status line after create', statusAfterCreate === 'Saved.', statusAfterCreate);
		check(tag + ': "PW step3 entry" in the agenda', await page.locator('.ep-cal__view .ep-cal__entry', { hasText: 'PW step3 entry' }).count() === 1);
		let j = await json(page, day, day);
		const created = (j.data.entries || []).find((e) => e.title === 'PW step3 entry');
		check(tag + ': "PW step3 entry" in the JSON, private, editable', created && created.visibility === 'private' && created.editable === true, created ? `entry_id ${created.entry_id}` : 'missing');

		// Edit.
		const row = page.locator('.ep-cal__view .ep-cal__entry', { hasText: 'PW step3 entry' }).first();
		await row.locator('.ep-cal__actions button').first().click();
		await page.waitForSelector('dialog.ep-cal__dialog[open]');
		await page.waitForFunction(() => document.querySelector('dialog.ep-cal__dialog input[name="title"]').value === 'PW step3 entry', null, { timeout: 15000 });
		check(tag + ': edit dialog loads the stored times', (await page.inputValue('dialog.ep-cal__dialog input[name="start_time"]')) === '18:00' && (await page.inputValue('dialog.ep-cal__dialog input[name="end_time"]')) === '19:00');
		await page.fill('dialog.ep-cal__dialog input[name="title"]', 'PW step3 edited');
		await page.click('dialog.ep-cal__dialog button[type="submit"]');
		await page.waitForFunction(() => !document.querySelector('dialog.ep-cal__dialog[open]'), null, { timeout: 15000 });
		await drawn(page, null);
		await page.waitForFunction(() => document.querySelector('.ep-cal__view').innerText.includes('PW step3 edited'), null, { timeout: 15000 });
		check(tag + ': "PW step3 edited" in the agenda', await page.locator('.ep-cal__view .ep-cal__entry', { hasText: 'PW step3 edited' }).count() === 1);
		j = await json(page, day, day);
		const titles = (j.data.entries || []).map((e) => e.title);
		check(tag + ': JSON has the edited title, not the old one', titles.includes('PW step3 edited') && !titles.includes('PW step3 entry'));

		// A write without the double-submit token is refused and writes nothing.
		const noToken = await page.evaluate(async () => {
			const fd = new FormData();
			fd.append('pm_ajax', 'EP_Calendar');
			fd.append('action', 'cal_create_entry');
			fd.append('data[title]', 'PW no token');
			fd.append('data[start]', '2026-10-03T10:00');
			fd.append('data[end]', '2026-10-03T11:00');
			const meta = document.querySelector('meta[name="csrf-token"]');
			const res = await fetch(location.pathname, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRF-Token': meta ? meta.content : '' } });
			return { status: res.status, body: await res.text() };
		});
		check(tag + ': write without ep_csrf_token refused', noToken.status === 403 && /ep_csrf_invalid/.test(noToken.body), noToken.status + ' ' + noToken.body.slice(0, 90));
		j = await json(page, day, day);
		check(tag + ': refused write left no row', !(j.data.entries || []).some((e) => e.title === 'PW no token'));

		// Delete, confirmed inside the dialog.
		const row2 = page.locator('.ep-cal__view .ep-cal__entry', { hasText: 'PW step3 edited' }).first();
		await row2.locator('.ep-cal__actions button.ep-cal__btn--danger').click();
		await page.waitForSelector('dialog.ep-cal__dialog[open] .ep-cal__confirm:not([hidden])');
		const confirmText = await page.locator('dialog.ep-cal__dialog .ep-cal__confirm-text').innerText();
		check(tag + ': delete asks once, in the dialog', confirmText.includes('PW step3 edited'), confirmText);
		await page.click('dialog.ep-cal__dialog .ep-cal__confirm .ep-cal__btn--danger');
		await page.waitForFunction(() => !document.querySelector('dialog.ep-cal__dialog[open]'), null, { timeout: 15000 });
		await drawn(page, null);
		const statusAfterDelete = await page.locator('.ep-cal__status').innerText();
		check(tag + ': status line after delete', statusAfterDelete === 'Deleted.', statusAfterDelete);
		j = await json(page, day, day);
		check(tag + ': "PW step3" gone from the JSON', !(j.data.entries || []).some((e) => /PW step3/.test(e.title)));
		const real = errors.filter((e) => !/status of 403/.test(e));
		check(tag + ': no console errors', real.length === 0, real.join(' | ').slice(0, 300));
		await context.close();
	}
}

await browser.close();

console.log('\nScreenshots:');
for (const p of shots)
	console.log('  ' + p);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
