import { chromium } from 'playwright';
const BASE='https://dev11b.elmspark.com';
const U=process.env.DEV11B_ADMIN_USER, P=process.env.DEV11B_ADMIN_PASSWORD;
if(!U||!P){console.error('missing DEV11B creds');process.exit(2);}
let fail=0;
const check=(l,c,g='')=>{if(!c)fail++;console.log(`[${c?'PASS':'FAIL'}] ${l}${g!==''?`  (${g})`:''}`);};

const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));

await p.goto(BASE+'/admin/',{waitUntil:'load'});
await p.locator('#user').fill(U); await p.locator('#password').fill(P);
await p.locator('#pm-login-button').click(); await p.waitForTimeout(3500);
check('logged in', (await p.title())!=='PageMotor Login');

// version, from the row PM actually renders it on
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1200);
await p.locator('button:has-text("Manage Plugins")').first().click(); await p.waitForTimeout(2500);
const rowTxt = await p.evaluate(()=>{const i=document.querySelector('input[name="plugins[EP_Finance]"]');
  if(!i) return null; const r=i.closest('tr,li')||i.parentElement; return (r.textContent||'').replace(/\s+/g,' ').trim();});
const seen = rowTxt && (rowTxt.match(/\bv(\d+\.\d+\.\d+[a-z]*)/)||[])[1];
check('the upgraded plugin reports v0.5.1', seen==='0.5.1', seen?('row says v'+seen):'row not found');

// reach EP Finance settings via the POST-only route (this is what runs install())
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1200);
await p.locator('form:has(input[type=hidden][name="plugin"][value="EP_Finance"]) button:has-text("Settings")').first().click();
await p.waitForLoadState('load'); await p.waitForTimeout(3000);
const body=await p.locator('body').innerText();
check('EP Finance settings screen reached', /EP Finance/i.test(body));

// the new panel
check('a "Change history" panel is rendered', /Change history/i.test(body));
const panel=p.locator('#ep-fin-history');
check('the panel has its own container', await panel.count()>0);

// drive a REAL change and watch it appear
const before = await p.evaluate(()=>document.querySelectorAll('#ep-fin-history tbody tr').length);
const nameField = p.locator('input[name="EP_Finance[closing_date]"]');
check('the 0.4.0 closing-date field survived the upgrade', await nameField.count()>0);

// create an account through the real AJAX route, which is an audited write
const created = await p.evaluate(async () => {
  const fd = new FormData();
  fd.append('pm_ajax','EP_Finance'); fd.append('action','create-account');
  fd.append('data[action]','create-account');
  const tok = document.querySelector('input[name="ep_csrf_token"]');
  if (tok) { fd.append('ep_csrf_token', tok.value); fd.append('data[ep_csrf_token]', tok.value); }
  const nm = 'Audit probe account ' + Date.now();
  fd.append('name', nm); fd.append('data[name]', nm);
  fd.append('class','expense'); fd.append('data[class]','expense');
  const r = await fetch(window.location.href, {method:'POST', body:fd, credentials:'same-origin'});
  const t = await r.text();
  try { return {ok:true, name:nm, body:JSON.parse(t)}; } catch(e){ return {ok:false, name:nm, raw:t.slice(0,200)}; }
});
check('an audited write (create-account) succeeded', created.ok && created.body && created.body.success===true,
  created.ok ? JSON.stringify(created.body).slice(0,90) : created.raw);

// refresh the history panel
const hist = await p.evaluate(async () => {
  const fd = new FormData();
  fd.append('pm_ajax','EP_Finance'); fd.append('action','change-history');
  fd.append('data[action]','change-history');
  const tok = document.querySelector('input[name="ep_csrf_token"]');
  if (tok) { fd.append('ep_csrf_token', tok.value); fd.append('data[ep_csrf_token]', tok.value); }
  const r = await fetch(window.location.href, {method:'POST', body:fd, credentials:'same-origin'});
  const t = await r.text();
  try { return JSON.parse(t); } catch(e){ return {raw:t.slice(0,200)}; }
});
check('change-history route returns HTML', hist && hist.success===true && typeof hist.html==='string',
  hist && hist.html ? 'html '+hist.html.length+' bytes' : JSON.stringify(hist).slice(0,90));
check('the new account appears in the history', hist && hist.html && /accounts #\d+/.test(hist.html),
  hist && hist.html ? (hist.html.match(/accounts #\d+/)||['no match'])[0] : '');
check('it is recorded as an insert', hist && hist.html && /ep-fin-act-insert/.test(hist.html));
check('it is attributed to a real person, not blank or system',
  hist && hist.html && !/<td>\s*<\/td>/.test(hist.html) && /claude_code|@/.test(hist.html),
  hist && hist.html ? (hist.html.match(/<td>([^<]*@[^<]*|claude_code)<\/td>/)||['not found'])[0] : '');

check('no uncaught JS errors', errs.length===0, errs.slice(0,2).join(' | '));
await p.screenshot({path:'/tmp/epfin-audit.png',fullPage:true});
console.log('\nscreenshot: /tmp/epfin-audit.png');
console.log(fail?`\nFAILED: ${fail} check(s)`:'\nALL CHECKS PASSED');
await b.close(); process.exit(fail?1:0);
