/* PlateTrace Match test (Texas Classic plates, ABC-1234 with the Texas outline between the groups).
   Each letter and number is a shape cut from real Texas plates. For a guess at where the characters
   sit and how blurred the footage is, PlateTrace draws a whole test plate, blurs it the same way and
   compares it with the recorded pixels (normalized cross-correlation). Nothing is drawn into the
   evidence; this only scores hypotheses. A character is reported only when it clearly beats every
   other choice and stays the winner when the fit is re-run from different starting points. */
"use strict";

const PTMatch = (() => {
  const GW = 41 / 57;                  // glyph width / pitch (measured on TLM-2392)
  const BOXW = GW * (1 + 4 / 41);      // template box width / pitch (glyph plus small margin)
  const SEP = 101 / 57;                // start of 3rd letter to start of 1st number, in pitches
  const SEP_AT = 55 / 57;              // start of 3rd letter to start of the Texas outline, in pitches
  const SEP_W = 41 / 57;
  const SPAN = 2 + SEP + 3 + GW;       // first glyph's left edge to last glyph's right edge, in pitches
  const WORK_H = 64;
  const TEMP = 0.03, SURE_SHARE = 0.9, SURE_SCORE = 0.7, MIN_FIT = 0.9;
  const LETTERS = "BCDFGHJKLMNPRSTVWXYZ", DIGITS = "0123456789";   // Texas general-issue plates skip all vowels and Q
  const PATTERN = "LLLNNNN";

  let glyphs = null, meta = null;
  const pause = () => new Promise((r) => setTimeout(r, 0));

  async function load() {
    if (glyphs) return;
    const res = await fetch("tx_glyphs/tx_glyphs.json");
    meta = await res.json();
    glyphs = {};
    for (const [k, arr] of Object.entries(meta.glyphs)) {
      const c = document.createElement("canvas"); c.width = 24; c.height = 60;
      const id = c.getContext("2d").createImageData(24, 60);
      arr.forEach((v, i) => id.data.set([v, v, v, 255], i * 4));
      c.getContext("2d").putImageData(id, 0, 0);
      glyphs[k] = c;
    }
  }

  function toWork(img) {
    const src = document.createElement("canvas"); src.width = img.width; src.height = img.height;
    src.getContext("2d").putImageData(img, 0, 0);
    const H = WORK_H, W = Math.max(16, Math.round((img.width * H) / img.height));
    let cur = src;
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

  // Left edge (in working pixels) of each character box, plus the outline separator.
  function layout(m) {
    const boxes = [];
    for (let i = 0; i < 7; i++) {
      const off = i < 3 ? i : 2 + SEP + (i - 3);
      boxes.push(m.x0 + off * m.p - ((BOXW - GW) * m.p) / 2);
    }
    return { boxes, sep: m.x0 + (2 + SEP_AT) * m.p - ((BOXW - GW) * m.p) / 2 };
  }

  // Draw a whole Texas test plate for this guess, at the footage's size, blurred like the footage.
  function render(str, m, obs) {
    const S = 2, c = document.createElement("canvas"); c.width = obs.W * S; c.height = obs.H * S;
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingQuality = "high";
    const L = layout(m), bw = BOXW * m.p, y0 = m.yc - m.h / 2;
    [...str].forEach((ch, i) => x.drawImage(glyphs[ch], L.boxes[i] * S, y0 * S, bw * S, m.h * S));
    x.drawImage(glyphs._sep, L.sep * S, y0 * S, ((SEP_W * BOXW) / GW) * m.p * S, m.h * S);
    const d = document.createElement("canvas"); d.width = obs.W; d.height = obs.H;
    const dx = d.getContext("2d"); dx.imageSmoothingQuality = "high"; dx.drawImage(c, 0, 0, obs.W, obs.H);
    const p = dx.getImageData(0, 0, obs.W, obs.H).data, g = new Float32Array(obs.W * obs.H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = p[j];
    return { g: gauss(g, obs.W, obs.H, m.sigma), L };
  }

  function ncc(a, b, W, x0, y0, x1, y1, ink) {
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W, Math.ceil(x1));
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x, u = a[i], v = b[i]; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; n++;
    }
    if (!n) return -1;
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 0 && vb > 0 ? (ink * cov) / Math.sqrt(va * vb) : -1;
  }
  const rows = (m, obs) => [Math.max(0, Math.floor(m.yc - m.h * 0.7)), Math.min(obs.H, Math.ceil(m.yc + m.h * 0.7))];

  function plateScore(str, m, obs) {
    const r = render(str, m, obs), [y0, y1] = rows(m, obs);
    return ncc(obs.g, r.g, obs.W, m.x0 - m.p * 0.3, y0, m.x0 + (SPAN + 0.3) * m.p, y1, m.ink);
  }
  const poolAt = (i) => (PATTERN[i] === "L" ? LETTERS : DIGITS);

  // Every allowed character at one spot, judged on that spot's own window, neighbours held fixed.
  function spotScores(str, i, m, obs) {
    const [y0, y1] = rows(m, obs);
    return [...poolAt(i)].map((ch) => {
      const r = render(str.slice(0, i) + ch + str.slice(i + 1), m, obs);
      const bx = r.L.boxes[i];
      return [ch, ncc(obs.g, r.g, obs.W, bx - m.p * 0.15, y0, bx + BOXW * m.p + m.p * 0.15, y1, m.ink)];
    }).sort((a, b) => b[1] - a[1]);
  }

  // Where the characters are: rows and columns with the most edge energy.
  function estimate(obs) {
    const { g, W, H } = obs, row = new Float32Array(H), col = new Float32Array(W);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) row[y] += Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    let peak = 0; for (let y = 0; y < H; y++) if (row[y] > row[peak]) peak = y;
    let y0 = peak, y1 = peak; const lim = row[peak] * 0.4;
    while (y0 > 0 && row[y0 - 1] > lim) y0--; while (y1 < H - 1 && row[y1 + 1] > lim) y1++;
    for (let y = y0; y <= y1; y++) for (let x = 1; x < W - 1; x++) col[x] += Math.abs(g[y * W + x + 1] - g[y * W + x - 1]);
    const sm = col.map((_, x) => (col[Math.max(0, x - 1)] + col[x] + col[Math.min(W - 1, x + 1)]) / 3);
    const cl = Math.max(...sm) * 0.2, edge = Math.round(W * 0.02); let x0 = 0, x1 = W - 1;
    for (let x = edge; x < W; x++) if (sm[x] > cl) { x0 = x; break; }
    for (let x = W - 1 - edge; x >= 0; x--) if (sm[x] > cl) { x1 = x; break; }
    return { x0, p: (x1 - x0) / SPAN, yc: (y0 + y1 + 1) / 2, h: (y1 - y0 + 1) * 1.05 };
  }

  async function fit(start, m0, obs, lim, onProgress, p0, p1) {
    let m = { ...m0 }, s = start, score;
    const steps = { x0: m.p * 0.15, p: m.p * 0.04, yc: m.h * 0.06, h: m.h * 0.06, sigma: 0.4 };
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 7; i++) s = s.slice(0, i) + spotScores(s, i, m, obs)[0][0] + s.slice(i + 1);
      score = plateScore(s, m, obs);
      for (const k of Object.keys(steps)) for (const dir of [1, -1]) for (;;) {
        const t = { ...m }; t[k] += dir * steps[k];
        if (k === "sigma" && t.sigma < 0.3) break;
        if (lim[k] && Math.abs(t[k] - lim[k][0]) > lim[k][1]) break;
        const v = plateScore(s, t, obs);
        if (v > score + 1e-4) { m = t; score = v; } else break;
      }
      Object.keys(steps).forEach((k) => (steps[k] /= 2));
      onProgress(p0 + ((p1 - p0) * (round + 1)) / 4); await pause();
    }
    return { s, m, score };
  }

  async function run(img, opt = {}, onProgress = () => {}) {
    await load();
    const obs = toWork(img), est = estimate(obs);
    const lim = { x0: [est.x0, est.p * 0.6], p: [est.p, est.p * 0.15], yc: [est.yc, est.h * 0.25], h: [est.h, est.h * 0.3] };
    // Coarse search: dark-on-light or the reverse, a few sizes, positions and blurs.
    let best = null, n = 0;
    for (const ink of [1, -1]) for (const dh of [0.94, 1.08]) for (const dx of [-0.15, 0.15]) for (const sigma of [1, 2.2]) {
      const m = { ...est, h: est.h * dh, x0: est.x0 + dx * est.p, sigma, ink };
      let s = "BBB0000";
      for (let i = 0; i < 7; i++) s = s.slice(0, i) + spotScores(s, i, m, obs)[0][0] + s.slice(i + 1);
      const v = plateScore(s, m, obs);
      if (!best || v > best.v) best = { v, m, s };
      onProgress((0.5 * ++n) / 16); await pause();
    }
    const main = await fit(best.s, best.m, obs, lim, onProgress, 0.5, 0.7);
    // Re-fit from different starting points; a character must survive all of them.
    const mm = main.m, refits = [];
    const starts = [{ ...mm, h: mm.h * 0.92 }, { ...mm, h: mm.h * 1.08 }, { ...mm, x0: mm.x0 + mm.p * 0.25, sigma: mm.sigma + 0.6 }, { ...mm, x0: mm.x0 - mm.p * 0.25, sigma: Math.max(0.4, mm.sigma - 0.5) }];
    for (let k = 0; k < starts.length; k++) refits.push(await fit(main.s, starts[k], obs, lim, onProgress, 0.7 + 0.075 * k, 0.775 + 0.075 * k));
    const enough = main.score >= MIN_FIT;
    const positions = [...main.s].map((_, i) => {
      const sorted = spotScores(main.s, i, mm, obs);
      const ex = sorted.map(([, v]) => Math.exp((v - sorted[0][1]) / TEMP)), z = ex.reduce((a, b) => a + b, 0);
      const top = sorted.slice(0, 3).map(([ch, v], j) => ({ ch, score: Math.round(v * 100) / 100, share: Math.round((ex[j] / z) * 100) }));
      const agree = refits.filter((r) => r.s[i] === top[0].ch).length;
      const sure = enough && top[0].share >= SURE_SHARE * 100 && top[0].score >= SURE_SCORE && agree === refits.length;
      return { pos: i + 1, result: sure ? top[0].ch : "?", top, stable: `${agree}/${refits.length}` };
    });
    const plate = positions.map((p) => p.result).join("");
    return {
      method: "template matching against Texas Classic character shapes cut from real plates; whole test plates drawn at the footage's size and blur and scored by normalized cross-correlation",
      templates: meta.source + (meta.from_font_chart ? ` (${meta.from_font_chart.join(", ")} from a font chart)` : ""),
      layout: "Texas Classic ABC-1234", polarity: mm.ink === 1 ? "dark characters on light plate" : "light characters on dark plate",
      blur_sigma_px: Math.round(mm.sigma * 10) / 10, fit: Math.round(main.score * 100) / 100, enough_detail: enough,
      rule: `A character is reported only if it takes at least ${SURE_SHARE * 100}% of the match share, scores at least ${SURE_SCORE}, and stays the winner in all ${refits.length} re-fits from different starting points; otherwise it is "?".`,
      plate: plate.slice(0, 3) + "-" + plate.slice(3), mask: plate, positions,
    };
  }

  return { run };
})();
