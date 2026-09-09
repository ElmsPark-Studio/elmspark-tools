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

// EP Finance settings via the POST-only route
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1500);
const form=p.locator('form:has(input[type=hidden][name="plugin"][value="EP_Finance"])').first();
check('EP Finance has a Settings form', await form.count()>0);
await form.locator('button:has-text("Settings")').first().click();
await p.waitForLoadState('load'); await p.waitForTimeout(3000);

const body=await p.locator('body').innerText();
check('EP Finance settings screen reached', /EP Finance/i.test(body));
// The version is NOT printed on a plugin's settings screen; it is on the Manage
// Plugins row. Assert it where it actually lives rather than where I assumed.
const verRow = await p.evaluate(async () => null);   // placeholder, checked separately below

// the new settings field
// PM namespaces every settings field as <Class>[<key>], so the bare key never matches.
const dateField=p.locator('input[name="EP_Finance[closing_date]"]').first();
check('"Book closed up to and including" field exists', await dateField.count()>0,
  await dateField.count()>0 ? await dateField.getAttribute('name') : 'not found');
check('it is a text field', (await dateField.getAttribute('type'))==='text');
check('the section explains what it does', /closed up to and including/i.test(body));
check('it states the default is unlocked', /Leave it empty and nothing is locked/i.test(body));

// the password UI
const wrap=p.locator('.ep-fin-closing-pw');
check('closing-password UI rendered', await wrap.count()>0);
check('it says no password is set yet', /No override password is set/i.test(body),
  (body.match(/(No override password is set|An override password is set)/)||['none'])[0]);
const setBtn=p.locator('#ep-fin-set-closing-pw');
check('"Set password" button present', await setBtn.count()>0);
check('the input is type=password', (await p.locator('#ep-fin-closing-pw').getAttribute('type'))==='password');

// too-short password must be refused by the server
await p.locator('#ep-fin-closing-pw').fill('short');
let rp=p.waitForResponse(r=>r.request().method()==='POST',{timeout:25000}).catch(()=>null);
await setBtn.click(); let resp=await rp; await p.waitForTimeout(1200);
let jb=null; try{ jb=JSON.parse(await resp.text()); }catch{}
check('a too-short password is refused server-side', jb && jb.success===false && jb.reason==='too_short',
  jb?`${jb.reason}`:'no json');

// a real password is accepted and the state text flips
await p.locator('#ep-fin-closing-pw').fill('a-real-override-password');
rp=p.waitForResponse(r=>r.request().method()==='POST',{timeout:25000}).catch(()=>null);
await p.locator('#ep-fin-set-closing-pw').click(); resp=await rp; await p.waitForTimeout(1500);
jb=null; try{ jb=JSON.parse(await resp.text()); }catch{}
check('setting a password returns success', jb && jb.success===true, jb?String(jb.success):'no json');
check('the response never echoes the password back', jb && !JSON.stringify(jb).includes('a-real-override-password'));
const after=await p.locator('body').innerText();
check('the panel now says a password IS set', /An override password is set/i.test(after),
  (after.match(/(No override password is set|An override password is set)/)||['none'])[0]);
check('a Remove button appeared', await p.locator('#ep-fin-clear-closing-pw').count()>0);

// clean up: put dev11b back as found
rp=p.waitForResponse(r=>r.request().method()==='POST',{timeout:25000}).catch(()=>null);
await p.locator('#ep-fin-clear-closing-pw').click(); resp=await rp; await p.waitForTimeout(1500);
jb=null; try{ jb=JSON.parse(await resp.text()); }catch{}
check('removing the password works (dev11b left as found)', jb && jb.success===true);
const final=await p.locator('body').innerText();
check('panel back to "no override password"', /No override password is set/i.test(final));

// Version, asserted from the Manage Plugins row where PM actually renders it.
await p.goto(BASE+'/admin/plugins/',{waitUntil:'load'}); await p.waitForTimeout(1200);
await p.locator('button:has-text("Manage Plugins")').first().click(); await p.waitForTimeout(2500);
const rowTxt = await p.evaluate(() => {
  const i = document.querySelector('input[name="plugins[EP_Finance]"]');
  if (!i) return null;
  const row = i.closest('tr,li') || i.parentElement;
  return (row.textContent||'').replace(/\s+/g,' ').trim();
});
const seen = rowTxt && (rowTxt.match(/\bv(\d+\.\d+\.\d+[a-z]*)/)||[])[1];
check('the installed plugin really is v0.4.0', seen==='0.4.0', seen?('row says v'+seen):'row not found');

check('no uncaught JS errors', errs.length===0, errs.slice(0,2).join(' | '));
await p.screenshot({path:'/tmp/epfin-closing.png',fullPage:true});
console.log('\nscreenshot: /tmp/epfin-closing.png');
console.log(fail?`\nFAILED: ${fail} check(s)`:'\nALL CHECKS PASSED');
await b.close(); process.exit(fail?1:0);
