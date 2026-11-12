/* PlateTrace integrity layer: what each operation may honestly claim, file provenance, and a
   recovery assessment for every output.

   Rules this file enforces:
   - Contrast stretch / levels makes faint-but-present edges visible. It never "reveals" absent detail.
   - Unsharp mask is cosmetic only and is labelled as non-recovery.
   - Deconvolution is partial sharpening that is only meaningful when the blur is known or estimated;
     it always carries an uncertainty flag and never guarantees character accuracy.
   - Multi-frame stacking needs several genuine (non-duplicate) frames and is confidence-scored.
   - Color channel separation is offered only when the channels hold distinct data.
   - Metadata / provenance is factual only: what the file says, nothing inferred beyond the rules below.
   - INV-4: if the blur is as wide as the character strokes, the detail did not survive and the output
     can't be evidence-grade, whatever it looks like.
   - Any generative / inferred output (model-based candidates) gets the disclaimer attached and is
     never evidence-grade. */
"use strict";

const PTIntegrity = (() => {
  const LABELS = {
    contrast: "Contrast stretch / levels: makes faint-but-present edges easier to see. It does not reveal detail that was not recorded.",
    sharpen: "Sharpening (unsharp mask): cosmetic only. It changes how crisp edges look; it is not recovery and adds no information.",
    deconvolution: "Unblur (deconvolution): partial sharpening, valid only as far as the blur shape is right. The result is uncertain and never guarantees that a character is correct.",
    stacking: "Multi-frame stacking: lowers noise when the frames are genuinely different captures. Gains detail only if the plate shifts by fractions of a pixel between frames.",
    channels: "Color channel separation: can help when glare or tint sits mostly in one color. Only offered when the channels hold different data.",
    provenance: "Metadata / provenance: facts read from the file itself (resolution, compression, capture settings). Nothing is guessed.",
  };
  const DISCLAIMER_GENERATIVE = "GENERATED / INFERRED OUTPUT. This was produced by a model (for example, re-blurring candidate plates and scoring the fit). It is a hypothesis, not recovered detail and not evidence. Never use it alone to identify a plate; confirm against the original footage and agency records.";
  const RAW_EXT = /\.(dng|cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|mrw|raw)$/i;
  const EDITORS = /photoshop|lightroom|gimp|snapseed|picsart|canva|pixlr|affinity|paint\.net|facetune|vsco|instagram|whatsapp|messenger|screenshot|preview|photos \d|capture one|darktable|rawtherapee/i;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r2 = (v) => Math.round(v * 100) / 100;

  // ---------- provenance: read facts straight from the file bytes ----------
  const ascii = (dv, o, n) => { let s = ""; for (let i = 0; i < n && o + i < dv.byteLength; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };

  function readExif(dv, start, len) {
    if (ascii(dv, start, 4) !== "Exif") return null;
    const t = start + 6, le = dv.getUint16(t) === 0x4949;
    const u16 = (o) => dv.getUint16(t + o, le), u32 = (o) => dv.getUint32(t + o, le);
    const out = {};
    const val = (type, count, vo) => {
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1, inline = size * count <= 4, off = inline ? vo : u32(vo);
      if (t + off + size * count > start + len + 4) return null;
      if (type === 2) return ascii(dv, t + off, count);
      if (type === 3) return u16(off);
      if (type === 4) return u32(off);
      if (type === 5) { const n = u32(off), d = u32(off + 4); return d ? n / d : null; }
      return null;
    };
    const ifd = (o, map) => {
      if (o <= 0 || t + o + 2 > dv.byteLength) return;
      const n = u16(o);
      for (let i = 0; i < n; i++) {
        const e = o + 2 + i * 12; if (t + e + 12 > dv.byteLength) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        if (tag === 0x8769) ifd(u32(e + 8), EXIF_TAGS);
        else if (map[tag]) { const v = val(type, count, e + 8); if (v != null && v !== "") out[map[tag]] = v; }
      }
    };
    const IFD0 = { 0x010f: "make", 0x0110: "model", 0x0131: "software", 0x0132: "date_time", 0x0112: "orientation" };
    const EXIF_TAGS = { 0x9003: "date_time_original", 0x829a: "exposure_time_s", 0x829d: "f_number", 0x8827: "iso", 0x920a: "focal_length_mm", 0xa405: "focal_length_35mm" };
    try { ifd(u32(4), IFD0); } catch { /* damaged EXIF: report what was read */ }
    return out;
  }

  // Estimated JPEG quality from the luminance quantization table (IJG scaling).
  const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  function jpegQuality(q) {
    let sum = 0, std = 0; for (let i = 0; i < 64; i++) { sum += q[i]; std += STD_LUMA[i]; }   // order-independent ratio
    const s = (sum / std) * 100;
    return Math.round(clamp(s <= 100 ? (200 - s) / 2 : 5000 / s, 1, 100));
  }

  function sniff(buf, name, type) {
    const dv = new DataView(buf), info = { container: null, width: null, height: null, compression: null };
    if (dv.byteLength > 3 && dv.getUint16(0) === 0xffd8) {
      info.container = "JPEG"; info.compression = "lossy (JPEG)";
      let o = 2;
      while (o + 4 < dv.byteLength) {
        if (dv.getUint8(o) !== 0xff) break;
        const m = dv.getUint8(o + 1), len = dv.getUint16(o + 2);
        if (m === 0xe1 && !info.exif) info.exif = readExif(dv, o + 4, len - 2);
        if (m === 0xdb && info.jpeg_quality_est == null) {
          const pq = dv.getUint8(o + 4) >> 4, q = [];
          for (let i = 0; i < 64; i++) q.push(pq ? dv.getUint16(o + 5 + i * 2) : dv.getUint8(o + 5 + i));
          info.jpeg_quality_est = jpegQuality(q);
        }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          info.height = dv.getUint16(o + 5); info.width = dv.getUint16(o + 7);
          info.jpeg_mode = m === 0xc2 ? "progressive" : "baseline";
        }
        if (m === 0xda) break;
        o += 2 + len;
      }
    } else if (dv.byteLength > 24 && dv.getUint32(0) === 0x89504e47) {
      info.container = "PNG"; info.compression = "lossless (PNG)";
      info.width = dv.getUint32(16); info.height = dv.getUint32(20); info.bit_depth = dv.getUint8(24);
      let o = 8;
      while (o + 12 <= dv.byteLength) {
        const len = dv.getUint32(o), typ = ascii(dv, o + 4, 4);
        if (typ === "tEXt") {
          const raw = new Uint8Array(buf, o + 8, len), z = raw.indexOf(0);
          const key = new TextDecoder().decode(raw.slice(0, z)), val = new TextDecoder().decode(raw.slice(z + 1));
          if (key === "PlateTrace") { try { info.platetrace_capture = JSON.parse(val); } catch { info.platetrace_capture = { unreadable: true }; } }
          else if (/software/i.test(key)) info.software = val;
        }
        if (typ === "IEND") break;
        o += 12 + len;
      }
    } else if (ascii(dv, 0, 4) === "RIFF" && ascii(dv, 8, 4) === "WEBP") { info.container = "WebP"; info.compression = "WebP (usually lossy)"; }
    else if (ascii(dv, 4, 4) === "ftyp") {
      const brand = ascii(dv, 8, 4);
      info.container = /hei|mif1|avif/i.test(brand) ? `HEIF (${brand})` : `MP4 / MOV (${brand})`;
      const head = new Uint8Array(buf, 0, Math.min(dv.byteLength, 4 * 1024 * 1024));
      const find = (s) => { const c = [...s].map((ch) => ch.charCodeAt(0)); outer: for (let i = 0; i < head.length - 4; i++) { for (let k = 0; k < 4; k++) if (head[i + k] !== c[k]) continue outer; return true; } return false; };
      const codec = ["avc1", "hvc1", "hev1", "av01", "vp09", "mp4v"].find(find);
      if (codec) info.codec = { avc1: "H.264", hvc1: "H.265 / HEVC", hev1: "H.265 / HEVC", av01: "AV1", vp09: "VP9", mp4v: "MPEG-4 Part 2" }[codec];
      info.compression = "lossy (inter-frame video compression)";
    } else if (dv.byteLength > 4 && dv.getUint32(0) === 0x1a45dfa3) { info.container = "WebM / Matroska"; info.compression = "lossy (inter-frame video compression)"; }
    if (RAW_EXT.test(name)) { info.container = info.container || "camera RAW"; info.compression = "RAW sensor data (format-specific)"; }
    if (!info.container) info.container = type || "unknown";
    return info;
  }

  // Source type, by fixed rules (each rule is written into the report).
  function classify(file, info, tipRow) {
    const pc = info.platetrace_capture;
    if (RAW_EXT.test(file.name)) return { source_type: "raw_capture", rule: "camera RAW file extension" };
    if (pc && pc.origin === "special_light_output") return { source_type: "derivative", rule: `PlateTrace Camera special-light result (${pc.method || pc.mode}) built from ${pc.from_frames || "several"} original captures; the originals are the evidence` };
    if (pc && pc.origin === "live_capture" && info.container === "PNG") {
      const tipOk = !tipRow || tipRow.sha256_at_capture === file.sha256;
      return tipOk ? { source_type: "raw_capture", rule: "lossless frame captured live by PlateTrace Camera special-light mode (embedded capture record)" + (tipRow ? "; fingerprint matches the one taken on the phone" : "") }
        : { source_type: "derivative", rule: "carries a PlateTrace capture record but its fingerprint does not match the one taken on the phone" };
    }
    if ((file.type || "").startsWith("video/") || /^(MP4|WebM)/.test(info.container)) return { source_type: "video_frame", rule: "frames decoded from compressed video" };
    if (tipRow && tipRow.sha256_at_capture === file.sha256 && /^(JPEG|PNG)$/.test(info.container)) return { source_type: "processed_image", rule: "photo taken in PlateTrace Camera (phone-processed); fingerprint matches the one taken on the phone" };
    const ex = info.exif || {};
    const sw = ex.software || info.software || "";
    if (EDITORS.test(sw)) return { source_type: "derivative", rule: `file was saved by editing/sharing software ("${sw}")` };
    if (info.container === "JPEG" && (ex.make || ex.model)) return { source_type: "processed_image", rule: "camera JPEG with the camera's own capture record (in-camera processing and compression)" };
    if (info.container === "JPEG") return { source_type: "derivative", rule: "JPEG without a camera capture record (usually re-saved, exported or sent through an app)" };
    if (info.container === "PNG") return { source_type: "derivative", rule: "PNG without a capture record (usually a screenshot or export)" };
    return { source_type: "derivative", rule: `${info.container} without a camera capture record` };
  }

  async function provenance(files, tipRows) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const buf = await f.file.arrayBuffer();
      const info = sniff(buf, f.name, f.type);
      const tip = tipRows?.[i] || null;
      const cls = classify(f, info, tip);
      out.push({ file: f.name, bytes: f.size, mime: f.type || null, ...info, ...cls,
        capture_settings_from_phone: tip?.camera || null });
    }
    return out;
  }
  // Weakest source decides the case (a chain is only as good as its weakest link).
  const RANK = { raw_capture: 3, processed_image: 2, video_frame: 1, derivative: 0 };
  const caseSource = (prov) => prov.reduce((a, p) => (RANK[p.source_type] < RANK[a] ? p.source_type : a), "raw_capture");

  // ---------- measurements on the combined plate ----------
  function grayOf(img, channel) {
    const n = img.width * img.height, g = new Float32Array(n), d = img.data;
    const c = channel === "r" ? 0 : channel === "g" ? 1 : channel === "b" ? 2 : -1;
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = c < 0 ? 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] : d[j + c];
    return g;
  }
  const at = (g, w, hgt, x, y) => {
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, hgt - 1.001);
    const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
    return (g[i] * (1 - ax) + g[i + 1] * ax) * (1 - ay) + (g[i + w] * (1 - ax) + g[i + w + 1] * ax) * ay;
  };
  const median = (a) => { if (!a.length) return null; const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };

  // Noise: median absolute Laplacian (robust; edges barely move it).
  function noiseSigma(g, w, hgt) {
    const v = [];
    for (let y = 1; y < hgt - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x; v.push(Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]));
    }
    return (median(v) || 0) / (0.6745 * Math.sqrt(20));
  }

  // Edge profiles: sampled across each strong edge, along the gradient (dark -> bright), lightly smoothed.
  function edgeProfiles(g, w, hgt) {
    const gx = new Float32Array(w * hgt), gy = new Float32Array(w * hgt), mag = new Float32Array(w * hgt);
    for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      gy[i] = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
    const thr = Float32Array.from(mag).sort()[Math.floor(mag.length * 0.95)];
    const L = Math.max(10, Math.round(Math.min(w, hgt) / 3)), out = [];
    const step = Math.max(1, Math.floor(Math.sqrt((w * hgt * 0.05) / 900)));
    for (let y = 2; y < hgt - 2; y += step) for (let x = 2; x < w - 2; x += step) {
      const i = y * w + x; if (mag[i] < thr || !mag[i]) continue;
      // keep only local maxima of the gradient along its direction (the edge centre)
      const ux = gx[i] / mag[i], uy = gy[i] / mag[i];
      if (at(mag, w, hgt, x + ux, y + uy) > mag[i] || at(mag, w, hgt, x - ux, y - uy) > mag[i]) continue;
      const raw = [];
      for (let t = -L; t <= L; t += 0.5) raw.push(at(g, w, hgt, x + ux * t, y + uy * t));
      const prof = raw.map((v, k) => (raw[Math.max(0, k - 1)] + 2 * v + raw[Math.min(raw.length - 1, k + 1)]) / 4);
      out.push(prof);
      if (out.length > 1200) break;
    }
    return out;
  }
  // Blur: 10-90% rise across edges that are flat on BOTH sides (wide paper / wide ink), so thin strokes
  // can't shorten the measurement. Gaussian: rise = 2.563 sigma; blur_radius = HWHM = 1.177 sigma.
  function estimateBlur(profiles) {
    const widths = [], amps = [], loose = [], looseA = [];
    for (const prof of profiles) {
      const c = prof.length >> 1; let lo = c, hi = c;
      while (lo > 0 && prof[lo - 1] <= prof[lo] + 0.5) lo--;
      while (hi < prof.length - 1 && prof[hi + 1] >= prof[hi] - 0.5) hi++;
      const A = prof[hi] - prof[lo]; if (A < 8) continue;
      const v10 = prof[lo] + 0.1 * A, v90 = prof[lo] + 0.9 * A;
      let t10 = null, t90 = null;
      for (let k = lo; k < hi; k++) {
        if (t10 == null && prof[k + 1] >= v10) t10 = k + (v10 - prof[k]) / Math.max(1e-6, prof[k + 1] - prof[k]);
        if (t90 == null && prof[k + 1] >= v90) { t90 = k + (v90 - prof[k]) / Math.max(1e-6, prof[k + 1] - prof[k]); break; }
      }
      if (t10 == null || t90 == null) continue;
      const rise = t90 - t10, near = Math.ceil(rise * 0.4), far = Math.ceil(rise * 1.2) + 2;
      loose.push(rise * 0.5); looseA.push(A);
      const a0 = Math.floor(t10) - far, b0 = Math.ceil(t90) + far;
      let flat = a0 >= 0 && b0 < prof.length;
      for (let q = a0; flat && q <= Math.floor(t10) - near; q++) if (Math.abs(prof[q] - prof[lo]) > 0.12 * A) flat = false;
      for (let q = Math.ceil(t90) + near; flat && q <= b0; q++) if (Math.abs(prof[q] - prof[hi]) > 0.12 * A) flat = false;
      if (flat) { widths.push(rise * 0.5); amps.push(A); }
    }
    const plateau = widths.length >= 8;
    const rise = plateau ? median(widths) : median(loose);
    if (rise == null) return { samples: 0, sigma: null, radius: null, amplitude: null, plateau_edges: 0 };
    const sigma = rise / 2.563;
    return { samples: plateau ? widths.length : loose.length, plateau_edges: widths.length, from_plateau_edges: plateau, sigma, radius: sigma * 1.1774, amplitude: median(plateau ? amps : looseA) };
  }

  // Blurred bar of width s (in sigmas): full width at half of its own peak, in sigmas.
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const barP = (x, s) => 0.5 * (erf((x + s / 2) / Math.SQRT2) - erf((x - s / 2) / Math.SQRT2));
  const FWHM_TABLE = (() => { const t = []; for (let s = 0.02; s <= 40; s *= 1.05) { const half = barP(0, s) / 2; let a = 0, b = s / 2 + 6; for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if (barP(m, s) > half) a = m; else b = m; } t.push([s, 2 * a, barP(0, s)]); } return t; })();
  const FWHM_MIN = FWHM_TABLE[0][1];

  // Stroke width: walk from each edge into the ink to the stroke's middle and out the other side, and
  // measure the stroke at half its own depth (FWHM). Blur widens that, so the true width is recovered
  // from the blur-model table above; if the stroke is no wider than the blur alone would make a hair-
  // thin line, its true width is unknowable and is reported as at most the blur's own width.
  function estimateStroke(g, w, hgt, profiles, sigma) {
    const hist = new Float64Array(256); for (const v of g) hist[clamp(v | 0, 0, 255)]++;
    const n = g.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, b = wB * wF * (mB - mF) ** 2; if (b > best) { best = b; t = i; } }
    let dark = 0; for (const v of g) if (v <= t) dark++;
    const inkIsDark = dark <= n / 2, fw = [];
    for (const p0 of profiles) {
      const prof = inkIsDark ? p0 : p0.map((v) => 255 - v).reverse();   // ink always on the low, left side
      const c = prof.length >> 1; let k = c;
      while (k > 0 && prof[k - 1] <= prof[k] + 0.5) k--;               // down into the stroke's middle
      const mid = k, bottom = prof[mid];
      let j = mid; while (j > 0 && prof[j - 1] >= prof[j] - 0.5) j--;  // up the stroke's far side
      if (j === 0) continue;                                              // ink wider than the window: not a stroke
      let hiNear = c; while (hiNear < prof.length - 1 && prof[hiNear + 1] >= prof[hiNear] - 0.5) hiNear++;
      const top = Math.min(prof[hiNear], prof[j]), depth = top - bottom; if (depth < 8) continue;
      const half = bottom + depth / 2;
      let a = null, b = null;
      for (let q = mid; q > j; q--) if (prof[q - 1] >= half) { a = q - (prof[q] < half ? (half - prof[q]) / Math.max(1e-6, prof[q - 1] - prof[q]) : 0); break; }
      for (let q = mid; q < hiNear; q++) if (prof[q + 1] >= half) { b = q + (half - prof[q]) / Math.max(1e-6, prof[q + 1] - prof[q]); break; }
      if (a == null || b == null) continue;
      fw.push((b - a) * 0.5);
    }
    // Perpendicular cuts are the narrowest; corners, joins and slanted cuts read wider, so use the 30th percentile.
    const f = fw.length >= 5 ? Float32Array.from(fw).sort()[Math.floor(fw.length * 0.3)] : null;
    if (f == null) return { stroke: null, observed_fwhm: null, ink: inkIsDark ? "dark on light" : "light on dark", resolved: false };
    if (!sigma) return { stroke: f, observed_fwhm: f, ink: inkIsDark ? "dark on light" : "light on dark", resolved: true };
    const ratio = f / sigma;
    if (ratio <= FWHM_MIN * 1.06) return { stroke: Math.min(f, sigma * 1.1774), observed_fwhm: f, ink: inkIsDark ? "dark on light" : "light on dark", resolved: false };
    let s = FWHM_TABLE[FWHM_TABLE.length - 1][0];
    for (let k = 1; k < FWHM_TABLE.length; k++) if (FWHM_TABLE[k][1] >= ratio) { const [s0, f0] = FWHM_TABLE[k - 1], [s1, f1] = FWHM_TABLE[k]; s = s0 + ((ratio - f0) / Math.max(1e-6, f1 - f0)) * (s1 - s0); break; }
    return { stroke: s * sigma, observed_fwhm: f, ink: inkIsDark ? "dark on light" : "light on dark", resolved: true };
  }

  // ---------- multi-frame stacking: genuine frames and sub-pixel diversity ----------
  function stackStats(frames) {
    const thumbs = frames.map((f) => {
      const { width: w, height: hgt, data: d } = f.img, tw = 48, th = Math.max(8, Math.round((48 * hgt) / w)), t = new Float32Array(tw * th);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const j = (Math.floor((y * hgt) / th) * w + Math.floor((x * w) / tw)) * 4; t[y * tw + x] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; }
      return t;
    });
    const unique = [], dupOf = [];
    thumbs.forEach((t, k) => {
      const same = unique.find((u) => { let s = 0; for (let i = 0; i < t.length; i++) s += Math.abs(t[i] - thumbs[u][i]); return s / t.length < 0.6; });
      if (same != null) dupOf.push({ frame: k + 1, same_as: same + 1 }); else unique.push(k);
    });
    const u = unique.map((k) => frames[k]);
    const ws = u.map((f) => f.weight ?? 1), sw = ws.reduce((a, b) => a + b, 0), sw2 = ws.reduce((a, b) => a + b * b, 0);
    const nEff = sw2 ? (sw * sw) / sw2 : 0;
    const frac = (v) => { const f = Math.abs(v) % 1; return Math.min(f, 1 - f); };
    const fx = u.map((f) => f.dx ?? 0), fy = u.map((f) => f.dy ?? 0);
    const spread = (a) => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    const fracSpread = Math.max(spread(fx.map((v) => v - Math.round(v))), spread(fy.map((v) => v - Math.round(v))));
    const subpixel = u.length >= 2 && fracSpread >= 0.15 && u.some((f) => frac(f.dx ?? 0) > 0.1 || frac(f.dy ?? 0) > 0.1);
    const meanMatch = u.length ? u.reduce((a, f) => a + (f.match ?? 1), 0) / u.length : 0;
    const genuine = u.length >= 2;
    const conf = genuine ? clamp(meanMatch * Math.min(1, Math.sqrt(nEff) / Math.sqrt(8)) * (subpixel ? 1 : 0.8), 0, 1) : 0;
    return {
      frames_given: frames.length, genuine_frames: u.length, duplicates: dupOf, effective_frames: r2(nEff),
      noise_reduction_factor: r2(Math.sqrt(Math.max(1, nEff))), subpixel_shift_diversity: subpixel, subpixel_spread_px: r2(fracSpread),
      mean_alignment_match: r2(meanMatch), confidence: r2(conf),
      valid: genuine,
      note: !genuine ? "Stacking not applicable: fewer than 2 genuine frames. The output is a single frame."
        : subpixel ? "Genuine frames with sub-pixel shifts: stacking lowers noise and can add real detail."
        : "Genuine frames but almost no sub-pixel movement: stacking lowers noise only; it cannot add resolution.",
    };
  }

  // ---------- color channels ----------
  function channelReport(img) {
    const ch = ["r", "g", "b"].map((c) => grayOf(img, c)), n = ch[0].length;
    const mean = ch.map((a) => a.reduce((s, v) => s + v, 0) / n);
    const corr = (a, b, ma, mb) => { let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : 1; };
    const rg = corr(ch[0], ch[1], mean[0], mean[1]), rb = corr(ch[0], ch[2], mean[0], mean[2]), gb = corr(ch[1], ch[2], mean[1], mean[2]);
    const stats = ch.map((a, k) => { const s = Float32Array.from(a).sort(); let clip = 0; for (const v of a) if (v >= 250) clip++;
      return { channel: "rgb"[k], contrast: Math.round(s[Math.floor(n * 0.99)] - s[Math.floor(n * 0.01)]), clipped_pct: r2((clip / n) * 100) }; });
    const minCorr = Math.min(rg, rb, gb), distinct = minCorr < 0.97;
    const best = stats.slice().sort((a, b) => (b.contrast - b.clipped_pct * 3) - (a.contrast - a.clipped_pct * 3))[0];
    return { correlation: { r_g: r2(rg), r_b: r2(rb), g_b: r2(gb) }, distinct, channels: stats, suggested: distinct ? best.channel : null,
      note: distinct ? `Channels differ (lowest correlation ${r2(minCorr)}). The ${({ r: "red", g: "green", b: "blue" })[best.channel]} channel has the most contrast with the least glare.`
        : `Channels carry the same data (all correlations ${r2(minCorr)} or higher), so separating them adds nothing here.` };
  }

  // ---------- the recovery assessment ----------
  // recovery_type: "none" (nothing changed), "enhancement" (rescaling / averaging / deconvolution of
  // recorded pixels), "generative" (model-made or inferred content).
  function assess({ img, channel, frames, smart, source_type, unblur, ops, generative, up }) {
    const w = img.width, hgt = img.height, g = grayOf(img, channel);
    const prof = edgeProfiles(g, w, hgt), bl = estimateBlur(prof), st = estimateStroke(g, w, hgt, prof, bl.sigma), noise = noiseSigma(g, w, hgt);
    const stack = frames?.length ? stackStats(frames) : null;
    const nodata = smart?.nodata_pct ?? 0, z = up || 1;
    const snr = bl.amplitude != null ? bl.amplitude / Math.max(0.5, noise) : 0;
    const blurPx = bl.radius, strokePx = st.stroke;
    const checks = [];
    if (bl.samples < 20) checks.push("too few clear edges to measure the blur");
    if (blurPx != null && strokePx != null && blurPx >= strokePx) checks.push(st.resolved ? "blur radius is as wide as or wider than the character strokes (INV-4: unrecoverable)" : "strokes are no wider than the blur itself; their true width can't be measured (INV-4: unrecoverable)");
    if (bl.samples >= 20 && !bl.from_plateau_edges) checks.push("no clean edges with flat sides to measure the blur on; the blur estimate may be too small");
    if (strokePx == null) checks.push("the character strokes couldn't be measured (too faint, too blurred, or no characters in the box)");
    if (snr < 4) checks.push("edge contrast is too close to the noise level");
    if (nodata >= 40) checks.push(`${nodata}% of the plate was not recorded well in any frame`);
    const signal_present = !generative && checks.length === 0 && blurPx != null && strokePx != null;
    const srcF = { raw_capture: 1, processed_image: 0.85, video_frame: 0.75, derivative: 0.55 }[source_type] ?? 0.55;
    const blurF = blurPx != null && strokePx ? clamp(1 - blurPx / strokePx, 0, 1) : 0;
    const snrF = clamp(snr / 20, 0, 1), covF = clamp(1 - nodata / 100, 0, 1), stackF = stack ? (stack.valid ? 0.6 + 0.4 * stack.confidence : 0.6) : 0.6;
    let confidence = generative ? 0 : Math.pow(Math.max(0, blurF) * snrF * covF * srcF * stackF, 1 / 3) * (signal_present ? 1 : 0.5);
    if (unblur) confidence *= 0.85;                                  // deconvolution adds model uncertainty
    const recovery_type = generative ? "generative" : (ops && ops.length) ? "enhancement" : "none";
    const evidence_grade = signal_present && recovery_type !== "generative";
    const flags = [];
    if (unblur) flags.push(`DECONVOLUTION UNCERTAIN: the blur shape was ${unblur.basis}; character accuracy is not guaranteed.`);
    if (stack && !stack.valid) flags.push("Stacking not applicable (fewer than 2 genuine frames).");
    if (stack?.duplicates?.length) flags.push(`${stack.duplicates.length} duplicate frame(s) found and counted once.`);
    if (source_type === "derivative") flags.push("Source is a derivative (re-saved, exported or screenshot); detail lost before PlateTrace cannot be recovered.");
    return {
      recovery_type, signal_present,
      blur_radius_est: blurPx == null ? null : r2(blurPx / z), stroke_width_est: strokePx == null ? null : r2(strokePx / z),
      units: "pixels in the original footage",
      source_type, confidence: r2(clamp(confidence, 0, 1)), evidence_grade,
      disclaimer: generative ? DISCLAIMER_GENERATIVE : "",
      measurements: { blur_sigma_px: bl.sigma == null ? null : r2(bl.sigma / z), edges_measured: bl.samples, plateau_edges: bl.plateau_edges, stroke_fwhm_observed_px: st.observed_fwhm == null ? null : r2(st.observed_fwhm / z), stroke_width_resolved: st.resolved, edge_contrast: bl.amplitude == null ? null : Math.round(bl.amplitude),
        noise_sigma: r2(noise), edge_snr: r2(snr), no_data_pct: nodata, ink: st.ink, measured_at_zoom: z, channel: channel || "luminance" },
      stacking: stack, failed_checks: checks, flags, operations: ops || [],
      method: "Blur: median 10-90% edge rise across strong edges that are flat on both sides (Gaussian: rise = 2.563 sigma; radius = 1.177 sigma). Stroke: median full width at half depth across the character strokes, corrected for the measured blur with a Gaussian-blurred-bar model; strokes no wider than the blur alone are reported as unresolvable. Noise: median absolute Laplacian. signal_present requires blur radius < stroke width (INV-4), edge SNR >= 4, >= 20 measured edges and < 40% no-data. Confidence = cube root of (blur margin x SNR x coverage x source x stacking), halved without signal, x0.85 after deconvolution.",
    };
  }

  function generativeTag(extra) {
    return { recovery_type: "generative", signal_present: false, evidence_grade: false, confidence: 0, disclaimer: DISCLAIMER_GENERATIVE, ...(extra || {}) };
  }

  return { LABELS, DISCLAIMER_GENERATIVE, provenance, caseSource, assess, stackStats, channelReport, generativeTag, grayOf };
})();
