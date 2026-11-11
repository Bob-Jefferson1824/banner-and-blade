
/* ===== Banner and Blade: simulation core (no rendering) ===== */
const Sim = (function () {
'use strict';

const T_BLUE = 1, T_RED = 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const REGEN_DELAY = 7, REGEN_RATE = 0.022; // seconds without taking damage, then this fraction of max health per second
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };

/* ---------- weapons ---------- */
const WEAPONS = {
  sword: { id: 'sword', name: 'Arming Sword', dmg: 25, reach: 2.6, arc: 1.05, dur: 0.54, hit: 0.31, cd: 0.08, cleave: 2, lunge: 2.6 },
  axe:   { id: 'axe',   name: 'War Axe',      dmg: 33, reach: 2.5, arc: 1.2, dur: 0.74, hit: 0.43, cd: 0.14, cleave: 3, lunge: 2.2 },
  spear: { id: 'spear', name: 'Long Spear',   dmg: 24, reach: 3.8, arc: 0.5, dur: 0.60, hit: 0.31, cd: 0.08, cleave: 1, lunge: 1.4 },
  knife: { id: 'knife', name: 'Hunting Knife', dmg: 16, reach: 1.85, arc: 1.3, dur: 0.30, hit: 0.12, cd: 0.03, cleave: 1, lunge: 3.2 },
  // ranged: hold attack to draw, release to loose. damage scales with draw time.
  bow:   { id: 'bow',   name: 'Longbow',      dmg: 30, reach: 2.2, arc: 0.6,  dur: 0.40, hit: 0.20, cd: 0.55, cleave: 1, ranged: true, draw: 1.05, speed: 46, spread: 0.032, minDraw: 0.34 },
  // crossbow: one hard-hitting accurate bolt, then a long wind-up before the next
  crossbow: { id: 'crossbow', name: 'Crossbow', dmg: 56, reach: 2.2, arc: 0.6, dur: 0.40, hit: 0.20, cd: 0.30, cleave: 1, ranged: true, xbow: 1, draw: 0.35, reload: 4.4, speed: 74, spread: 0.013, minDraw: 0.01 }
};
// classes: each has a weapon, a body, a speed and an armour value (damage taken multiplier)
const CLASSES = {
  knight:      { id: 'knight', name: 'Knight', weapon: 'sword', alt: ['sword', 'axe'], hp: 140, speed: 0.9, armor: 0.8, shield: 1, role: 'Defensive frontline. Heavy plate, sword and shield. Slow, but very hard to kill.' },
  archer:      { id: 'archer', name: 'Archer', weapon: 'bow', alt: ['bow'], hp: 90, speed: 1.04, armor: 1.0, role: 'Ranged support. Light armour and a longbow. Strong at range, weak when caught.' },
  crossbowman: { id: 'crossbowman', name: 'Crossbowman', weapon: 'crossbow', alt: ['crossbow'], hp: 105, speed: 0.96, armor: 0.9, role: 'Heavy bolts, long reload. One accurate shot can drop a soldier; miss and you are exposed.' },
  scout:       { id: 'scout', name: 'Scout', weapon: 'knife', alt: ['knife'], hp: 95, speed: 1.17, armor: 1.0, role: 'Fast skirmisher with twin quick knives. Flank, dart in, strike, and leave.' },
  spearman:    { id: 'spearman', name: 'Spearman', weapon: 'spear', alt: ['spear'], hp: 125, speed: 0.98, armor: 0.85, shield: 1, role: 'Long reach and a light shield. Holds lines and keeps cavalry-style rushes at bay.' }
};
const CLASS_IDS = Object.keys(CLASSES);
const LEGACY_CLASS = { sword: 'knight', axe: 'knight', bow: 'archer', spear: 'spearman' };
const ARROW_G = 12;
WEAPONS.ballista = { id: 'bow', name: 'Ballista', dmg: 95, reach: 2, arc: 0.6, dur: 0.4, hit: 0.2, cd: 3.2, cleave: 1, ranged: true, draw: 0.5, speed: 85, big: 1 };
WEAPONS.catapult = { id: 'bow', name: 'Catapult', dmg: 110, reach: 2, arc: 0.6, dur: 0.4, hit: 0.2, cd: 5, cleave: 1, ranged: true, draw: 0.7, speed: 44, big: 1, stone: 1 };

const DIFF = {
  easy:   { block: 0.18, aggr: 0.7, dmg: 0.8,  speed: 0.92 },
  normal: { block: 0.42, aggr: 1.0, dmg: 1.0,  speed: 1.0 },
  hard:   { block: 0.68, aggr: 1.3, dmg: 1.12, speed: 1.06 }
};

/* ---------- maps ---------- */
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }

const HALF = 130; // playfield half-size in metres (260 x 260)
function buildMap(id) {
  const def = { id, half: id === 'fortress' ? 180 : HALF, obs: [], points: [], roads: [], decorTrees: [], spawn: {}, platforms: [], ladders: [], towers: [], decor: [], water: [], ramps: [], horses: [], ballistas: [], posts: [] };
  def.spawn[T_BLUE] = { x: 0, z: -(HALF - 12), w: 76, d: 8 };
  def.spawn[T_RED]  = { x: 0, z: HALF - 12,  w: 76, d: 8 };
  const box = (x, z, w, d, h, kind, extra) => def.obs.push(Object.assign({ t: 'box', x, z, w, d, h, kind }, extra || {}));
  const circ = (x, z, r, h, kind, extra) => def.obs.push(Object.assign({ t: 'circle', x, z, r, h, kind }, extra || {}));
  const sym = (f) => { f(1, false); f(-1, true); }; // 180-degree rotational symmetry
  const H = def.half;
  // scatter extra cover (houses, barricades, rocks...) over the outer parts of the field, mirrored for fairness,
  // keeping lanes at least ~4m wide and the flag circles and spawn strips clear
  const fillOuter = (rng, count, kinds) => {
    let placed = 0, tries = 0;
    const clear = (x, z, r) => {
      if (Math.abs(x) > H - 8 - r || Math.abs(z) > H - 32) return false;
      if (Math.abs(x) < 82 && Math.abs(z) < 72) return false; // the original core of the map
      for (const p of def.points) if (Math.hypot(x - p.x, z - p.z) < p.r + r + 5) return false;
      for (const o of def.obs) if (distToObs(o, x, z) < r + 4.5) return false;
      return true;
    };
    while (placed < count && tries++ < 1500) {
      const [kind, w, d, h] = kinds[(rng() * kinds.length) | 0], r = Math.hypot(w, d) / 2, x = rnd2(rng, -(H - 10), H - 10), z = rnd2(rng, -(H - 34), 0);
      if (Math.hypot(2 * x, 2 * z) < 2 * r + 5 || !clear(x, z, r)) continue;
      const tone = (rng() * 4) | 0;
      const put = (px, pz) => kind === 'rock' ? circ(px, pz, w / 2, h, 'rock') : box(px, pz, w, d, h, kind, kind === 'house' ? { tone } : undefined);
      put(x, z);
      if (!clear(-x, -z, r)) { def.obs.pop(); continue; }
      put(-x, -z); placed++;
    }
  };

  // shared building blocks (castle and village both use the climbable towers)
    const FACES = { px: { nx: 1, nz: 0 }, nx: { nx: -1, nz: 0 }, pz: { nx: 0, nz: 1 }, nz: { nx: 0, nz: -1 } };
    const OPP = { px: 'nx', nx: 'px', pz: 'nz', nz: 'pz' };
    const WALK = 9; // height of the wall walk and of the second floor of the big towers
    // a hollow tower: walls with a door, windows and wall-walk doorways, floors with a ladder hole, a ladder and a parapet roof
    const addTower = (o) => {
      const { cx, cz, half, tw, levels } = o, roof = levels[levels.length - 1], Ht = roof; // walls end at the roof floor; a thin parapet is added below
      const open = { px: [], nx: [], pz: [], nz: [] };
      if (o.door) open[o.door.face].push({ a: o.door.a, w: 2.0, y1: 0, y2: 2.4 });
      for (const at of o.attach) open[at.face].push({ a: at.a || 0, w: 2.0, y1: WALK, y2: WALK + 2.4 });
      const lo = o.ladder.a, lf = o.ladder.face;
      for (const f of ['px', 'nx', 'pz', 'nz']) for (const a of o.winOffsets) {
        if (f === lf && Math.abs(a - lo) < 2.0) continue;
        let w = 1.6, skip = false;
        for (const c of open[f]) {
          if (Math.abs(c.a - a) < 0.01) { w = c.w; if (c.y1 > 0) skip = true; }
          else if (Math.abs(c.a - a) < (c.w + 1.6) / 2 + 0.2) skip = true;
        }
        if (skip) continue;
        for (const L of levels.slice(0, -1)) open[f].push({ a, w, y1: L + 1.0, y2: L + 2.4 });
      }
      for (const f of ['px', 'nx', 'pz', 'nz']) {
        const F = FACES[f], horiz = f === 'px' || f === 'nx';
        const lo_ = horiz ? -half : -half + tw, hi_ = horiz ? half : half - tw;
        const band = (a0, a1, y0, y1) => {
          if (a1 - a0 < 0.01 || y1 - y0 < 0.01) return;
          const ac = (a0 + a1) / 2, len = a1 - a0, nrm = half - tw / 2;
          const ex = {}; if (y0 > 0) ex.y0 = y0;
          if (horiz) box(cx + F.nx * nrm, cz + ac, tw, len, y1, 'twall', ex); else box(cx + ac, cz + F.nz * nrm, len, tw, y1, 'twall', ex);
        };
        const cols = new Map();
        for (const c of open[f]) { const k = c.a + '|' + c.w; if (!cols.has(k)) cols.set(k, { a: c.a, w: c.w, gaps: [] }); cols.get(k).gaps.push([c.y1, c.y2]); }
        const list = [...cols.values()].sort((p, q) => p.a - q.a);
        let pos = lo_;
        for (const c of list) {
          band(pos, c.a - c.w / 2, 0, Ht);
          c.gaps.sort((p, q) => p[0] - q[0]);
          let y = 0;
          for (const g of c.gaps) { if (g[0] > y + 0.001) band(c.a - c.w / 2, c.a + c.w / 2, y, g[0]); y = g[1]; }
          if (y < Ht - 0.001) band(c.a - c.w / 2, c.a + c.w / 2, y, Ht);
          pos = c.a + c.w / 2;
        }
        band(pos, hi_, 0, Ht);
      }
      // waist-high parapet along the roof edge, with a gap where a wall walk joins the roof
      for (const f of ['px', 'nx', 'pz', 'nz']) {
        const F = FACES[f], horiz = f === 'px' || f === 'nx', pt = 0.4, off = half - pt / 2;
        const gaps = roof === WALK ? o.attach.filter(at => at.face === f).map(at => [(at.a || 0) - 1.0, (at.a || 0) + 1.0]) : [];
        let a0 = -half; gaps.sort((p, q) => p[0] - q[0]); gaps.push([half, half]);
        for (const g of gaps) {
          if (g[0] - a0 > 0.05) { const len = g[0] - a0, ac = (a0 + g[0]) / 2; if (horiz) box(cx + F.nx * off, cz + ac, pt, len, roof + 0.8, 'parapet', { y0: roof }); else box(cx + ac, cz + F.nz * off, len, pt, roof + 0.8, 'parapet', { y0: roof }); }
          a0 = g[1];
        }
      }
      // ladder against the inside of its wall
      const F = FACES[lf], horiz = lf === 'px' || lf === 'nx', nrm = half - tw - 0.55;
      const zx = horiz ? cx + F.nx * nrm : cx + lo, zz = horiz ? cz + lo : cz + F.nz * nrm;
      const zw = horiz ? 1.1 : 1.5, zd = horiz ? 1.5 : 1.1;
      def.ladders.push({ x: zx, z: zz, w: zw, d: zd, y1: roof, nx: F.nx, nz: F.nz });
      const Fd = FACES[o.door.face], hd = o.door.face === 'px' || o.door.face === 'nx';
      const dX = hd ? cx + Fd.nx * half : cx + o.door.a, dZ = hd ? cz + o.door.a : cz + Fd.nz * half;
      def.towers.push({ cx, cz, half, roof, lad: { x: zx, z: zz, nx: F.nx, nz: F.nz, y1: roof },
        door: { ox: dX + Fd.nx * 4, oz: dZ + Fd.nz * 4, ix: dX - Fd.nx * (tw + 1.4), iz: dZ - Fd.nz * (tw + 1.4) } });
      const hole = { x: zx, z: zz, w: zw, d: zd };
      for (const L of levels) def.platforms.push({ x: cx, z: cz, w: 2 * half, d: 2 * half, y: L, kind: 'floor', holes: [hole], inset: tw }); // inset: the floor only covers the room inside the walls, never their tops
    };
    const levels3 = [4.5, 9, 13.5], levels2 = [4.5, 9];

  if (id === 'castle') {
    def.name = 'Castle Grounds';
    def.blurb = 'A great stone fortress on open farmland. Take the courtyard, hold the flanks.';
    def.ground = 'grass';
    const W = 30, T = 3;
    // a wall segment with a walkway and parapets on top
    const addWall = (cx, cz, w, d) => {
      box(cx, cz, w, d, WALK, 'cwall');
      def.platforms.push({ x: cx, z: cz, w, d, y: WALK, kind: 'walk' });
      const pt = 0.4;
      for (const sd of [-1, 1]) {
        if (w > d) box(cx, cz + sd * (d / 2 - pt / 2), w, pt, WALK + 0.8, 'parapet', { y0: WALK });
        else box(cx + sd * (w / 2 - pt / 2), cz, pt, d, WALK + 0.8, 'parapet', { y0: WALK });
      }
    };
    // corner towers
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const xf = sx < 0 ? 'px' : 'nx', zf = sz < 0 ? 'pz' : 'nz';
      addTower({ cx: sx * W, cz: sz * W, half: 6, tw: 1.4, levels: levels3, door: { face: xf, a: -sz * 3 }, attach: [{ face: xf, a: 0 }, { face: zf, a: 0 }], ladder: { face: OPP[xf], a: 2.6 }, winOffsets: [-3.2, 3.2] });
    }
    // gate towers, with the curtain walls and gate bridges between the towers
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      const spur = sx === sz; // the two gate towers that carry a spur wall out to a watchtower
      const spurA = sx < 0 ? -0.5 : 0.5;
      const cf = sz < 0 ? 'pz' : 'nz', field = OPP[cf];
      const attach = [{ face: sx < 0 ? 'nx' : 'px', a: 0 }, { face: sx < 0 ? 'px' : 'nx', a: 0 }];
      if (spur) attach.push({ face: field, a: spurA });
      addTower({ cx: sx * 8.5, cz: sz * W, half: 3.5, tw: 1.2, levels: levels2, door: { face: cf, a: 0 }, attach, ladder: { face: field, a: spur ? (spurA < 0 ? 1.4 : -1.4) : 1.4 }, winOffsets: [0, -1.3, 1.3] });
      addWall(sx * 18, sz * W, 12, T);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const cf = sx < 0 ? 'px' : 'nx', field = OPP[cf];
      const attach = [{ face: sz < 0 ? 'nz' : 'pz', a: 0 }, { face: sz < 0 ? 'pz' : 'nz', a: 0 }];
      addTower({ cx: sx * W, cz: sz * 8.5, half: 3.5, tw: 1.2, levels: levels2, door: { face: cf, a: 0 }, attach, ladder: { face: field, a: 1.4 }, winOffsets: [0, -1.3, 1.3] });
      addWall(sx * W, sz * 18, T, 12);
    }
    // walkways across the four gates, high enough to walk under
    for (const s of [-1, 1]) {
      def.platforms.push({ x: 0, z: s * W, w: 10, d: T, y: WALK, kind: 'walk' });
      def.platforms.push({ x: s * W, z: 0, w: T, d: 10, y: WALK, kind: 'walk' });
      for (const sd of [-1, 1]) {
        box(0, s * W + sd * (T / 2 - 0.2), 10, 0.4, WALK + 0.8, 'parapet', { y0: WALK });
        box(s * W + sd * (T / 2 - 0.2), 0, 0.4, 10, WALK + 0.8, 'parapet', { y0: WALK });
      }
      box(0, s * W, 10, T, WALK - 0.5, 'twall', { y0: 7 });
      box(s * W, 0, T, 10, WALK - 0.5, 'twall', { y0: 7 });
    }
    // outlying watchtowers, joined to the gatehouses by a spur wall
    for (const k of [1, -1]) {
      const wx = k * -9, wz = k * -55, m = (f) => (k === 1 ? f : OPP[f]);
      addWall(wx, k * -42, T, 18);
      addTower({ cx: wx, cz: wz, half: 4, tw: 1.2, levels: levels3, door: { face: m('px'), a: 0 }, attach: [{ face: m('pz'), a: 0 }], ladder: { face: m('nx'), a: 0 }, winOffsets: [0] });
    }
    // courtyard buildings and well
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * 17, sz * 17, 10, 7, 5, 'house', { tone: 0 });
    circ(0, 0, 1.6, 1.2, 'well');
    sym((k, m) => {
      // flank ruins
      box(k * 70, k * -14, 7, 6, 5, 'house', { tone: 1 });
      circ(k * 66, k * 8, 1.6, 2, 'rock');
      // field barricades
      box(k * -30, k * -52, 8, 1.2, 1.5, 'barricade');
      box(k * 30, k * -52, 8, 1.2, 1.5, 'barricade');
      box(k * -16, k * -62, 6, 1.2, 1.5, 'barricade');
      box(k * 16, k * -62, 6, 1.2, 1.5, 'barricade');
      box(k * -42, k * -30, 1.2, 8, 1.5, 'barricade');
      box(k * 42, k * -30, 1.2, 8, 1.5, 'barricade');
      box(k * -46, k * 22, 7, 1.2, 1.5, 'barricade');
      circ(k * -48, k * -12, 2, 2.4, 'rock');
      circ(k * 52, k * -24, 1.8, 2.2, 'rock');
      box(k * -36, k * 14, 1.6, 1.6, 1.3, 'crate');
      box(k * -34.2, k * 15.4, 1.6, 1.6, 1.3, 'crate');
    });
    def.points = [
      { id: 'A', name: 'West Field',   x: -58, z: 0,   r: 8, owner: 0 },
      { id: 'B', name: 'Courtyard',    x: 0,   z: 0,   r: 8, owner: 0 },
      { id: 'C', name: 'East Field',   x: 58,  z: 0,   r: 8, owner: 0 },
      { id: 'D', name: 'North Tower',  x: 0,   z: -52, r: 8, owner: T_BLUE },
      { id: 'E', name: 'South Tower',  x: 0,   z: 52,  r: 8, owner: T_RED },
      { id: 'F', name: 'Northwest Camp', x: -66, z: -96, r: 8, owner: T_BLUE },
      { id: 'G', name: 'Northeast Camp', x: 66,  z: -96, r: 8, owner: T_BLUE },
      { id: 'H', name: 'Southeast Camp', x: 66,  z: 96,  r: 8, owner: T_RED },
      { id: 'I', name: 'Southwest Camp', x: -66, z: 96,  r: 8, owner: T_RED }
    ];
    fillOuter(lcg(311), 34, [['house', 7, 6, 5], ['barricade', 8, 1.2, 1.5], ['barricade', 1.2, 8, 1.5], ['rock', 2, 2, 2.4], ['crate', 1.6, 1.6, 1.3]]);
    // trees
    const rng = lcg(7);
    const okTree = (x, z) => {
      if (Math.abs(x) < 36 && Math.abs(z) < 36) return false;
      if (Math.abs(z) > H - 24) return false;
      for (const p of def.points) if (Math.hypot(x - p.x, z - p.z) < p.r + 5) return false;
      for (const o of def.obs) if (distToObs(o, x, z) < 2.5) return false;
      return true;
    };
    let n = 0, tries = 0;
    while (n < 80 && tries++ < 1600) {
      const x = rnd2(rng, -(H - 6), H - 6), z = rnd2(rng, -(H - 24), 0);
      if (!okTree(x, z)) continue;
      circ(x, z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.7 });
      circ(-x, -z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.7 });
      n++;
    }
  } else if (id === 'fortress') {
    def.name = 'The Fortress'; def.blurb = 'A snowbound fortress. Break the gate with the ram or climb the walls, cross the courtyard and slay the king.'; def.ground = 'snow';
    def.spawn[T_BLUE] = { x: 0, z: -162, w: 100, d: 8 }; def.spawn[T_RED] = { x: 0, z: 40, w: 26, d: 20 }; def.roofY = 10; // defenders spawn on the keep roof
    const WH = 12, KH = 10, pr = (x, z, w, d, y) => box(x, z, w, d, (y || WH) + 0.6, 'parapet', { y0: y || WH });
    const wall = (x, z, w, d) => { box(x, z, w, d, WH, 'cwall'); def.platforms.push({ x, z, w, d, y: WH, kind: 'walk' }); };
    const cuts = (a, b, gs) => { const r = []; let p = a; for (const g of gs.slice().sort((u, v) => u[0] - v[0])) { if (g[0] > p) r.push([p, g[0]]); p = g[1]; } if (b > p) r.push([p, b]); return r; };
    const runX = (a, b, z, gs, y) => cuts(a, b, gs).forEach(r => pr((r[0] + r[1]) / 2, z, r[1] - r[0], 0.4, y));
    const runZ = (a, b, x, gs, y) => cuts(a, b, gs).forEach(r => pr(x, (r[0] + r[1]) / 2, 0.4, r[1] - r[0], y));
    const LX = [-40, -24, 24, 40];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { wall(sx * 52, sz * 58, 12, 12); pr(sx * 46.2, sz * 58, 0.4, 12); pr(sx * 52, sz * 52.2, 12, 0.4); }
    wall(-26, -62, 40, 4); wall(26, -62, 40, 4); wall(0, 62, 92, 4); wall(-56, 0, 4, 104); wall(56, 0, 4, 104);
    box(0, -62, 12, 4, WH, 'cwall', { y0: 9 }); def.platforms.push({ x: 0, z: -62, w: 12, d: 4, y: WH, kind: 'walk' });
    box(0, -62, 12, 4, 9, 'gate', { hp: 4500, max: 4500 });
    runX(-58, 58, -63.8, LX.map(x => [x - 1.2, x + 1.2])); runX(-46, 46, -60.2, [[-18.5, -13.5], [13.5, 18.5]]);
    runX(-58, 58, 63.8, []); runX(-46, 46, 60.2, []); runZ(-64, 64, 57.8, []); runZ(-64, 64, -57.8, []); runZ(-52, 52, 54.2, []); runZ(-52, 52, -54.2, []);
    for (const x of LX) { def.ladders.push({ x, z: -64.55, w: 1.5, d: 1.1, y1: WH, nx: 0, nz: 1 }); def.platforms.push({ x, z: -64.9, w: 2.4, d: 1.8, y: WH, kind: 'floor', inset: 0 }); }
    def.ramps.push({ x: -16, w: 5, zs: -27, ze: -57, y0: 0, y1: WH }, { x: 16, w: 5, zs: -27, ze: -57, y0: 0, y1: WH }, { x: 12.5, w: 5, zs: -5, ze: 24.5, y0: 0, y1: KH });
    for (const x of [-16, 16]) def.platforms.push({ x, z: -58.5, w: 5, d: 3.5, y: WH, kind: 'walk' });
    def.platforms.push({ x: 12.5, z: 26, w: 5, d: 3, y: KH, kind: 'walk' });
    // (no moat: the snow runs right up to the walls)
    for (const [x, z] of [[-44, -148], [-30, -154], [44, -148], [30, -154], [-62, -138], [62, -138], [-78, -152], [78, -152]]) circ(x, z, 2.4, 3, 'tent');
    for (const [x, z] of [[-14, -150], [16, -152]]) { box(x, z, 1.6, 1.6, 1.3, 'crate'); box(x + 1.7, z + 0.3, 1.6, 1.6, 1.3, 'crate'); }
    def.horses = [[-8, -151], [-4, -153], [4, -153], [8, -151], [-20, -147], [20, -147]].map(([x, z]) => ({ x, z })); def.ram = { x: 0, z: -126 }; def.catapults = [{ x: -30, z: -91 }, { x: 30, z: -91 }];
    circ(0, -20, 1.6, 6, 'statue'); box(-40, -30, 10, 12, 6, 'house', { tone: 0 }); box(40, -30, 10, 12, 6, 'house', { tone: 2 });
    const slits = (x0, x1, z, d) => { for (let x = x0; x + 3.2 <= x1 + 0.01; x += 3.2) box(x + 1.4, z, 2.8, d, KH, 'cwall'); };
    slits(-18, -4, 27.5, 3); slits(4, 18, 27.5, 3);
    box(0, 52.5, 36, 3, KH, 'cwall'); box(-16.5, 40, 3, 28, KH, 'cwall'); box(16.5, 40, 3, 28, KH, 'cwall'); box(-9, 40, 12, 1.5, KH, 'cwall'); box(9, 40, 12, 1.5, KH, 'cwall');
    def.platforms.push({ x: 0, z: 40, w: 36, d: 28, y: KH, kind: 'walk' });
    runX(-18, 18, 26.2, [[10, 15]], KH); runX(-18, 18, 53.8, [], KH); runZ(26, 54, -17.8, [], KH); runZ(26, 54, 17.8, [], KH);
    const wp = (x, o) => Object.assign({ x, z: -61.5, y: WH, kind: 'wall', bow: 1, ramp: x < 0 ? 0 : 1 }, o);
    const gp = (x, z) => ({ x, z, kind: 'gate' }), sp = (x) => ({ x, z: 31, kind: 'slit', bow: 1, fire: 1 }), rp = (x) => ({ x, z: 29.5, y: KH, kind: 'roof', bow: 1, fire: 1, ramp: 2 });
    def.ballistas = [{ x: -12, z: -61.5, y: WH }, { x: 12, z: -61.5, y: WH }];
    def.posts = [wp(-12, { kind: 'ballista', bal: 0, bow: 0, fire: 1 }), wp(12, { kind: 'ballista', bal: 1, bow: 0, fire: 1 }), wp(-44), wp(44), gp(-3, -54), gp(3, -54), wp(-30), wp(30), sp(-11.8), sp(10.2),
      wp(-20, { kind: 'patrol', bow: 0, patrol: 1 }), wp(20, { kind: 'patrol', bow: 0, patrol: 1 }), rp(-8), rp(8), gp(-6, -50), gp(6, -50), sp(-8.6), sp(13.4), wp(-36), wp(36),
      gp(0, -46), { x: -10, z: -34, kind: 'yard' }, { x: 10, z: -34, kind: 'yard' }, { x: 0, z: -12, kind: 'yard' }];
    def.kingPts = [[0, 46], [-9, 46], [9, 46], [-8, 34], [8, 34]];
    // ground: cobbled courtyard, a trampled road from the camp to the gate, and a worn camp ground
    def.roads.push({ x: 0, z: 0, w: 106, d: 118, kind: 'cobble' }, { x: 0, z: -111, w: 9, d: 94, kind: 'dirt' }, { x: 0, z: -153, w: 124, d: 26, kind: 'dirt' });
    // round towers: four big corner towers, two gate towers standing in front of the wall, four keep turrets and a great tower on the keep roof
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) circ(sx * 57.5, sz * 63.5, 4.2, WH + 5, 'turret', { flag: 1 });
    circ(-8.8, -67, 3.2, WH + 3, 'turret', { flag: 1 }); circ(8.8, -67, 3.2, WH + 3, 'turret', { flag: 1 });
    for (const sx of [-1, 1]) { circ(sx * 18, 26, 3, KH + 9, 'turret', { flag: 1 }); circ(sx * 18, 54, 3, KH + 9, 'turret', { flag: 1 }); }
    box(0, 49, 14, 4, KH + 9, 'donjon', { y0: KH }); // sits on the roof, so people inside the keep walk under it
    def.drifts = []; { const dr = lcg(77); while (def.drifts.length < 110) { const x = rnd2(dr, -172, 172), z = rnd2(dr, -172, 172); if (Math.abs(x) < 64 && Math.abs(z) < 70) continue; if (Math.abs(x) < 8 && z < -64) continue; def.drifts.push({ x, z, s: 1 + dr() * 2.4 }); } }
    // a pine forest between the attackers' camp and the walls, with an open lane down the middle for the ram
    { const fr = lcg(404); let n = 0, tries = 0;
      while (n < 120 && tries++ < 4000) {
        const x = rnd2(fr, -128, 128), z = rnd2(fr, -122, -97);
        if (Math.abs(x) < 15) continue;
        let ok = true; for (const o of def.obs) if (distToObs(o, x, z) < 2.8) { ok = false; break; }
        if (ok) { circ(x, z, 0.8, 7, 'tree', { s: 0.9 + fr() * 0.8 }); n++; }
      } }
  } else if (id === 'palace') {
    def.name = 'Central Palace';
    def.blurb = 'The royal stronghold. Storm the gates, win the Grand Courtyard, then fight room to room through the palace to the throne. Gardens, towers and side gates give a dozen ways in.';
    def.ground = 'grass';
    const T = 4, WX = 84, WZ = 100, PH = 11;
    // ---- outer curtain wall: corner towers, twin gate towers north and south, mid-wall side towers, small posterns ----
    const addWall = (cx, cz, w, d) => {
      box(cx, cz, w, d, WALK, 'cwall');
      def.platforms.push({ x: cx, z: cz, w, d, y: WALK, kind: 'walk' });
      const pt = 0.4;
      for (const sd of [-1, 1]) {
        if (w > d) box(cx, cz + sd * (d / 2 - pt / 2), w, pt, WALK + 0.8, 'parapet', { y0: WALK });
        else box(cx + sd * (w / 2 - pt / 2), cz, pt, d, WALK + 0.8, 'parapet', { y0: WALK });
      }
    };
    const postern = (cx, cz, ax) => { // a small gate: a walkway carried over a 6m opening
      const w = ax ? 6 : T, d = ax ? T : 6;
      def.platforms.push({ x: cx, z: cz, w, d, y: WALK, kind: 'walk' });
      for (const sd of [-1, 1]) { if (ax) box(cx, cz + sd * (T / 2 - 0.2), w, 0.4, WALK + 0.8, 'parapet', { y0: WALK }); else box(cx + sd * (T / 2 - 0.2), cz, 0.4, d, WALK + 0.8, 'parapet', { y0: WALK }); }
      box(cx, cz, w, d, WALK - 0.5, 'twall', { y0: 6.2 });
    };
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // corner towers
      const xf = sx < 0 ? 'px' : 'nx', zf = sz < 0 ? 'pz' : 'nz';
      addTower({ cx: sx * WX, cz: sz * WZ, half: 6, tw: 1.4, levels: levels3, door: { face: xf, a: -sz * 4 }, attach: [{ face: xf, a: 0 }, { face: zf, a: 0 }], ladder: { face: OPP[xf], a: 2.6 }, winOffsets: [-3.2, 3.2] });
    }
    for (const sz of [-1, 1]) { // gate towers and the N/S curtain
      for (const sx of [-1, 1]) {
        const cf = sz < 0 ? 'pz' : 'nz', field = OPP[cf];
        addTower({ cx: sx * 8.5, cz: sz * WZ, half: 3.5, tw: 1.2, levels: levels2, door: { face: cf, a: 0 }, attach: [{ face: 'nx', a: 0 }, { face: 'px', a: 0 }], ladder: { face: field, a: 1.4 }, winOffsets: [0, -1.3, 1.3] });
        addWall(sx * 29.5, sz * WZ, 35, T); addWall(sx * 65.5, sz * WZ, 25, T); postern(sx * 50, sz * WZ, true);
      }
      def.platforms.push({ x: 0, z: sz * WZ, w: 10, d: T, y: WALK, kind: 'walk' });
      for (const sd of [-1, 1]) box(0, sz * WZ + sd * (T / 2 - 0.2), 10, 0.4, WALK + 0.8, 'parapet', { y0: WALK });
      box(0, sz * WZ, 10, T, WALK - 0.5, 'twall', { y0: 7 });
    }
    for (const sx of [-1, 1]) { // E/W curtain, side towers, posterns
      const f = sx < 0 ? 'px' : 'nx';
      addTower({ cx: sx * WX, cz: 0, half: 5, tw: 1.3, levels: levels3, door: { face: f, a: 0 }, attach: [{ face: 'pz', a: 0 }, { face: 'nz', a: 0 }], ladder: { face: OPP[f], a: 0 }, winOffsets: [-2.6, 2.6] });
      for (const sz of [-1, 1]) { addWall(sx * WX, sz * 76, T, 36); addWall(sx * WX, sz * 28.5, T, 47); postern(sx * WX, sz * 55, false); }
    }
    // ---- the palace ----
    const run = (x0, z0, x1, z1, th, hgt, gaps) => {
      const ax = z0 === z1, a0 = ax ? Math.min(x0, x1) : Math.min(z0, z1), a1 = ax ? Math.max(x0, x1) : Math.max(z0, z1), c = ax ? z0 : x0;
      const put = (p, q, y0, y1) => { if (q - p < 0.05 || y1 - y0 < 0.05) return; const m = (p + q) / 2, ex = y0 > 0 ? { y0 } : undefined; if (ax) box(m, c, q - p, th, y1, 'twall', ex); else box(c, m, th, q - p, y1, 'twall', ex); };
      let p = a0;
      for (const g of gaps.slice().sort((u, v) => u.a0 - v.a0)) { put(p, g.a0, 0, hgt); if (g.y1 > 0) put(g.a0, g.a1, 0, g.y1); put(g.a0, g.a1, g.y2, hgt); p = g.a1; }
      put(p, a1, 0, hgt);
    };
    const dr = (c, w, y2) => ({ a0: c - w / 2, a1: c + w / 2, y1: 0, y2: y2 || 4.6 });
    const wn = (c) => ({ a0: c - 1.2, a1: c + 1.2, y1: 2.2, y2: 4.8 });
    def.windows = [];
    const wins = (cs, fixed, ax) => cs.map(c => { def.windows.push(ax ? { x: c, z: fixed, ax: 1 } : { x: fixed, z: c, ax: 0 }); return wn(c); });
    // outer walls (inner faces at x=+-34, z=+-22)
    run(-36, 23, 36, 23, 2, PH, [dr(0, 8, 6.5), dr(-25, 5), dr(25, 5)].concat(wins([-32, -18, -9, 9, 18, 32], 23, true)));
    run(-36, -23, 36, -23, 2, PH, [dr(0, 6, 5.6), dr(-25, 5), dr(25, 5)].concat(wins([-32, -18, -9, 9, 18, 32], -23, true)));
    for (const sx of [-1, 1]) run(sx * 35, -22, sx * 35, 22, 2, PH, [dr(-11, 5), dr(11, 5)].concat(wins([-18, -3, 3, 18], sx * 35, false)));
    // inner walls
    const IH = PH - 0.5;
    for (const sx of [-1, 1]) {
      run(sx * 14, -22, sx * 14, 22, 1.6, IH, [dr(-16, 5), dr(-6, 5), dr(6, 5), dr(16, 5)]);
    }
    run(-14, 12, 14, 12, 1.6, IH, [dr(0, 8, 6)]);
    run(-14, -12, 14, -12, 1.6, IH, [dr(-9, 5), dr(9, 5)]);
    for (const sx of [-1, 1]) run(sx * 36, 0, sx * 14, 0, 1.6, IH, [dr(sx * 25, 5)]);
    box(0, 0, 76, 52, PH + 1.2, 'twall', { y0: PH }); // roof slab
    // portico on the courtyard front
    box(0, 27.5, 36, 7, 10, 'twall', { y0: 9 });
    for (const x of [-16.5, -11.5, -6.5, 6.5, 11.5, 16.5]) circ(x, 27, 0.9, 9, 'pillar');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) circ(sx * 36.5, sz * 24.5, 3.2, 15, 'turret');
    // interior: columns, throne, tables, chests
    for (const sx of [-1, 1]) { for (const z of [-6, 0, 6]) circ(sx * 8, z, 0.8, PH, 'pillar'); circ(sx * 9, 17, 0.8, PH, 'pillar'); }
    box(0, -10.3, 2.6, 2.0, 3.4, 'throne');
    box(0, -17, 8, 1.6, 1.1, 'crate'); // banquet table in the antechamber
    for (const sx of [-1, 1]) {
      box(sx * 25, 12, 8, 1.6, 1.1, 'crate'); box(sx * 25, -12, 8, 1.6, 1.1, 'crate'); // wing tables
      box(sx * 31, 16, 1.6, 1.6, 1.3, 'crate'); box(sx * 31, -16, 1.6, 1.6, 1.3, 'crate'); box(sx * 20, 5, 1.6, 1.6, 1.3, 'crate'); box(sx * 20, -5, 1.6, 1.6, 1.3, 'crate');
    }
    // ---- Grand Courtyard (south) ----
    circ(0, 70, 4.8, 1.1, 'well'); circ(0, 70, 1.5, 4.8, 'statue');
    for (const sx of [-1, 1]) {
      box(sx * 14, 56, 10, 1.6, 1.1, 'lowwall'); box(sx * 14, 84, 10, 1.6, 1.1, 'lowwall'); // flower planters
      circ(sx * 24, 38, 1.5, 4.6, 'statue'); circ(sx * 26, 78, 1.5, 4.6, 'statue');
      // guardhouses by the main gate, servants' quarters and stores in the side yards
      box(sx * 24, 90, 12, 8, 5, 'house', { tone: 0 });
      for (const [bx, bz, bw, bd, tn] of [[70, 38, 12, 9, 1], [53, 38, 12, 9, 3], [70, 66, 12, 10, 2], [53, 66, 12, 10, 0], [70, 88, 12, 9, 3], [53, 88, 12, 9, 1]]) box(sx * bx, bz, bw, bd, 5, 'house', { tone: tn });
      for (const [bx, bz] of [[62, 50], [62, 52], [60.4, 51.2], [62, 78], [44, 100 - 8]]) box(sx * bx, bz, 1.6, 1.6, 1.3, 'crate');
      circ(sx * 44, 52, 1.2, 1.6, 'rock');
    }
    // ---- Royal Gardens (north): hedges, fountains, statues, gardener's lodges ----
    for (const sx of [-1, 1]) {
      for (const z of [-40, -80]) { box(sx * 32, z, 20, 1.2, 1.5, 'hedge'); box(sx * 56, z, 12, 1.2, 1.5, 'hedge'); }
      box(sx * 26, -68, 14, 1.2, 1.5, 'hedge'); box(sx * 26, -52, 14, 1.2, 1.5, 'hedge');
      circ(sx * 26, -60, 2.4, 1.2, 'well'); circ(sx * 46, -60, 1.4, 4.4, 'statue');
      box(sx * 74, -88, 12, 8, 5, 'house', { tone: 2 }); box(sx * 74, -34, 10, 8, 5, 'house', { tone: 0 });
      box(sx * 38, -88, 3, 1, 0.9, 'lowwall'); box(sx * 38, -33, 3, 1, 0.9, 'lowwall'); // benches
      box(sx * 70, -78, 1.6, 1.6, 1.3, 'crate'); box(sx * 71.8, -77, 1.6, 1.6, 1.3, 'crate');
    }
    // ---- flank yards (open ground between the side towers and the palace) ----
    for (const sx of [-1, 1]) {
      box(sx * 56, -16, 8, 1.2, 1.5, 'barricade'); box(sx * 56, 16, 8, 1.2, 1.5, 'barricade');
      box(sx * 48, 0, 1.2, 8, 1.5, 'barricade'); circ(sx * 62, 10, 1.8, 2.2, 'rock'); circ(sx * 62, -10, 1.8, 2.2, 'rock');
      box(sx * 70, 18, 1.6, 1.6, 1.3, 'crate'); box(sx * 70, -18, 1.6, 1.6, 1.3, 'crate');
    }
    // ---- fields outside the walls ----
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      box(sx * 26, sz * 108, 8, 1.2, 1.5, 'barricade'); box(sx * 60, sz * 110, 8, 1.2, 1.5, 'barricade');
      circ(sx * 44, sz * 108, 2, 2.4, 'rock'); box(sx * 12, sz * 112, 6, 1.2, 1.5, 'barricade');
      box(sx * 100, sz * 30, 7, 6, 5, 'house', { tone: 1 }); circ(sx * 104, sz * 14, 1.8, 2.2, 'rock');
      box(sx * 108, sz * 60, 1.2, 8, 1.5, 'barricade'); box(sx * 98, sz * 80, 7, 1.2, 1.5, 'barricade');
    }
    // roads
    def.roads.push({ x: 0, z: 63, w: 88, d: 70, kind: 'cobble' });          // Grand Courtyard
    def.roads.push({ x: 0, z: -62, w: 10, d: 76, kind: 'cobble' });          // garden avenue
    def.roads.push({ x: 0, z: -60, w: 22, d: 22, kind: 'cobble' });          // garden plaza
    for (const sz of [-1, 1]) {
      def.roads.push({ x: 0, z: sz * 111, w: 10, d: 24, kind: 'dirt' });
      for (const sx of [-1, 1]) {
        def.roads.push({ x: sx * 50, z: sz * 111, w: 5, d: 24, kind: 'dirt' });
        def.roads.push({ x: sx * 94, z: sz * 55, w: 24, d: 5, kind: 'dirt' });
        def.roads.push({ x: sx * 60, z: sz * 11, w: 50, d: 4, kind: 'dirt' });
        def.roads.push({ x: sx * 64, z: sz * 55, w: 4, d: 8, kind: 'dirt' });
      }
    }
    def.roads.push({ x: 0, z: 0, w: 70, d: 3, kind: 'dirt' });
    def.roads = def.roads.filter(r => r.w * r.d > 0);
    def.beds = [];
    for (const sx of [-1, 1]) { def.beds.push({ x: sx * 50, z: -48, w: 10, d: 8 }, { x: sx * 50, z: -72, w: 10, d: 8 }, { x: sx * 15, z: -88, w: 6, d: 6 }, { x: sx * 15, z: -33, w: 6, d: 6 }); }
    def.points = [
      { id: 'A', name: 'Western Tower',   x: -68, z: 0,   r: 8, owner: 0 },
      { id: 'B', name: 'Main Courtyard',  x: 0,   z: 52,  r: 8, owner: 0 },
      { id: 'C', name: 'Eastern Tower',   x: 68,  z: 0,   r: 8, owner: 0 },
      { id: 'D', name: 'Palace Entrance', x: 0,   z: 33,  r: 8, owner: 0 },
      { id: 'E', name: 'Throne Room',     x: 0,   z: 1,   r: 8, owner: 0 },
      { id: 'F', name: 'Royal Gardens',   x: 0,   z: -60, r: 8, owner: 0 },
      { id: 'G', name: 'Rear Gatehouse',  x: 0,   z: -88, r: 8, owner: T_BLUE },
      { id: 'H', name: 'Main Gatehouse',  x: 0,   z: 88,  r: 8, owner: T_RED }
    ];
    // trees: orchards in the gardens, groves along the walls and outside (mirrored in x)
    const rng = lcg(37);
    const okTree = (x, z) => {
      if (Math.abs(z) > H - 22) return false;
      if (Math.abs(x) < 80 && Math.abs(z) < 98) { if (z > -30) return false; if (Math.abs(x) < 12 || Math.abs(x) > 70) return false; }
      for (const p of def.points) if (Math.hypot(x - p.x, z - p.z) < p.r + 5) return false;
      for (const o of def.obs) if (distToObs(o, x, z) < 3.2) return false;
      for (const r of def.roads) if (Math.abs(x - r.x) < r.w / 2 + 1.5 && Math.abs(z - r.z) < r.d / 2 + 1.5) return false;
      return true;
    };
    let n = 0, tries = 0;
    while (n < 56 && tries++ < 4000) {
      const x = rnd2(rng, 8, H - 6), z = rnd2(rng, -(H - 22), H - 22);
      if (!okTree(x, z) || !okTree(-x, z)) continue;
      circ(x, z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.6 }); circ(-x, z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.6 }); n++;
    }
    for (const sx of [-1, 1]) for (const z of [-92, -84, -36, -30]) circ(sx * 9.5, z, 0.8, 6, 'tree', { s: 0.7 }); // along the garden avenue
  } else {
    def.name = 'Medieval Village';
    def.blurb = 'Tight streets, a market square and a hilltop church. Fight house to house, or climb the church and mill towers for the high ground.';
    def.ground = 'village';
    // roads: N-S main street, E-W street, central square
    def.roads.push({ x: 0, z: 0, w: 10, d: 2 * H - 8, kind: 'dirt' });
    def.roads.push({ x: 0, z: 0, w: 2 * H - 8, d: 10, kind: 'dirt' });
    def.roads.push({ x: 0, z: 0, w: 24, d: 24, kind: 'cobble' });
    def.roads.push({ x: -40, z: -22, w: 24, d: 24, kind: 'cobble' });
    def.roads.push({ x: 40, z: 22, w: 24, d: 24, kind: 'cobble' });
    def.roads.push({ x: 0, z: -50, w: 24, d: 24, kind: 'cobble' });
    def.roads.push({ x: 0, z: 50, w: 24, d: 24, kind: 'cobble' });
    // central fountain and market stalls
    circ(0, 0, 2.2, 1.4, 'well');
    box(-7, -7, 3.2, 2.2, 1.3, 'stall'); box(7, 7, 3.2, 2.2, 1.3, 'stall');
    box(7, -7, 2.2, 3.2, 1.3, 'stall'); box(-7, 7, 2.2, 3.2, 1.3, 'stall');
    // north-west quarter (mirrored to the south-east)
    sym((k, m) => {
      box(k * -22, k * -16, 10, 9, 5, 'house', { tone: 0 });
      box(k * -36, k * -7.5, 9, 7, 5, 'house', { tone: 2 });
      box(k * -18, k * -34, 9, 9, 6, 'house', { tone: 1 });
      box(k * -10, k * -24, 6, 6, 4, 'house', { tone: 3 });
      box(k * -30, k * -50, 11, 9, 5, 'house', { tone: 0 });
      box(k * -14, k * -57, 9, 8, 5, 'house', { tone: 2 });
      box(k * -46, k * -46, 9, 9, 5, 'house', { tone: 1 });
      box(k * -56, k * -26, 12, 20, 9, m ? 'mill' : 'church');
      // the bell tower beside the church (and the mill's twin): climb the inside ladder, shoot out of the windows
      addTower({ cx: k * -56, cz: k * -12, half: 4, tw: 1.2, levels: levels3, door: { face: k === 1 ? 'pz' : 'nz', a: 0 }, attach: [], ladder: { face: k === 1 ? 'nz' : 'pz', a: 0 }, winOffsets: [0] });
      for (const cx of [-1, 1]) for (const cz of [-1, 1]) def.decor.push({ kind: 'pinnacle', x: k * -56 + cx * 3.5, z: k * -12 + cz * 3.5, y: 13.5 + 0.8, r: 0.55, h: 2.6, slate: !m });
      box(k * -6, k * -44, 10, 1, 1.6, 'lowwall');
      box(k * -28, k * -31, 1, 10, 1.6, 'lowwall');
      box(k * -26, k * -22, 1.6, 1.6, 1.3, 'crate');
      box(k * -9, k * -33, 1.6, 1.6, 1.3, 'crate');
      circ(k * -26, k * -2.5, 1.5, 2, 'rock');
    });
    // north-east quarter (mirrored to the south-west)
    sym((k, m) => {
      box(k * 22, k * -18, 9, 10, 5, 'house', { tone: 2 });
      box(k * 34, k * -34, 10, 9, 5, 'house', { tone: 0 });
      box(k * 46, k * -12, 9, 8, 5, 'house', { tone: 3 });
      box(k * 12, k * -36, 8, 8, 5, 'house', { tone: 1 });
      box(k * 22, k * -54, 10, 8, 5, 'house', { tone: 2 });
      box(k * 42, k * -54, 9, 9, 5, 'house', { tone: 0 });
      box(k * 54, k * -38, 8, 10, 5, 'house', { tone: 3 });
      box(k * 34, k * -20, 12, 1, 1.6, 'lowwall');
      box(k * 28, k * -26, 1, 12, 1.6, 'lowwall');
      box(k * 14, k * -26, 1.6, 1.6, 1.3, 'crate');
      circ(k * 66, k * -22, 1.8, 2.2, 'rock');
    });
    def.points = [
      { id: 'A', name: 'Town Square',    x: 0,   z: 0,   r: 8, owner: 0 },
      { id: 'B', name: 'Church',         x: -40, z: -22, r: 8, owner: 0 },
      { id: 'C', name: 'Mill',           x: 40,  z: 22,  r: 8, owner: 0 },
      { id: 'D', name: 'North Barracks', x: 0,   z: -50, r: 8, owner: T_BLUE },
      { id: 'E', name: 'South Barracks', x: 0,   z: 50,  r: 8, owner: T_RED },
      { id: 'F', name: 'Orchard',        x: -66, z: -92, r: 8, owner: T_BLUE },
      { id: 'G', name: 'Smithy',         x: 66,  z: -92, r: 8, owner: T_BLUE },
      { id: 'H', name: 'Granary',        x: 66,  z: 92,  r: 8, owner: T_RED },
      { id: 'I', name: 'Old Well',       x: -66, z: 92,  r: 8, owner: T_RED }
    ];
    for (const p of def.points.slice(5)) def.roads.push({ x: p.x, z: p.z, w: 24, d: 24, kind: 'cobble' });
    def.roads.push({ x: 0, z: -92, w: 132, d: 6, kind: 'dirt' }); def.roads.push({ x: 0, z: 92, w: 132, d: 6, kind: 'dirt' });
    fillOuter(lcg(517), 46, [['house', 10, 9, 5], ['house', 9, 8, 5], ['house', 8, 10, 6], ['lowwall', 12, 1, 1.6], ['lowwall', 1, 12, 1.6], ['crate', 1.6, 1.6, 1.3], ['rock', 2, 2, 2.2]]);
    const rng = lcg(21);
    let n = 0, tries = 0;
    while (n < 60 && tries++ < 1600) {
      const x = rnd2(rng, -(H - 6), H - 6), z = rnd2(rng, -(H - 24), 0);
      let ok = Math.abs(x) > 8 && Math.abs(z) > 8;
      if (ok) for (const p of def.points) if (Math.hypot(x - p.x, z - p.z) < p.r + 5) { ok = false; break; }
      if (ok) for (const o of def.obs) if (distToObs(o, x, z) < 3.5) { ok = false; break; }
      if (ok) for (const s of [-1, 1]) { const sp = def.spawn[s === -1 ? T_BLUE : T_RED]; if (Math.abs(z - sp.z) < 14) ok = false; }
      if (!ok) continue;
      circ(x, z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.6 });
      circ(-x, -z, 0.8, 7, 'tree', { s: 0.8 + rng() * 0.6 });
      n++;
    }
  }
  // perimeter walls
  const L = H * 2 + 12;
  box(0, -(H + 1.5), L, 3, 4, 'fence'); box(0, H + 1.5, L, 3, 4, 'fence');
  box(-(H + 1.5), 0, 3, L, 4, 'fence'); box(H + 1.5, 0, 3, L, 4, 'fence');
  // decorative forest outside the walls (no collision)
  const r2 = lcg(99);
  for (let i = 0; i < 160; i++) {
    const a = r2() * Math.PI * 2, d = H + 8 + r2() * 38;
    const x = Math.cos(a) * d * 1.0, z = Math.sin(a) * d * 1.0;
    if (Math.abs(x) < H + 4 && Math.abs(z) < H + 4) continue;
    def.decorTrees.push({ x, z, s: 1 + r2() * 1.1 });
  }
  for (let pass = 0; pass < 6; pass++) separateFaces(def);
  return def;
}
// Two boxes whose faces lie in the same plane and overlap make the GPU flicker between them (z-fighting).
// Nudge the later box's face inwards by 2cm wherever that happens (sides and tops; hidden bottoms don't matter).
function separateFaces(def) {
  const B = def.obs.filter(o => o.t === 'box'), E = 0.02, ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
  const ext = (o) => ({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, y0: o.y0 || 0, y1: o.h, z0: o.z - o.d / 2, z1: o.z + o.d / 2 });
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const a = ext(B[i]), b = ext(B[j]), o = B[j];
    if (a.x1 < b.x0 - 0.1 || b.x1 < a.x0 - 0.1 || a.z1 < b.z0 - 0.1 || b.z1 < a.z0 - 0.1) continue;
    // tops
    if (Math.abs(a.y1 - b.y1) < 0.012 && ov(a.x0, a.x1, b.x0, b.x1) > 0.05 && ov(a.z0, a.z1, b.z0, b.z1) > 0.05 && o.h - E > (o.y0 || 0) + 0.1) o.h -= E;
    // sides (re-read the box after each nudge)
    if (ov(a.y0, a.y1, b.y0, b.y1) < 0.05) continue;
    for (const [lo, hi, c, len, o2lo, o2hi, key, dim] of [['x0', 'x1', 'x', 'w', 'z0', 'z1', 'x', 'w'], ['z0', 'z1', 'z', 'd', 'x0', 'x1', 'z', 'd']]) {
      const bb = ext(o);
      if (ov(a[o2lo], a[o2hi], bb[o2lo], bb[o2hi]) < 0.05) continue;
      if (Math.abs(a[hi] - bb[hi]) < 0.06 && o[dim] > 4 * E) { o[dim] -= E; o[c] -= E / 2; }
      else if (Math.abs(a[lo] - bb[lo]) < 0.06 && o[dim] > 4 * E) { o[dim] -= E; o[c] += E / 2; }
    }
  }
}
function rnd2(rng, a, b) { return a + rng() * (b - a); }

/* ground height under a point for a soldier at height y (floors, wall walks) */
const STEP = 0.65;
function groundAt(def, x, z, y, nc) {
  if (nc || (y < 3.8 && !def.ramps.length)) return 0;
  let g = 0; const P = def.platforms;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.y <= g || y < p.y - STEP) continue;
    if (Math.abs(x - p.x) > p.w / 2 || Math.abs(z - p.z) > p.d / 2) continue;
    let inHole = false;
    if (p.holes) for (const h of p.holes) if (Math.abs(x - h.x) < h.w / 2 && Math.abs(z - h.z) < h.d / 2) { inHole = true; break; }
    if (!inHole) g = p.y;
  }
  const R = def.ramps;
  for (let i = 0; i < R.length; i++) { const r = R[i]; if (Math.abs(x - r.x) > r.w / 2) continue; const t = (z - r.zs) / (r.ze - r.zs); if (t < 0 || t > 1) continue; const h = r.y0 + (r.y1 - r.y0) * t; if (h > g && y >= h - STEP) g = h; }
  return g;
}
function waterAt(def, x, z) { const W = def.water; for (let i = 0; i < W.length; i++) { const w = W[i]; if (Math.abs(x - w.x) <= w.w / 2 && Math.abs(z - w.z) <= w.d / 2) return w; } return null; }
function ladderAt(def, x, z) {
  const L = def.ladders;
  for (let i = 0; i < L.length; i++) { const l = L[i]; if (Math.abs(x - l.x) <= l.w / 2 && Math.abs(z - l.z) <= l.d / 2) return l; }
  return null;
}

/* distance from point to obstacle surface (negative inside) */
function distToObs(o, x, z) {
  if (o.t === 'circle') return Math.hypot(x - o.x, z - o.z) - o.r;
  const hx = o.w / 2, hz = o.d / 2;
  const dx = Math.abs(x - o.x) - hx, dz = Math.abs(z - o.z) - hz;
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
  return Math.max(dx, dz);
}

/* 3D line of sight against walls (windows and the gaps under parapets let shots through) */
function rayClear(def, x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz), n = Math.max(1, Math.ceil(len / 0.3));
  for (let i = 1; i < n; i++) {
    const t = i / n, x = x0 + dx * t, y = y0 + dy * t, z = z0 + dz * t;
    if (y < 0.05) return false;
    const obs = nearObs(def, x, z);
    for (let j = 0; j < obs.length; j++) { const o = obs[j]; if (y < o.h && y >= (o.y0 || 0) && distToObs(o, x, z) < 0.05) return false; }
  }
  return true;
}

/* spatial grid of obstacles so collision only looks at what is nearby */
function obsGrid(def) {
  if (def._grid) return def._grid;
  const C = 8, n = Math.ceil(def.half * 2 / C) + 3, cells = [];
  for (let i = 0; i < n * n; i++) cells.push([]);
  const idx = (v) => clamp(Math.floor((v + def.half) / C) + 1, 0, n - 1);
  for (let i = 0; i < def.obs.length; i++) {
    const o = def.obs[i], hx = o.t === 'circle' ? o.r : o.w / 2, hz = o.t === 'circle' ? o.r : o.d / 2, pad = 1.5;
    const x0 = idx(o.x - hx - pad), x1 = idx(o.x + hx + pad), z0 = idx(o.z - hz - pad), z1 = idx(o.z + hz + pad);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) cells[cz * n + cx].push(o);
  }
  return (def._grid = { C, n, cells, idx });
}
function nearObs(def, x, z) { const g = obsGrid(def); return g.cells[g.idx(z) * g.n + g.idx(x)]; }

/* push circle (x,z,r) out of obstacles; returns [x,z] adjusted. y = feet height */
function resolveObstacles(def, p, r) {
  for (let pass = 0; pass < 2; pass++) {
    const obs = nearObs(def, p.x, p.z);
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (p.y >= o.h - 0.05) continue; // vaulted over low obstacle
      if (o.y0 && p.y + 1.9 <= o.y0) continue; // passes under (gate walkways, doorways)
      if (o.t === 'circle') {
        const dx = p.x - o.x, dz = p.z - o.z, rr = o.r + r;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 0.0001;
          p.x = o.x + dx / d * rr; p.z = o.z + dz / d * rr;
        }
      } else {
        const hx = o.w / 2, hz = o.d / 2;
        const cx = clamp(p.x, o.x - hx, o.x + hx), cz = clamp(p.z, o.z - hz, o.z + hz);
        const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            p.x = cx + dx / d * r; p.z = cz + dz / d * r;
          } else {
            // centre inside the box: push out along smallest penetration
            const px = hx + r - Math.abs(p.x - o.x), pz = hz + r - Math.abs(p.z - o.z);
            if (px < pz) p.x += (p.x >= o.x ? 1 : -1) * px; else p.z += (p.z >= o.z ? 1 : -1) * pz;
          }
        }
      }
    }
  }
  const lim = def.half - r - 0.5;
  p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
}

/* ---------- navigation ---------- */
class Nav {
  constructor(def) {
    this.def = def; this.half = def.half;
    // coarse grid for A*
    this.C = 2; this.n = Math.ceil(def.half * 2 / this.C);
    this.blocked = new Uint8Array(this.n * this.n);
    // fine grid for line of sight
    this.F = 1; this.fn = Math.ceil(def.half * 2 / this.F);
    this.fine = new Uint8Array(this.fn * this.fn);
    for (let cz = 0; cz < this.n; cz++) for (let cx = 0; cx < this.n; cx++) {
      const x = -this.half + (cx + 0.5) * this.C, z = -this.half + (cz + 0.5) * this.C;
      this.blocked[cz * this.n + cx] = this.pointBlocked(x, z, 1.1) ? 1 : 0;
    }
    for (let cz = 0; cz < this.fn; cz++) for (let cx = 0; cx < this.fn; cx++) {
      const x = -this.half + (cx + 0.5) * this.F, z = -this.half + (cz + 0.5) * this.F;
      this.fine[cz * this.fn + cx] = this.pointBlocked(x, z, 0.62) ? 1 : 0;
    }
    this.cost = new Float32Array(this.n * this.n).fill(1); this.wat = new Uint8Array(this.fn * this.fn);
    if (def.water.length) {
      for (let i = 0; i < this.n * this.n; i++) { const w = waterAt(def, -this.half + ((i % this.n) + 0.5) * this.C, -this.half + (((i / this.n) | 0) + 0.5) * this.C); if (w && !w.ice) this.cost[i] = 5; }
      for (let i = 0; i < this.fn * this.fn; i++) { const w = waterAt(def, -this.half + ((i % this.fn) + 0.5) * this.F, -this.half + (((i / this.fn) | 0) + 0.5) * this.F); if (w && !w.ice) this.wat[i] = 1; }
    }
    // connected regions of the path grid, so a goal sealed off from the start (a tower interior) fails at once
    const NN = this.n * this.n, nn = this.n;
    this.comp = new Int32Array(NN).fill(-1);
    const stack = new Int32Array(NN); let cid = 0;
    for (let i0 = 0; i0 < NN; i0++) {
      if (this.blocked[i0] || this.comp[i0] >= 0) continue;
      let sp = 0; stack[sp++] = i0; this.comp[i0] = cid;
      while (sp > 0) {
        const cur = stack[--sp], cx = cur % nn, cz = (cur / nn) | 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const x2 = cx + dx, z2 = cz + dz; if (x2 < 0 || z2 < 0 || x2 >= nn || z2 >= nn) continue;
          const ni = z2 * nn + x2; if (this.blocked[ni] || this.comp[ni] >= 0) continue;
          if (dx && dz && (this.blocked[cz * nn + x2] || this.blocked[z2 * nn + cx])) continue;
          this.comp[ni] = cid; stack[sp++] = ni;
        }
      }
      cid++;
    }
    const N = this.n * this.n;
    this.g = new Float32Array(N); this.came = new Int32Array(N); this.stamp = new Int32Array(N); this.closed = new Int32Array(N);
    this.ver = 0;
    this.heap = new Int32Array(N + 8); this.hf = new Float32Array(N + 8); this.hn = 0;
  }
  pointBlocked(x, z, rad) {
    const lim = this.half - 1.2;
    if (Math.abs(x) > lim || Math.abs(z) > lim) return true;
    const obs = nearObs(this.def, x, z); // only the obstacles in this 8m cell (they are padded by 1.5m, more than any radius used here)
    for (let i = 0; i < obs.length; i++) { if (obs[i].y0 >= 1.9) continue; if (distToObs(obs[i], x, z) < rad) return true; }
    return false;
  }
  cellOf(x, z) {
    const cx = clamp(Math.floor((x + this.half) / this.C), 0, this.n - 1);
    const cz = clamp(Math.floor((z + this.half) / this.C), 0, this.n - 1);
    return cz * this.n + cx;
  }
  centerOf(i) { const cx = i % this.n, cz = (i / this.n) | 0; return { x: -this.half + (cx + 0.5) * this.C, z: -this.half + (cz + 0.5) * this.C }; }
  nearestFreeCell(i) {
    if (!this.blocked[i]) return i;
    const n = this.n, cx0 = i % n, cz0 = (i / n) | 0;
    for (let r = 1; r < 14; r++) {
      let best = -1, bd = 1e9;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx, cz = cz0 + dz;
        if (cx < 0 || cz < 0 || cx >= n || cz >= n) continue;
        const j = cz * n + cx;
        if (!this.blocked[j]) { const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = j; } }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  nearestFreePoint(x, z) {
    const c = this.nearestFreeCell(this.cellOf(x, z));
    return c < 0 ? { x: 0, z: 0 } : this.centerOf(c);
  }
  fineBlocked(x, z) {
    const cx = Math.floor((x + this.half) / this.F), cz = Math.floor((z + this.half) / this.F);
    if (cx < 0 || cz < 0 || cx >= this.fn || cz >= this.fn) return true;
    return this.fine[cz * this.fn + cx] === 1;
  }
  los(ax, az, bx, bz, nw) {
    const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
    if (d < 0.01) return true;
    const steps = Math.ceil(d / 0.6);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = ax + dx * t, pz = az + dz * t; if (this.fineBlocked(px, pz)) return false;
      if (nw && this.wat[Math.floor((pz + this.half) / this.F) * this.fn + Math.floor((px + this.half) / this.F)]) return false;
    }
    return true;
  }
  // binary heap helpers
  _push(node, f) {
    let i = this.hn++; const H = this.heap, F = this.hf;
    while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; H[i] = H[p]; F[i] = F[p]; i = p; }
    H[i] = node; F[i] = f;
  }
  _pop() {
    const H = this.heap, F = this.hf; const top = H[0];
    const ln = H[--this.hn], lf = F[this.hn];
    let i = 0; const n = this.hn;
    while (true) {
      let c = i * 2 + 1; if (c >= n) break;
      if (c + 1 < n && F[c + 1] < F[c]) c++;
      if (F[c] >= lf) break;
      H[i] = H[c]; F[i] = F[c]; i = c;
    }
    if (n > 0) { H[i] = ln; F[i] = lf; }
    return top;
  }
  findPath(sx, sz, gx, gz) {
    const n = this.n;
    let s = this.nearestFreeCell(this.cellOf(sx, sz)), g = this.nearestFreeCell(this.cellOf(gx, gz));
    if (s < 0 || g < 0 || this.comp[s] !== this.comp[g]) return null;
    const gc = this.centerOf(g);
    const goalPt = this.blocked[this.cellOf(gx, gz)] ? gc : { x: gx, z: gz };
    if (s === g) return [goalPt];
    const ver = ++this.ver;
    this.hn = 0;
    this.g[s] = 0; this.stamp[s] = ver; this.came[s] = -1;
    const gcx = g % n, gcz = (g / n) | 0;
    const hfn = (i) => { const dx = Math.abs((i % n) - gcx), dz = Math.abs(((i / n) | 0) - gcz); return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz); };
    this._push(s, hfn(s));
    const D8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
    let found = false, iter = 0;
    while (this.hn > 0 && iter++ < 12000) {
      const cur = this._pop();
      if (this.closed[cur] === ver) continue;
      this.closed[cur] = ver;
      if (cur === g) { found = true; break; }
      const cx = cur % n, cz = (cur / n) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = D8[k][0], dz = D8[k][1];
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (this.blocked[ni]) continue;
        if (dx !== 0 && dz !== 0 && (this.blocked[cz * n + nx] || this.blocked[nz * n + cx])) continue;
        const ng = this.g[cur] + D8[k][2] * this.cost[ni];
        if (this.stamp[ni] !== ver || ng < this.g[ni]) {
          this.stamp[ni] = ver; this.g[ni] = ng; this.came[ni] = cur;
          this._push(ni, ng + hfn(ni));
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = g; c !== -1; c = this.came[c]) cells.push(c);
    cells.reverse();
    const pts = [{ x: sx, z: sz }];
    for (let i = 1; i < cells.length - 1; i++) pts.push(this.centerOf(cells[i]));
    pts.push(goalPt);
    // string pulling
    const out = []; let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(pts[i].x, pts[i].z, pts[j].x, pts[j].z, true)) j--;
      out.push(pts[j]); i = j;
    }
    return out;
  }
}

/* ---------- soldiers ---------- */
let nextId = 1;
class Soldier {
  constructor(match, team, isPlayer, weaponId, look) {
    this.m = match; this.id = nextId++; this.team = team; this.isPlayer = isPlayer; this.look = look || team;
    const cid = CLASSES[weaponId] ? weaponId : (LEGACY_CLASS[weaponId] || 'knight');
    this.cls = cid; this.cdef = CLASSES[cid];
    this.weapon = WEAPONS[LEGACY_CLASS[weaponId] && weaponId !== 'sword' ? weaponId : this.cdef.weapon] || WEAPONS.sword;
    this.armor = this.cdef.armor; this.regenMul = 1; this.loaded = true; this.reloadT = 0; this.blockT = 0; this.atkBuf = 0; this.carrying = false;
    this.maxHp = this.cdef.hp * (match.hpMul || 1);
    this.name = isPlayer ? 'You' : match.mode === 'ffa' ? 'Knight ' + this.id : (team === T_BLUE ? 'Blue' : 'Red') + ' Knight ' + this.id;
    this.kills = 0; this.deaths = 0; this.dmgDealt = 0;
    this.input = { mx: 0, mz: 0, yaw: 0, attack: false, block: false, sprint: false, jump: false, aim: null };
    this.drawT = -1; this._aim = { x: 0, y: 0, z: 0 }; this.ladderCd = 0; this.teamKills = 0;
    this.ai = { t: Math.random() * 0.3, target: null, role: 'attack', obj: -1, ox: 0, oz: 0, blockT: 0, reactId: -1, path: null, pi: 0, pathT: 0, pgx: 0, pgz: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 1, wanderT: 0, chkT: 0.8, cx: 0, cz: 0, stuck: 0, sideT: 0, side: 1, skill: rnd(0.8, 1.2), moved: false, drawGoal: 0.7, tw: null, twCd: rnd(2, 10), reck: false };
    this.speedBase = (isPlayer ? 5.4 : 4.5) * rnd(0.95, 1.05) * this.cdef.speed;
    this.respawnDelay = isPlayer ? 5 : rnd(5, 9);
    this.spawn();
    this.alive = true; this.deadT = 0;
  }
  setClass(cid) { // used by the online client to mirror the server's choice
    if (!CLASSES[cid]) return;
    this.cls = cid; this.cdef = CLASSES[cid]; this.weapon = WEAPONS[this.cdef.weapon] || WEAPONS.sword; this.armor = this.cdef.armor;
    this.maxHp = this.cdef.hp * (this.m.hpMul || 1);
  }
  spawn(pos) {
    const m = this.m;
    const p = pos || m.pickSpawn(this.team, this);
    this.x = p.x; this.z = p.z; this.y = p.y || 0; this.vy = 0; this.vx = 0; this.vz = 0;
    this.yaw = m.mode === 'ffa' ? rnd(0, Math.PI * 2) : this.team === T_BLUE ? 0 : Math.PI; // face the enemy base
    this.input.yaw = this.yaw;
    this.hp = this.maxHp; this.alive = true; this.deadT = 0; this.respawnT = 0;
    this.atkT = -1; this.atkHit = false; this.atkSeq = 0; this.cdT = 0.3; this.blocking = false; this.drawT = -1; this.ladderCd = 0;
    this.stamina = 100; this.stagger = 0; this.lastAttacker = null; this.lastHitT = -99; this.sprinting = false; this.sprintLock = 0;
    this.ai.path = null; this.ai.target = null; this.ai.stuck = 0; this.ai.cx = this.x; this.ai.cz = this.z; this.ai.tw = null; this.ai.twCd = rnd(4, 14);
    this.lastCombat = -99; this.lastDmgT = -99; this.regenAcc = 0; this.burnT = 0; this.sw = this.sw || 0; this.loaded = true; this.reloadT = 0; this.atkBuf = 0; this.blockT = 0; this.regening = false;
  }
  get speed() { return Math.hypot(this.vx, this.vz); }

  step(dt) {
    const m = this.m, w = this.weapon, inp = this.input;
    if (!this.alive) {
      this.deadT += dt;
      this.respawnT -= dt;
      if (this.respawnT <= 0 && !m.ended) { this.spawn(); m.emit('respawn', this); }
      return;
    }
    this.cdT -= dt; this.stagger -= dt; this.sprintLock -= dt; if (this._grace > 0) this._grace -= dt;
    if (this.burnT > 0) { this.burnT -= dt; if (!this.god) this.hp -= 6 * dt; if (this.hp <= 0) { m.kill(this, this.lastAttacker); return; } }
    // blocking
    const ranged = !!w.ranged;
    if (!ranged && this.drawT >= 0) this.drawT = -1;
    const canBlock = !ranged && this.atkT < 0 && this.stagger <= 0 && this.stamina > 0;
    const wasBlk = this.blocking;
    this.blocking = !!(inp.block && canBlock);
    if (this.blocking) this.blockT = wasBlk ? this.blockT + dt : 0; else this.blockT = 9; // blockT = how long the guard has been up (a fresh guard can parry)
    if (!ranged) { if (inp.attack) this.atkBuf = 0.2; else this.atkBuf -= dt; } // brief input buffer: a click just before the swing is ready still swings
    // start attack
    if (!ranged && (inp.attack || this.atkBuf > 0) && this.atkT < 0 && this.cdT <= 0 && !this.blocking && this.stagger <= 0) {
      this.atkT = 0; this.atkHit = false; this.atkSeq++; this.atkBuf = 0;
      const lg = w.lunge || 0; if (lg && !this.horse && !this.mount) { this.vx += Math.sin(this.yaw) * lg; this.vz += Math.cos(this.yaw) * lg; } // step into the blow
      m.emit('swing', this);
    }
    // bow: hold to draw, release to loose
    if (ranged && w.xbow && !this.mount) {
      // crossbow: shot is already wound; pull the trigger to loose it, then a long reload
      if (!this.loaded) { this.reloadT -= dt * (this.speed > 3 ? 0.8 : 1); if (this.reloadT <= 0) { this.loaded = true; this.reloadT = 0; m.emit('reloaded', this); } }
      else if (inp.attack && this.cdT <= 0 && this.stagger <= 0) { m.fireArrow(this, 1); this.loaded = false; this.reloadT = w.reload; this.cdT = w.cd; this.drawT = -1; }
      this.drawT = -1;
    } else if (ranged) {
      const mb = this.mount, ready = !mb || (mb.cd <= 0 && !mb.pend); // a siege weapon must be reloaded before it can be wound again
      if (inp.attack && this.cdT <= 0 && this.stagger <= 0 && ready) {
        if (this.drawT < 0) { this.drawT = 0; m.emit('draw', this); }
        this.drawT = Math.min(w.draw, this.drawT + dt);
      } else if (this.drawT >= 0) {
        if (this.drawT >= (mb ? 0.22 : (w.minDraw || 0.22)) && this.stagger <= 0) { if (mb) { m.shootMount(this, mb, Math.min(1, this.drawT / w.draw)); this.cdT = 0.2; } else { m.fireArrow(this, Math.min(1, this.drawT / w.draw)); this.cdT = w.cd; } }
        this.drawT = -1;
      }
    }
    if (this.atkT >= 0) {
      this.atkT += dt;
      if (!this.atkHit && this.atkT >= w.hit) { this.atkHit = true; m.resolveHit(this); }
      if (this.atkT >= w.dur) { this.atkT = -1; this.cdT = w.cd + (this.isPlayer ? 0 : rnd(0.1, 0.5) / this.ai.skill); }
    }
    if (this.mount) { const b = this.mount; this.x = b.x; this.z = b.z; this.y = b.y; this.vx = this.vz = this.vy = 0; this.yaw = this.isPlayer ? inp.yaw : this.yaw + clamp(angDiff(this.yaw, inp.yaw), -8.5 * dt, 8.5 * dt); return; }
    // movement
    let mx = inp.mx, mz = inp.mz;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const wz = m.def.water.length ? waterAt(m.def, this.x, this.z) : null, swim = !!(wz && !wz.ice && this.y < 0.5 && !this.fly);
    this.sw += ((swim ? 1 : 0) - this.sw) * Math.min(1, dt * 6);
    let sp = this.speedBase * (this.isPlayer ? 1 : this.m.speedMulFor(this));
    if (swim) sp *= 0.5; if (this.horse) sp *= 1.8; if (this.fly) sp *= 1.7;
    if (this.blocking) sp *= 0.55;
    if (this.atkT >= 0) sp *= 0.62;
    if (this.drawT >= 0) sp *= 0.42;
    if (w.xbow && !this.loaded) sp *= 0.82;
    if (this.carrying) sp *= 0.9;
    if (this.stagger > 0) sp *= 0.35;
    const drg = (inp.drag && !this.horse && !this.fly && !this.admin && this.y < 1 && !swim) ? m.dragTarget(this) : null;
    if (drg) sp = Math.min(sp, 0.9); // dragging a catapult is very slow
    this.dragging = drg;
    this.sprinting = false;
    if (!drg && inp.sprint && !swim && ml > 0.1 && !this.blocking && this.atkT < 0 && this.drawT < 0 && (this.admin || (this.stamina > 4 && this.sprintLock <= 0))) {
      sp *= 1.6; this.sprinting = true; if (!this.admin) { this.stamina -= 20 * dt;
      if (this.stamina <= 4) this.sprintLock = 1.2; }
    }
    const k = Math.min(1, dt * 9);
    this.vx += (mx * sp - this.vx) * k; this.vz += (mz * sp - this.vz) * k;
    const px0 = this.x, pz0 = this.z;
    this.x += this.vx * dt; this.z += this.vz * dt;
    // vertical: ladders, jumping, gravity, floors
    const def = m.def;
    let gy = groundAt(def, this.x, this.z, this.y, this.admin), climbing = false, railed = false;
    const lad = ((this.isPlayer || this.ai.tw || this.ai.climb) && !this.horse && !this.fly) ? ladderAt(def, this.x, this.z) : null;
    this.ladderCd -= dt;
    if (lad && this.ladderCd <= 0) {
      const fwd = mx * Math.sin(this.yaw) + mz * Math.cos(this.yaw);
      const facingWall = Math.sin(this.yaw) * lad.nx + Math.cos(this.yaw) * lad.nz > 0.2; // climb only while facing the ladder
      if (inp.jump && this.y > gy + 0.3) { this.ladderCd = 0.45; this.vy = 4; }
      else if (!facingWall) { if (this.y > gy + 0.05 && this.y <= lad.y1 + 0.01) { this.vy = 0; climbing = true; } }
      else if (fwd > 0.3 && this.y < lad.y1 - 0.001) { this.y = Math.min(lad.y1, this.y + 3.4 * dt); this.vy = 0; climbing = true; railed = true; }
      else if (fwd < -0.3 && this.y > gy + 0.02) { this.y = Math.max(gy, this.y - 3.4 * dt); this.vy = 0; climbing = true; railed = true; }
      else if (this.y > gy + 0.05 && this.y <= lad.y1 + 0.01) { this.vy = 0; climbing = true; railed = true; }
    }
    if (climbing) {
      this.vx *= 0.6; this.vz *= 0.6;
      // stay against the wall while on the rungs (turn round or step sideways to get off)
      if (!railed) { /* turned away: free to walk off */ }
      else if (Math.abs(lad.nx) > 0.5) { this.x = clamp(this.x, lad.x - lad.w / 2 + 0.12, lad.x + lad.w / 2 - 0.12); this.vx = 0; }
      else { this.z = clamp(this.z, lad.z - lad.d / 2 + 0.12, lad.z + lad.d / 2 - 0.12); this.vz = 0; }
    }
    else {
      if (this.fly) { this.vy = inp.jump ? 10 : inp.down ? -10 : 0; this.y += this.vy * dt; }
      else {
        if (inp.jump && !swim && this.y <= gy + 0.001) this.vy = 7.2;
        this.vy -= 22 * dt; this.y += this.vy * dt;
        if (def.ramps.length && this.vy < 0 && this.vy > -6 && this.y > gy && this.y - gy < 0.5) this.y = gy;
      }
    }
    gy = groundAt(def, this.x, this.z, this.y, this.admin);
    if (this.y <= gy) {
      const imp = -this.vy;
      this.y = gy; this.vy = 0;
      if (imp > 13 && this.alive && !this.god && !(this._grace > 0)) {
        const dmg = (imp - 13) * 4; this.hp -= dmg; m.emit('fall', { e: this, dmg });
        if (this.hp <= 0) m.kill(this, null);
      }
    }
    if (this.admin) { const lim = m.def.half - 1; this.x = clamp(this.x, -lim, lim); this.z = clamp(this.z, -lim, lim); } else resolveObstacles(m.def, this, 0.5);
    if (drg) m.dragCat(this, drg, this.x - px0, this.z - pz0, dt);
    if (this.horse) { this.horse.x = this.x; this.horse.z = this.z; this.horse.yaw = this.yaw; }
    // facing
    if (this.isPlayer) this.yaw = inp.yaw;
    else {
      const d = angDiff(this.yaw, inp.yaw), rate = 8.5 * dt;
      this.yaw += clamp(d, -rate, rate);
    }
    // stamina regen
    if (!this.sprinting && !this.blocking) this.stamina = Math.min(100, this.stamina + 16 * dt);
    else if (this.blocking) this.stamina = Math.min(100, this.stamina + 4 * dt);
    // natural health regeneration: slowly, after a spell without taking damage (modes can scale or switch it off)
    this.regening = false;
    if (!this.isKing && this.burnT <= 0 && this.hp < this.maxHp && m.elapsed - this.lastDmgT > REGEN_DELAY && this.regenMul * m.regenMul > 0) {
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * REGEN_RATE * this.regenMul * m.regenMul * dt); this.regening = true;
    }
  }
}

/* ---------- match ---------- */
class Match {
  constructor(cfg) {
    this.cfg = Object.assign({ map: 'castle', mode: 'conquest', team: T_BLUE, n: 12, duration: 360, difficulty: 'normal', weapon: 'sword' }, cfg);
    const c = this.cfg;
    this.ffa = c.mode === 'ffa';
    if (this.ffa) c.team = 1; // the player is fighter 1
    this.def = buildMap(c.map);
    this.nav = new Nav(this.def);
    this.mode = c.mode;
    this.hpMul = c.mode === 'ironsquad' ? 2 : 1; this.regenMul = 1; // Iron Squad: double health for everyone
    this.listeners = [];
    this.time = c.duration; this.elapsed = 0; this.ended = false; this.winner = 0;
    this.scores = { 1: 0, 2: 0 };
    this.target = c.mode === 'conquest' ? 100 * this.def.points.length : this.ffa ? 0 : (c.mode === 'manhunt' || c.mode === 'laststand' || c.mode === 'champion') ? 1e9 : c.mode === 'kingstandard' ? 150 : Math.max(30, c.n * 5);
    this.points = this.def.points.map((p, i) => ({ idx: i, id: p.id, name: p.name, x: p.x, z: p.z, r: p.r, owner: p.owner, v: p.owner === T_BLUE ? 100 : p.owner === T_RED ? -100 : 0, bCount: 0, rCount: 0 }));
    this.scoreT = 0; this.assignT = 0; this.pathBudget = 0;
    this.diff = DIFF[c.difficulty] || DIFF.normal;
    this.soldiers = [];
    this.arrows = []; this.arrowSeq = 1;
    this.stats = { captures: 0 };
    const H = c.humans && c.humans.length ? c.humans : null; // online match: a list of human fighters {id,name,team,cls}
    const rangedOnly = c.mode === 'archers';
    const wpick = () => { if (rangedOnly) return Math.random() < 0.62 ? 'archer' : 'crossbowman'; const r = Math.random(); return r < 0.3 ? 'knight' : r < 0.52 ? 'spearman' : r < 0.72 ? 'archer' : r < 0.84 ? 'crossbowman' : 'scout'; };
    let pw = c.cls && CLASSES[c.cls] ? c.cls : c.weapon;
    if (rangedOnly && !(pw === 'archer' || pw === 'crossbowman' || pw === 'bow')) pw = 'archer'; // Archer's Gambit: ranged classes only
    if (this.ffa) {
      // free for all: every fighter is their own side
      for (let i = 0; i < c.n; i++) {
        const team = i + 1; this.scores[team] = 0;
        const hu = H && H[i];
        const so = new Soldier(this, team, H ? !!hu : i === 0, H ? (hu ? hu.cls : wpick()) : i === 0 ? pw : wpick(), i === 0 ? 1 : 2 + ((i - 1) % 7));
        if (hu) { so.hid = hu.id; so.name = hu.name; }
        this.soldiers.push(so);
      }
    } else for (const team of [T_BLUE, T_RED]) {
      for (let i = 0, cnt = c.mode === 'siege' && team === T_BLUE ? Math.round(c.n * 1.2) : c.n; i < cnt; i++) {
        const hu = H ? H.filter(h => h.team === team)[i] : null;
        const isP = H ? !!hu : team === c.team && i === 0;
        const so = new Soldier(this, team, isP, H ? (hu ? hu.cls : wpick()) : isP ? pw : wpick());
        if (hu) { so.hid = hu.id; so.name = hu.name; }
        this.soldiers.push(so);
      }
    }
    this.player = this.soldiers.find(s => s.isPlayer);
    if (!H) this.player.name = 'You';
    this.setupMode();
    this.assignObjectives(T_BLUE); this.assignObjectives(T_RED);
    if (this.mode === 'siege') this.setupSiege();
  }
  /* ----- special modes ----- */
  setupMode() {
    const mo = this.mode, S = this.soldiers, P = this.player, special = (s, mul, nm) => { s.maxHp = s.hp = Math.round(s.maxHp * mul); s.respawnDelay = 1e9; s.name = nm; };
    if (mo === 'manhunt') { // Blue is hunted: its target (you, if you fight for Blue) must live until the clock runs out
      const t = P.team === T_BLUE ? P : S.find(q => q.team === T_BLUE && !q.isPlayer);
      t.isTarget = true; this.hunted = t; special(t, 1.6, t.isPlayer ? 'You (target)' : 'The Target'); t.speedBase *= 1.1; t.regenMul = 0.5;
    } else if (mo === 'champion') { // each side has a champion; when one falls, that side loses
      this.champs = {};
      for (const team of [T_BLUE, T_RED]) {
        const c = team === P.team ? P : S.filter(q => q.team === team && !q.isPlayer)[0];
        c.isChampion = true; this.champs[team] = c; special(c, 1.8, c.isPlayer ? 'You (champion)' : (team === T_BLUE ? 'Blue' : 'Red') + ' Champion'); c.regenMul = 0.6;
      }
    } else if (mo === 'kingstandard') {
      const q = this.nav.nearestFreePoint(0, 0); this.banner = { x: q.x, z: q.z, y: 0, home: { x: q.x, z: q.z }, carrier: null, team: 0, cd: 1, t: 0 };
    } else if (mo === 'laststand') { // the Red defenders hold the centre-most point; Blue must take and hold it
      let bp = this.points[0], bd = 1e9; for (const p of this.points) { const d = Math.hypot(p.x, p.z); if (d < bd) { bd = d; bp = p; } }
      bp.r = Math.max(bp.r, 10); bp.owner = T_RED; bp.v = -100; this.points = [bp]; bp.idx = 0; this.stand = bp;
      for (const q of S) if (q.team === T_RED) q.spawn();
    }
  }
  stepMode(dt) {
    const b = this.banner;
    if (this.mode === 'kingstandard' && b) {
      if (b.carrier && !b.carrier.alive) this.dropBanner();
      if (!b.carrier) {
        b.cd -= dt;
        if (b.cd <= 0) { let best = null, bd = 2.4; for (const s of this.soldiers) { if (!s.alive || s.admin || s.mount || Math.abs(s.y - b.y) > 2) continue; const d = Math.hypot(s.x - b.x, s.z - b.z); if (d < bd) { bd = d; best = s; } } if (best) { b.carrier = best; best.carrying = true; b.team = best.team; this.emit('bannerup', best); } }
      } else { b.x = b.carrier.x; b.z = b.carrier.z; b.y = b.carrier.y; b.t += dt; while (b.t >= 1) { b.t -= 1; this.scores[b.team] += 1; this.checkEnd(); } }
    }
    if (this.mode === 'laststand' && this.stand && this.stand.owner === T_BLUE) this.finish(T_BLUE);
  }
  dropBanner() { const b = this.banner; if (!b || !b.carrier) return; b.carrier.carrying = false; b.carrier = null; b.cd = 1.5; this.emit('bannerdrop', b); }
  modeGoal(s) {
    const mo = this.mode, S = this.soldiers;
    if (mo === 'manhunt') {
      const t = this.hunted; if (!t || !t.alive) return null;
      if (s === t) { // the hunted AI runs from the nearest hunter
        let e = null, bd = 1e9; for (const o of S) if (o.alive && o.team !== s.team) { const d = Math.hypot(o.x - s.x, o.z - s.z); if (d < bd) { bd = d; e = o; } }
        if (!e) return null; const dd = bd || 1, lim = this.def.half - 12, q = this.nav.nearestFreePoint(clamp(s.x + (s.x - e.x) / dd * 24, -lim, lim), clamp(s.z + (s.z - e.z) / dd * 24, -lim, lim));
        return { x: q.x, z: q.z, near: 3, sprint: bd < 30 };
      }
      return s.team === t.team ? { x: t.x, z: t.z, near: 7 } : { x: t.x, z: t.z, near: 2, sprint: true };
    }
    if (mo === 'champion') {
      const own = this.champs[s.team], foe = this.champs[s.team === T_BLUE ? T_RED : T_BLUE];
      if (s.isChampion) return null;
      if (own && own.alive && s.id % 3 === 0) return { x: own.x, z: own.z, near: 6 };
      return foe && foe.alive ? { x: foe.x, z: foe.z, near: 2, sprint: true } : null;
    }
    if (mo === 'kingstandard' && this.banner) {
      const b = this.banner;
      if (!b.carrier) return { x: b.x, z: b.z, near: 2.2, sprint: true };
      if (b.carrier === s) { const sp = this.def.spawn[s.team]; return { x: sp.x, z: sp.z, near: 14 }; }
      if (b.carrier.team === s.team) return s.id % 2 ? { x: b.x, z: b.z, near: 7 } : null;
      return { x: b.x, z: b.z, near: 2, sprint: true };
    }
    return null;
  }
  on(fn) { this.listeners.push(fn); }
  emit(type, data) { for (const f of this.listeners) f(type, data); }
  speedMulFor(s) { return s.team !== this.cfg.team ? this.diff.speed : 1; }

  pickSpawn(team, self) {
    if (this.ffa) {
      const nav = this.nav, lim = this.def.half - 10;
      if (this.mainComp === undefined) this.mainComp = nav.comp[nav.nearestFreeCell(nav.cellOf(this.def.spawn[T_BLUE].x, this.def.spawn[T_BLUE].z))];
      let best = null, bs = -1;
      for (let tries = 0; tries < 60; tries++) {
        const x = rnd(-lim, lim), z = rnd(-lim, lim);
        if (nav.pointBlocked(x, z, 1.1) || nav.comp[nav.cellOf(x, z)] !== this.mainComp) continue; // open ground only, never sealed tower rooms
        let md = 1e9;
        for (const o of this.soldiers) if (o !== self && o.alive && o.x !== undefined) md = Math.min(md, Math.hypot(o.x - x, o.z - z));
        if (md > bs) { bs = md; best = { x, z }; }
        if (md > 35) break;
      }
      return best || nav.nearestFreePoint(this.def.spawn[T_BLUE].x, this.def.spawn[T_BLUE].z);
    }
    if (this.mode === 'siege' && team === T_RED && this.def.roofY) {
      // defenders always appear on the keep roof and run down the ramp
      for (let tries = 0; tries < 30; tries++) {
        const x = rnd(-13, 13), zz = rnd(31, 44); let ok = true;
        if (this.soldiers) for (const o of this.soldiers) if (o !== self && o.alive && o.x !== undefined && Math.abs(o.y - this.def.roofY) < 2 && Math.hypot(o.x - x, o.z - zz) < 1.3) { ok = false; break; }
        if (ok) return { x, z: zz, y: this.def.roofY };
      }
      return { x: 0, z: 40, y: this.def.roofY };
    }
    if (this.mode === 'laststand' && team === T_RED && this.stand) {
      const nav = this.nav, st = this.stand;
      if (this.mainComp === undefined) this.mainComp = nav.comp[nav.nearestFreeCell(nav.cellOf(this.def.spawn[T_BLUE].x, this.def.spawn[T_BLUE].z))];
      for (let tries = 0; tries < 40; tries++) { const a = rnd(0, 6.283), r = rnd(3, st.r * 1.3), x = st.x + Math.cos(a) * r, zz = st.z + Math.sin(a) * r; if (nav.pointBlocked(x, zz, 1.0) || nav.comp[nav.cellOf(x, zz)] !== this.mainComp) continue; return { x, z: zz }; }
      return nav.nearestFreePoint(st.x, st.z);
    }
    const z = this.def.spawn[team];
    for (let tries = 0; tries < 24; tries++) {
      const x = z.x + rnd(-z.w / 2, z.w / 2), zz = z.z + rnd(-z.d / 2, z.d / 2);
      const p = this.nav.pointBlocked(x, zz, 0.8) ? this.nav.nearestFreePoint(x, zz) : { x, z: zz };
      let ok = true;
      if (this.soldiers) for (const o of this.soldiers) if (o !== self && o.alive && o.x !== undefined && Math.hypot(o.x - p.x, o.z - p.z) < 1.3) { ok = false; break; }
      if (ok) return p;
    }
    return this.nav.nearestFreePoint(z.x, z.z);
  }

  /* ----- siege ----- */
  setupSiege() {
    const d = this.def, S = this.soldiers;
    this.gate = d.obs.find(o => o.kind === 'gate'); this.gateOpen = false; this.phase = 0;
    this.horses = d.horses.map(h => ({ x: h.x, z: h.z, ox: h.x, oz: h.z, yaw: 0, rider: null, hp: 160, max: 160, alive: true, deadT: 0, flash: 0 }));
    const wst = { cd: 0, wind: 0, shotT: 99, pend: null, pitch: 0 };
    this.ballistas = d.ballistas.map(b => Object.assign({ x: b.x, z: b.z, y: b.y, op: null, yaw: Math.PI }, wst)).concat((d.catapults || []).map(c => Object.assign({ x: c.x, z: c.z, y: 0, op: null, cat: true, yaw: 0 }, wst)));
    this.catapults = this.ballistas.filter(b => b.cat);
    this.ram = { x: d.ram.x, z: d.ram.z, crew: 0, t: 0 };
    let hi = 0, ai = 0, di = 0, catN = 0;
    for (const s of S) {
      if (s.isPlayer) continue;
      if (s.team === T_BLUE) {
        const k = ai++; s.ai.climb = true; s.ai.li = k; s.ai.role = k % 5 === 0 ? 'ram' : 'ladder'; s.ramOp = s.ai.role === 'ram';
        if (k % 5 === 2 && this.catapults.length && (catN < this.catapults.length)) { s.ai.role = 'cat'; s.ai.cat = catN++; s.ramOp = false; } // one crewman per catapult
        if (k % 5 === 4 && hi < Math.ceil(this.horses.length / 2)) { const h = this.horses[hi++]; s.x = h.x; s.z = h.z; h.rider = s; s.horse = h; }
      } else {
        const p = d.posts[di++ % d.posts.length]; s.ai.post = p; s.ai.jx = rnd(-1, 1);
        // at the very start of the match the ballista crews and wall guards already stand at their posts;
        // everyone else (and every defender who respawns later) appears on the keep roof and runs down the ramp
        if (p.kind === 'ballista' || p.kind === 'wall' || p.kind === 'patrol') { s.x = p.x + (p.kind === 'ballista' ? 0 : s.ai.jx); s.z = p.z; s.y = p.y || 0; }
        else { const sp0 = this.pickSpawn(T_RED, s); s.x = sp0.x; s.z = sp0.z; s.y = sp0.y || 0; }
        s.ai.cx = s.x; s.ai.cz = s.z;
        if (p.bow) s.weapon = WEAPONS.bow;
        
        s.yaw = s.input.yaw = Math.PI;
      }
    }
    const K = new Soldier(this, T_RED, false, 'sword', 5);
    K.isKing = true; K.name = 'The King'; K.maxHp = K.hp = 900; K.respawnDelay = 1e9; K.speedBase = 3.8; K.x = 0; K.z = 46; K.y = 0;
    S.push(K); this.king = K;
  }
  mountB(s, b) { this.dismount(s); b.op = s; s.mount = b; s.prevW = s.weapon; s.weapon = b.cat ? WEAPONS.catapult : WEAPONS.ballista; s.x = b.x; s.z = b.z; s.y = b.y; s.drawT = -1; s.cdT = 0; if (!s.isPlayer) s.yaw = b.yaw; }
  // a friendly AI hops off so the player can use the weapon or horse; it steps aside and waits a moment
  eject(o, at, side) {
    this.dismount(o);
    const sd = side || 1; o.x = at.x + Math.cos(at.yaw || 0) * 2 * sd; o.z = at.z - Math.sin(at.yaw || 0) * 2 * sd;
    if (at.cat === undefined && at.y !== undefined) o.y = at.y; // ballista on the wall walk: stay up there
    o.vx = o.vz = 0; o.ai.rt = null; o.ai.path = null; o.ai.noMountT = this.time + 12; o.stagger = 0.3;
    if (o.ai.tw) o.ai.tw = null;
  }
  shootMount(a, b, power) {
    b.cd = a.weapon.cd; b.shotT = 0; b.shotPow = power;
    b.pend = { a, power, t: b.cat ? 0.17 : 0.05 }; // the arm swings (or the string snaps) a moment before the missile leaves
    this.emit('mountfire', { a, b });
  }
  stepMounts(dt) {
    for (const b of this.ballistas) {
      b.cd = Math.max(0, b.cd - dt); b.shotT += dt;
      const o = b.op;
      b.wind = o && o.alive && o.drawT >= 0 ? clamp(o.drawT / o.weapon.draw, 0, 1) : 0;
      if (o && o.alive) {
        b.yaw = o.yaw;
        const aim = o.input.aim; if (!b.cat && aim) { const hd = Math.hypot(aim.x - b.x, aim.z - b.z) || 1; b.pitch = clamp(Math.atan2(aim.y - (b.y + 1.2), hd), -0.25, 0.6); }
      }
      if (b.pend) { b.pend.t -= dt; if (b.pend.t <= 0) { const a = b.pend.a, pw = b.pend.power; b.pend = null; if (a.alive && a.mount === b) this.fireArrow(a, pw); } }
    }
  }
  dragTarget(s) {
    if (!this.catapults) return null;
    let best = null, bd = 5.2;
    for (const b of this.catapults) { if (b.op) continue; const d = Math.hypot(b.x - s.x, b.z - s.z); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  dragCat(s, b, dx, dz, dt) {
    if (!dx && !dz) return;
    const nx = b.x + dx, nz = b.z + dz, W = this.def.water.length ? waterAt(this.def, nx, nz) : null;
    if (W && !W.ice) { s.x -= dx; s.z -= dz; return; } // no pushing it into the moat
    const lim = this.def.half - 4, q = { x: clamp(nx, -lim, lim), z: clamp(nz, -lim, lim), y: 0 };
    resolveObstacles(this.def, q, 1.5);
    s.x += q.x - nx; s.z += q.z - nz;
    b.x = q.x; b.z = q.z;
    const mv = Math.hypot(dx, dz); if (mv > 1e-4) b.yaw += clamp(angDiff(b.yaw, Math.atan2(dx, dz)), -1.1 * dt, 1.1 * dt);
  }
  dismount(s) { if (s.mount) { s.mount.op = null; s.mount = null; if (s.prevW) s.weapon = s.prevW; } if (s.horse) { s.horse.rider = null; s.horse = null; } }
  near(s) {
    if (!s.alive) return null;
    if (s.mount) return { k: 'b', label: s.mount.cat ? 'E leave the catapult · hold click to wind, release to fire' : 'E leave the ballista · click to fire' };
    if (s.horse) return { k: 'd', label: 'E dismount · horse ' + Math.max(0, Math.ceil(s.horse.hp)) + ' HP' };
    let best = null, bd = 1e9;
    const t = (k, o, r, label) => { const d = Math.hypot(o.x - s.x, o.z - s.z); if (d < r && d < bd && Math.abs((o.y || 0) - s.y) < 2.5) { bd = d; best = { k, o, label }; } };
    const ally = (o) => o && !o.isPlayer && o.team === s.team;
    for (const h of this.horses || []) if (h.alive && (!h.rider || ally(h.rider))) t('h', h, 3.2, h.rider ? 'E take the horse (your soldier hops off)' : 'E mount horse');
    for (const b of this.ballistas || []) if (!b.op || ally(b.op)) t('b', b, 3.2, (b.op ? 'E take the ' : 'E man the ') + (b.cat ? 'catapult' : 'ballista') + (b.op ? ' (your soldier hops off)' : b.cat ? ' · hold R to drag it' : ''));
    if (!best && this.catapults) for (const c of this.catapults) if (!c.op && Math.hypot(c.x - s.x, c.z - s.z) < 5.2) return { k: 'x', label: 'Hold R: drag the catapult (very slowly)' };
    if (this.ram && s.team === T_BLUE && !this.gateOpen) t('r', this.ram, 6, s.ramOp ? 'E let go of the ram' : `E push the battering ram (crew ${this.ram.crew})`);
    return best;
  }
  interact(s) {
    if (s.admin) return 'Switch admin mode off (K) to use this';
    const n = this.near(s); if (!n || n.k === 'x') return '';
    if (n.k === 'd') { this.dismount(s); return 'Dismounted'; }
    if (n.k === 'b' && s.mount) { this.dismount(s); return 'Left the ballista'; }
    if (n.k === 'h') { if (n.o.rider) this.eject(n.o.rider, n.o, 1); this.dismount(s); n.o.rider = s; s.horse = n.o; return 'Mounted: faster, but no ladders'; }
    if (n.k === 'b') { if (n.o.op) this.eject(n.o.op, n.o, n.o.x > 0 ? -1 : 1); this.mountB(s, n.o); return n.o.cat ? 'Catapult ready: hold click to wind up, release to fire' : 'Ballista ready: click to fire the bolt'; }
    if (n.k === 'r') { s.ramOp = !s.ramOp; return s.ramOp ? 'Pushing the ram: stay behind it' : 'Let go of the ram'; }
    return '';
  }
  call(p) { let n = 0; for (const s of this.soldiers) { if (!s.alive || s === p || s.team !== p.team || s.isKing || s.ai.post || s.mount || s.ramOp || Math.hypot(s.x - p.x, s.z - p.z) > 40) continue; if (s.ai.tw) leaveTower(s, 30); s.ai.follow = p; s.ai.cmd = 'follow'; s.ai.rt = null; s.ai.avenge = null; s.ai.target = null; n++; } return n; }
  send(p, x, z) { let n = 0; for (const s of this.soldiers) if (s.alive && s.ai.follow === p) { s.ai.avenge = null; s.ai.cmd = 'send'; s.ai.dx = x + rnd(-2, 2); s.ai.dz = z + rnd(-2, 2); s.ai.follow = null; s.ai.rt = null; n++; } return n; }
  stepSiege(dt) {
    const r = this.ram, g = this.gate;
    if (!this.gateOpen) {
      let crew = 0; for (const s of this.soldiers) if (s.alive && s.ramOp && Math.hypot(s.x - r.x, s.z - r.z) < 9) crew++;
      r.crew = crew; const stop = g.z - 6.4;
      if (crew > 0) { if (r.z < stop) { r.z = Math.min(stop, r.z + (0.8 + crew * 0.5) * dt); r.t = 0; } else { r.t += dt; if (r.t >= 1.8) { r.t = 0; this.hitGate(12 * Math.min(crew, 6)); } } }
    }
    this.pt = (this.pt || 0) - dt;
    if (this.pt <= 0) { this.pt = 1; let n = 0; for (const s of this.soldiers) if (s.alive && s.team === T_BLUE && s.y < 3 && s.z > -56 && s.z < 22 && Math.abs(s.x) < 54) n++; if (n >= 5) this.phase = 2; else if (this.gateOpen && this.phase < 1) this.phase = 1; }
  }
  hitGate(dmg) {
    const g = this.gate; g.hp -= dmg; this.emit('gatehit', g);
    if (g.hp <= 0) { const i = this.def.obs.indexOf(g); if (i >= 0) this.def.obs.splice(i, 1); this.def._grid = null; this.nav = new Nav(this.def); this.gateOpen = true; this.phase = Math.max(1, this.phase); this.emit('gate', g); }
  }

  /* ----- horses and stones ----- */
  stepHorses(dt) {
    for (const h of this.horses || []) {
      if (h.flash > 0) h.flash -= dt;
      if (!h.alive) { h.deadT += dt; if (h.deadT > 40 && !h.rider) { h.alive = true; h.hp = h.max; h.x = h.ox; h.z = h.oz; h.deadT = 0; } }
    }
  }
  hitHorse(h, dmg, a, pos) {
    if (!h.alive || this.ended) return;
    if (h.rider ? a.team === h.rider.team : a.team === T_BLUE) return; // no friendly fire on horses; spare horses are the attackers'
    h.hp -= dmg; h.flash = 0.2; a.dmgDealt += dmg;
    this.emit('hit', { a, e: h, dmg, pos, arrow: false, head: false, friendly: false });
    if (h.hp <= 0) this.killHorse(h, a);
  }
  killHorse(h, a) {
    h.alive = false; h.deadT = 0; h.hp = 0; const r = h.rider;
    if (r) { h.rider = null; r.horse = null; r.stagger = 0.7; r.vx = r.vz = 0; }
    this.emit('horsedown', { h, rider: r, k: a });
  }
  swingHorses(a) {
    if (!this.horses) return;
    const w = a.weapon, fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    for (const h of this.horses) {
      if (!h.alive || a.horse === h) continue;
      const dx = h.x - a.x, dz = h.z - a.z, d = Math.hypot(dx, dz);
      if (d > w.reach + 0.8 || Math.abs((h.rider ? h.rider.y : 0) - a.y) > 1.5) continue;
      if (d > 0.8 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > w.arc + 0.2) continue;
      this.hitHorse(h, w.dmg * rnd(0.88, 1.12) * (a.isPlayer ? 1 : (a.team !== this.cfg.team ? this.diff.dmg : 1)), a, { x: h.x, y: 1.3, z: h.z });
    }
  }
  splash(ar) {
    const R = 4.5, o = ar.owner, mul = o.isPlayer ? 1 : (o.team !== this.cfg.team ? this.diff.dmg : 1);
    for (const e of this.soldiers) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - ar.x, e.y + 1 - ar.y, e.z - ar.z); if (d > R) continue;
      this.damage(e, 90 * (1 - d / R * 0.6) * mul, o, e.x - ar.x, e.z - ar.z, { arrow: true, pos: { x: e.x, y: e.y + 1.3, z: e.z } });
    }
    const g = this.gate; if (g && !this.gateOpen && Math.hypot(g.x - ar.x, g.z - ar.z) < 6 && ar.y < 10) this.hitGate(o.isPlayer ? 40 : 20);
    this.emit('boom', { x: ar.x, y: ar.y, z: ar.z });
  }

  /* ----- combat ----- */
  resolveHit(a) {
    const w = a.weapon, fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const cands = [];
    for (const e of this.soldiers) {
      if (!e.alive || e === a) continue; // friendly fire: allies in the arc are hit too
      const dx = e.x - a.x, dz = e.z - a.z, d = Math.hypot(dx, dz);
      if (d > w.reach + 0.55 + Math.min(0.6, e.speed * 0.12)) continue; // a target stepping away is still reachable
      if (Math.abs(e.y - a.y) > 1.3) continue;
      if (d > 0.7) {
        const dot = (dx * fx + dz * fz) / d;
        const arc = a.isPlayer ? w.arc + 0.3 : w.arc + 0.08;
        if (Math.acos(clamp(dot, -1, 1)) > arc) continue;
      }
      if (d > 1 && !this.nav.los(a.x, a.z, e.x, e.z)) continue;
      cands.push({ e, d, dx, dz });
    }
    this.swingHorses(a); cands.sort((p, q) => p.d - q.d);
    for (let i = 0; i < Math.min(w.cleave, cands.length); i++) {
      const c = cands[i], dmg = w.dmg * rnd(0.88, 1.12) * (a.isPlayer ? 1 : (a.team !== this.cfg.team ? this.diff.dmg : 1));
      this.damage(c.e, dmg, a, c.dx, c.dz);
    }
  }
  fireArrow(a, power) {
    const w = a.weapon, sp = w.speed * (0.5 + 0.5 * power), g = ARROW_G;
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const mb = a.mount, cat = !!(mb && mb.cat), lob = !!w.stone;
    const sx = a.x + fx * (cat ? 1.4 : mb ? 1.3 : 0.5), sy = a.y + (cat ? 3.0 : mb ? 1.3 : 1.55), sz = a.z + fz * (cat ? 1.4 : mb ? 1.3 : 0.5);
    const aim = a.input.aim;
    let tx, ty, tz;
    if (aim && (aim.x - a.x) * fx + (aim.z - a.z) * fz > 1) { tx = aim.x; ty = aim.y; tz = aim.z; }
    else { tx = sx + fx * 30; ty = sy; tz = sz + fz * 30; }
    let dx = tx - sx, dz = tz - sz, hd = Math.hypot(dx, dz) || 0.01;
    if (!lob && w.spread) { // accuracy: spread widens when moving and with a short draw, and is tighter for a held aim
      const sprd = w.spread * (1.5 - 0.7 * power) + a.speed * (w.xbow ? 0.004 : 0.0075) + (a.sprinting ? 0.02 : 0), ay = Math.atan2(dx, dz) + rnd(-sprd, sprd);
      dx = Math.sin(ay) * hd; dz = Math.cos(ay) * hd; ty += rnd(-sprd, sprd) * hd * 0.7;
    }
    if (lob) {
      // catapult stones fly in a high arc: pick the launch speed for a ~50 degree lob onto the aim point
      const th = 0.87, c = Math.cos(th), tn = Math.tan(th), den = 2 * c * c * (hd * tn - (ty - sy));
      const v = den > 1 ? clamp(Math.sqrt(g * hd * hd / den), 12, 70) : 30;
      const ar = { id: this.arrowSeq++, x: sx, y: sy, z: sz, vx: dx / hd * v * c, vy: v * Math.sin(th), vz: dz / hd * v * c, owner: a, team: a.team, dmg: w.dmg * (0.35 + 0.65 * power), life: 12, stuck: 0, fire: false, big: true, stone: true };
      this.arrows.push(ar); if (this.arrows.length > 220) this.arrows.shift(); this.emit('shoot', { a, ar }); return;
    }
    // raise the aim point to cancel gravity drop, so the arrow lands where you aimed
    let dy = ty - sy, len = Math.hypot(hd, dy);
    for (let i = 0; i < 3; i++) { const t = len / sp; dy = (ty - sy) + 0.5 * g * t * t; dy = Math.min(dy, hd * 2.2); len = Math.hypot(hd, dy); }
    const k = sp / len;
    const ar = { id: this.arrowSeq++, x: sx, y: sy, z: sz, vx: dx * k, vy: dy * k, vz: dz * k, owner: a, team: a.team, dmg: w.dmg * (0.35 + 0.65 * power), life: 4, trav: 0, xb: !!w.xbow, stuck: 0, fire: !!((w.big && !w.stone) || (a.ai.post && a.ai.post.fire)), big: !!w.big, stone: !!w.stone };
    this.arrows.push(ar);
    if (this.arrows.length > 220) this.arrows.shift();
    this.emit('shoot', { a, ar });
  }
  stepArrows(dt) {
    const A = this.arrows, N = 3, h = dt / N;
    for (let i = A.length - 1; i >= 0; i--) {
      const ar = A[i];
      if (ar.stuck > 0) { ar.stuck -= dt; if (ar.stuck <= 0) A.splice(i, 1); continue; }
      ar.life -= dt;
      if (ar.life <= 0) { A.splice(i, 1); continue; }
      let gone = false;
      for (let k = 0; k < N && !gone; k++) {
        ar.vy -= ARROW_G * h; ar.x += ar.vx * h; ar.y += ar.vy * h; ar.z += ar.vz * h; ar.trav += Math.hypot(ar.vx, ar.vz) * h;
        for (const e of this.soldiers) {
          if (!e.alive || e === ar.owner) continue; // friendly fire: arrows hit anyone but the shooter
          const ey = ar.y - e.y - (e.horse ? 0.8 : 0); if (ey < -0.1 || ey > 1.95) continue;
          const ex = ar.x - e.x, ez = ar.z - e.z;
          if (ex * ex + ez * ez > 0.2) continue;
          const o = ar.owner, head = ey > 1.52;
          const fall = ar.big ? 1 : clamp(1.18 - Math.max(0, ar.trav - 38) / 90, 0.5, 1) * (ar.trav < 5 ? 0.75 : 1); // far shots lose punch, point-blank shots are clumsy
          const dmg = ar.dmg * (head ? (this.mode === 'archers' ? 2.1 : 1.6) : 1) * fall * rnd(0.92, 1.08) * (o.isPlayer ? 1 : (o.team !== this.cfg.team ? this.diff.dmg : 1));
          this.damage(e, dmg, o, ar.vx, ar.vz, { arrow: true, pos: { x: ar.x, y: ar.y, z: ar.z }, head });
          if (ar.fire && e.alive) e.burnT = 3; if (ar.stone) this.splash(ar);
          gone = true; break;
        }
        if (gone) break;
        if (this.horses) {
          let hh = null;
          for (const h of this.horses) { if (!h.alive || ar.owner.horse === h) continue; if ((h.rider ? h.rider.team : T_BLUE) === ar.team) continue; const hy = ar.y - (h.rider ? h.rider.y : 0); if (hy < 0 || hy > 1.9) continue; const hx = ar.x - h.x, hz = ar.z - h.z; if (hx * hx + hz * hz > 0.85) continue; hh = h; break; }
          if (hh) { const o = ar.owner; this.hitHorse(hh, ar.dmg * rnd(0.92, 1.08) * (o.isPlayer ? 1 : (o.team !== this.cfg.team ? this.diff.dmg : 1)), o, { x: ar.x, y: ar.y, z: ar.z }); if (ar.stone) this.splash(ar); gone = true; break; }
        }
        let stick = ar.y <= 0.05;
        if (!stick) { const obs = nearObs(this.def, ar.x, ar.z); for (let j = 0; j < obs.length; j++) { const o = obs[j]; if (ar.y < o.h && ar.y >= (o.y0 || 0) && distToObs(o, ar.x, ar.z) < 0.05) { stick = true; break; } } }
        if (!stick) {
          const P = this.def.platforms;
          for (let j = 0; j < P.length; j++) {
            const p = P[j];
            if (ar.y > p.y || ar.y < p.y - 0.7 || Math.abs(ar.x - p.x) > p.w / 2 || Math.abs(ar.z - p.z) > p.d / 2) continue;
            let inHole = false;
            if (p.holes) for (const h of p.holes) if (Math.abs(ar.x - h.x) < h.w / 2 && Math.abs(ar.z - h.z) < h.d / 2) { inHole = true; break; }
            if (!inHole) { stick = true; ar.y = p.y; break; }
          }
        }
        if (stick) { ar.y = Math.max(ar.y, 0.05); ar.stuck = 4; ar.vx = ar.vy = ar.vz = 0; if (ar.stone) { this.splash(ar); ar.stuck = 0.05; } this.emit('arrowstick', ar); break; }
      }
      if (gone) A.splice(i, 1);
    }
  }
  damage(e, dmg, a, dx, dz, opt) {
    if (!e.alive || this.ended || e.god) return;
    const arrow = !!(opt && opt.arrow);
    // a called soldier who is struck in melee (not by an arrow, bolt or stone) breaks off to hunt down whoever hit him
    if (!arrow && a !== e && a.team !== e.team && !e.isPlayer && e.ai.cmd === 'follow') { e.ai.avenge = a; e.ai.avT = this.time; }
    if (a.team === e.team) dmg *= 0.7; // friendly fire hurts, a little less than an enemy blow
    dmg *= e.armor || 1;
    if (!arrow && e.weapon.ranged && !e.mount) dmg *= 1.15; // a bow or crossbow in melee range is a poor guard
    const d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d;
    // block check: defender faces the attacker
    const ex = Math.sin(e.yaw), ez = Math.cos(e.yaw);
    const facing = (-nx * ex + -nz * ez) > 0.3;
    const mid = arrow && opt.pos ? opt.pos : { x: (a.x + e.x) / 2, y: 1.3, z: (a.z + e.z) / 2 };
    e.lastCombat = a.lastCombat = this.time; e.lastDmgT = this.elapsed;
    if (e.blocking && facing && e.stamina > 0 && !arrow && e.blockT < 0.2 && a !== e && (e.isPlayer || Math.random() < 0.4 * (e.ai.skill || 1))) {
      // parry: the guard went up just as the blow landed. No damage, the attacker is thrown off balance and open
      e.stamina = Math.min(100, e.stamina + 12); a.stagger = Math.max(a.stagger, 0.85); a.atkT = -1; a.cdT = Math.max(a.cdT, 0.7); a.vx -= nx * 3; a.vz -= nz * 3; a.drawT = -1;
      this.emit('parry', { a, e, pos: mid, friendly: a.team === e.team });
      return;
    }
    if (e.blocking && facing && e.stamina > 0) {
      e.stamina -= dmg * (arrow ? 0.4 : 0.7) * (e.cdef && e.cdef.shield ? 0.75 : 1);
      e.hp -= dmg * 0.08;
      this.emit('block', { a, e, pos: mid, friendly: a.team === e.team });
      if (e.stamina <= 0) { e.stamina = 0; e.stagger = 0.9; e.blocking = false; e.atkT = -1; this.emit('guardbreak', { a, e, pos: mid }); }
      if (!arrow) a.stagger = Math.max(a.stagger, 0.12);
      e.vx += nx * 2; e.vz += nz * 2;
      if (e.hp <= 0) this.kill(e, a);
      return;
    }
    e.hp -= dmg; if (a.team !== e.team) a.dmgDealt += dmg;
    e.lastAttacker = a; e.lastHitT = this.time;
    e.stagger = Math.max(e.stagger, 0.2);
    if (e.atkT >= 0 && e.atkT < e.weapon.hit) { e.atkT = -1; e.cdT = 0.35; } // interrupted swing
    e.drawT = -1;
    const kb = arrow ? 1.5 : 4.5; e.vx += nx * kb; e.vz += nz * kb;
    this.emit('hit', { a, e, dmg, pos: mid, arrow, head: !!(opt && opt.head), friendly: a.team === e.team });
    if (e.hp <= 0) this.kill(e, a);
  }
  kill(e, a) {
    this.dismount(e); e.ramOp = false; e.ai.rt = null; e.ai.cmd = null; e.ai.follow = null; e.ai.avenge = null;
    if (e.isPlayer) for (const q of this.soldiers) if (q.ai.follow === e) { q.ai.follow = null; q.ai.cmd = null; }
    e.hp = 0; e.alive = false; e.deadT = 0; e.blocking = false; e.atkT = -1; e.drawT = -1;
    e.deaths++; e.respawnT = e.respawnDelay;
    const friendly = !!(a && a !== e && a.team === e.team);
    if (a && a !== e) {
      if (friendly) a.teamKills++; // killing a teammate scores nothing
      else { a.kills++; if (this.mode === 'kingstandard') { if (e.carrying) this.addScore(a.team, 3); } else this.addScore(a.team, 1, true); }
    }
    if (e.carrying) this.dropBanner();
    if (e.isTarget) this.finish(T_RED);
    if (e.isChampion) this.finish(e.team === T_BLUE ? T_RED : T_BLUE);
    this.emit('kill', { k: a, v: e, friendly });
    if (e.isKing) this.finish(T_BLUE);
  }
  addScore(team, n) {
    this.scores[team] += n;
    this.checkEnd();
  }
  checkEnd() {
    if (this.ended || this.ffa || this.mode === 'siege') return;
    if (this.scores[T_BLUE] >= this.target || this.scores[T_RED] >= this.target) {
      this.finish(this.scores[T_BLUE] >= this.target && this.scores[T_RED] >= this.target ? (this.scores[T_BLUE] > this.scores[T_RED] ? T_BLUE : this.scores[T_RED] > this.scores[T_BLUE] ? T_RED : 0) : (this.scores[T_BLUE] >= this.target ? T_BLUE : T_RED));
    }
  }
  finish(winner) {
    if (this.ended) return;
    this.ended = true; this.winner = winner;
    this.emit('end', { winner });
  }

  /* ----- main step ----- */
  step(dt) {
    if (this.ended) { for (const s of this.soldiers) if (!s.alive) s.deadT += dt; return; }
    this.elapsed += dt; this.time -= dt;
    this.pathBudget = 4;
    this.assignT -= dt;
    if (this.assignT <= 0) { this.assignT = 2; this.assignObjectives(T_BLUE); this.assignObjectives(T_RED); }
    const S = this.soldiers;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (!s.isPlayer && s.alive) aiThink(this, s, dt);
      s.step(dt);
    }
    // separation between soldiers
    for (let i = 0; i < S.length; i++) {
      const a = S[i]; if (!a.alive) continue;
      for (let j = i + 1; j < S.length; j++) {
        const b = S[j]; if (!b.alive) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(dx) > 1 || Math.abs(dz) > 1 || Math.abs(a.y - b.y) > 1.5) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1 && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = (1 - d) * 0.5;
          const ux = dx / d, uz = dz / d;
          a.x -= ux * push; a.z -= uz * push; b.x += ux * push; b.z += uz * push;
        } else if (d2 <= 1e-6) { a.x += rnd(-0.1, 0.1); a.z += rnd(-0.1, 0.1); }
      }
    }
    for (const s of S) if (s.alive && !s.admin) resolveObstacles(this.def, s, 0.5);
    if (this.mode === 'siege') { this.stepSiege(dt); this.stepHorses(dt); this.stepMounts(dt); }
    this.stepArrows(dt);
    if (this.mode === 'conquest' || this.mode === 'laststand') this.updatePoints(dt);
    this.stepMode(dt);
    if (this.time <= 0 && !this.ended) {
      this.time = 0;
      if (this.mode === 'siege' || this.mode === 'laststand') this.finish(T_RED);
      else if (this.mode === 'manhunt') this.finish(T_BLUE); // the hunted survived
      else if (this.mode === 'champion') { const f = (t) => { const c = this.champs[t]; return c.alive ? c.hp / c.maxHp : 0; }, a = f(T_BLUE), b2 = f(T_RED); this.finish(Math.abs(a - b2) < 0.01 ? 0 : a > b2 ? T_BLUE : T_RED); }
      else if (this.ffa) {
        // most eliminations wins; fewer deaths breaks a tie; still level is a draw
        let bk = -1, bd = 0, w = 0, tie = false;
        for (const q of this.soldiers) {
          if (q.kills > bk || (q.kills === bk && q.deaths < bd)) { bk = q.kills; bd = q.deaths; w = q.team; tie = false; }
          else if (q.kills === bk && q.deaths === bd) tie = true;
        }
        this.finish(tie ? 0 : w);
      } else {
        const b = this.scores[T_BLUE], r = this.scores[T_RED];
        this.finish(b > r ? T_BLUE : r > b ? T_RED : 0);
      }
    }
  }

  updatePoints(dt) {
    for (const p of this.points) {
      let b = 0, r = 0;
      for (const s of this.soldiers) {
        if (!s.alive) continue;
        if (Math.hypot(s.x - p.x, s.z - p.z) <= p.r) { if (s.team === T_BLUE) b++; else r++; }
      }
      p.bCount = b; p.rCount = r;
      const prevOwner = p.owner;
      const cr = this.mode === 'laststand' ? 0.4 : 1; // taking the last stand is slow work
      if (b > 0 && r === 0) p.v = Math.min(100, p.v + 12 * cr * Math.min(b, 3) * dt);
      else if (r > 0 && b === 0) p.v = Math.max(-100, p.v - 12 * cr * Math.min(r, 3) * dt);
      if (p.v >= 100) p.owner = T_BLUE;
      else if (p.v <= -100) p.owner = T_RED;
      else if (p.owner === T_BLUE && p.v <= 0) p.owner = 0;
      else if (p.owner === T_RED && p.v >= 0) p.owner = 0;
      if (p.owner !== prevOwner) {
        if (p.owner !== 0) {
          this.addScore(p.owner, 5);
          if (this.player && p.owner === this.player.team && Math.hypot(this.player.x - p.x, this.player.z - p.z) <= p.r) this.stats.captures++;
        }
        this.emit('point', { p, prev: prevOwner, owner: p.owner });
      }
    }
    this.scoreT += dt;
    while (this.scoreT >= 1) {
      this.scoreT -= 1;
      for (const p of this.points) if (p.owner) this.scores[p.owner] += 1;
      this.checkEnd();
    }
  }

  /* ----- strategy ----- */
  assignObjectives(team) {
    if (this.mode !== 'conquest' && this.mode !== 'laststand') return;
    const ais = this.soldiers.filter(s => s.team === team && s.alive && !s.isPlayer);
    const owned = this.points.filter(p => p.owner === team), notOwned = this.points.filter(p => p.owner !== team);
    const counts = this.points.map(() => 0);
    const enemy = team === T_BLUE ? T_RED : T_BLUE;
    const threatened = (p) => (enemy === T_BLUE ? p.bCount : p.rCount) > 0;
    for (const s of ais) {
      let idx = -1, role = 'attack';
      if ((s.id % 3 === 0 || notOwned.length === 0) && owned.length) {
        let best = 1e9;
        for (const p of owned) { const sc = counts[p.idx] * 4 + (threatened(p) ? -6 : 0) + Math.hypot(p.x - s.x, p.z - s.z) * 0.05; if (sc < best) { best = sc; idx = p.idx; } }
        role = 'defend';
      } else {
        const pool = notOwned.length ? notOwned : this.points;
        let best = 1e9;
        for (const p of pool) { const sc = Math.hypot(p.x - s.x, p.z - s.z) + counts[p.idx] * 16; if (sc < best) { best = sc; idx = p.idx; } }
      }
      counts[idx]++;
      if (s.ai.obj !== idx) {
        s.ai.obj = idx; const p = this.points[idx];
        s.ai.ox = rnd(-0.45, 0.45) * p.r; s.ai.oz = rnd(-0.45, 0.45) * p.r; s.ai.path = null;
      }
      s.ai.role = role;
    }
  }
}

/* ---------- AI ---------- */
function steerTo(m, s, gx, gz, dt, faceMove) {
  const ai = s.ai, inp = s.input;
  let tx = gx, tz = gz;
  if (s.y > 3) ai.path = null; // up on a wall or roof: walk straight, the ground path grid doesn't apply
  else if (!m.nav.los(s.x, s.z, gx, gz, true)) {
    ai.pathT -= dt;
    if (!ai.path || ai.pathT <= 0 || Math.hypot(ai.pgx - gx, ai.pgz - gz) > 5) {
      if (m.pathBudget > 0) {
        m.pathBudget--;
        ai.path = m.nav.findPath(s.x, s.z, gx, gz); ai.pi = 0; ai.pgx = gx; ai.pgz = gz; ai.pathT = 1.2 + Math.random() * 0.8;
      }
    }
    if (ai.path && ai.pi < ai.path.length) {
      while (ai.pi < ai.path.length - 1 && Math.hypot(ai.path[ai.pi].x - s.x, ai.path[ai.pi].z - s.z) < 1.4) ai.pi++;
      tx = ai.path[ai.pi].x; tz = ai.path[ai.pi].z;
    }
  } else ai.path = null;
  const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz) || 1;
  inp.mx = dx / d; inp.mz = dz / d;
  if (ai.sideT > 0) { const ux = inp.mx, uz = inp.mz; inp.mx = ux - uz * ai.side * 0.9; inp.mz = uz + ux * ai.side * 0.9; }
  if (faceMove) inp.yaw = Math.atan2(dx, dz);
  ai.moved = true;
}

// a defender who spawned on the keep roof ignores the ground fight until it has run down the ramp to its post
function descending(m, s) { return m.mode === 'siege' && s.ai.post && !s.mount && s.y > 8 && s.z > 22 && Math.abs(s.x) < 19 && !(s.ai.post.y > 8 && s.ai.post.z > 22); }
function pickTarget(m, s) {
  const ai = s.ai;
  if (descending(m, s)) { ai.target = null; return; }
  if (ai.post && ai.post.kind === 'ballista' && !s.mount) { ai.target = null; return; } // a ballista crewman goes straight to his weapon instead of wandering off the wall
  if (ai.cmd === 'follow') {
    // called soldiers only follow: the one exception is a soldier struck in melee, who hunts whoever hit him, then comes back
    const t = ai.avenge;
    if (t && t.alive && !t.admin && m.time - ai.avT < 40 && Math.hypot(t.x - s.x, t.z - s.z) < 90) ai.target = t; else { ai.avenge = null; ai.target = null; }
    return;
  }
  const holding = ai.tw && ai.tw.st === 'hold';
  const aggro = holding ? 36 : (m.mode !== 'conquest' && m.mode !== 'laststand') ? (s.weapon.big ? 60 : 45) : ai.role === 'defend' ? 18 : 24;
  if (ai.target && ai.target.alive && !ai.target.admin) {
    const d = Math.hypot(ai.target.x - s.x, ai.target.z - s.z);
    if (d < aggro * 1.5 && (d < 9 || (Math.abs(ai.target.y - s.y) > 3 || s.y > 3 ? clear3(m, s, ai.target) : m.nav.los(s.x, s.z, ai.target.x, ai.target.z)))) {
      // keep, unless someone is much closer
      let closer = false;
      for (const e of m.soldiers) { if (e.alive && e.team !== s.team && e !== ai.target && Math.hypot(e.x - s.x, e.z - s.z) < d - 5) { closer = true; break; } }
      if (!closer) return;
    }
  }
  let best = null, bs = 1e9;
  for (const e of m.soldiers) {
    if (!e.alive || e.team === s.team) continue;
    const d = Math.hypot(e.x - s.x, e.z - s.z);
    if (d > aggro || e.admin) continue;
    const high = Math.abs(e.y - s.y) > 3;
    if (high && !(s.weapon.ranged && d > 8)) continue;
    if (d > 8 && (high || s.y > 3 ? !clear3(m, s, e) : !m.nav.los(s.x, s.z, e.x, e.z))) continue;
    let sc = d - (e.isPlayer ? 3 : 0) - (e.isTarget || e.isChampion || e.carrying ? 25 : 0);
    if (e.lastAttacker && e.lastAttacker.alive === false) sc += 0;
    if (sc < bs) { bs = sc; best = e; }
  }
  // assist allies that are under attack
  for (const a of m.soldiers) {
    if (!a.alive || a.team !== s.team || a === s) continue;
    if (Math.hypot(a.x - s.x, a.z - s.z) > 12) continue;
    const at = a.lastAttacker;
    if (at && at.alive && !at.admin && at.team !== s.team && m.time - a.lastHitT < 3) {
      const d = Math.hypot(at.x - s.x, at.z - s.z);
      if (d < 20 && d - 6 < bs) { bs = d - 6; best = at; }
    }
  }
  ai.target = best;
}

const clear3 = (m, s, e) => {
  const tw = s.ai.tw;
  if (tw && tw.st === 'hold') { const sp = roofSpot(tw.t, e.x, e.z); if (rayClear(m.def, sp.x, s.y + 1.55, sp.z, e.x, e.y + 1.2, e.z)) return true; }
  return rayClear(m.def, s.x, s.y + 1.55, s.z, e.x, e.y + 1.2, e.z);
};

/* is a teammate standing in the line of fire (or in the swing)? */
function laneBlocked(m, s, a) {
  const x0 = s.x, y0 = s.y + 1.55, z0 = s.z, dx = a.x - x0, dy = a.y - y0, dz = a.z - z0, L2 = dx * dx + dz * dz;
  if (L2 < 1) return false;
  for (const o of m.soldiers) {
    if (o === s || !o.alive || o.team !== s.team) continue;
    const px = o.x - x0, pz = o.z - z0, u = (px * dx + pz * dz) / L2;
    if (u < 0.02 || u > 1) continue;
    const cx = px - u * dx, cz = pz - u * dz;
    if (cx * cx + cz * cz > 0.6) continue;
    const yl = y0 + dy * u; if (yl < o.y - 0.3 || yl > o.y + 2.2) continue;
    return true;
  }
  return false;
}
function allyInArc(m, s, reach, arc, dTarget) {
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  for (const o of m.soldiers) {
    if (o === s || !o.alive || o.team !== s.team) continue;
    const dx = o.x - s.x, dz = o.z - s.z, d = Math.hypot(dx, dz);
    if (d > reach + 0.5 || Math.abs(o.y - s.y) > 1.3) continue;
    if (d > 0.7 && Math.acos(clamp((dx * fx + dz * fz) / d, -1, 1)) > arc) continue;
    return true;
  }
  return false;
}

function aiBow(m, s, tgt, d, dx, dz, dt, diff, hold) {
  const ai = s.ai, inp = s.input, w = s.weapon;
  const los = d < 3 || (hold || Math.abs(tgt.y - s.y) > 3 ? clear3(m, s, tgt) : m.nav.los(s.x, s.z, tgt.x, tgt.z));
  const highT = Math.abs(tgt.y - s.y) > 3;
  if (hold) { inp.mx = inp.mz = 0; }
  else if (highT) { if (!los) { ai.target = null; return; } inp.mx = inp.mz = 0; }
  else if (!los || d > 26) {
    steerTo(m, s, tgt.x, tgt.z, dt, false);
    if (d > 32) inp.sprint = true;
  } else if (d < 9) {
    // too close: back away while still shooting
    inp.mx = -dx / d * 0.8; inp.mz = -dz / d * 0.8; ai.moved = true;
  } else {
    ai.strafeT -= dt;
    if (ai.strafeT <= 0) { ai.strafeT = rnd(0.8, 2.2); ai.strafe = Math.random() < 0.5 ? 1 : -1; }
    inp.mx = -dz / d * ai.strafe * 0.4; inp.mz = dx / d * ai.strafe * 0.4;
  }
  // aim with lead and a little error that grows with range
  const t = d / (w.speed * 0.85), err = d * 0.045 / (diff.aggr * ai.skill);
  const a = s._aim;
  a.x = tgt.x + tgt.vx * t + rnd(-err, err) * 0.5; a.z = tgt.z + tgt.vz * t + rnd(-err, err) * 0.5; a.y = tgt.y + 1.15 + rnd(-err, err) * 0.4;
  inp.aim = a;
  const facing = Math.abs(angDiff(s.yaw, inp.yaw)) < 0.35;
  const range = hold ? (w.big ? 60 : 34) : w.xbow ? 36 : 28;
  if (s.drawT >= 0) {
    // a teammate walked into the line of fire: let the arrow go unless careless
    if (!ai.reck && (!los || laneBlocked(m, s, a))) { s.drawT = -1; s.cdT = 0.3; }
    else inp.attack = s.drawT < ai.drawGoal;
  } else if (los && d <= range && facing && s.cdT <= 0 && (!w.xbow || s.loaded) && s.stagger <= 0 && Math.random() < 3 * dt * diff.aggr * ai.skill) {
    ai.reck = Math.random() < 0.1;
    if (ai.reck || !laneBlocked(m, s, a)) { ai.drawGoal = w.draw * rnd(0.7, 1); inp.attack = true; }
  }
}

/* ----- tower duty: archers climb a tower ladder, hold the top and shoot over the parapet ----- */
// melee soldiers follow an enemy who has climbed a tower or wall: up the ladder to that level, then fight there
function tryChase(m, s) {
  const ai = s.ai; let e = null, ed = 40;
  for (const o of m.soldiers) {
    if (!o.alive || o.team === s.team || o.y < 3.5 || o.admin) continue;
    const d = Math.hypot(o.x - s.x, o.z - s.z); if (d < ed) { ed = d; e = o; }
  }
  if (!e) return;
  const top = [4.5, 9, 13.5].reduce((a, b) => Math.abs(b - e.y) < Math.abs(a - e.y) ? b : a);
  let best = null, bs = 1e9;
  for (const T of m.def.towers) {
    const ds = Math.hypot(T.cx - s.x, T.cz - s.z), de = Math.hypot(T.cx - e.x, T.cz - e.z);
    if (ds > 46) continue;
    if (top !== 9 && de > T.half + 3) continue; // another floor or the roof: only that tower's own ladder gets there
    let occ = 0; for (const o of m.soldiers) if (o.alive && o.ai.tw && o.ai.tw.t === T && o.ai.tw.chase) occ++;
    if (occ >= 3) continue;
    const sc = ds + de * 0.5 + occ * 8; if (sc < bs) { bs = sc; best = T; }
  }
  if (best) ai.tw = { t: best, st: 'go', age: 0, idle: 0, chase: true, top };
}
function tryTower(m, s) {
  const ai = s.ai; let best = null, bd = 46;
  for (const T of m.def.towers) {
    const d = Math.hypot(T.cx - s.x, T.cz - s.z); if (d >= bd) continue;
    let occ = 0; for (const o of m.soldiers) if (o.alive && o.ai.tw && o.ai.tw.t === T) occ++;
    if (occ < 1) { best = T; bd = d; }
  }
  if (best) ai.tw = { t: best, st: 'go', age: 0, idle: 0 };
}
// where on the roof edge to stand to shoot at (tx,tz), keeping clear of the ladder hole
function roofSpot(T, tx, tz) {
  const L = T.lad, ang = Math.atan2(tz - T.cz, tx - T.cx);
  const mk = (a) => { const ux = Math.cos(a), uz = Math.sin(a), k = (T.half - 1.05) / Math.max(Math.abs(ux), Math.abs(uz)); return { x: T.cx + ux * k, z: T.cz + uz * k }; };
  let sp = mk(ang);
  for (let i = 1; i <= 8 && Math.hypot(sp.x - L.x, sp.z - L.z) < 1.8; i++) sp = mk(ang + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.3);
  return sp;
}
function walkTo(s, x, z) { const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz) || 1; s.input.mx = dx / d; s.input.mz = dz / d; s.input.yaw = Math.atan2(dx, dz); }
function moveVec(s, x, z) { const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz) || 1; s.input.mx = dx / d; s.input.mz = dz / d; }
function leaveTower(s, cd) { const chase = s.ai.tw && s.ai.tw.chase; s.ai.tw = null; s.ai.twCd = chase ? Math.min(cd, 3) : cd; s.ai.path = null; } // melee chasers may go straight back up after someone
// returns true while the tower task is steering this soldier
function towerTask(m, s, dt, diff) {
  const ai = s.ai, tw = ai.tw, T = tw.t, L = T.lad, inp = s.input, def = m.def;
  tw.age += dt;
  const inZone = !!ladderAt(def, s.x, s.z), wallYaw = Math.atan2(L.nx, L.nz), top = tw.top || L.y1;
  const tx = -L.nz, tz = L.nx, sgn = ((T.cx - L.x) * tx + (T.cz - L.z) * tz) >= 0 ? 1 : -1;
  switch (tw.st) {
    case 'go': {
      // the doorway is narrower than the path grid: path to a spot outside the door, then walk straight in
      const D = T.door, dl = Math.hypot(s.x - L.x, s.z - L.z);
      if (dl < 0.5) { tw.st = 'climb'; tw.age = 0; tw.wp = 0; break; }
      const inside = Math.abs(s.x - T.cx) < T.half - 0.6 && Math.abs(s.z - T.cz) < T.half - 0.6;
      if (inside) walkTo(s, L.x, L.z);
      else if (tw.wp === 1 || Math.hypot(s.x - D.ox, s.z - D.oz) < 1.8) { tw.wp = 1; if (Math.hypot(s.x - D.ix, s.z - D.iz) < 0.7) walkTo(s, L.x, L.z); else walkTo(s, D.ix, D.iz); }
      else steerTo(m, s, D.ox, D.oz, dt, true);
      if (tw.age > 40) leaveTower(s, 40);
      return true;
    }
    case 'climb': {
      inp.yaw = wallYaw; inp.mx = L.nx; inp.mz = L.nz;
      if (s.y >= top - 0.03) { tw.st = 'step'; tw.age = 0; }
      else if (tw.age > 25 || (s.y < 0.3 && !inZone)) tw.st = 'go';
      return true;
    }
    case 'step': {
      inp.mx = tx * sgn; inp.mz = tz * sgn; inp.yaw = Math.atan2(inp.mx, inp.mz);
      if (!inZone && s.y >= top - 0.05) { tw.st = tw.chase ? 'fight' : 'hold'; tw.age = 0; tw.idle = 0; }
      else if (tw.age > 6) tw.st = 'down';
      return true;
    }
    case 'fight': {
      const tgt = ai.target;
      if (tgt && tgt.alive && Math.abs(tgt.y - s.y) < 3) tw.idle = 0; else tw.idle += dt;
      if (tw.idle > 5 || s.y < top - 1.2 || ai.stuck >= 3) { tw.st = 'down'; tw.age = 0; }
      if (tw.idle > 0.3) { inp.mx = inp.mz = 0; return true; } // nobody up here to fight: wait, don't wander off the edge
      return false; // normal melee combat takes over
    }
    case 'hold': {
      const tgt = ai.target;
      inp.mx = inp.mz = 0;
      if (tgt && tgt.alive) {
        const dx = tgt.x - s.x, dz = tgt.z - s.z, d = Math.hypot(dx, dz) || 0.001;
        inp.yaw = Math.atan2(dx, dz); tw.idle = 0;
        // stand against the parapet on the side facing the target (never over the ladder hole)
        const cdx = tgt.x - T.cx, cdz = tgt.z - T.cz;
        let ang = Math.atan2(cdz, cdx);
        if (tw.ang === undefined || Math.abs(angDiff(tw.ang, ang)) > 0.5) {
          const sp = roofSpot(T, tgt.x, tgt.z);
          tw.spot = sp; tw.ang = ang; tw.mv = tw.spot && Math.hypot(sp.x - s.x, sp.z - s.z) > 2.5 ? 1 : 2;
        }
        aiBow(m, s, tgt, d, dx, dz, dt, diff, true);
        if (tw.mv === 1) { moveVec(s, T.cx, T.cz); if (Math.hypot(s.x - T.cx, s.z - T.cz) < 1.2) tw.mv = 2; }
        else if (tw.mv === 2) { moveVec(s, tw.spot.x, tw.spot.z); if (Math.hypot(s.x - tw.spot.x, s.z - tw.spot.z) < 0.4) tw.mv = 0; }
      } else if ((tw.idle += dt) > 14) tw.st = 'down';
      if (s.y < L.y1 - 0.5) tw.st = 'down'; // knocked off
      return true;
    }
    case 'down': {
      if (s.y < 0.06) { tw.st = 'out'; tw.age = 0; tw.wp = 0; return true; }
      if (inZone) { inp.yaw = wallYaw; inp.mx = -L.nx; inp.mz = -L.nz; }
      else walkTo(s, L.x, L.z);
      if (tw.age > 60) leaveTower(s, 45);
      return true;
    }
    case 'out': {
      const D = T.door;
      if (tw.wp === 0) { walkTo(s, D.ix, D.iz); if (Math.hypot(s.x - D.ix, s.z - D.iz) < 0.7) tw.wp = 1; }
      else { walkTo(s, D.ox, D.oz); if (Math.hypot(s.x - D.ox, s.z - D.oz) < 1.0) { leaveTower(s, 45); return false; } }
      if (tw.age > 20) { leaveTower(s, 45); return false; }
      return true;
    }
  }
  return true;
}

/* ----- orders (CALL / SEND) and siege duty ----- */
const SGO = (m, s, x, z, dt, tol, line) => {
  const d = Math.hypot(x - s.x, z - s.z);
  if (d > tol) { if (line || s.y > 3) walkTo(s, x, z); else steerTo(m, s, x, z, dt, true); s.input.sprint = d > 18 && (s.y < 3 || s.team === T_RED); s.ai.moved = true; }
  return d <= tol;
};
function route(m, s, dt) { const ai = s.ai, p = ai.rt[ai.ri]; if (!p) { ai.rt = null; return true; } if (SGO(m, s, p.x, p.z, dt, 1.3, p.l)) ai.ri++; return false; }
function cmdMove(m, s, dt) {
  const ai = s.ai, P = ai.follow;
  if (ai.cmd === 'follow') {
    if (!P || !P.alive) { ai.cmd = null; ai.follow = null; return false; }
    const d = Math.hypot(P.x - s.x, P.z - s.z);
    if (d > 5) { steerTo(m, s, P.x, P.z, dt, true); s.input.sprint = d > 16; } else s.input.yaw = P.yaw;
    return true;
  }
  const d = Math.hypot(ai.dx - s.x, ai.dz - s.z);
  if (ai.cmd === 'send' && d > 3) { steerTo(m, s, ai.dx, ai.dz, dt, true); s.input.sprint = d > 20; return true; }
  ai.cmd = 'hold';
  if (d > 7) steerTo(m, s, ai.dx, ai.dz, dt, true);
  return true;
}
function attackerGoal(m, s, dt) {
  const ai = s.ai, d = m.def, inp = s.input, K = m.king;
  if (s.horse && s.z > -84) m.dismount(s);
  if (ai.role === 'cat' && !s.mount) {
    const b = m.catapults[ai.cat];
    if (m.gateOpen && m.phase >= 2) ai.role = 'ladder';
    else if (b) {
      if (b.op && b.op !== s) SGO(m, s, b.x + 3, b.z - 1, dt, 2.5); // the player took it: stand by
      else if (!(m.time < (ai.noMountT || 0))) { if (SGO(m, s, b.x - Math.sin(b.yaw) * 1.5, b.z - Math.cos(b.yaw) * 1.5, dt, 2.2)) m.mountB(s, b); }
      return;
    }
  }
  if (ai.rt && !route(m, s, dt)) return;
  if (s.y > 11.5 && s.z < -50) { const r = d.ramps[Math.abs(s.x + 16) < Math.abs(s.x - 16) ? 0 : 1]; ai.rt = [{ x: r.x, z: -61.5, l: 1 }, { x: r.x, z: r.ze + 1.5, l: 1 }, { x: r.x, z: r.zs - 0.5, l: 1 }]; ai.ri = 0; return; }
  if (m.gateOpen || (s.y < 3 && s.z > -56)) { if (K && K.alive) SGO(m, s, K.x, K.z, dt, 1.5); return; }
  if (ai.role === 'ram') { const r = m.ram; SGO(m, s, r.x + (s.id % 3 - 1) * 1.1, r.z - 3.4, dt, 1.2); return; }
  const L = d.ladders[ai.li % d.ladders.length], bx = L.x, bz = L.z - 2.4;
  if (ladderAt(d, s.x, s.z) || Math.hypot(s.x - bx, s.z - bz) < 1.3) { inp.mx = L.nx; inp.mz = L.nz; inp.yaw = Math.atan2(L.nx, L.nz); ai.moved = true; }
  else SGO(m, s, bx, bz, dt, 1.3);
}
function defenderGoal(m, s, dt) {
  const ai = s.ai, p = ai.post, inp = s.input;
  if (!p) { SGO(m, s, 0, -20, dt, 4); return; }
  if (ai.rt && !route(m, s, dt)) return;
  let x = p.x + (ai.jx || 0), z = p.z; const y = p.y || 0;
  // spawned on the keep roof: run down the ramp by the keep door first (the roof opening is at x 10-15)
  if (s.y > 8 && s.z > 22 && Math.abs(s.x) < 19 && !(y > 8 && p.z > 22)) { ai.rt = [{ x: 12.5, z: 31, l: 1 }, { x: 12.5, z: 25, l: 1 }, { x: 12.5, z: -6, l: 1 }]; ai.ri = 0; return; }
  if (!y) { if (m.phase >= 2) { x = (ai.jx || 0) * 3 + (p.x > 0 ? 3 : -3); z = 34; } else if (m.phase === 1 && p.kind === 'gate') { x = p.x > 0 ? 6 : -6; z = -38; } }
  if (y > 3 && s.y < 3) { const r = m.def.ramps[p.ramp]; ai.rt = p.ramp === 2 ? [{ x: r.x, z: r.zs + 1 }, { x: r.x, z: r.ze, l: 1 }, { x: p.x, z: p.z, l: 1 }] : [{ x: r.x, z: r.zs + 1 }, { x: r.x, z: r.ze, l: 1 }, { x: r.x, z: p.z, l: 1 }, { x: p.x, z: p.z, l: 1 }]; ai.ri = 0; return; }
  if (p.patrol) x = p.x + Math.sin(m.elapsed * 0.15 + s.id) * 12;
  if (SGO(m, s, x, z, dt, p.patrol ? 0.8 : 1.2, y > 3)) {
    if (p.kind === 'ballista' && !s.mount) { const b = m.ballistas[p.bal]; if (!b.op) m.mountB(s, b); }
    inp.yaw = Math.PI;
  }
}
function siegeGoal(m, s, dt) {
  const ai = s.ai;
  if (s.isKing) { ai.kt = (ai.kt || 0) - dt; if (ai.kt <= 0 || !ai.kp) { ai.kt = rnd(5, 9); ai.kp = m.def.kingPts[(Math.random() * m.def.kingPts.length) | 0]; } SGO(m, s, ai.kp[0], ai.kp[1], dt, 1.2); return true; }
  if (s.team === T_BLUE) attackerGoal(m, s, dt); else defenderGoal(m, s, dt);
  return true;
}

/* ----- catapult crew: man a catapult, wind it up and lob stones at the gate and the defenders ----- */
function pickCatTarget(m, s, b) {
  const free = (x, z) => { for (const o of m.soldiers) if (o.alive && o.team === s.team && Math.hypot(o.x - x, o.z - z) < 7.5) return false; return true; };
  const c = [];
  if (m.gate && !m.gateOpen) { const g = m.gate, x = g.x + rnd(-2.5, 2.5), z = g.z - 3; if (free(x, z)) c.push({ x, y: 0.4, z }, { x, y: 0.4, z }); }
  for (const e of m.soldiers) {
    if (!e.alive || e.team === s.team || e.admin || e.isKing) continue;
    const d = Math.hypot(e.x - b.x, e.z - b.z); if (d < 28 || d > 110 || !free(e.x, e.z)) continue;
    c.push({ x: e.x + e.vx * 1.2, y: e.y + 0.8, z: e.z + e.vz * 1.2 });
    if (e.y > 3) c.push({ x: e.x, y: e.y + 0.8, z: e.z });
  }
  return c.length ? c[(Math.random() * c.length) | 0] : null;
}
function catCrew(m, s, dt) {
  const ai = s.ai, inp = s.input, b = s.mount, w = s.weapon;
  if (m.gateOpen && m.phase >= 2) { m.dismount(s); ai.role = 'ladder'; return; } // the breach is made: join the assault
  ai.ct = (ai.ct || 0) - dt;
  if (ai.ct <= 0) { ai.ct = rnd(1.5, 3); ai.ctgt = pickCatTarget(m, s, b); }
  const T = ai.ctgt; inp.aim = null;
  if (!T) return;
  const dx = T.x - b.x, dz = T.z - b.z;
  inp.yaw = Math.atan2(dx, dz);
  const a = s._aim; a.x = T.x; a.y = T.y; a.z = T.z; inp.aim = a;
  const facing = Math.abs(angDiff(s.yaw, inp.yaw)) < 0.1;
  if (s.drawT >= 0) inp.attack = s.drawT < ai.drawGoal;
  else if (facing && s.cdT <= 0 && b.cd <= 0 && !b.pend && s.stagger <= 0) { ai.drawGoal = w.draw * rnd(0.85, 1); inp.attack = true; }
}
function aiThink(m, s, dt) {
  const ai = s.ai, inp = s.input;
  ai.t -= dt;
  if (ai.t <= 0) {
    ai.t = 0.25 + Math.random() * 0.2; pickTarget(m, s);
    if (!ai.tw && ai.cmd !== 'follow' && !s.mount && s.weapon.ranged && ai.twCd <= 0 && m.def.towers.length && (!ai.target || ai.target.team === s.team || Math.hypot(ai.target.x - s.x, ai.target.z - s.z) > 14) && Math.random() < 0.04) tryTower(m, s);
    if (!ai.tw && ai.cmd !== 'follow' && !s.mount && !s.weapon.ranged && s.y < 1 && ai.twCd <= 0 && m.def.towers.length && (!ai.target || Math.hypot(ai.target.x - s.x, ai.target.z - s.z) > 6) && Math.random() < 0.6) tryChase(m, s);
  }
  ai.twCd -= dt;
  inp.attack = false; inp.jump = false; inp.sprint = false; inp.mx = 0; inp.mz = 0;
  ai.moved = false; ai.sideT -= dt;
  if (ai.blockT > 0) { ai.blockT -= dt; inp.block = true; } else inp.block = false;
  if (s.mount && s.mount.cat) { catCrew(m, s, dt); return; }
  if (ai.tw && !s.weapon.ranged && !ai.tw.chase) leaveTower(s, 30);
  if (ai.tw) { const dfn = s.team !== m.cfg.team ? m.diff : DIFF.normal; if (towerTask(m, s, dt, dfn)) { ai.chkT = 0.9; ai.cx = s.x; ai.cz = s.z; return; } }
  const tgt = ai.target;
  if (tgt && tgt.alive) {
    const dx = tgt.x - s.x, dz = tgt.z - s.z, d = Math.hypot(dx, dz) || 0.001, reach = s.weapon.reach;
    inp.yaw = Math.atan2(dx, dz);
    const diff = s.team !== m.cfg.team ? m.diff : DIFF.normal;
    // react to incoming swings
    if (d < tgt.weapon.reach + 1.8 && tgt.atkT >= 0 && tgt.atkT < tgt.weapon.hit && ai.reactId !== tgt.atkSeq) {
      ai.reactId = tgt.atkSeq;
      if (Math.random() < diff.block * ai.skill && s.atkT < 0 && s.stamina > 8) ai.blockT = tgt.weapon.hit - tgt.atkT + 0.22;
    }
    if (s.weapon.ranged) { aiBow(m, s, tgt, d, dx, dz, dt, diff, !!(ai.post && (s.y > 3 || s.mount || ai.post.kind === 'slit'))); }
    else {
    const want = reach * 0.78;
    if (d > want + 0.35) {
      steerTo(m, s, tgt.x, tgt.z, dt, false);
      if (d > 12) inp.sprint = true;
    } else if (d < reach * 0.4) {
      inp.mx = -dx / d * 0.6; inp.mz = -dz / d * 0.6;
    } else {
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafeT = rnd(0.8, 2.2); ai.strafe = Math.random() < 0.5 ? 1 : -1; }
      inp.mx = -dz / d * ai.strafe * 0.55 + dx / d * 0.12; inp.mz = dx / d * ai.strafe * 0.55 + dz / d * 0.12;
    }
    const facing = Math.abs(angDiff(s.yaw, inp.yaw)) < 0.45;
    if (d <= reach + 0.25 && facing && s.atkT < 0 && s.cdT <= 0 && !inp.block && s.stagger <= 0 && Math.random() < 7 * dt * diff.aggr * ai.skill && !(allyInArc(m, s, reach, s.weapon.arc, d) && ((ai.hesT = (ai.hesT || 0) + dt) < 1.5) && Math.random() < 0.93)) { inp.attack = true; ai.hesT = 0; } // crowded in a narrow spot (wall walks): stop dithering and swing
    }
  } else {
    s.input.aim = null;
    // objective behaviour
    const p = (m.mode === 'conquest' || m.mode === 'laststand') && ai.obj >= 0 ? m.points[ai.obj] : null;
    if (ai.cmd ? cmdMove(m, s, dt) : m.mode === 'siege' && siegeGoal(m, s, dt)) { /* following an order, or siege duty */ } else if (!p && m.modeGoal && (ai.mg = m.modeGoal(s))) {
      const g = ai.mg, dd = Math.hypot(g.x - s.x, g.z - s.z);
      if (dd > (g.near || 3)) { steerTo(m, s, g.x, g.z, dt, true); inp.sprint = !!g.sprint || dd > 30; }
    } else if (!p) {
      // hunt the nearest enemy anywhere
      let e = null, bd = 1e9;
      for (const o of m.soldiers) { if (!o.alive || o.team === s.team || o.admin) continue; const d = Math.hypot(o.x - s.x, o.z - s.z); if (d < bd) { bd = d; e = o; } }
      if (e) { steerTo(m, s, e.x, e.z, dt, true); inp.sprint = bd > 20; }
    } else {
      const gx = p.x + ai.ox, gz = p.z + ai.oz, d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d > p.r * 0.6) {
        steerTo(m, s, gx, gz, dt, true);
        inp.sprint = d > 25;
      } else {
        ai.wanderT -= dt;
        if (ai.wanderT <= 0) { ai.wanderT = 2 + Math.random() * 3; ai.ox = rnd(-0.45, 0.45) * p.r; ai.oz = rnd(-0.45, 0.45) * p.r; }
        if (Math.hypot(gx - s.x, gz - s.z) > 1.3) steerTo(m, s, gx, gz, dt, true);
        else inp.yaw = Math.atan2(s.x - p.x, s.z - p.z);
      }
    }
  }
  // stuck detection
  ai.chkT -= dt;
  if (ai.chkT <= 0) {
    ai.chkT = 0.9;
    const moved = Math.hypot(s.x - ai.cx, s.z - ai.cz);
    if (ai.moved && moved < 0.5 && s.stagger <= 0) {
      ai.stuck++; ai.pathT = 0; ai.sideT = 0.7; ai.side = Math.random() < 0.5 ? 1 : -1;
      if (ai.stuck >= 4) {
        if (s.y > 3) { if (ai.tw) { ai.tw.st = 'down'; ai.tw.age = 0; } ai.stuck = 0; } // stuck up high: head back down instead of warping
        else { const q = m.nav.nearestFreePoint(s.x, s.z); s.x = q.x; s.z = q.z; ai.stuck = 0; ai.path = null; }
      }
    } else ai.stuck = 0;
    ai.cx = s.x; ai.cz = s.z;
  }
}

return { T_BLUE, T_RED, WEAPONS, CLASSES, CLASS_IDS, DIFF, buildMap, Nav, Match, Soldier, resolveObstacles, distToObs, groundAt, ladderAt, rayClear, angDiff, clamp };
})();
if (typeof module !== 'undefined') module.exports = Sim;

