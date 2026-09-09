import { chromium } from 'playwright';
const BASE='https://dev11b.elmspark.com';
const U=process.env.DEV11B_ADMIN_USER, P=process.env.DEV11B_ADMIN_PASSWORD;
if(!U||!P){console.error('missing DEV11B creds');process.exit(2);}
let fail=0;
const check=(l,c,g='')=>{if(!c)fail++;console.log(`[${c?'PASS':'FAIL'}] ${l}${g!==''?`  (${g})`:''}`);};

const FAMILY=[['EP_Finance','0.6.0'],['EP_Finance_Invoicing','0.2.0'],
              ['EP_Finance_Tax_UK','0.1.6'],['EP_Finance_Tax_IE','0.1.4'],['EP_Finance_Tax_US','0.1.4']];

const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));

await p.goto(BASE+'/admin/',{waitUntil:'load'});
await p.locator('#user').fill(U); await p.locator('#password').fill(P);
await p.locator('#pm-login-button').click(); await p.waitForTimeout(3500);
check('logged in', (await p.title())!=='PageMotor Login');

// activate + assert each version from its own row
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1200);
await p.locator('button:has-text("Manage Plugins")').first().click(); await p.waitForTimeout(3000);
for (const [cls,ver] of FAMILY) {
  const rowTxt = await p.evaluate((c)=>{const i=document.querySelector(`input[name="plugins[${c}]"]`);
    if(!i) return null; const r=i.closest('tr,li')||i.parentElement; return (r.textContent||'').replace(/\s+/g,' ').trim();}, cls);
  const seen = rowTxt && (rowTxt.match(/\bv(\d+\.\d+\.\d+[a-z]*)/)||[])[1];
  check(`${cls} row advertises exactly v${ver}`, seen===ver, seen?('v'+seen):'row not found');
  const cb=p.locator(`input[name="plugins[${cls}]"]`).first();
  if (await cb.count() && !(await cb.isChecked())) await cb.check();
}
await p.locator('button:has-text("Save Plugins")').first().click();
await p.waitForLoadState('load'); await p.waitForTimeout(5000);
const checked = await p.evaluate(()=>Object.fromEntries(
  [...document.querySelectorAll('input[type=checkbox]')].filter(i=>/^plugins\[EP_Finance/.test(i.name))
   .map(i=>[i.name.replace(/plugins\[|\]/g,''), i.checked])));
check('all five activated and persisted', FAMILY.every(([c])=>checked[c]===true), JSON.stringify(checked));

// every settings screen renders without fataling
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1500);
for (const [cls] of FAMILY) {
  const form=p.locator(`form:has(input[type=hidden][name="plugin"][value="${cls}"])`).first();
  if (!(await form.count())) { check(`${cls} settings form exists`, false); continue; }
  await form.locator('button:has-text("Settings")').first().click();
  await p.waitForLoadState('load'); await p.waitForTimeout(1600);
  const t=await p.locator('body').innerText();
  const bad=/Fatal error|Uncaught|Parse error|Warning:|Deprecated:/i.test(t);
  check(`${cls} settings screen renders clean`, !bad,
    bad ? (t.match(/(Fatal error|Uncaught|Parse error|Warning:|Deprecated:)[^\n]{0,80}/)||[''])[0] : 'clean');
  await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(800);
}

// Land on EP Finance's OWN settings page before firing its AJAX: the CSRF token
// on /admin/plugins/ belongs to that page, not to a plugin's action, so running
// the fetch from the list is an invalid-token failure of the test's own making.
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1200);
await p.locator('form:has(input[type=hidden][name="plugin"][value="EP_Finance"]) button:has-text("Settings")').first().click();
await p.waitForLoadState('load'); await p.waitForTimeout(2500);

const mig = await p.evaluate(async () => {
  const fd=new FormData(); fd.append('pm_ajax','EP_Finance'); fd.append('action','run-audit');
  fd.append('data[action]','run-audit');
  const tok=document.querySelector('input[name="ep_csrf_token"]');
  if(tok){fd.append('ep_csrf_token',tok.value);fd.append('data[ep_csrf_token]',tok.value);}
  const r=await fetch(window.location.href,{method:'POST',body:fd,credentials:'same-origin'});
  const t=await r.text(); try{return JSON.parse(t);}catch(e){return {raw:t.slice(0,150)};}
});
check('an EP Finance admin action still succeeds after the upgrade', mig && mig.success===true,
  mig && mig.audit ? ('audit clean='+mig.audit.clean) : JSON.stringify(mig).slice(0,90));

check('no uncaught JS errors', errs.length===0, errs.slice(0,2).join(' | '));
console.log(fail?`\nFAILED: ${fail} check(s)`:'\nALL CHECKS PASSED');
await b.close(); process.exit(fail?1:0);
