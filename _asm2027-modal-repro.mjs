import { chromium } from 'playwright';
const URL = process.env.URL || 'https://asm.anzca.edu.au/speakers/';
const OUT = process.env.OUT || '.';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(URL, { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
// pick the trigger whose modal has the most text
const pick = await p.evaluate(() => {
  const trig = [...document.querySelectorAll('[data-hs-overlay^="#hs-scroll"]')].filter(t => t.getAttribute('aria-haspopup'));
  let best = null, max = -1;
  for (const t of trig) { const m = document.querySelector(t.dataset.hsOverlay); const n = (m?.innerText || '').length; if (n > max) { max = n; best = t.dataset.hsOverlay; } }
  return { count: trig.length, best, max };
});
console.log('triggers', pick);
await p.click(`[data-hs-overlay="${pick.best}"][aria-haspopup]`);
await p.waitForTimeout(900);
const r = await p.evaluate((sel) => {
  const ov = document.querySelector(sel);
  const cs = getComputedStyle(ov);
  const rect = ov.getBoundingClientRect();
  const panel = ov.querySelector('.bg-white');
  const prect = panel.getBoundingClientRect();
  const at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? (e.tagName + '.' + [...e.classList].slice(0,3).join('.')) : null; };
  return {
    htmlClass: document.documentElement.className, bodyClass: document.body.className.slice(0,120),
    bodyOverflow: getComputedStyle(document.body).overflow, bodyPos: getComputedStyle(document.body).position,
    ovClass: ov.className.slice(0, 80), ovPos: cs.position, ovOverflowY: cs.overflowY, ovZ: cs.zIndex,
    ovRect: [rect.x, rect.y, rect.width, rect.height].map(Math.round), ovScroll: [ov.scrollHeight, ov.clientHeight],
    panelRect: [prect.y, prect.height].map(Math.round), panelMaxH: getComputedStyle(panel).maxHeight,
    content: (()=>{ const c = panel.querySelector('.overflow-y-auto'); const s = getComputedStyle(c); return { h: c.clientHeight, sh: c.scrollHeight, maxH: s.maxHeight, ovY: s.overflowY }; })(),
    topPoint: at(720, 40), bottomPoint: at(720, 880), midPoint: at(720, 450),
    innerH: innerHeight, docScrollY: scrollY,
    stacking: (()=>{ let e = ov.parentElement, out = []; while (e && e !== document.body) { const s = getComputedStyle(e); if (s.position !== 'static' && s.zIndex !== 'auto' || s.transform !== 'none' || s.filter !== 'none' || s.contain !== 'none') out.push(e.tagName + '#' + e.id + ' pos=' + s.position + ' z=' + s.zIndex + ' tf=' + s.transform + ' ov=' + s.overflow); e = e.parentElement; } return out; })(),
  };
}, pick.best);
console.log(JSON.stringify(r, null, 1));
await p.screenshot({ path: OUT + '/live-modal-open.png' });
// try to scroll the overlay with the wheel over the panel
await p.mouse.move(720, 450); await p.mouse.wheel(0, 600); await p.waitForTimeout(400);
const after = await p.evaluate((sel) => { const ov = document.querySelector(sel); const c = ov.querySelector('.overflow-y-auto'); return { ovScrollTop: ov.scrollTop, contentScrollTop: c.scrollTop, winY: scrollY }; }, pick.best);
console.log('after wheel', JSON.stringify(after));
await p.screenshot({ path: OUT + '/live-modal-wheel.png' });
await b.close();
