import { test, expect, Page } from '@playwright/test';
import { adminLogin, saveOptions } from '../fixtures/auth';

/**
 * EP Suite trait: settings-group status tag (ep_status_label() + ep_suite_status_tag_js()).
 *
 * Each pilot group shows, in its collapsed header, whether its feature is on. Checks, per group:
 *  - on load the tag matches the enable checkbox core rendered from the SAVED row
 *    (settings() runs before saved values load, so this proves the trait reads the row itself)
 *  - it sits in the header while the group is collapsed, right of the title, left of the chevron
 *  - no inline style attributes; inks clear WCAG AA
 *  - ticking the box flips it live and marks it unsaved; ticking back clears the mark
 *  - after Save Settings it stops being "unsaved"; after a reload the server agrees
 *  - the original setting is restored (and re-verified after reload) in a finally
 * Plus the dated states (Scheduled / Showing now / Ended) driven through the SHIPPED
 * script on a real settings page, since no pilot group has start/end dates yet.
 */

const SHOTS = process.env.EP_SHOT_DIR || 'test-results';

const PILOTS: { cls: string; group: string; box: string }[] = [
	{ cls: 'EP_Local_Business', group: 'group-business', box: 'enable_localbusiness-enabled' },
	{ cls: 'EP_Newsletter', group: 'group-forms', box: 'enable_subscribe_form-enabled' },
	{ cls: 'EP_Newsletter', group: 'group-auto-newsletter', box: 'auto_newsletter_enabled-enabled' },
	{ cls: 'EP_Booking', group: 'group-public', box: 'public_pages_enabled-enabled' },
	{ cls: 'EP_Booking', group: 'group-form', box: 'enable_booking_form-enabled' },
];

async function openSettings(page: Page, cls: string) {
	await page.goto('/admin/plugins/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	await page.locator('form input[name="plugin"]').first().waitFor({ state: 'attached' });
	await page.evaluate(c => {
		const f = document.createElement('form');
		f.method = 'post'; f.action = '/admin/plugins/';
		const i = document.createElement('input');
		i.type = 'hidden'; i.name = 'plugin'; i.value = c;
		f.appendChild(i); document.body.appendChild(f); f.submit();
	}, cls);
	await page.waitForURL('**/admin/plugins/**', { waitUntil: 'load' });
	await page.locator('form.pm-options-form').waitFor({ timeout: 15000 });
	await expect(page.locator('script#ep-suite-status-tag'), `${cls}: status-tag script from the trait`).toHaveCount(1);
	await page.waitForTimeout(800);	// core + suite JS bind group toggles at body end
}

// Core wraps each group as id="group-{id}", and these ids already start with "group-".
const wrap = (group: string) => `#group-${group}`;
const tagOf = (page: Page, group: string) => page.locator(`${wrap(group)} > label > .ep-status-tag`);

async function tagState(page: Page, group: string) {
	return tagOf(page, group).evaluate(el => ({
		text: el.textContent!.trim(),
		state: (el.className.match(/ep-status-tag--(on|off|live|scheduled|ended)\b/) || [])[1],
		unsaved: el.classList.contains('ep-status-tag--unsaved'),
		title: el.getAttribute('title'),
	}));
}

async function openGroup(page: Page, group: string, box: string) {
	const input = page.locator(`#${box}`);
	if (!(await input.isVisible()))
		await page.locator(`${wrap(group)} > label .ep-section-title`).click();
	await expect(input, `${group}: opens to show its enable box`).toBeVisible();
}

function ratio(fg: string, bg: string) {
	const lum = (s: string) => {
		const [r, g, b] = s.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
			v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
	return (hi + 0.05) / (lo + 0.05);
}

test.describe('EP Suite settings-group status tag', () => {
	test.setTimeout(300000);

	for (const pilot of PILOTS) {
		test(`${pilot.cls} ${pilot.group}: load, live flip, save, reload`, async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', e => errors.push(e.message));
			await adminLogin(page);
			await openSettings(page, pilot.cls);

			const cls = pilot.cls;
			const boxId = `${cls}-${pilot.box}`;
			const box = page.locator(`#${boxId}`);
			const tag = tagOf(page, pilot.group);
			await expect(tag, 'one tag in the group header').toHaveCount(1);

			// 1. On load: the tag agrees with the box core rendered from the saved row.
			const original = await box.isChecked();
			const load = await tagState(page, pilot.group);
			console.log(`${cls} ${pilot.group}: saved=${original ? 'on' : 'off'} tag=${JSON.stringify(load)}`);
			expect(load.state, 'tag on load matches the saved checkbox').toBe(original ? 'on' : 'off');
			expect(load.text).toBe(original ? 'On' : 'Off');
			expect(load.unsaved).toBe(false);

			// 2. Visible while collapsed, between the title and the chevron, no inline style.
			await expect(box, 'group starts collapsed').toBeHidden();
			await expect(tag, 'tag visible on the collapsed header').toBeVisible();
			expect(await page.locator(`${wrap(pilot.group)} > label [style]`).count(), 'no inline styles in the header').toBe(0);
			const geo = await page.locator(`${wrap(pilot.group)} > label`).evaluate(l => {
				const t = l.querySelector('.ep-status-tag')!.getBoundingClientRect();
				const info = l.querySelector('.ep-section-info')!.getBoundingClientRect();
				const lr = l.getBoundingClientRect();
				const after = getComputedStyle(l, '::after');
				const pad = parseFloat(getComputedStyle(l).paddingRight);
				return { tagLeft: t.left, tagRight: t.right, infoRight: info.right, chevronW: parseFloat(after.width),
					space: lr.right - pad - t.right, midY: Math.abs((t.top + t.bottom) / 2 - (lr.top + lr.bottom) / 2) };
			});
			expect(geo.tagLeft, 'tag right of the title block').toBeGreaterThan(geo.infoRight);
			expect(Math.round(geo.space), 'tag sits beside the chevron (chevron + 14px gap)').toBe(geo.chevronW + 14);
			expect(geo.midY, 'tag vertically centred in the header').toBeLessThanOrEqual(2);
			const ink = await tag.evaluate(el => { const cs = getComputedStyle(el); return { c: cs.color, bg: cs.backgroundColor }; });
			expect(ratio(ink.c, ink.bg), `tag ink passes AA (${ink.c} on ${ink.bg})`).toBeGreaterThanOrEqual(4.5);
			await page.locator(`${wrap(pilot.group)} > label`).screenshot({ path: `${SHOTS}/status-tag-${cls}-${pilot.group}-load.png` });

			const flipped = original ? 'off' : 'on';
			try {
				// 3. Live flip on tick, marked unsaved; ticking back clears the mark.
				await openGroup(page, pilot.group, boxId);
				await box.click();
				let s = await tagState(page, pilot.group);
				expect(s.state, 'tag flips live on tick').toBe(flipped);
				expect(s.text).toBe(flipped === 'on' ? 'On' : 'Off');
				expect(s.unsaved, 'unsaved until Save').toBe(true);
				expect(s.title).toContain('Save Settings');
				await page.locator(`${wrap(pilot.group)} > label`).screenshot({ path: `${SHOTS}/status-tag-${cls}-${pilot.group}-unsaved.png` });
				await box.click();
				s = await tagState(page, pilot.group);
				expect(s.state, 'ticking back restores the tag').toBe(original ? 'on' : 'off');
				expect(s.unsaved, 'back to the saved state: no unsaved mark').toBe(false);
				expect(s.title).toBeNull();

				// 4. Tick, Save: the unsaved mark clears on the successful AJAX save.
				await box.click();
				await saveOptions(page, `${cls} settings`);
				await expect.poll(async () => (await tagState(page, pilot.group)).unsaved, { message: 'unsaved mark clears after Save' }).toBe(false);
				expect((await tagState(page, pilot.group)).state).toBe(flipped);

				// 5. Reload: the server renders the new state from the saved row.
				await openSettings(page, cls);
				expect(await page.locator(`#${boxId}`).isChecked(), 'save persisted').toBe(!original);
				s = await tagState(page, pilot.group);
				expect(s.state, 'after reload the server-side tag shows the saved state').toBe(flipped);
				expect(s.unsaved).toBe(false);
				await page.locator(`${wrap(pilot.group)} > label`).screenshot({ path: `${SHOTS}/status-tag-${cls}-${pilot.group}-reloaded.png` });
			} finally {
				// Restore the original setting whatever happened above, and prove it.
				await openSettings(page, cls);
				if ((await page.locator(`#${boxId}`).isChecked()) !== original) {
					await openGroup(page, pilot.group, boxId);
					await page.locator(`#${boxId}`).click();
					await saveOptions(page, `${cls} restore`);
					await openSettings(page, cls);
				}
				expect(await page.locator(`#${boxId}`).isChecked(), 'original setting restored').toBe(original);
				expect((await tagState(page, pilot.group)).state, 'tag back to the original').toBe(original ? 'on' : 'off');
			}
			expect(errors, 'no page errors').toEqual([]);
		});
	}

	test('dated states through the shipped script', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await adminLogin(page);
		await openSettings(page, 'EP_Newsletter');

		// A synthetic dated group on the real page, in exactly the markup the trait emits,
		// bound by the shipped script's public scan(). Server "now" is fixed so the
		// assertions do not depend on the clock.
		const run = (steps: { tick: boolean; start: string; end: string }) => page.evaluate(st => {
			let host = document.getElementById('ep-test-dated');
			if (!host) {
				host = document.createElement('div');
				host.id = 'ep-test-dated';
				host.innerHTML =
					'<input type="checkbox" id="EP_Test-show-enabled">'
					+ '<input type="date" id="EP_Test-from"><input type="datetime-local" id="EP_Test-until">'
					+ '<span class="ep-status-tag" data-ep-status=\'' + JSON.stringify({
						field: 'EP_Test-show', option: 'enabled', start: 'EP_Test-from', end: 'EP_Test-until', dated: true,
						now: '2026-09-25T12:00', saved: 'off',
						text: { on: 'On', off: 'Off', live: 'Showing now', scheduled: 'Scheduled', ended: 'Ended', unsaved: 'Not saved yet: press Save Settings to apply' },
					}).replace(/'/g, '&#39;') + '\'></span>';
				document.querySelector('form.pm-options-form')!.appendChild(host);
				(window as any).epSuiteStatusTag.scan();
			}
			const cb = document.getElementById('EP_Test-show-enabled') as HTMLInputElement;
			(document.getElementById('EP_Test-from') as HTMLInputElement).value = st.start;
			(document.getElementById('EP_Test-until') as HTMLInputElement).value = st.end;
			cb.checked = st.tick;
			cb.dispatchEvent(new Event('change', { bubbles: true }));
			const t = host.querySelector('.ep-status-tag')!;
			return t.textContent + '|' + (t.className.match(/--(on|off|live|scheduled|ended)\b/) || [])[1];
		}, steps);

		expect(await run({ tick: false, start: '2026-10-01', end: '' }), 'unticked').toBe('Off|off');
		expect(await run({ tick: true, start: '2026-10-01', end: '' }), 'start ahead').toBe('Scheduled|scheduled');
		expect(await run({ tick: true, start: '2026-09-25', end: '' }), 'starts today (00:00)').toBe('Showing now|live');
		expect(await run({ tick: true, start: '', end: '2026-09-25T12:00' }), 'ends this minute').toBe('Showing now|live');
		expect(await run({ tick: true, start: '', end: '2026-09-25T11:59' }), 'ended a minute ago').toBe('Ended|ended');
		expect(await run({ tick: true, start: '2026-09-01', end: '2026-09-25' }), 'bare end date runs to 23:59').toBe('Showing now|live');
		expect(await run({ tick: true, start: '', end: '' }), 'dated group, no dates set').toBe('Showing now|live');
		expect(errors, 'no page errors').toEqual([]);
	});

	test('narrow screen: tag stays on the header row', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 900 });
		await adminLogin(page);
		await openSettings(page, 'EP_Newsletter');
		const g = await page.locator('#group-group-forms > label').evaluate(l => {
			const t = l.querySelector('.ep-status-tag')!.getBoundingClientRect();
			const lr = l.getBoundingClientRect();
			return { inside: t.left >= lr.left && t.right <= lr.right, oneLine: t.height < 30, overflow: document.documentElement.scrollWidth - window.innerWidth };
		});
		expect(g.inside, 'tag inside the header box').toBe(true);
		expect(g.oneLine, 'tag text on one line').toBe(true);
		await page.locator('#group-group-forms > label').screenshot({ path: `${SHOTS}/status-tag-narrow.png` });
	});
});
