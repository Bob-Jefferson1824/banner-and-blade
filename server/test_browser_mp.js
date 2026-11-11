/* Two real browser pages (stubbed WebGL) run the actual client code against the actual server hub.
   The Socket.IO wire is replaced by a Playwright bridge; everything else is the real code. */
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const Sim = require('../server/sim.js'); const { createHub } = require('../server/hub.js');
const hub = createHub(Sim, {}); hub.start();
const FAKE_IO = `(()=>{ const acks={}; let n=0; window.__nack=(id,r)=>{ const f=acks[id]; delete acks[id]; if(f) f(r); };
 window.io=(url,opts)=>{ const h={}; const fire=(e,d)=>(h[e]||[]).slice().forEach(f=>f(d));
  const sock={ id:window.__nid, on(e,f){(h[e]=h[e]||[]).push(f)}, once(e,f){const w=(d)=>{h[e]=h[e].filter(x=>x!==w);f(d)};this.on(e,w)}, close(){},
   emit(ev,data,ack){ let id=0; if(typeof ack==='function'){ id=++n; acks[id]=ack; } window.__nsend(ev,data,id); } };
  window.__nrecv=fire; setTimeout(()=>fire('connect'),20); return sock; }; })();`;
(async () => {
  const b = await chromium.launch(); const errs = [];
  async function mkPage(id) {
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    p.on('pageerror', e => errs.push(id + ': ' + e.message + ' | ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
    await p.route('**/*', r => { const u = r.request().url(); if (u.includes('three.min.js')) return r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('stub.js', 'utf8') }); if (u.startsWith('file:')) return r.continue(); return r.abort(); });
    await p.addInitScript('window.__nid=' + JSON.stringify(id) + ';');
    await p.addInitScript(FAKE_IO);
    let h = null;
    await p.exposeFunction('__nsend', (ev, data, ackId) => {
      if (!h) h = hub.connect(id, (e, d) => { p.evaluate(([e, d]) => window.__nrecv && window.__nrecv(e, d), [e, d]).catch(() => {}); });
      h.handle(ev, data, ackId ? (r) => { p.evaluate(([i, r]) => window.__nack(i, r), [ackId, r]).catch(() => {}); } : undefined);
    });
    p._disc = () => { if (h) h.disconnect(); };
    await p.goto('file://' + path.resolve(process.argv[2])); await p.waitForTimeout(500);
    return p;
  }
  let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
  const A = await mkPage('pgA'), B = await mkPage('pgB');
  await A.click('button[data-go=online]'); ok(await A.locator('#scr-online.active').count() === 1, 'Online Play opens from main menu');
  await A.fill('#nName', 'Alice'); await A.click('#nConnect'); await A.waitForTimeout(400);
  ok(await A.locator('#nPanel:not([hidden])').count() === 1, 'A connected, panel shown: ' + await A.locator('#nStatus').innerText());
  await A.click('#nCreate'); await A.waitForTimeout(400);
  ok(await A.locator('#scr-lobby.active').count() === 1, 'A in lobby');
  const code = (await A.locator('#lCode').innerText()).trim(); ok(code.length === 4, 'room code ' + code);
  await B.click('button[data-go=online]'); await B.fill('#nName', 'Bob'); await B.click('#nConnect'); await B.waitForTimeout(400);
  ok((await B.locator('#nRooms .prow').count()) === 1, 'B sees public room in the browser');
  await B.click('#nRooms [data-join]'); await B.waitForTimeout(400);
  ok(await B.locator('#scr-lobby.active').count() === 1 && await A.locator('#lPlayers .prow').count() === 2, 'B joined; A sees 2 players');
  ok(await B.locator('#lStart').isHidden(), 'start button host-only');
  await B.click('#lClass [data-cls=archer]'); await B.waitForTimeout(250);
  await A.click('#lCfg [data-cfg="mode|ffa"]'); await A.waitForTimeout(250);
  ok((await B.locator('#lCfg').innerText()).includes('Free for All'), 'host mode change reaches B');
  await A.click('#lCfg [data-cfg="mode|ironsquad"]'); await A.click('#lCfg [data-cfg="map|palace"]'); await A.waitForTimeout(250);
  await A.click('#lClass [data-cls=spearman]'); await B.click('#lTeam [data-team="2"]'); await A.waitForTimeout(250);
  await A.click('#lStart'); await A.waitForTimeout(1500);
  for (const [nm, P] of [['A', A], ['B', B]]) {
    const r = await P.evaluate(() => { const m = window.__bb.match, p = m && m.player; return m && { mode: m.mode, map: m.def.id, n: m.soldiers.length, cls: p.cls, team: p.team, alive: p.alive, hp: p.hp, t: Math.round(m.time), net: !!document.body.classList.contains('playing') }; });
    console.log(nm, JSON.stringify(r)); ok(r && r.mode === 'ironsquad' && r.map === 'palace' && r.net, nm + ' match running in browser');
    if (nm === 'A') ok(r.cls === 'spearman' && r.team === 1, 'A class/team from lobby'); else ok(r.cls === 'archer' && r.team === 2, 'B class/team from lobby');
  }
  // drive A forward via real keyboard & mouse; check position changes via server snapshots
  const pos = async (P) => P.evaluate(() => { const p = window.__bb.match.player; return [p.x, p.z, p.hp]; });
  const p0 = await pos(A);
  await A.keyboard.down('KeyW'); await A.keyboard.down('ShiftLeft'); await A.waitForTimeout(2500); await A.keyboard.up('KeyW'); await A.keyboard.up('ShiftLeft');
  const p1 = await pos(A); const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  ok(d > 2, 'A moved ' + d.toFixed(1) + ' m via server (real keyboard input)');
  // B sees A at the same place (mirror)
  const seen = await B.evaluate(() => { const a = window.__bb.match.soldiers.find(s => s.name === 'Alice'); return a && [a.x, a.z]; });
  ok(seen && Math.hypot(seen[0] - p1[0], seen[1] - p1[1]) < 3, 'B sees Alice at her position ' + JSON.stringify(seen));
  await A.mouse.down(); await A.waitForTimeout(1200); await A.mouse.up();
  const hudA = await A.evaluate(() => ({ clock: document.getElementById('clock').textContent, k: document.getElementById('kK').textContent }));
  ok(/^\d+:\d\d$/.test(hudA.clock), 'HUD clock from server time ' + hudA.clock);
  // force match end on the server
  const room = hub.rooms.get(code); room.match.time = 0.1; await A.waitForTimeout(3500);
  ok(await A.locator('#scr-end.active').count() === 1 && await B.locator('#scr-end.active').count() === 1, 'both clients show the end screen');
  await A.click('#eAgain'); await A.waitForTimeout(300);
  console.log('A after Play Again on:', await A.evaluate(() => document.querySelector('.screen.active') && document.querySelector('.screen.active').id));
  await B.click('#eMenu'); await B.waitForTimeout(400);
  ok(room.members.size === 1, 'B left via Main Menu; room has ' + room.members.size);
  // disconnect of A mid-lobby cleans up
  A._disc(); await A.waitForTimeout(100); ok(!hub.rooms.has(code), 'room removed after last player disconnects');
  // regression: offline play still starts
  const C = await mkPage('pgC'); await C.click('button[data-go=custom]'); await C.click('#cStart'); await C.waitForTimeout(1200);
  ok(await C.evaluate(() => window.__bb.match && window.__bb.match.soldiers.length > 8 && !document.body.classList.contains('x')), 'offline battle still starts and runs locally');
  console.log('JS ERRORS', errs.length); errs.slice(0, 8).forEach(e => console.log(' ', e));
  hub.stop(); await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(0);
})();
