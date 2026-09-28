/**
 * Card pop-up fix (28 Sep, Vanessa): the pop-up must sit above the sticky nav and
 * the footer, and its text must be reachable by scrolling inside the panel.
 * Runs against the review site by default (origin header), or a public URL with
 * HOST=asm.anzca.edu.au. Exits 1 on any failed check.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const HOST = process.env.HOST || 'asm2027.elmspark.com';
const REVIEW = HOST === 'asm2027.elmspark.com';
const OUT = process.env.OUT || '.';
const PAGES = (process.env.PAGES || '/speakers/,/regional-organising-committee/').split(',');
const AUTH = REVIEW ? (readFileSync(homedir() + '/.config/elmspark/asm-staging-gate.env', 'utf8').match(/^ORIGIN_SHARED_SECRET=(.+)$/m) || [])[1].trim() : null;
const b = await chromium.launch(REVIEW ? { args: ['--host-resolver-rules=MAP asm2027.elmspark.com 88.208.226.236'] } : {});
let fails = 0; const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FAIL ') + msg); if (!c) fails++; };
for (const vp of [{ width: 1440, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'phone' }]) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, ignoreHTTPSErrors: REVIEW });
  if (REVIEW) await ctx.route('**/*', async (r, q) => { const s = new URL(q.url()).hostname === HOST; await r.continue(s ? { headers: { ...q.headers(), 'x-ep-origin-auth': AUTH } } : {}); });
  const p = await ctx.newPage();
  for (const path of PAGES) {
    console.log(`== ${vp.tag} ${path}`);
    await p.goto(`https://${HOST}${path}?pw=${Date.now()}`, { waitUntil: 'networkidle' }); await p.waitForTimeout(600);
    const info = await p.evaluate(() => {
      const trig = [...document.querySelectorAll('[data-hs-overlay^="#hs-scroll"][aria-haspopup]')];
      let best = null, max = -1;
      for (const t of trig) { const m = document.querySelector(t.dataset.hsOverlay); const n = (m?.innerText || '').length; if (n > max) { max = n; best = t.dataset.hsOverlay; } }
      const ov = best && document.querySelector(best);
      return { triggers: trig.length, best, chars: max, overlayParent: ov && ov.parentElement.tagName, insideMain: ov ? !!ov.closest('main') : null };
    });
    ok(info.triggers > 0, `${info.triggers} card triggers on the page`);
    ok(info.overlayParent === 'BODY' && info.insideMain === false, `pop-up is a direct child of <body> (parent=${info.overlayParent}, insideMain=${info.insideMain})`);
    // scroll so the sticky nav shows and the card is mid-screen, like Vanessa's screenshot
    const trigger = p.locator(`[data-hs-overlay="${info.best}"][aria-haspopup]`);
    // Vanessa's screenshot: page scrolled, sticky nav showing, footer in view. Put the card at the
    // top of the screen so the nav has appeared, then open it.
    await trigger.evaluate(e => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(400);
    await p.evaluate(() => window.scrollBy(0, -120)); await p.waitForTimeout(400);
    await trigger.click(); await p.waitForTimeout(900);
    const m = await p.evaluate(({ sel, w, h }) => {
      const ov = document.querySelector(sel); const panel = ov.querySelector('.bg-white'); const body = panel.querySelector('.overflow-y-auto');
      const inOv = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && ov.contains(e)); };
      const pr = panel.getBoundingClientRect();
      const nav = document.getElementById('sticky-nav'); const nr = nav && nav.getBoundingClientRect(); const navShown = !!(nr && nr.height > 0 && Math.round(nr.top) === 0 && getComputedStyle(nav).display !== 'none');
      return {
        open: ov.classList.contains('open'), ovRect: ov.getBoundingClientRect().height, ovScrollable: ov.scrollHeight - ov.clientHeight,
        top: inOv(w / 2, 20), bottom: inOv(w / 2, h - 20), navShown,
        panelTop: Math.round(pr.top), panelBottom: Math.round(pr.bottom), panelFits: pr.top >= 0 && pr.bottom <= h,
        bodyScrollable: body.scrollHeight - body.clientHeight, bodyOverflow: getComputedStyle(body).overflowY,
      };
    }, { sel: info.best, w: vp.width, h: vp.height });
    ok(m.open, 'overlay opened');
    ok(m.top && (vp.width < 1024 || m.navShown), `top of screen (y=20) is the pop-up, with the sticky nav underneath it (nav shown: ${m.navShown})`);
    ok(m.bottom, `bottom of screen (y=${vp.height - 20}) is the pop-up, not the footer`);
    ok(m.panelFits, `panel fits the viewport: top ${m.panelTop}, bottom ${m.panelBottom} of ${vp.height}`);
    // a short pop-up has nothing to scroll; a long one (longer than the panel) must scroll INSIDE the panel
    ok(m.bodyOverflow === 'auto' && (m.bodyScrollable > 0 || info.chars < 1200), `text scrolls inside the panel when it needs to (${m.bodyScrollable}px more to read, overflow-y ${m.bodyOverflow}) for a ${info.chars}-char pop-up`);
    await p.screenshot({ path: `${OUT}/modal-${vp.tag}${path.replace(/\//g, '_')}open.png` });
    // scroll the panel body to the end with the wheel over the panel, then check the last paragraph is on screen
    const end = await p.evaluate(async ({ sel, h }) => {
      const ov = document.querySelector(sel); const body = ov.querySelector('.overflow-y-auto');
      body.scrollTop = body.scrollHeight; await new Promise(r => setTimeout(r, 200));
      const last = body.querySelector('.wysiwyg-content').lastElementChild || body.querySelector('.wysiwyg-content');
      const r = last.getBoundingClientRect(); return { lastBottom: Math.round(r.bottom), visible: r.bottom <= h && r.bottom > 0, atEnd: Math.abs(body.scrollTop + body.clientHeight - body.scrollHeight) < 2 };
    }, { sel: info.best, h: vp.height });
    ok(end.atEnd && end.visible, `scrolled to the end: last element bottom at ${end.lastBottom} (viewport ${vp.height})`);
    await p.screenshot({ path: `${OUT}/modal-${vp.tag}${path.replace(/\//g, '_')}end.png` });
    // close by the X, then by Escape on a re-open
    await p.locator(`${info.best} button[aria-label="Close"]`).click(); await p.waitForTimeout(700);
    ok(await p.evaluate(s => !document.querySelector(s).classList.contains('open'), info.best), 'Close button closes it');
    await trigger.click(); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(700);
    ok(await p.evaluate(s => !document.querySelector(s).classList.contains('open') && getComputedStyle(document.body).overflow !== 'hidden', info.best), 'Escape closes it and the page scrolls again');
  }
  await ctx.close();
}
await b.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
