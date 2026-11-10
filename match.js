/* PlateTrace Match test: template matching against blurred test plates.
   For every position on the plate, each allowed letter or number is drawn in a plate-style font,
   shrunk and blurred to look like the footage, then compared with what was actually recorded
   (normalized cross-correlation). Nothing is drawn into the evidence; this only scores hypotheses.
   A character is only reported when it clearly beats every other choice; otherwise it is "?". */
"use strict";

const PTMatch = (() => {
  const LET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", DIG = "0123456789";
  const FONT = 'bold 100px "Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif';
  const WORK_H = 64;                     // the plate box is studied at this height (pixels)
  const TEMP = 0.035;                    // how sharply scores turn into shares (lower = stricter)
  const SURE_SHARE = 0.8, SURE_SCORE = 0.75, MIN_FIT = 0.3;

  const pause = () => new Promise((r) => setTimeout(r, 0));

  function toWork(img) {
    const src = document.createElement("canvas"); src.width = img.width; src.height = img.height;
    src.getContext("2d").putImageData(img, 0, 0);
    const H = WORK_H, W = Math.max(16, Math.round((img.width * H) / img.height));
    let cur = src;                                     // halve step by step so shrinking doesn't alias
    while (cur.height / 2 >= H * 1.4) {
      const c = document.createElement("canvas"); c.width = Math.round(cur.width / 2); c.height = Math.round(cur.height / 2);
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, c.width, c.height); cur = c;
    }
    const d = document.createElement("canvas"); d.width = W; d.height = H;
    const x = d.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, W, H);
    const p = x.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * p[j] + 0.587 * p[j + 1] + 0.114 * p[j + 2];
    return { g, W, H };
  }

  function gauss(src, w, h, sigma) {
    if (sigma < 0.3) return src;
    const r = Math.ceil(sigma * 2.5), k = [];
    let s = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))]; tmp[y * w + x] = a;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]; out[y * w + x] = a;
    }
    return out;
  }

  // One test character, dark on light, the size of one slot, blurred like the footage.
  const cache = new Map();
  let condense = null;
  function template(ch, tw, th, capH, sigma) {
    const key = `${ch}|${tw}|${th}|${capH}|${sigma}`;
    if (cache.has(key)) return cache.get(key);
    const S = 4, c = document.createElement("canvas"); c.width = tw * S; c.height = th * S;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.font = FONT;
    if (!condense) { const m = x.measureText("H"); condense = { cap: m.actualBoundingBoxAscent || 72 }; }
    const scale = (capH * S) / condense.cap;
    const mW = x.measureText("M").width * scale;
    const sx = Math.min(1, (0.86 * tw * S) / mW);       // plate fonts are narrow: squeeze to fit the slot
    x.save(); x.translate(c.width / 2, c.height / 2 + (capH * S) / 2); x.scale(scale * sx, scale);
    x.fillStyle = "#000"; x.textAlign = "center"; x.textBaseline = "alphabetic"; x.fillText(ch, 0, 0); x.restore();
    const d = document.createElement("canvas"); d.width = tw; d.height = th;
    const dx = d.getContext("2d"); dx.imageSmoothingQuality = "high"; dx.drawImage(c, 0, 0, tw, th);
    const p = dx.getImageData(0, 0, tw, th).data, g = new Float32Array(tw * th);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = p[j];
    const t = prep(gauss(g, tw, th, sigma));
    cache.set(key, t);
    return t;
  }
  function prep(a) {                                   // zero mean, unit length
    let m = 0; for (const v of a) m += v; m /= a.length;
    let n = 0; const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) { o[i] = a[i] - m; n += o[i] * o[i]; }
    n = Math.sqrt(n) || 1; for (let i = 0; i < o.length; i++) o[i] /= n;
    return o;
  }
  function patch(obs, x0, y0, tw, th) {
    const { g, W, H } = obs, out = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++)
      out[y * tw + x] = g[Math.min(H - 1, Math.max(0, y0 + y)) * W + Math.min(W - 1, Math.max(0, x0 + x))];
    return prep(out);
  }
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  function poolFor(kind, noIOQ) {
    if (kind === "L") return noIOQ ? LET.replace(/[IOQ]/g, "") : LET;
    if (kind === "N") return DIG;
    return (noIOQ ? LET.replace(/[IOQ]/g, "") : LET) + DIG;
  }

  // Slot rectangles for a layout and a guess at where the characters sit on the plate.
  function slots(pattern, geo, obs) {
    const n = pattern.length, capH = Math.round(geo.h * obs.H), th = Math.round(capH * 1.3);
    let cut = -1; for (let i = 1; i < n; i++) if (pattern[i] !== pattern[i - 1] && pattern[i] !== "X" && pattern[i - 1] !== "X") { cut = i; break; }
    const left = geo.l * obs.W, right = geo.r * obs.W;
    const units = n + (cut > 0 ? geo.gap : 0), sw = (right - left) / units;
    const tw = Math.max(5, Math.round(sw)), yTop = Math.round(geo.c * obs.H - th / 2);
    const out = Array.from({ length: n }, (_, i) => { const fx = left + sw * (i + (cut > 0 && i >= cut ? geo.gap : 0)); return { x: Math.round(fx), fx, y: yTop, tw, th, capH }; });
    out.cut = cut; return out;
  }

  function scoreSlot(obs, s, pool, sigma, sx, sy, ink) {
    let best = null;
    for (let dy = -sy; dy <= sy; dy++) for (let dx = -sx; dx <= sx; dx++) {
      const p = patch(obs, s.x + dx, s.y + dy, s.tw, s.th);
      const sc = [...pool].map((ch) => [ch, ink * dot(p, template(ch, s.tw, s.th, s.capH, sigma))]);
      const top = Math.max(...sc.map((v) => v[1]));
      if (!best || top > best.top) best = { top, sc, dx, dy };
    }
    return best;
  }

  // Whole-plate model: draw a full candidate plate with a given layout geometry and blur,
  // at the same size as the footage, so neighbouring characters and spacing are judged together.
  function renderPlate(str, pattern, geo, sigma, obs) {
    const S = 3, W = obs.W, H = obs.H, c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.font = FONT;
    if (!condense) condense = { cap: x.measureText("H").actualBoundingBoxAscent || 72 };
    const ss = slots(pattern, geo, obs), capH = geo.h * H, scale = (capH * S) / condense.cap;
    const sw = ((geo.r - geo.l) * W) / (pattern.length + (ss.cut > 0 ? geo.gap : 0));
    const sx = ((geo.wx || 0.86) * sw * S) / (x.measureText("M").width * scale);
    x.fillStyle = "#000"; x.textAlign = "center"; x.textBaseline = "alphabetic";
    [...str].forEach((ch, i) => {
      const cx = (ss[i].fx + sw / 2) * S, base = (geo.c * H + capH / 2) * S;
      x.save(); x.translate(cx, base); x.scale(scale * sx, scale); x.fillText(ch, 0, 0); x.restore();
    });
    const d = document.createElement("canvas"); d.width = W; d.height = H;
    const dx = d.getContext("2d"); dx.imageSmoothingQuality = "high"; dx.drawImage(c, 0, 0, W, H);
    const p = dx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = p[j];
    return { g: gauss(g, W, H, sigma), ss, sw };
  }
  function nccRect(a, b, W, x0, y0, x1, y1, ink) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x, u = a[i], v = b[i]; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; n++;
    }
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 0 && vb > 0 ? (ink * cov) / Math.sqrt(va * vb) : -1;
  }
  function bandRect(geo, obs) {
    const y0 = Math.max(0, Math.floor((geo.c - geo.h * 0.85) * obs.H)), y1 = Math.min(obs.H, Math.ceil((geo.c + geo.h * 0.85) * obs.H));
    const x0 = Math.max(0, Math.floor((geo.l - 0.02) * obs.W)), x1 = Math.min(obs.W, Math.ceil((geo.r + 0.02) * obs.W));
    return [x0, y0, x1, y1];
  }
  function plateScore(str, pattern, m, obs) {
    const r = renderPlate(str, pattern, m.geo, m.sigma, obs), [x0, y0, x1, y1] = bandRect(m.geo, obs);
    return nccRect(obs.g, r.g, obs.W, x0, y0, x1, y1, m.ink);
  }
  // Score every allowed character at one position, judged on that position's own window.
  function positionScores(str, i, pattern, m, obs, pool) {
    const [, y0, , y1] = bandRect(m.geo, obs);
    return [...pool].map((ch) => {
      const s2 = str.slice(0, i) + ch + str.slice(i + 1), r = renderPlate(s2, pattern, m.geo, m.sigma, obs);
      const x0 = Math.max(0, Math.floor(r.ss[i].fx - r.sw * 0.15)), x1 = Math.min(obs.W, Math.ceil(r.ss[i].fx + r.sw * 1.15));
      return [ch, nccRect(obs.g, r.g, obs.W, x0, y0, x1, y1, m.ink)];
    }).sort((a, b) => b[1] - a[1]);
  }
  async function refine(str, pattern, m, obs, pools, onProgress, p0, p1) {
    let cur = { ...m, geo: { ...m.geo } }, s = str, score = plateScore(s, pattern, cur, obs);
    const steps = { l: 0.02, r: 0.02, c: 0.03, h: 0.04, wx: 0.1, gap: 0.25, sigma: 0.4 };
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < s.length; i++) {             // best character at each spot, others held fixed
        const sc = positionScores(s, i, pattern, cur, obs, pools[i]);
        s = s.slice(0, i) + sc[0][0] + s.slice(i + 1);
      }
      score = plateScore(s, pattern, cur, obs);
      for (const k of Object.keys(steps)) {            // then nudge size, position, spacing and blur
        for (const dir of [1, -1]) {
          for (;;) {
            const t = { ...cur, geo: { ...cur.geo } };
            if (k === "sigma") t.sigma = Math.max(0.3, t.sigma + dir * steps[k]); else t.geo[k] = (t.geo[k] ?? 0.86) + dir * steps[k];
            if (k === "wx" && (t.geo.wx < 0.55 || t.geo.wx > 1.0)) break;
            if (m.lim && k in m.lim && Math.abs(t.geo[k] - m.lim[k][0]) > m.lim[k][1]) break;
            if (k === "gap" && (t.geo.gap < 0 || t.geo.gap > 1)) break;
            const v = plateScore(s, pattern, t, obs);
            if (v > score + 1e-4) { cur = t; score = v; } else break;
          }
        }
      }
      Object.keys(steps).forEach((k) => (steps[k] /= 2));
      onProgress(p0 + ((p1 - p0) * (round + 1)) / 4); await pause();
    }
    return { s, m: cur, score };
  }

  // Where the characters are: rows and columns with the most edge energy.
  function estimateGeometry(obs, n) {
    const { g, W, H } = obs, row = new Float32Array(H), col = new Float32Array(W);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) row[y] += Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    let peak = 0; for (let y = 0; y < H; y++) if (row[y] > row[peak]) peak = y;
    let y0 = peak, y1 = peak; const lim = row[peak] * 0.45;
    while (y0 > 0 && row[y0 - 1] > lim) y0--; while (y1 < H - 1 && row[y1 + 1] > lim) y1++;
    for (let y = y0; y <= y1; y++) for (let x = 1; x < W - 1; x++) col[x] += Math.abs(g[(y + 1 < H ? y + 1 : y) * W + x] - g[(y > 0 ? y - 1 : y) * W + x]) + Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    const sm = col.map((_, x) => (col[Math.max(0, x - 1)] + col[x] + col[Math.min(W - 1, x + 1)]) / 3);
    const cm = Math.max(...sm), cl = cm * 0.25; let x0 = 0, x1 = W - 1;
    const edge = Math.round(W * 0.02);
    for (let x = edge; x < W; x++) if (sm[x] > cl) { x0 = x; break; }
    for (let x = W - 1 - edge; x >= 0; x--) if (sm[x] > cl) { x1 = x; break; }
    const hgt = (y1 - y0 + 1) / H, sw = (x1 - x0) / W / n;
    return { h: hgt * 1.08, c: (y0 + y1 + 1) / 2 / H, l: x0 / W - sw * 0.07, r: x1 / W + sw * 0.07 };
  }

  async function run(img, patterns, opt = {}, onProgress = () => {}) {
    const obs = toWork(img);
    const pats = patterns.length ? patterns : ["XXXXXX", "XXXXXXX"];
    const geos = opt.geos ? opt.geos.slice() : [];
    const est = estimateGeometry(obs, (pats[0] || "XXXXXXX").length);
    if (!opt.geos) for (const dh of [-0.06, 0, 0.06]) for (const dc of [-0.03, 0, 0.03]) for (const dl of [-0.03, 0, 0.03]) for (const dr of [-0.03, 0, 0.03]) for (const gap of [0, 0.5])
      geos.push({ h: est.h + dh, c: est.c + dc, l: est.l + dl, r: est.r + dr, gap });
    let best = null, done = 0;
    const total = pats.length * geos.length;
    for (const pattern of pats) {
      const pools = [...pattern].map((k) => poolFor(k, opt.noIOQ));
      for (const geo of geos) {
        const ss = slots(pattern, geo, obs);
        for (const ink of [1, -1]) {                   // dark characters on a light plate, or the reverse
          let sum = 0;
          for (let i = 0; i < ss.length; i++) sum += scoreSlot(obs, ss[i], pools[i], 1.5, Math.round(ss[i].tw * 0.3), 0, ink).top;
          const fit = sum / ss.length;
          if (!best || fit > best.fit) best = { fit, pattern, geo, ink };
        }
        if (++done % 40 === 0) { onProgress(0.7 * done / total); await pause(); }
      }
    }
    // Starting guess: the best character in each slot.
    const pools = [...best.pattern].map((p) => poolFor(p, opt.noIOQ));
    const ss0 = slots(best.pattern, best.geo, obs);
    let start = ss0.map((s, i) => scoreSlot(obs, s, pools[i], 1.5, Math.round(s.tw * 0.3), 1, best.ink).sc.reduce((a, b) => (b[1] > a[1] ? b : a))[0]).join("");
    // Fit the whole plate: characters, size, position, spacing and blur together.
    const lim = { l: [est.l, 0.04], r: [est.r, 0.04], h: [est.h, est.h * 0.25], c: [est.c, 0.05] };
    const fit0 = await refine(start, best.pattern, { geo: best.geo, sigma: 1.5, ink: best.ink, lim }, obs, pools, onProgress, 0.7, 0.85);
    // Stability check: re-fit from slightly different starting sizes / blur.
    // A character is only reported if every re-fit lands on the same character.
    const g0 = fit0.m.geo, starts = [
      { geo: { ...g0, h: g0.h * 0.9 }, sigma: fit0.m.sigma, ink: best.ink, lim },
      { geo: { ...g0, h: g0.h * 1.1 }, sigma: fit0.m.sigma, ink: best.ink, lim },
      { geo: { ...g0, l: g0.l + 0.02, r: g0.r - 0.02 }, sigma: fit0.m.sigma * 1.3 + 0.2, ink: best.ink, lim },
    ];
    const refits = [];
    for (let k = 0; k < starts.length; k++) refits.push(await refine(fit0.s, best.pattern, starts[k], obs, pools, onProgress, 0.85 + 0.05 * k, 0.9 + 0.05 * k));
    const fine = { fit: fit0.score, sigma: Math.round(fit0.m.sigma * 10) / 10 };
    const positions = [...fit0.s].map((ch0, i) => {
      const sorted = positionScores(fit0.s, i, best.pattern, fit0.m, obs, pools[i]);
      const ex = sorted.map(([, v]) => Math.exp((v - sorted[0][1]) / TEMP)), z = ex.reduce((a, b) => a + b, 0);
      const top = sorted.slice(0, 3).map(([ch, v], j) => ({ ch, score: Math.round(v * 100) / 100, share: Math.round((ex[j] / z) * 100) }));
      const agree = refits.filter((r) => r.s[i] === top[0].ch).length;
      const sure = fine.fit >= MIN_FIT && top[0].share >= SURE_SHARE * 100 && top[0].score >= SURE_SCORE && agree === refits.length;
      return { pos: i + 1, kind: best.pattern[i], result: sure ? top[0].ch : "?", top, stable: `${agree}/${refits.length}` };
    });
    const enough = fine.fit >= MIN_FIT;
    return {
      method: "template matching: each allowed character drawn in a plate-style font, shrunk and blurred to match the footage, scored by normalized cross-correlation at each position",
      font_note: "Generic narrow sans-serif font; real state plate fonts differ slightly, which lowers scores but does not add characters.",
      layout: best.pattern, polarity: best.ink === 1 ? "dark characters on light plate" : "light characters on dark plate",
      blur_sigma_px: fine.sigma, fit: Math.round(fine.fit * 100) / 100, enough_detail: enough,
      rule: `A character is reported only if it takes at least ${SURE_SHARE * 100}% of the match share and scores at least ${SURE_SCORE}; and stays the top choice when the blur, size and spacing are changed slightly (3 re-fits); otherwise it is "?".`,
      _model: { s: fit0.s, m: fit0.m, pattern: best.pattern, start },
      plate: enough ? positions.map((p) => p.result).join("") : "?".repeat(positions.length),
      positions,
    };
  }

  return { run, _dbg: { toWork, renderPlate, estimateGeometry } };
})();
