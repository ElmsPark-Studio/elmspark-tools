// EP Calendar acceptance (build step 7): the ANONYMOUS view on dev11b.elmspark.com over
// https, at 390x844 and 1280x900. No sign-in, no credentials, nothing written.
//
// Expects on dev11b (seeded in step 7 through the dev11b MCP connector):
//   /calendar/ = a live page whose body is [ep-calendar] + [ep-calendar-subscribe]
//   "ACCEPT public entry" (public) and "ACCEPT private entry" (private) on 2026-10-03
//   the public external feed "Irish public holidays" (Google's Irish holiday calendar)
//
// Checks, per width: agenda rows present, including ACCEPT public entry and an Irish holiday
// row when a holiday falls inside the agenda window; no Add button; no private titles and no
// private rows; no data-csrf; three view buttons and Previous / Today / Next; week (7 days)
// and month (5 or 6 weeks) render; the source chips are present, all on, and switching the
// holidays chip off hides its rows (sources= in the hash) and on again restores them; the
// view survives a reload through location.hash; an anonymous write is refused by the router;
// no horizontal overflow at 390; a service worker is registered for scope / over https; the
// manifest link and theme-color are in <head>; no console errors (other than the one 403 the
// deliberate anonymous write logs). Build step 7b adds the computed type checks (typeCheck):
// day heading 16-20px and start-aligned, Today at most 14px, title start-aligned, subscribe
// links not underlined and as tall as Copy link, in agenda and week at both widths.
//
// Run:  cd ~/Developer/elmspark/tools/playwright-tests && EP_CAL_SHOTS=/some/dir node ep-calendar-dev11b-anon.mjs
// Final line: ALL CHECKS PASSED, or the failure count.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = process.env.EP_CAL_BASE || 'https://dev11b.elmspark.com';
const PAGE = BASE + '/calendar/';
const SHOTS = resolve(process.env.EP_CAL_SHOTS || './ep-calendar-dev11b-shots');
const PUBLIC_TITLE = 'ACCEPT public entry';
const PRIVATE_TITLE = 'ACCEPT private entry';
const FEED_LABEL = 'Irish public holidays';
const VIEWPORTS = [{ name: '390', width: 390, height: 844 }, { name: '1280', width: 1280, height: 900 }];

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
async function drawn(page, selector) {
	await page.waitForSelector('.ep-cal--js .ep-cal__view[data-drawn="1"]', { timeout: 20000 });
	await page.waitForFunction(() => !document.querySelector('.ep-cal[aria-busy="true"]'), null, { timeout: 20000 });
	if (selector)
		await page.waitForSelector('.ep-cal__view ' + selector, { timeout: 20000 });
	// Build step 7b: the view fades to 0.6 while busy and back over 120 ms; a screenshot
	// taken inside that fade made the whole week look muted grey (dev11b-anon-week-1280,
	// step 7). Wait for the fade to finish.
	await page.waitForFunction(() => getComputedStyle(document.querySelector('.ep-cal__view')).opacity === '1', null, { timeout: 5000 });
}

// Build step 7b: computed type of the calendar and the subscribe block under the site's
// theme. Under Attention at 1280, step 7 measured day headings 29px centred, Today 21.75px,
// the view title 37px centred and underlined subscribe links 58px tall beside a 44px button.
async function typeCheck(page, tag, view) {
	const m = await page.evaluate(() => {
		const one = (sel) => {
			const el = document.querySelector(sel);
			if (!el || el.hidden || el.getClientRects().length === 0) return null;
			const cs = getComputedStyle(el);
			return { size: parseFloat(cs.fontSize), align: cs.textAlign, deco: cs.textDecorationLine, weight: cs.fontWeight, h: el.getBoundingClientRect().height };
		};
		const links = Array.from(document.querySelectorAll('a.ep-cal-subscribe__btn')).map((a) => {
			const cs = getComputedStyle(a);
			return { text: a.textContent.trim(), deco: cs.textDecorationLine, h: a.getBoundingClientRect().height };
		});
		return {
			title: one('.ep-cal__title'),
			heading: one('.ep-cal__view .ep-cal__day-heading'),
			today: one('.ep-cal__view .ep-cal__today'),
			row: one('.ep-cal__view .ep-cal__entry-title'),
			copy: one('button.ep-cal-subscribe__btn'),
			links,
			weekCols: document.querySelector('.ep-cal__week') ? getComputedStyle(document.querySelector('.ep-cal__week')).gridTemplateColumns.split(' ').length : 0
		};
	});
	const f = (o) => (o ? `${o.size}px ${o.align} ${o.deco} w${o.weight} h${o.h.toFixed(1)}` : 'absent');
	console.log(`  [type ${tag} ${view}] title ${f(m.title)} | day heading ${f(m.heading)} | Today ${f(m.today)} | row title ${f(m.row)} | Copy link ${f(m.copy)} | links ${m.links.map((l) => `${l.text} ${l.deco} h${l.h.toFixed(1)}`).join(', ')}`);
	// A seven-column week sets its headings smaller on purpose (0.875 of the scale); the
	// 16-20px rule is for the agenda and the week as a list.
	if (view === 'agenda' || m.weekCols === 1)
		check(`${tag} ${view}: day heading 16-20px and start-aligned`, m.heading && m.heading.size >= 16 && m.heading.size <= 20 && m.heading.align === 'start', f(m.heading));
	check(`${tag} ${view}: Today badge at most 14px`, m.today && m.today.size <= 14, f(m.today));
	check(`${tag} ${view}: view title start-aligned`, m.title && m.title.align === 'start', f(m.title));
	check(`${tag} ${view}: subscribe links carry no underline`, m.links.length === 3 && m.links.every((l) => l.deco === 'none'), m.links.map((l) => l.deco).join(', '));
	check(`${tag} ${view}: subscribe links as tall as Copy link (within 2px)`, m.copy && m.links.length === 3 && m.links.every((l) => Math.abs(l.h - m.copy.h) <= 2), `links ${m.links.map((l) => l.h.toFixed(1)).join('/')} vs Copy link ${m.copy ? m.copy.h.toFixed(1) : 'absent'}`);
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
function addDays(ymd, n) {
	const d = new Date(ymd + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
	const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
	const page = await context.newPage();
	const errors = [];
	watchConsole(page, errors);
	const tag = 'anon ' + vp.name;

	const resp = await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
	check(tag + ': /calendar/ answers 200 over https', resp && resp.status() === 200 && PAGE.startsWith('https://'), resp ? 'HTTP ' + resp.status() : 'no response');
	await drawn(page, null);
	const day = await today(page);
	const days = Number(await page.getAttribute('[data-ep-calendar]', 'data-days')) || 31;

	// What the agenda window holds, from the JSON the view itself reads.
	const data = await json(page, day, addDays(day, days - 1));
	const entries = (data.data && data.data.entries) || [];
	check(tag + ': JSON is the public view (can_private false)', data.data && data.data.can_private === false);
	check(tag + ': JSON has no private entry', !entries.some((e) => e.visibility !== 'public' || e.title === PRIVATE_TITLE), entries.length + ' entries');
	const holidays = entries.filter((e) => e.source_label === FEED_LABEL);
	const firstHoliday = holidays.length ? holidays[0].title : '';

	// Agenda.
	await page.waitForSelector('.ep-cal__view .ep-cal__entry', { timeout: 20000 });
	const rows = await page.locator('.ep-cal__view .ep-cal__entry').count();
	check(tag + ': agenda rows present', rows > 0, rows + ' rows');
	check(tag + ': agenda has ' + PUBLIC_TITLE, (await page.locator('.ep-cal__view .ep-cal__entry', { hasText: PUBLIC_TITLE }).count()) === 1);
	if (holidays.length)
		check(tag + ': agenda has an Irish holiday row (' + firstHoliday + ')', (await page.locator('.ep-cal__view .ep-cal__entry', { hasText: firstHoliday }).count()) >= 1, holidays.length + ' holiday(s) in the ' + days + '-day window');
	else
		console.log('  (no Irish holiday falls inside the ' + days + '-day agenda window; that check is skipped)');
	check(tag + ': no Add button', (await page.locator('.ep-cal__btn--add').count()) === 0);
	const body = await page.locator('body').innerText();
	check(tag + ': no private titles, no private rows', !body.includes(PRIVATE_TITLE) && (await page.locator('.ep-cal__entry--private').count()) === 0);
	check(tag + ': no data-csrf on the root', (await page.locator('[data-ep-calendar][data-csrf]').count()) === 0);
	check(tag + ': three view buttons and Previous / Today / Next', (await page.locator('.ep-cal__view-btn').count()) === 3 && (await page.locator('.ep-cal__nav-btn').count()) === 3);
	let o = await overflow(page);
	if (vp.width === 390) check(tag + ': agenda has no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await page.waitForSelector('button.ep-cal-subscribe__btn:not([hidden])', { timeout: 10000 });
	await typeCheck(page, tag, 'agenda');
	await shot(page, `dev11b-anon-agenda-${vp.name}.png`);

	// Source chips: present, all on; the holidays chip hides and restores its rows.
	const chips = await page.$$eval('.ep-cal__filter', (bs) => bs.map((b) => ({ id: b.getAttribute('data-source'), on: b.getAttribute('aria-pressed'), text: b.textContent.trim() })));
	check(tag + ': source chips present, all on', chips.length >= 2 && chips.every((c) => c.on === 'true'), chips.map((c) => `${c.id}=${c.on} "${c.text}"`).join(', '));
	const feedChip = chips.find((c) => c.text === FEED_LABEL || /^external:/.test(c.id || ''));
	if (feedChip && holidays.length) {
		const sel = `.ep-cal__filter[data-source="${feedChip.id}"]`;
		const feedRows = () => page.$$eval(`.ep-cal__view .ep-cal__entry[data-source="${feedChip.id}"]`, (r) => r.length);
		const before = await feedRows();
		await page.click(sel);
		const off = await feedRows();
		const hashOff = await page.evaluate(() => location.hash);
		check(tag + ': holidays chip off hides its rows; sources= in the hash', before > 0 && off === 0 && (await page.getAttribute(sel, 'aria-pressed')) === 'false' && /[#&]sources=/.test(hashOff), `${before} -> ${off} row(s), ${hashOff}`);
		if (vp.width === 390) await shot(page, `dev11b-anon-agenda-holidays-off-${vp.name}.png`);
		await page.click(sel);
		const on = await feedRows();
		const hashOn = await page.evaluate(() => location.hash);
		check(tag + ': holidays chip on restores the rows; hash drops sources=', on === before && !/sources=/.test(hashOn), `${on} row(s), ${hashOn}`);
	}
	else
		check(tag + ': a chip for the holidays feed', false, 'chip ' + (feedChip ? 'present' : 'missing') + ', holidays in window ' + holidays.length);

	// Week.
	await page.click('.ep-cal__view-btn[data-view="week"]');
	await drawn(page, '.ep-cal__week');
	const wdays = await page.locator('.ep-cal__week > li').count();
	check(tag + ': week shows seven days', wdays === 7, wdays + ' days');
	check(tag + ': week shows ' + PUBLIC_TITLE, (await page.locator('.ep-cal__week').innerText()).includes(PUBLIC_TITLE));
	check(tag + ': week button pressed', (await page.getAttribute('.ep-cal__view-btn[data-view="week"]', 'aria-pressed')) === 'true');
	o = await overflow(page);
	if (vp.width === 390) check(tag + ': week has no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	if (vp.width === 1280) {
		const lay = await page.evaluate(() => ({
			cols: getComputedStyle(document.querySelector('.ep-cal__week')).gridTemplateColumns.split(' ').length,
			width: document.querySelector('.ep-cal__view').getBoundingClientRect().width,
			rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
		}));
		const want = lay.width >= 44 * lay.rem ? 7 : 1;
		check(tag + ': week layout follows the calendar width', lay.cols === want, `${lay.cols} column(s) in a ${Math.round(lay.width)}px calendar, expected ${want}`);
	}
	await typeCheck(page, tag, 'week');
	const fade = await page.evaluate(() => getComputedStyle(document.querySelector('.ep-cal__view')).opacity);
	check(tag + ': week view fully opaque at the screenshot (no mid-fade grey)', fade === '1', 'opacity ' + fade);
	await shot(page, `dev11b-anon-week-${vp.name}.png`);

	// Month.
	await page.click('.ep-cal__view-btn[data-view="month"]');
	await drawn(page, '.ep-cal__month');
	const cell = page.locator(`.ep-cal__month td[data-date="${day}"]`);
	check(tag + ': month cell for today exists and is marked', (await cell.count()) === 1 && (await cell.getAttribute('aria-current')) === 'date');
	const inMonth = await page.locator(`.ep-cal__month [title="${PUBLIC_TITLE}"]`).count();
	check(tag + ': month shows ' + PUBLIC_TITLE, inMonth > 0, inMonth + ' chip(s)');
	const weeks = await page.locator('.ep-cal__month tbody tr').count();
	check(tag + ': month grid is 5 or 6 weeks', weeks === 5 || weeks === 6, weeks + ' rows');
	check(tag + ': hash carries the view', /view=month/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
	o = await overflow(page);
	if (vp.width === 390) check(tag + ': month has no horizontal overflow', o.sw <= o.cw, `scrollWidth ${o.sw}, clientWidth ${o.cw}`);
	await shot(page, `dev11b-anon-month-${vp.name}.png`);

	await page.reload({ waitUntil: 'domcontentloaded' });
	await drawn(page, '.ep-cal__month');
	check(tag + ': reload restores Month from the hash', (await page.getAttribute('.ep-cal__view-btn[data-view="month"]', 'aria-pressed')) === 'true');

	// PWA: manifest + theme colour in <head>, a service worker for scope / over https.
	const head = await page.evaluate(() => {
		const l = document.head.querySelector('link[rel="manifest"]');
		const m = document.head.querySelector('meta[name="theme-color"]');
		return { manifest: l ? l.getAttribute('href') + (l.hasAttribute('data-ep-calendar') ? ' (added by script)' : ' (server)') : '', colour: m ? m.getAttribute('content') : '' };
	});
	check(tag + ': manifest link and theme-color in <head>', /ep_calendar_manifest=1 \(server\)$/.test(head.manifest) && head.colour !== '', head.manifest + ' | ' + head.colour);
	let regs = 0;
	for (let i = 0; i < 30 && regs < 1; i++) {
		regs = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1));
		if (regs < 1) await page.waitForTimeout(500);
	}
	const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistrations(); return r.length ? r[0].scope + ' script=' + ((r[0].active || r[0].installing || r[0].waiting || {}).scriptURL || '') : ''; });
	check(tag + ': service worker registered over https for scope /', regs === 1 && sw.startsWith(BASE + '/ ') && /ep_calendar_sw=1/.test(sw), sw);

	// Subscribe block: four buttons, Copy link shown by the script, no personal-feed line.
	const sub = await page.evaluate(() => ({
		buttons: Array.from(document.querySelectorAll('.ep-cal-subscribe__btn')).map((b) => b.textContent.trim()),
		copyShown: (() => { const b = document.querySelector('[data-ep-cal-copy-url]'); return b ? !b.hidden : false; })(),
		personal: Boolean(document.querySelector('.ep-cal-subscribe__personal'))
	}));
	check(tag + ': subscribe buttons (Apple, Google, Outlook, Copy link), no personal-feed line', sub.buttons.length === 4 && sub.copyShown && !sub.personal, sub.buttons.join(' | '));

	// An anonymous write is refused by core's router.
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
	check(tag + ': anonymous write refused', anonWrite.status === 403, anonWrite.status + ' ' + anonWrite.body.slice(0, 90));
	const real = errors.filter((e) => !/status of 403/.test(e));
	check(tag + ': no console errors', real.length === 0, real.join(' | ').slice(0, 300));
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
