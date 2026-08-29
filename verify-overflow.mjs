#!/usr/bin/env node
/*
	verify-overflow.mjs — the per-element overflow/clipping gate for HTML deliverables.

		node verify-overflow.mjs <file-or-url> [more files/urls...]
		node verify-overflow.mjs guide.html --width=375,1280
		node verify-overflow.mjs guide.html --allow=".map,.diagram"

	Sweeping a whole hub: cd to the content root and pass RELATIVE paths through a zsh
	array. Do not interpolate a `$(find ...)` of absolute paths, because zsh word-splits
	command substitution on IFS and every path under "Claude Workspace" breaks at the
	space, giving 79 confident "no such file" errors that look like a real result.

		cd "…/guides-elmspark-com/site"
		files=( index.html <star><slash>index.html )   # literally: asterisk, then slash
		node ~/Developer/elmspark/tools/playwright-tests/verify-overflow.mjs "${files[@]}" --width=375,1280

	The glob is spelled out in words above because writing it literally would close
	this comment block on its own asterisk-slash, which is exactly how this file got
	a syntax error the first time round.

	WHY THIS EXISTS. The old gate checked `documentElement.scrollWidth > innerWidth`
	at 375px. That check PASSES on a page that is losing content, because any
	ancestor with `overflow:hidden` absorbs the overflow instead of causing page
	scroll. Caught 2026-08-15 on pm-licence-business-model: a 408px table inside a
	293px slot under the house `details{overflow:hidden}` rule. The page-level check
	reported clean while ~115px of the most important column was invisible on a
	phone. See memory guide_gate_overflow_check_misses_clipped_tables.

	So this measures per element, three ways:

		A. viewport   — the element's box extends past the viewport edge
		B. container  — the element's box extends past its parent's CONTENT box
		C. self       — the element's own scrollWidth exceeds its clientWidth

	B is the one that catches silent clipping, and it is the check the page-level
	gate can never make. C catches an element that is internally truncated.

	C skips DELIBERATE single-line ellipsis (text-overflow:ellipsis + nowrap), because
	that truncation is intentional and visibly signalled to the reader. It skips it only
	for text: an element child too wide for an ellipsis box is genuinely cut off with no
	ellipsis rendered, so that still reports. Added 2026-08-29 after 8 of 33 public
	guides failed solely on the breadcrumb's own ellipsis.

	A deliberate scroll container is not a defect. Walking up from an offender, if
	we reach an ancestor whose computed overflow-x is auto or scroll BEFORE we reach
	one that is hidden or clip, the content is reachable and we say nothing. That
	makes the house `.scroll{overflow-x:auto}` wrapper pass automatically, without
	hardcoding the class name.

	Only the OUTERMOST offender is reported. A 408px table inside a 293px slot makes
	every cell in it technically wide too; printing forty descendants buries the one
	element you have to wrap.

	Exit code 0 = clean at every width. Exit 1 = findings. Exit 2 = could not load.

	The measurement predicates B and C are adapted from Prompt Advisers' Bench Studio
	(MIT, server/pdf_preflight.mjs). Its own runner uses `chrome --dump-dom`, which
	silently ignores --window-size and always measures at ~500px wide, so the
	viewport control here is Playwright rather than a lift of theirs. Their element
	selector also omitted `table` itself, which is the exact shape of the bug above.
*/
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
	args.filter((a) => a.startsWith('--')).map((a) => {
		const [k, ...v] = a.replace(/^--/, '').split('=');
		return [k, v.join('=') || true];
	}),
);
const targets = args.filter((a) => !a.startsWith('--'));

if (!targets.length) {
	console.error('usage: node verify-overflow.mjs <file-or-url> [...] [--width=375,1280] [--allow=sel,sel]');
	process.exit(2);
}

const widths = String(flags.width ?? '375')
	.split(',')
	.map((w) => Number(w.trim()))
	.filter((w) => Number.isFinite(w) && w > 0);
const allow = String(flags.allow ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const toUrl = (t) => {
	if (/^https?:\/\//i.test(t)) return t;
	const abs = resolvePath(t);
	if (!existsSync(abs)) throw new Error(`no such file: ${t}`);
	return pathToFileURL(abs).href;
};

/*
	Runs in the page. Kept as one self-contained function because it is serialised
	across the CDP boundary and cannot close over anything from this file.
*/
function probe(allowSelectors) {
	const SLACK = 2;          // sub-pixel layout noise
	const SELF_SLACK = 4;     // scrollWidth rounds up on some fonts

	const isAllowed = (el) => allowSelectors.some((s) => {
		try { return el.closest(s); } catch { return false; }
	});

	/*
		Reachable = a scrollable ancestor is found before a genuinely CLIPPING one.

		"overflow:hidden" alone does not mean an element clips. Several guides set
		table{overflow:hidden} purely so border-radius rounds the corners; such a table
		is exactly as wide as its rows and cuts nothing. Treating it as a wall made the
		walk stop one level too early and report every thead/tbody inside a perfectly
		good .scroller as clipped, on five guides. So a hidden ancestor only blocks when
		its own content actually overflows it.
	*/
	const isReachable = (el) => {
		for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
			const ox = getComputedStyle(p).overflowX;
			if (ox === 'auto' || ox === 'scroll') return true;
			if ((ox === 'hidden' || ox === 'clip') && p.scrollWidth > p.clientWidth + SELF_SLACK) return false;
		}
		return false;
	};

	/*
		Does anything above this element actually cut content off? A box that sticks out
		of its parent is only a DEFECT if the overhang is eventually clipped, or if it
		leaves the viewport. bunny-dns-vs-cloudflare has a "/200" span overhanging its
		display-font parent by 3px with every ancestor at overflow:visible and the whole
		thing 200px inside the viewport: nothing is lost, and reporting it is noise that
		trains you to ignore the gate.
	*/
	const isClippedAbove = (el) => {
		for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
			const ox = getComputedStyle(p).overflowX;
			if ((ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll')
				&& p.scrollWidth > p.clientWidth + SELF_SLACK) return true;
		}
		return false;
	};

	const offenders = [];
	for (const el of document.querySelectorAll('body *')) {
		/*
			Skip the inside of an SVG. scrollWidth/clientWidth are not meaningful box
			metrics on SVG children, and an SVG child's rect compared against its
			parent's "content box" is comparing two different coordinate systems.
			Measured on anzca-plan-restructure: a <text> reporting sw 211 / cw 211 /
			rect 203, which produced a confident phantom finding. The <svg> element
			itself is a normal replaced box and IS still checked.
		*/
		if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;

		const style = getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
		if (style.position === 'fixed' || style.position === 'absolute') continue;
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		if (isAllowed(el)) continue;

		const reasons = [];

		// A. past the viewport edge
		if (rect.right > innerWidth + 1) reasons.push(`viewport +${Math.round(rect.right - innerWidth)}px`);
		if (rect.left < -1) reasons.push(`viewport ${Math.round(rect.left)}px left`);

		// B. past the parent's CONTENT box — the silent-clipping check
		const parent = el.parentElement;
		if (parent && parent !== document.body) {
			const pr = parent.getBoundingClientRect();
			const ps = getComputedStyle(parent);
			const inLeft = pr.left + parseFloat(ps.paddingLeft || 0) + parseFloat(ps.borderLeftWidth || 0);
			const inRight = pr.right - parseFloat(ps.paddingRight || 0) - parseFloat(ps.borderRightWidth || 0);
			const avail = Math.round(inRight - inLeft);
			/*
				A negative margin is a deliberate full-bleed, not a defect. k3-wargamer's
				sticky pill nav uses margin:0 -20px to run edge to edge, so it is exactly
				20px past its parent's content box BY DESIGN and reads as a finding
				forever unless the bleed is credited back. Allow the breach up to the
				negative margin, and keep flagging anything beyond it.
			*/
			const bleed = Math.max(0, -parseFloat(style.marginRight || 0));
			const atRisk = rect.right > innerWidth + 1 || isClippedAbove(el);
			if (atRisk && avail > 0 && rect.right > inRight + SLACK + bleed) {
				/*
					An element can breach its container by being too wide OR by fitting
					and sitting too far right. Saying "763px in a 763px slot" for the
					second case reads as a rounding artefact when it is really an 8px
					offset, so name which one it is.
				*/
				const over = Math.round(rect.right - inRight);
				reasons.push(Math.round(rect.width) > avail
					? `container ${Math.round(rect.width)}px in ${avail}px slot, ${over}px past the edge`
					: `container fits (${Math.round(rect.width)}px in ${avail}px) but sits ${over}px past the right edge`);
			}
		}

		/*
			C. internally truncated. Skipped when the element scrolls itself: a
			`.scroll{overflow-x:auto}` wrapper is SUPPOSED to have scrollWidth >
			clientWidth. That is the fix, not the defect, and reporting it turns
			the gate into an infinite loop.
		*/
		/*
			Only a container that actually CLIPS can lose content this way. With
			overflow-x:visible, scrollWidth exceeding clientWidth just means a child is
			bleeding out of it in full view, which is how every full-bleed nav and pulled
			margin works; nothing is hidden, and a child that truly leaves the viewport is
			still caught by check A. Restricting this to hidden/clip is what stops the
			gate reporting the wrapper of every deliberate bleed.
		*/
		const clipsSelf = style.overflowX === 'hidden' || style.overflowX === 'clip';
		if (clipsSelf && el.scrollWidth > el.clientWidth + SELF_SLACK && el.clientWidth > 0) {
			// Name the widest child that explains it, so the finding is actionable.
			let widest = null;
			for (const kid of el.children) {
				const kr = kid.getBoundingClientRect();
				if (kr.width > el.clientWidth + SLACK && (!widest || kr.width > widest.w)) {
					widest = { tag: kid.tagName.toLowerCase(), w: Math.round(kr.width) };
				}
			}
			/*
				Deliberate single-line ellipsis is not a defect. The breadcrumb idiom
				`overflow:hidden; text-overflow:ellipsis; white-space:nowrap` truncates
				a long title ON PURPOSE and SHOWS the reader it has done so. Reporting
				it made 8 of the 33 documentation.elmspark.com guides fail forever on a
				finding nobody would ever action, which is how a gate gets ignored.

				Two conditions, both required, because text-overflow only actually
				ellipsises when the line cannot wrap:
				  - computed text-overflow is ellipsis
				  - the line is held on one line (nowrap / pre)

				And crucially it is skipped ONLY for text overflow. text-overflow
				cannot ellipsise an ELEMENT child: a wide table inside an
				ellipsis box is cut off silently with no ellipsis rendered, which is
				a real defect and exactly the bug this tool exists for. So if we found
				a `widest` element child, the skip does not apply.
				Fixtures: fixtures/overflow/ellipsis-benign.html (must pass) vs
				ellipsis-hiding-element.html (must fail).
			*/
			const ellipsisTruncation =
				style.textOverflow === 'ellipsis'
				&& (style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre')
				&& !widest;

			if (!ellipsisTruncation) {
				reasons.push(
					`self ${el.scrollWidth}px content in ${el.clientWidth}px box`
					+ (widest ? ` (widest child: ${widest.tag} at ${widest.w}px)` : ''),
				);
			}
		}

		if (!reasons.length) continue;
		if (isReachable(el)) continue;   // sits in a real scroll container

		// getAttribute, not .className: on an SVG element className is an
		// SVGAnimatedString and stringifies to "[object SVGAnimatedString]".
		const cls = (el.getAttribute('class') || '').trim().replace(/\s+/g, '.');
		offenders.push({
			el,
			label: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : ''),
			text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
			reasons,
			viewportOnly: reasons.every((r) => r.startsWith('viewport')),
		});
	}

	/*
		Suppress viewport-only cascades: one wide element pushes every wrapper
		above it past the viewport edge too, and printing the whole chain buries
		the element you actually have to wrap. Container and self findings are
		always kept, because "this clips" and "this is too wide for its slot" are
		two different jobs and both need doing.
	*/
	const set = new Set(offenders.map((o) => o.el));
	return offenders
		.filter((o) => {
			if (!o.viewportOnly) return true;
			for (let p = o.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
			return true;
		})
		.map(({ label, text, reasons }) => ({ label, text, reasons }));
}

const browser = await chromium.launch();
let failed = 0;
let loadErrors = 0;

for (const target of targets) {
	let url;
	try {
		url = toUrl(target);
	} catch (e) {
		console.log(`\n${target}\n  LOAD FAIL  ${e.message}`);
		loadErrors++;
		continue;
	}
	console.log(`\n${target}`);

	for (const width of widths) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		try {
			const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
			if (res && !res.ok() && /^https?:/i.test(url)) {
				console.log(`  ${width}px  LOAD FAIL  HTTP ${res.status()}`);
				loadErrors++;
				await page.close();
				continue;
			}
			const findings = await page.evaluate(probe, allow);
			if (!findings.length) {
				console.log(`  ${width}px  ok`);
			} else {
				failed++;
				console.log(`  ${width}px  ${findings.length} clipped or overflowing element${findings.length > 1 ? 's' : ''}`);
				for (const f of findings) {
					console.log(`      ${f.label}`);
					console.log(`        ${f.reasons.join(' | ')}`);
					if (f.text) console.log(`        "${f.text}"`);
				}
			}
		} catch (e) {
			console.log(`  ${width}px  LOAD FAIL  ${e.message.split('\n')[0]}`);
			loadErrors++;
		}
		await page.close();
	}
}

await browser.close();

console.log(
	failed || loadErrors
		? `\nFAIL — ${failed} width-check${failed === 1 ? '' : 's'} with findings${loadErrors ? `, ${loadErrors} load error${loadErrors === 1 ? '' : 's'}` : ''}.\nWrap wide content in .scroll{overflow-x:auto} and re-run. Do not assume the fix; re-run this.`
		: `\nPASS — nothing clipped or overflowing at ${widths.join('px, ')}px.`,
);
process.exit(failed || loadErrors ? 1 : 0);
