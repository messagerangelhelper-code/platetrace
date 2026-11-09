/* PlateTrace demo (stage 1): verified-agency access, frame combining, honest enhancement,
   multi-read plate candidates, evidence log and case package. Footage never leaves the device. */
"use strict";

const SB_URL = "https://wbugdujmydwmzemccbiy.supabase.co";
const SB_KEY = "sb_publishable_4RYit1aVs5Egh3gJsx2bJA_m6Kje0ES";
const ADMIN_EMAILS = ["cashcowaiadmin@gmail.com"];
const VERSION = "PlateTrace demo 0.1";
const UP = 4;                                   // detail factor for combined images

const sb = window.supabase.createClient(SB_URL, SB_KEY);
const $app = document.getElementById("app");
const $who = document.getElementById("who");

const S = { user: null, access: null, isAdmin: false, ocr: null };
let C = null;                                   // the open case

// ---------- small helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const nowIso = () => new Date().toISOString();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Move a video to a time and wait until that frame is ready (also when it's already there).
function seekTo(video, t) {
  return new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && !video.seeking && video.readyState >= 2) return res();
    const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); res(); };
    const timer = setTimeout(done, 4000);
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}
function canvasOf(w, hgt) { const c = document.createElement("canvas"); c.width = w; c.height = hgt; return c; }
function canvasFromData(img) { const c = canvasOf(img.width, img.height); c.getContext("2d").putImageData(img, 0, 0); return c; }
const blobOf = (canvas) => new Promise((r) => canvas.toBlob(r, "image/png"));
function logStep(step, details) {
  if (!C) return;
  C.log.push({ time: nowIso(), step, ...details });
  const box = document.getElementById("log");
  if (box) box.textContent = C.log.map(({ time, step: st, ...rest }) => `${time}  ${st}  ${JSON.stringify(rest)}`).join("\n");
}
async function audit(action, details) {
  try {
    await sb.from("platetrace_audit").insert({ email: S.user.email, case_no: C?.caseNo || null, file_sha256: C?.fileHash || null, action, details: details || {} });
  } catch { /* the export still works; the log inside the package is the record */ }
}

// ---------- sign in & access ----------
let linkError = "";
async function boot() {
  // A sign-in link that was too old comes back with an error in the address: explain it instead of looping.
  const hp = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  if (hp.get("error_code") || hp.get("error_description")) {
    linkError = hp.get("error_code") === "otp_expired" || /expired|invalid/i.test(hp.get("error_description") || "")
      ? "That email link was an old one (each new email cancels the earlier links). Sign in with your password below, or send a new link and tap only the newest email."
      : (hp.get("error_description") || "That sign-in link didn't work.");
    history.replaceState(null, "", location.pathname);
  }
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  sb.auth.onAuthStateChange((_e, session) => {
    const was = S.user?.id;
    S.user = session?.user || null;
    if ((S.user?.id || null) !== (was || null)) route();
  });
  route();
}

async function route() {
  $who.replaceChildren();
  if (!S.user) return renderSignIn();
  S.isAdmin = ADMIN_EMAILS.includes(String(S.user.email || "").toLowerCase());
  $who.append(S.user.email, h("button", { class: "ghost", onclick: async () => { await sb.auth.signOut(); } }, "Sign out"));
  const { data, error } = await sb.from("platetrace_access").select("*").eq("user_id", S.user.id).maybeSingle();
  if (error) return renderMessage("Can't check your access", "The access table isn't set up yet, or the connection failed. " + error.message);
  S.access = data;
  if (S.isAdmin) return renderTool(true);
  if (!data) return renderRequest();
  if (data.status === "approved") return renderTool(false);
  if (data.status === "rejected") return renderMessage("Access not approved", data.note || "Your request wasn't approved. Contact PlateTrace if you think this is a mistake.");
  renderMessage("Verification in progress", `Thanks, ${data.full_name}. We verify every agency before turning access on, usually within 1–2 business days. We may call your supervisor at the number you gave.`);
}

function renderMessage(title, text) {
  $app.replaceChildren(h("div", { class: "card narrow" }, h("h1", {}, title), h("p", { class: "muted" }, text)));
}

function renderSignIn() {
  const email = h("input", { type: "email", placeholder: "you@agency.gov", autocomplete: "email" });
  const pass = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = h("p", { class: linkError ? "small error" : "small" }, linkError);
  linkError = "";
  const say = (ok, text) => { msg.className = ok ? "small ok" : "small error"; msg.textContent = text; };
  const addr = () => {
    const v = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { say(false, "Enter a valid work email."); return ""; }
    return v;
  };
  const withPassword = async (e) => {
    e.preventDefault();
    const v = addr(); if (!v) return;
    if (!pass.value) { say(false, "Enter your password, or use the email link below."); return; }
    const { error } = await sb.auth.signInWithPassword({ email: v, password: pass.value });
    if (error) say(false, error.message === "Invalid login credentials" ? "That email and password don't match." : error.message);
  };
  const withLink = async () => {
    const v = addr(); if (!v) return;
    const { error } = await sb.auth.signInWithOtp({ email: v, options: { emailRedirectTo: location.origin + "/" } });
    if (error) say(false, error.message);
    else say(true, "Sent. In Gmail, sign-in emails stack into one conversation: open the LAST message in it (tap 'Show quoted text' if needed) and tap its Sign in link. Older links stop working.");
  };
  $app.replaceChildren(h("form", { class: "card narrow", onsubmit: withPassword },
    h("h1", {}, "PlateTrace"),
    h("p", { class: "muted" }, "Plate enhancement and candidate reading for verified law enforcement and licensed investigators."),
    h("label", {}, "Work email", email),
    h("label", {}, "Password", pass),
    h("p", { class: "small muted", style: "margin:4px 0 0" }, "Same password as your CashCow dashboard, if you have one."),
    h("button", { type: "submit", style: "margin-top:12px;width:100%" }, "Sign in"),
    h("button", { type: "button", class: "ghost", style: "margin-top:8px;width:100%", onclick: withLink }, "No password? Email me a sign-in link"),
    msg,
    h("p", { class: "small muted" }, "Use your official agency email. Personal email addresses are not approved.")));
}

function renderRequest() {
  const f = {
    full_name: h("input", { autocomplete: "name" }), agency: h("input", { placeholder: "e.g. Dallas County Sheriff's Office" }),
    role: h("select", {}, ["Sworn officer / detective", "Crime analyst", "Forensic video analyst", "Prosecutor's office", "Licensed private investigator"].map((r) => h("option", {}, r))),
    badge_id: h("input", { placeholder: "Badge, employee or license number" }), supervisor_phone: h("input", { type: "tel", placeholder: "Supervisor's work phone" }),
  };
  const msg = h("p", { class: "small" });
  const submit = async (e) => {
    e.preventDefault();
    const row = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
    if (Object.values(row).some((v) => !v)) { msg.className = "small error"; msg.textContent = "Please fill in every field."; return; }
    const { error } = await sb.from("platetrace_access").insert({ ...row, user_id: S.user.id, email: S.user.email, status: "pending" });
    if (error) { msg.className = "small error"; msg.textContent = error.message; return; }
    route();
  };
  $app.replaceChildren(h("form", { class: "card narrow", onsubmit: submit },
    h("h1", {}, "Request access"),
    h("p", { class: "muted small" }, `Signed in as ${S.user.email}. PlateTrace is only for verified agencies and licensed investigators.`),
    h("label", {}, "Full name", f.full_name), h("label", {}, "Agency or firm", f.agency), h("label", {}, "Role", f.role),
    h("label", {}, "Badge / employee / license number", f.badge_id), h("label", {}, "Supervisor's work phone", f.supervisor_phone),
    h("button", { type: "submit", style: "margin-top:12px;width:100%" }, "Send for verification"), msg));
}

async function renderAdmin(box) {
  box.replaceChildren(h("p", { class: "muted small" }, "Loading requests…"));
  const { data, error } = await sb.from("platetrace_access").select("*").order("created_at", { ascending: false });
  if (error) { box.replaceChildren(h("p", { class: "error" }, error.message)); return; }
  if (!data.length) { box.replaceChildren(h("p", { class: "muted small" }, "No access requests yet.")); return; }
  const review = async (r, status) => {
    const note = status === "rejected" ? prompt("Reason (shown to the requester):", "We couldn't verify your agency.") : null;
    if (status === "rejected" && note == null) return;
    const { error: e } = await sb.from("platetrace_access").update({ status, note, reviewed_at: nowIso() }).eq("user_id", r.user_id);
    if (e) alert(e.message); else renderAdmin(box);
  };
  box.replaceChildren(h("table", {},
    h("tr", {}, h("th", {}, "Person"), h("th", {}, "Agency"), h("th", {}, "Status"), h("th", {}, "")),
    data.map((r) => h("tr", {},
      h("td", {}, h("div", {}, r.full_name), h("div", { class: "small muted" }, r.email), h("div", { class: "small muted" }, `${r.role} · #${r.badge_id}`)),
      h("td", {}, h("div", {}, r.agency), h("div", { class: "small muted" }, `Supervisor ${r.supervisor_phone}`)),
      h("td", {}, h("span", { class: r.status === "approved" ? "pill good" : r.status === "pending" ? "pill warn" : "pill" }, r.status)),
      h("td", {}, r.status !== "approved" ? h("button", { onclick: () => review(r, "approved") }, "Approve") : null, " ",
        r.status !== "rejected" ? h("button", { class: "danger", onclick: () => review(r, "rejected") }, r.status === "approved" ? "Remove" : "Reject") : null)))));
}

// ---------- the tool ----------
function renderTool(isAdmin) {
  C = null;
  const caseNo = h("input", { placeholder: "e.g. 2026-004512" });
  const examiner = h("input", { value: S.access?.full_name || "" });
  const file = h("input", { type: "file", accept: "video/*,image/*", multiple: true });
  const msg = h("p", { class: "small" });
  const start = async () => {
    if (!caseNo.value.trim() || !examiner.value.trim()) { msg.className = "small error"; msg.textContent = "Enter the case number and examiner name first."; return; }
    const files = [...file.files];
    if (!files.length) { msg.className = "small error"; msg.textContent = "Choose a video, or one or more photos."; return; }
    msg.className = "small muted"; msg.textContent = "Fingerprinting the original file (SHA-256)…";
    C = { caseNo: caseNo.value.trim(), examiner: examiner.value.trim(), files: [], log: [], frames: [], box: null, kind: "", combined: null };
    for (const f of files) C.files.push({ name: f.name, size: f.size, type: f.type, sha256: await sha256(await f.arrayBuffer()), file: f });
    C.fileHash = C.files[0].sha256;
    C.kind = files[0].type.startsWith("video/") ? "video" : "images";
    logStep("case_opened", { case_no: C.caseNo, examiner: C.examiner, user: S.user.email, version: VERSION });
    C.files.forEach((f) => logStep("original_file", { name: f.name, bytes: f.size, sha256: f.sha256 }));
    audit("open", { files: C.files.map((f) => ({ name: f.name, sha256: f.sha256 })) });
    renderWork();
  };
  const adminBox = h("div", {});
  $app.replaceChildren(
    isAdmin ? h("div", { class: "card" }, h("h2", {}, "Access requests"), adminBox) : null,
    h("div", { class: "card" },
      h("h1", {}, "New case"),
      h("p", { class: "muted small" }, "Load a video clip, or several photos of the same vehicle. Nothing is uploaded; processing happens on this device."),
      h("div", { class: "row" }, h("label", {}, "Case number", caseNo), h("label", {}, "Examiner", examiner)),
      h("label", {}, "Footage", file),
      h("button", { style: "margin-top:12px", onclick: start }, "Open case"), msg));
  if (isAdmin) renderAdmin(adminBox);
}

function stepsBar(on) {
  const names = ["1 Mark plate", "2 Clearest frames", "3 Combine", "4 Read", "5 Vehicle details", "6 Case package"];
  return h("div", { class: "steps" }, names.map((n, i) => h("span", { class: i + 1 < on ? "done" : i + 1 === on ? "on" : "" }, n)));
}

async function renderWork() {
  const head = h("div", { class: "card" },
    h("div", { class: "row" }, h("div", {}, h("h2", {}, `Case ${C.caseNo}`), h("div", { class: "small muted" }, `${C.files.length} file(s) · ${C.files[0].name} · SHA-256 ${C.fileHash.slice(0, 16)}…`)),
      h("button", { class: "ghost", onclick: () => { if (confirm("Close this case? Unsaved work is lost.")) renderTool(S.isAdmin); } }, "Close case")));
  const stage = h("div", { class: "card" });
  const logCard = h("div", { class: "card" }, h("h3", { style: "margin-top:0" }, "Evidence log"), h("div", { class: "log", id: "log" }));
  $app.replaceChildren(head, stage, logCard);
  logStep("work_started", {});
  if (C.kind === "video") await markOnVideo(stage); else await markOnImages(stage);
}

// ---------- step 1: mark the plate ----------
function attachBoxDrawing(overlay, srcW, srcH, onBox) {
  const ctx = overlay.getContext("2d");
  let start = null;
  const toSrc = (e) => {
    const r = overlay.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width * srcW, 0, srcW), y: clamp((e.clientY - r.top) / r.height * srcH, 0, srcH) };
  };
  const draw = (b) => {
    overlay.width = srcW; overlay.height = srcH;
    ctx.clearRect(0, 0, srcW, srcH);
    if (!b) return;
    ctx.strokeStyle = "#4fb3ff"; ctx.lineWidth = Math.max(2, srcW / 400);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  };
  overlay.addEventListener("pointerdown", (e) => { overlay.setPointerCapture(e.pointerId); start = toSrc(e); });
  overlay.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = toSrc(e);
    draw({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
  });
  overlay.addEventListener("pointerup", (e) => {
    if (!start) return;
    const p = toSrc(e);
    const b = { x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)), w: Math.round(Math.abs(p.x - start.x)), h: Math.round(Math.abs(p.y - start.y)) };
    start = null;
    if (b.w < 8 || b.h < 4) { draw(null); onBox(null); return; }
    draw(b); onBox(b);
  });
  return draw;
}

async function markOnVideo(stage) {
  const url = URL.createObjectURL(C.files[0].file);
  const video = h("video", { src: url, muted: true, playsinline: true, preload: "auto" });
  await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error("This video format can't be opened in this browser.")); }).catch((e) => {
    stage.replaceChildren(h("p", { class: "error" }, e.message)); throw e;
  });
  C.video = video;
  const W = video.videoWidth, H = video.videoHeight, dur = video.duration || 0;
  logStep("video_opened", { width: W, height: H, duration_s: +dur.toFixed(3) });
  const overlay = h("canvas", { class: "overlay" });
  const time = h("input", { type: "range", min: 0, max: dur, step: 1 / 30, value: 0 });
  const label = h("span", { class: "small muted" }, "0.00 s");
  const status = h("p", { class: "small muted" }, "Pause on a frame where the plate is visible, then drag a box tightly around the plate.");
  const next = h("button", { disabled: true }, "Next: find the clearest frames");
  const seek = async (t) => { await seekTo(video, clamp(t, 0, dur)); label.textContent = video.currentTime.toFixed(2) + " s"; };
  time.addEventListener("input", () => seek(+time.value));
  const draw = attachBoxDrawing(overlay, W, H, (b) => {
    C.box = b; C.refTime = video.currentTime; next.disabled = !b;
    status.textContent = b ? `Plate box ${b.w}×${b.h} px at ${video.currentTime.toFixed(2)} s.` : "Box too small. Drag again around the plate.";
  });
  draw(null);
  next.addEventListener("click", () => { logStep("plate_marked", { box: C.box, ref_time_s: +C.refTime.toFixed(3) }); framesStep(stage); });
  stage.replaceChildren(stepsBar(1), h("h2", {}, "Mark the plate"), h("div", { class: "stage" }, video, overlay),
    h("div", { class: "row", style: "margin-top:8px" }, time),
    h("div", { class: "row" }, h("button", { class: "ghost", onclick: () => { time.value = +time.value - 1 / 30; seek(+time.value); } }, "◀ Frame"),
      label, h("button", { class: "ghost", onclick: () => { time.value = +time.value + 1 / 30; seek(+time.value); } }, "Frame ▶")),
    status, next);
  await seek(0);
}

async function markOnImages(stage) {
  C.images = [];
  for (const f of C.files) {
    const img = await createImageBitmap(f.file);
    C.images.push(img);
  }
  const first = C.images[0];
  const base = h("canvas", { class: "frame", width: first.width, height: first.height });
  base.getContext("2d").drawImage(first, 0, 0);
  const overlay = h("canvas", { class: "overlay" });
  const status = h("p", { class: "small muted" }, "Drag a box tightly around the plate on this first photo.");
  const next = h("button", { disabled: true }, "Next: line up the photos");
  const draw = attachBoxDrawing(overlay, first.width, first.height, (b) => { C.box = b; next.disabled = !b; status.textContent = b ? `Plate box ${b.w}×${b.h} px.` : "Box too small. Drag again."; });
  draw(null);
  next.addEventListener("click", () => { logStep("plate_marked", { box: C.box, on: C.files[0].name }); framesStep(stage); });
  stage.replaceChildren(stepsBar(1), h("h2", {}, "Mark the plate"), h("div", { class: "stage" }, base, overlay), status, next);
}

// ---------- step 2: find, line up and score frames ----------
function grayRegion(ctx, x, y, w, hgt) {
  const d = ctx.getImageData(x, y, w, hgt).data;
  const g = new Float32Array(w * hgt);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return g;
}

// Normalized cross-correlation of the reference plate patch inside a search region, at shift (dx, dy).
function nccAt(ref, rw, rh, reg, regW, ox, oy, stride) {
  let sa = 0, sb2 = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = 0; y < rh; y += stride) {
    const ry = y * rw, gy = (y + oy) * regW + ox;
    for (let x = 0; x < rw; x += stride) {
      const a = ref[ry + x], b = reg[gy + x];
      sa += a; sb2 += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
  }
  const cov = sab - (sa * sb2) / n, va = saa - (sa * sa) / n, vb = sbb - (sb2 * sb2) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

function alignTo(ref, box, ctx, srcW, srcH) {
  const m = Math.round(clamp(Math.max(box.h * 0.6, 12), 12, 60));
  const rx = clamp(box.x - m, 0, srcW), ry = clamp(box.y - m, 0, srcH);
  const rw = Math.min(box.w + 2 * m, srcW - rx), rh = Math.min(box.h + 2 * m, srcH - ry);
  const reg = grayRegion(ctx, rx, ry, rw, rh);
  const stride = box.w * box.h > 8000 ? 2 : 1;
  const bx = box.x - rx, by = box.y - ry;                      // box position inside the region at zero shift
  const ok = (dx, dy) => bx + dx >= 0 && by + dy >= 0 && bx + dx + box.w <= rw && by + dy + box.h <= rh;
  let best = { dx: 0, dy: 0, s: -2 };
  for (let dy = -m; dy <= m; dy += 2) for (let dx = -m; dx <= m; dx += 2) {
    if (!ok(dx, dy)) continue;
    const s = nccAt(ref, box.w, box.h, reg, rw, bx + dx, by + dy, stride * 2);
    if (s > best.s) best = { dx, dy, s };
  }
  const score = (dx, dy) => (ok(dx, dy) ? nccAt(ref, box.w, box.h, reg, rw, bx + dx, by + dy, stride) : -2);
  let fine = { ...best, s: score(best.dx, best.dy) };
  for (let dy = best.dy - 2; dy <= best.dy + 2; dy++) for (let dx = best.dx - 2; dx <= best.dx + 2; dx++) {
    const s = score(dx, dy); if (s > fine.s) fine = { dx, dy, s };
  }
  // sub-pixel refinement: fit a parabola through the neighbours on each axis
  const sub = (a, b, c) => { const d = a - 2 * b + c; return d < 0 ? clamp(0.5 * (a - c) / d, -0.5, 0.5) : 0; };
  const sx = sub(score(fine.dx - 1, fine.dy), fine.s, score(fine.dx + 1, fine.dy));
  const sy = sub(score(fine.dx, fine.dy - 1), fine.s, score(fine.dx, fine.dy + 1));
  return { dx: fine.dx + sx, dy: fine.dy + sy, match: fine.s };
}

function sharpness(gray, w, hgt) {           // variance of the Laplacian: higher = crisper
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    sum += v; sum2 += v * v; n++;
  }
  return n ? sum2 / n - (sum / n) ** 2 : 0;
}

function framesStep(stage) {
  const isVideo = C.kind === "video";
  const dur = isVideo ? C.video.duration : 0;
  const from = h("input", { type: "number", step: "0.1", min: 0, value: isVideo ? Math.max(0, C.refTime - 1.5).toFixed(1) : 0 });
  const to = h("input", { type: "number", step: "0.1", min: 0, value: isVideo ? Math.min(dur, C.refTime + 1.5).toFixed(1) : 0 });
  const samples = h("input", { type: "number", min: 4, max: 90, value: 30 });
  const keep = h("input", { type: "number", min: 1, max: 40, value: 12 });
  const bar = h("i", {});
  const status = h("p", { class: "small muted" });
  const thumbs = h("div", { class: "thumbs" });
  const next = h("button", { disabled: true, onclick: () => combineStep(stage) }, "Next: combine the frames");
  const run = async () => {
    go.disabled = true; next.disabled = true; thumbs.replaceChildren();
    const box = C.box;
    let srcW, srcH, grab, times;
    const frameCanvas = canvasOf(1, 1);
    const fctx = frameCanvas.getContext("2d", { willReadFrequently: true });
    if (isVideo) {
      srcW = C.video.videoWidth; srcH = C.video.videoHeight;
      frameCanvas.width = srcW; frameCanvas.height = srcH;
      const a = clamp(+from.value, 0, dur), b = clamp(+to.value, a, dur), n = clamp(Math.round(+samples.value), 2, 90);
      times = Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
      if (!times.some((t) => Math.abs(t - C.refTime) < 1e-3)) times.push(C.refTime);
      grab = async (t) => { await seekTo(C.video, t); fctx.drawImage(C.video, 0, 0); };
    } else {
      srcW = C.images[0].width; srcH = C.images[0].height;
      frameCanvas.width = srcW; frameCanvas.height = srcH;
      times = C.images.map((_, i) => i);
      grab = async (i) => { fctx.clearRect(0, 0, srcW, srcH); fctx.drawImage(C.images[i], 0, 0); };
    }
    // reference patch: the frame where the plate was marked
    await grab(isVideo ? C.refTime : 0);
    const ref = grayRegion(fctx, box.x, box.y, box.w, box.h);
    const found = [];
    for (let k = 0; k < times.length; k++) {
      await grab(times[k]);
      const al = alignTo(ref, box, fctx, srcW, srcH);
      const big = canvasOf(box.w * UP, box.h * UP);
      const bctx = big.getContext("2d", { willReadFrequently: true });
      bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = "high";
      bctx.drawImage(frameCanvas, box.x + al.dx, box.y + al.dy, box.w, box.h, 0, 0, big.width, big.height);
      const g = grayRegion(fctx, Math.round(box.x + al.dx), Math.round(box.y + al.dy), box.w, box.h);
      found.push({ key: times[k], at: isVideo ? +times[k].toFixed(3) : C.files[times[k]].name, dx: +al.dx.toFixed(2), dy: +al.dy.toFixed(2), match: +al.match.toFixed(3), sharp: +sharpness(g, box.w, box.h).toFixed(1), img: bctx.getImageData(0, 0, big.width, big.height) });
      bar.style.width = `${Math.round(((k + 1) / times.length) * 100)}%`;
      status.textContent = `Checked ${k + 1} of ${times.length} frames…`;
    }
    // keep frames that really line up with the plate, then the sharpest of those
    const good = found.filter((f) => f.match >= 0.5);
    const dropped = found.length - good.length;
    good.sort((a, b) => b.sharp - a.sharp);
    C.frames = good.slice(0, clamp(Math.round(+keep.value), 1, 40)).map((f) => ({ ...f, use: true }));
    logStep("frames_scanned", { checked: found.length, dropped_poor_match: dropped, kept: C.frames.length, range: isVideo ? [+from.value, +to.value] : "all photos" });
    C.frames.forEach((f, i) => logStep("frame_kept", { n: i + 1, frame: f.at, shift_px: [f.dx, f.dy], match: f.match, sharpness: f.sharp }));
    status.textContent = C.frames.length
      ? `Kept the ${C.frames.length} clearest well-matched frames${dropped ? ` (${dropped} skipped because the plate didn't line up)` : ""}. Untick any that look wrong.`
      : "No frames lined up with the plate. Try a smaller time range or re-mark the plate.";
    C.frames.forEach((f, i) => {
      const cb = h("input", { type: "checkbox", checked: true, style: "width:auto", onchange: (e) => { f.use = e.target.checked; next.disabled = !C.frames.some((x) => x.use); } });
      thumbs.append(h("figure", {}, h("img", { src: canvasFromData(f.img).toDataURL(), alt: `Frame ${i + 1}` }),
        h("figcaption", {}, h("label", { style: "display:flex;gap:6px;align-items:center;margin:0;font-weight:400" }, cb, `#${i + 1} · ${isVideo ? f.at + " s" : f.at}`),
          `match ${f.match} · sharp ${f.sharp}`)));
    });
    next.disabled = !C.frames.length; go.disabled = false;
  };
  const go = h("button", { onclick: run }, isVideo ? "Find the clearest frames" : "Line up the photos");
  stage.replaceChildren(stepsBar(2), h("h2", {}, "Find the clearest frames"),
    isVideo ? h("div", { class: "row" }, h("label", {}, "From (seconds)", from), h("label", {}, "To (seconds)", to), h("label", {}, "Frames to check", samples), h("label", {}, "Keep the best", keep))
      : h("p", { class: "small muted" }, `${C.images.length} photo(s) will be lined up to the first one.`),
    h("div", { style: "margin-top:10px" }, go), h("div", { class: "progress" }, bar), status, thumbs, h("div", { style: "margin-top:12px" }, next));
}

// ---------- step 3: combine and enhance ----------
function averageFrames(frames) {
  const w = frames[0].img.width, hgt = frames[0].img.height, acc = new Float32Array(w * hgt * 3);
  for (const f of frames) { const d = f.img.data; for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { acc[i] += d[j]; acc[i + 1] += d[j + 1]; acc[i + 2] += d[j + 2]; } }
  const out = new ImageData(w, hgt);
  for (let i = 0, j = 0; j < out.data.length; i += 3, j += 4) { out.data[j] = acc[i] / frames.length; out.data[j + 1] = acc[i + 1] / frames.length; out.data[j + 2] = acc[i + 2] / frames.length; out.data[j + 3] = 255; }
  return out;
}
function toGray(img) {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
  return g;
}
function boxBlur(src, w, hgt, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), k = 2 * r + 1;
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += src[y * w + clamp(x + i, 0, w - 1)]; tmp[y * w + x] = s / k; }
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += tmp[clamp(y + i, 0, hgt - 1) * w + x]; out[y * w + x] = s / k; }
  return out;
}
// Contrast stretch (1st–99th percentile) and an unsharp mask. Both only rescale real pixels.
function enhance(img, amount, gray) {
  const w = img.width, hgt = img.height;
  const chans = gray ? [toGray(img)] : [0, 1, 2].map((c) => { const a = new Float32Array(w * hgt); for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + c]; return a; });
  const lum = toGray(img), sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)] || 255, span = Math.max(1, hi - lo);
  const out = new ImageData(w, hgt);
  const res = chans.map((ch) => {
    const st = ch.map((v) => clamp(((v - lo) / span) * 255, 0, 255));
    if (!amount) return st;
    const bl = boxBlur(boxBlur(st, w, hgt, UP / 2), w, hgt, UP / 2);
    return st.map((v, i) => clamp(v + amount * (v - bl[i]), 0, 255));
  });
  for (let i = 0; i < w * hgt; i++) {
    out.data[i * 4] = res[0][i]; out.data[i * 4 + 1] = (res[1] || res[0])[i]; out.data[i * 4 + 2] = (res[2] || res[0])[i]; out.data[i * 4 + 3] = 255;
  }
  return out;
}

function combineStep(stage) {
  const used = C.frames.filter((f) => f.use);
  C.combinedRaw = averageFrames(used);
  C.best = used[0];
  const amount = h("input", { type: "range", min: 0, max: 2.5, step: 0.1, value: 1.2 });
  const gray = h("input", { type: "checkbox", checked: true, style: "width:auto" });
  const imgBest = h("img", { alt: "Clearest single frame" }), imgComb = h("img", { alt: "Combined frames, enhanced" });
  const paint = () => {
    C.params = { frames_combined: used.length, detail_factor: UP, contrast: "stretch 1st-99th percentile", sharpen_amount: +amount.value, grayscale: gray.checked };
    C.combined = enhance(C.combinedRaw, +amount.value, gray.checked);
    C.bestEnh = enhance(C.best.img, +amount.value, gray.checked);
    imgComb.src = canvasFromData(C.combined).toDataURL();
    imgBest.src = canvasFromData(C.bestEnh).toDataURL();
  };
  amount.addEventListener("input", paint); gray.addEventListener("change", paint);
  paint();
  const next = h("button", { onclick: () => { logStep("combined", C.params); readStep(stage); } }, "Next: read the plate");
  stage.replaceChildren(stepsBar(3), h("h2", {}, "Combine and enhance"),
    h("p", { class: "small muted" }, `${used.length} lined-up frames averaged at ${UP}× detail. Averaging lowers noise and blur that changes from frame to frame; it doesn't invent detail.`),
    h("div", { class: "result-imgs" }, h("figure", { style: "margin:0" }, imgBest, h("figcaption", { class: "small muted" }, "Clearest single frame")),
      h("figure", { style: "margin:0" }, imgComb, h("figcaption", { class: "small muted" }, `Combined (${used.length} frames)`))),
    h("div", { class: "row", style: "margin-top:10px" }, h("label", {}, "Sharpen", amount), h("label", { style: "display:flex;gap:8px;align-items:center" }, gray, "Black & white")),
    h("div", { style: "margin-top:12px" }, next));
}

// ---------- step 4: read the plate ----------
const FORMATS = {
  any: { label: "Any state / unknown", re: null, pattern: "" },
  tx: { label: "Texas passenger (ABC1234)", re: /^[A-Z]{3}[0-9]{4}$/, pattern: "LLLNNNN" },
  ca: { label: "California passenger (1ABC234)", re: /^[0-9][A-Z]{3}[0-9]{3}$/, pattern: "NLLLNNN" },
  custom: { label: "Custom pattern (L = letter, N = number)", re: null, pattern: "" },
};
const TO_DIGIT = { O: "0", D: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8", T: "7", A: "4" };
const TO_LETTER = { 0: "O", 1: "I", 2: "Z", 5: "S", 6: "G", 8: "B", 7: "T", 4: "A" };

function otsu(img, invert) {
  const g = toGray(img), hist = new Array(256).fill(0);
  g.forEach((v) => hist[Math.round(v)]++);
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = g.length - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  const out = new ImageData(img.width, img.height);
  g.forEach((v, i) => { const on = (v > t) !== !!invert ? 255 : 0; out.data.set([on, on, on, 255], i * 4); });
  return out;
}
function padded(img) {                       // white margin helps the reader find the characters
  const p = Math.round(img.height * 0.25), c = canvasOf(img.width + 2 * p, img.height + 2 * p), x = c.getContext("2d");
  x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.putImageData(img, p, p); return c;
}

function buildCandidates(reads, maskStr) {
  const clean = reads.map((r) => r.text).filter((t) => t.length >= 4 && t.length <= 8);
  if (!clean.length) return [];
  const byLen = {};
  reads.forEach((r) => { if (r.text.length >= 4 && r.text.length <= 8) (byLen[r.text.length] = byLen[r.text.length] || []).push(r); });
  const mask = maskStr.toUpperCase().replace(/[^A-Z0-9?]/g, "");
  const lengths = Object.keys(byLen).map(Number).sort((a, b) => byLen[b].length - byLen[a].length);
  if (mask && !lengths.includes(mask.length)) lengths.unshift(mask.length);
  const out = [];
  for (const L of lengths.slice(0, 2)) {
    const group = byLen[L] || [];
    // per-position vote, weighted by the reader's own confidence
    const pos = Array.from({ length: L }, () => ({}));
    let total = 0;
    group.forEach((r) => { const w = 0.2 + r.conf / 100; total += w; [...r.text].forEach((ch, i) => (pos[i][ch] = (pos[i][ch] || 0) + w)); });
    const probs = pos.map((p, i) => {
      if (mask[i] && mask[i] !== "?" && mask.length === L) return [[mask[i], 1]];
      const list = Object.entries(p).map(([ch, w]) => [ch, w / (total || 1)]).sort((a, b) => b[1] - a[1]);
      return list.length ? list.slice(0, 4) : [["?", 0.01]];
    });
    let beam = [["", 1]];
    probs.forEach((opts) => {
      beam = beam.flatMap(([s, p]) => opts.map(([ch, q]) => [s + ch, p * Math.max(q, 0.01)])).sort((a, b) => b[1] - a[1]).slice(0, 40);
    });
    const share = group.length / reads.length;
    beam.forEach(([s, p]) => out.push({ plate: s, agreement: Math.pow(p, 1 / L) * (0.5 + 0.5 * share), length_reads: group.length }));
  }
  return out;
}

function fitFormat(cands, fmt, customPattern) {
  const pattern = fmt === "custom" ? customPattern.toUpperCase().replace(/[^LN]/g, "") : FORMATS[fmt].pattern;
  if (!pattern) return cands.map((c) => ({ ...c, note: "" }));
  const res = [];
  for (const c of cands) {
    if (c.plate.length !== pattern.length) continue;
    let s = "", changed = 0, ok = true;
    [...c.plate].forEach((ch, i) => {
      const want = pattern[i];
      if (want === "L" && /[0-9]/.test(ch)) { if (TO_LETTER[ch]) { s += TO_LETTER[ch]; changed++; } else ok = false; }
      else if (want === "N" && /[A-Z]/.test(ch)) { if (TO_DIGIT[ch]) { s += TO_DIGIT[ch]; changed++; } else ok = false; }
      else s += ch;
    });
    if (ok) res.push({ ...c, plate: s, agreement: c.agreement * Math.pow(0.85, changed), note: changed ? `adjusted ${changed} look-alike character${changed > 1 ? "s" : ""} to fit format` : "fits format" });
  }
  return res;
}

function readStep(stage) {
  const fmt = h("select", {}, Object.entries(FORMATS).map(([k, f]) => h("option", { value: k }, f.label)));
  const custom = h("input", { placeholder: "e.g. LLLNNNN", style: "display:none" });
  fmt.addEventListener("change", () => (custom.style.display = fmt.value === "custom" ? "" : "none"));
  const mask = h("input", { placeholder: "e.g. 7?K4?2 (optional)" });
  const status = h("p", { class: "small muted" });
  const bar = h("i", {});
  const results = h("div", {});
  const next = h("button", { disabled: true, onclick: () => vehicleStep(stage) }, "Next: vehicle details");
  const run = async () => {
    go.disabled = true; results.replaceChildren();
    try {
      if (!S.ocr) {
        status.textContent = "Loading the plate reader (first time only)…";
        S.ocr = await Tesseract.createWorker("eng");
        await S.ocr.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", tessedit_pageseg_mode: "7" });
      }
      const used = C.frames.filter((f) => f.use);
      const variants = [
        ["combined, enhanced", C.combined], ["combined, raw", C.combinedRaw],
        ["combined, black/white", otsu(C.combined, false)], ["combined, black/white inverted", otsu(C.combined, true)],
        ...used.slice(0, 4).map((f, i) => [`single frame #${i + 1}`, enhance(f.img, C.params.sharpen_amount, true)]),
        ...used.slice(0, 2).map((f, i) => [`single frame #${i + 1}, black/white`, otsu(enhance(f.img, C.params.sharpen_amount, true), false)]),
      ];
      const reads = [];
      for (let i = 0; i < variants.length; i++) {
        status.textContent = `Reading version ${i + 1} of ${variants.length}…`;
        const { data } = await S.ocr.recognize(padded(variants[i][1]));
        const text = String(data.text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        reads.push({ source: variants[i][0], text, conf: Math.round(data.confidence || 0) });
        bar.style.width = `${Math.round(((i + 1) / variants.length) * 100)}%`;
      }
      let cands = fitFormat(buildCandidates(reads, mask.value), fmt.value, custom.value);
      const m = mask.value.toUpperCase().replace(/[^A-Z0-9?]/g, "");
      if (m) cands = cands.filter((c) => c.plate.length === m.length && [...m].every((ch, i) => ch === "?" || ch === c.plate[i]));
      const seen = new Set();
      cands = cands.sort((a, b) => b.agreement - a.agreement).filter((c) => !seen.has(c.plate) && seen.add(c.plate)).slice(0, 10);
      C.reads = reads; C.candidates = cands.map((c) => ({ ...c, agreement: Math.round(c.agreement * 100) }));
      C.readSettings = { format: FORMATS[fmt.value].label, custom_pattern: custom.value || null, mask: m || null };
      logStep("plate_read", { versions_read: reads.length, ...C.readSettings, top: C.candidates.slice(0, 3).map((c) => `${c.plate} (${c.agreement}%)`) });
      status.textContent = `Read ${reads.length} versions of the plate.`;
      results.replaceChildren(
        h("div", { class: "notice" }, "These are investigative leads, not an identification. Confirm any candidate against the original footage and your agency's records before acting on it."),
        C.candidates.length ? h("table", {},
          h("tr", {}, h("th", {}, "#"), h("th", {}, "Candidate"), h("th", {}, "Agreement"), h("th", {}, "Notes")),
          C.candidates.map((c, i) => h("tr", {}, h("td", {}, i + 1), h("td", { class: "plate" }, c.plate),
            h("td", {}, h("div", { class: "bar" }, h("i", { style: `width:${c.agreement}%` })), h("span", { class: "small" }, `${c.agreement}%`)),
            h("td", { class: "small muted" }, [c.note, `${c.length_reads} of ${reads.length} reads had this length`].filter(Boolean).join(" · ")))))
          : h("p", { class: "error" }, "No candidates matched. Try 'Any state', remove the known-characters mask, or mark the plate more tightly. If the plate is only a few blurry pixels, the detail may simply not be in the footage."),
        h("details", { style: "margin-top:10px" }, h("summary", { class: "small" }, "All reads (for transparency)"),
          h("table", {}, reads.map((r) => h("tr", {}, h("td", { class: "small muted" }, r.source), h("td", { class: "plate", style: "font-size:14px" }, r.text || "—"), h("td", { class: "small muted" }, `${r.conf}%`))))));
      next.disabled = false;
    } catch (e) {
      status.className = "small error"; status.textContent = "The plate reader couldn't run: " + (e.message || e);
    }
    go.disabled = false;
  };
  const go = h("button", { onclick: run }, "Read the plate");
  stage.replaceChildren(stepsBar(4), h("h2", {}, "Read the plate"),
    h("div", { class: "row" }, h("label", {}, "Plate format", fmt, custom), h("label", {}, "Known characters (? = unknown)", mask)),
    h("div", { style: "margin-top:10px" }, go), h("div", { class: "progress" }, bar), status, results, h("div", { style: "margin-top:12px" }, next));
}

// ---------- step 5: vehicle details (the rest of the "fingerprint") ----------
const FINISHES = ["Not sure", "Solid (plain)", "Metallic / pearl (sparkly highlights)", "Matte / flat", "Two-tone", "Stripes", "Wrap / graphics / pattern", "Primer or mismatched panel", "Faded / peeling clear coat", "Rust spots"];
function toLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => Math.hypot(...toLab(a).map((v, i) => v - toLab(b)[i]));
// How even the paint is inside the sample: spread of brightness after removing slow shading.
function evenness(img, box) {
  const vals = [];
  for (let y = box.y + 1; y < Math.min(img.height - 1, box.y + box.h - 1); y++)
    for (let x = box.x + 1; x < Math.min(img.width - 1, box.x + box.w - 1); x++) {
      const L = (i) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      const i = (y * img.width + x) * 4, w = img.width * 4;
      vals.push(L(i) - (L(i - 4) + L(i + 4) + L(i - w) + L(i + w)) / 4);
    }
  if (!vals.length) return { score: 0, label: "too small to judge" };
  const sd = Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length);
  return { score: +sd.toFixed(2), label: sd < 2 ? "smooth and even" : sd < 5 ? "slight variation" : "blotchy or textured" };
}
const MARK_TYPES = ["Sticker / decal", "Dent / damage", "Tow hitch", "Aftermarket part", "Missing or mismatched part", "Light pattern", "Other"];

function rgbToHex(c) { return "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join(""); }
function colorName([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2 / 255, sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  if (sat < 0.14 || max - min < 22) return l > 0.82 ? "white" : l > 0.6 ? "silver / light gray" : l > 0.32 ? "gray" : l > 0.16 ? "dark gray / charcoal" : "black";
  let hue = 0;
  if (max === r) hue = ((g - b) / (max - min)) % 6; else if (max === g) hue = (b - r) / (max - min) + 2; else hue = (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  const shade = l < 0.25 ? "dark " : l > 0.7 ? "light " : "";
  let name;
  if (hue < 15 || hue >= 345) name = l < 0.3 ? "maroon / burgundy" : "red";
  else if (hue < 40) name = l < 0.35 ? "brown" : sat < 0.45 ? "beige / tan" : "orange";
  else if (hue < 65) name = sat < 0.45 ? "gold / champagne" : "yellow";
  else if (hue < 165) name = "green";
  else if (hue < 200) name = "teal";
  else if (hue < 255) name = "blue";
  else if (hue < 290) name = "purple";
  else name = "magenta / pink";
  return /maroon|brown|beige|gold/.test(name) ? name : shade + name;
}
function medianColor(img, box) {
  const ch = [[], [], []];
  for (let y = Math.max(0, box.y); y < Math.min(img.height, box.y + box.h); y++)
    for (let x = Math.max(0, box.x); x < Math.min(img.width, box.x + box.w); x++) {
      const i = (y * img.width + x) * 4; ch[0].push(img.data[i]); ch[1].push(img.data[i + 1]); ch[2].push(img.data[i + 2]);
    }
  return ch.map((a) => { a.sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; });
}
// The plate's background is printed white: its recorded color tells us the color cast of the light.
function whiteGains() {
  const img = C.combinedRaw, px = [];
  for (let i = 0; i < img.data.length; i += 4) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  px.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
  const top = px.slice(0, Math.max(10, Math.floor(px.length * 0.2)));
  const mean = [0, 1, 2].map((c) => top.reduce((s, p) => s + p[c], 0) / top.length);
  const gray = (mean[0] + mean[1] + mean[2]) / 3;
  return { reference: mean.map((v) => Math.round(v)), gains: mean.map((v) => (v > 0 ? gray / v : 1)) };
}
function markedRear() {
  const v = C.vehicle, c = canvasFromData(v.combined), x = c.getContext("2d");
  const r = Math.max(10, c.width / 45);
  (v.samples || []).forEach((sm) => {
    x.strokeStyle = "#f2b84b"; x.lineWidth = Math.max(2, c.width / 300); x.strokeRect(sm.box.x, sm.box.y, sm.box.w, sm.box.h);
    x.fillStyle = "#f2b84b"; x.font = `bold ${Math.round(r * 1.2)}px sans-serif`; x.textAlign = "left"; x.textBaseline = "bottom"; x.fillText(sm.label, sm.box.x + 2, sm.box.y - 2);
  });
  v.marks.forEach((m) => {
    x.beginPath(); x.arc(m.x, m.y, r, 0, Math.PI * 2); x.fillStyle = "rgba(79,179,255,.85)"; x.fill();
    x.fillStyle = "#04121f"; x.font = `bold ${Math.round(r * 1.2)}px sans-serif`; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(m.n), m.x, m.y + 1);
  });
  return c;
}

// ---------- Print & Pattern scan ----------
const AREA_LABELS = ["Review", "Light / reflector", "Sticker / decal", "Repaint / mismatched panel", "Primer / bare metal", "Damage / scratch", "Wrap / graphics / stripe", "Ignore"];

function printPatternScan(v) {
  const img = v.combined, W = img.width, H = img.height, N = W * H, d = img.data;
  const { gains } = whiteGains();
  // lighting-corrected color and Lab for every pixel
  const lab = new Float32Array(N * 3), corr = new Float32Array(N * 3), gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = [d[i * 4] * gains[0], d[i * 4 + 1] * gains[1], d[i * 4 + 2] * gains[2]].map((x) => clamp(x, 0, 255));
    corr.set(c, i * 3); lab.set(toLab(c), i * 3);
    gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  // main body color: sample A if taken, otherwise the most common corrected color of the rear
  let ref;
  if (v.samples?.length) ref = toLab(v.samples[0].corrected.rgb);
  else {
    const bins = new Map();
    for (let i = 0; i < N; i += 3) { const k = [0, 1, 2].map((c) => Math.round(corr[i * 3 + c] / 24)).join(","); bins.set(k, (bins.get(k) || 0) + 1); }
    const top = [...bins.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map((x) => +x * 24);
    ref = toLab(top);
  }
  // the plate area (already read in step 4) is left out of the search for odd areas
  const sc = v.scale, pb = { x: (C.box.x - v.box.x) * sc, y: (C.box.y - v.box.y) * sc, w: C.box.w * sc, h: C.box.h * sc };
  const inPlate = (x, y) => x >= pb.x - 4 && x <= pb.x + pb.w + 4 && y >= pb.y - 4 && y <= pb.y + pb.h + 4;

  // 1) color difference map
  const de = new Float32Array(N);
  const diff = new ImageData(W, H);
  for (let i = 0; i < N; i++) {
    de[i] = Math.hypot(lab[i * 3] - ref[0], lab[i * 3 + 1] - ref[1], lab[i * 3 + 2] - ref[2]);
    // gray where the paint matches; yellow for small differences, red for big ones
    const g = gray[i] * 0.55, t = clamp((de[i] - 8) / 32, 0, 1), mix = Math.min(1, t * 1.6);
    const ramp = [255, 220 - 180 * t, 30 * (1 - t)];
    diff.data.set([g + (ramp[0] - g) * mix, g + (ramp[1] - g) * mix, g + (ramp[2] - g) * mix, 255], i * 4);
  }
  // 2) detail map: fine texture lifted out of the slow shading
  const blur = boxBlur(boxBlur(gray, W, H, 5), W, H, 5), detail = new ImageData(W, H);
  for (let i = 0; i < N; i++) { const val = clamp(128 + (gray[i] - blur[i]) * 5, 0, 255); detail.data.set([val, val, val, 255], i * 4); }
  // 3) paint print: 8 x 4 grid of corrected colors
  const cols = 8, rows = 4, cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const box = { x: Math.floor((c * W) / cols), y: Math.floor((r * H) / rows), w: Math.floor(W / cols), h: Math.floor(H / rows) };
    const m = medianColor(img, box).map((x, k) => clamp(x * gains[k], 0, 255)).map(Math.round);
    cells.push({ row: r + 1, col: c + 1, rgb: m, hex: rgbToHex(m), name: colorName(m) });
  }
  const sw = 40, printC = canvasOf(cols * sw, rows * sw), px = printC.getContext("2d");
  cells.forEach((cl) => { px.fillStyle = cl.hex; px.fillRect((cl.col - 1) * sw, (cl.row - 1) * sw, sw, sw); });
  // 4) areas that stand out: coarse grid, flood-fill neighbours, keep the meaningful ones
  const cell = Math.max(4, Math.round(Math.min(W, H) / 60)), gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const flag = new Uint8Array(gw * gh), cellLab = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sum = 0, n = 0; const L = [0, 0, 0];
    for (let y = gy * cell; y < Math.min(H, (gy + 1) * cell); y++) for (let x = gx * cell; x < Math.min(W, (gx + 1) * cell); x++) {
      if (inPlate(x, y)) continue;
      const q = y * W + x; sum += de[q]; n++; L[0] += lab[q * 3]; L[1] += lab[q * 3 + 1]; L[2] += lab[q * 3 + 2];
    }
    const k = gy * gw + gx;
    flag[k] = n && sum / n > 10 ? 1 : 0;
    if (n) cellLab.set(L.map((v) => v / n), k * 3);
  }
  // neighbouring cells only join one area when their colors are alike (keeps a light apart from the panel beside it)
  const alike = (a, b) => Math.hypot(cellLab[a * 3] - cellLab[b * 3], cellLab[a * 3 + 1] - cellLab[b * 3 + 1], cellLab[a * 3 + 2] - cellLab[b * 3 + 2]) < 16;
  const seen = new Uint8Array(gw * gh), areas = [];
  for (let i = 0; i < flag.length; i++) {
    if (!flag[i] || seen[i]) continue;
    const stack = [i]; seen[i] = 1; let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, count = 0;
    while (stack.length) {
      const k = stack.pop(), x = k % gw, y = (k / gw) | 0; count++;
      minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, nk = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && flag[nk] && !seen[nk] && alike(k, nk)) { seen[nk] = 1; stack.push(nk); }
      }
    }
    if (count < Math.max(3, flag.length * 0.004)) continue;
    if (minx === 0 && miny === 0 && maxx === gw - 1 && maxy === gh - 1) continue;   // the background around the vehicle
    const pad = cell, box = { x: Math.max(0, minx * cell - pad), y: Math.max(0, miny * cell - pad) };
    box.w = Math.min(W, (maxx + 1) * cell + pad) - box.x; box.h = Math.min(H, (maxy + 1) * cell + pad) - box.y;
    let sumDe = 0, n = 0; const acc = [0, 0, 0];
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { const q = y * W + x; if (de[q] > 10) { sumDe += de[q]; n++; acc[0] += corr[q * 3]; acc[1] += corr[q * 3 + 1]; acc[2] += corr[q * 3 + 2]; } }
    const mean = acc.map((a) => Math.round(a / Math.max(1, n)));
    const crop = canvasOf(box.w, box.h); crop.getContext("2d").putImageData(img, -box.x, -box.y);
    areas.push({ box, size_pct: +((count / flag.length) * 100).toFixed(1), difference: +(sumDe / Math.max(1, n)).toFixed(1), color: { rgb: mean, hex: rgbToHex(mean), name: colorName(mean) }, crop, label: "Review" });
  }
  areas.sort((a, b) => b.size_pct * b.difference - a.size_pct * a.difference);
  areas.splice(12);
  areas.forEach((a, i) => (a.n = i + 1));
  return { reference_lab: ref.map((x) => +x.toFixed(1)), diff, detail, printC, cells, areas };
}

function outlinedDiff(scan) {
  const c = canvasFromData(scan.diff), x = c.getContext("2d"), lw = Math.max(2, c.width / 250);
  scan.areas.forEach((a) => {
    x.strokeStyle = "#4fb3ff"; x.lineWidth = lw; x.strokeRect(a.box.x, a.box.y, a.box.w, a.box.h);
    x.fillStyle = "#4fb3ff"; x.font = `bold ${Math.round(lw * 7)}px sans-serif`; x.textBaseline = "bottom"; x.fillText(String(a.n), a.box.x + 2, a.box.y - 2);
  });
  return c;
}

async function vehicleStep(stage) {
  const isVideo = C.kind === "video";
  const used = C.frames.filter((f) => f.use);
  // reference frame, full size, to mark the back of the vehicle
  const srcW = isVideo ? C.video.videoWidth : C.images[0].width, srcH = isVideo ? C.video.videoHeight : C.images[0].height;
  const frameCanvas = canvasOf(srcW, srcH), fctx = frameCanvas.getContext("2d", { willReadFrequently: true });
  const grab = async (key) => {
    if (isVideo) { await seekTo(C.video, key); fctx.drawImage(C.video, 0, 0); }
    else { fctx.clearRect(0, 0, srcW, srcH); fctx.drawImage(C.images[key], 0, 0); }
  };
  await grab(isVideo ? C.refTime : 0);
  const base = h("canvas", { class: "frame", width: srcW, height: srcH }); base.getContext("2d").drawImage(frameCanvas, 0, 0);
  const overlay = h("canvas", { class: "overlay" });
  C.vehicle = C.vehicle || { marks: [] };
  const status = h("p", { class: "small muted" }, "Drag a box around the whole back of the vehicle (bumper, lights, trunk).");
  const combineBtn = h("button", { disabled: !C.vehicle.box }, "Combine the back of the vehicle");
  const bar = h("i", {});
  const work = h("div", {});
  const draw = attachBoxDrawing(overlay, srcW, srcH, (b) => { C.vehicle.box = b; combineBtn.disabled = !b; });
  draw(C.vehicle.box || null);

  const combine = async () => {
    combineBtn.disabled = true;
    const box = C.vehicle.box, scale = box.w * box.h > 90000 ? 1 : 2;
    await grab(isVideo ? C.refTime : 0);
    const ref = grayRegion(fctx, box.x, box.y, box.w, box.h);
    const imgs = [];
    for (let i = 0; i < used.length; i++) {
      await grab(used[i].key);
      const al = alignTo(ref, box, fctx, srcW, srcH);
      if (al.match < 0.5) continue;
      const big = canvasOf(box.w * scale, box.h * scale), bctx = big.getContext("2d", { willReadFrequently: true });
      bctx.imageSmoothingQuality = "high";
      bctx.drawImage(frameCanvas, box.x + al.dx, box.y + al.dy, box.w, box.h, 0, 0, big.width, big.height);
      imgs.push({ img: bctx.getImageData(0, 0, big.width, big.height) });
      bar.style.width = `${Math.round(((i + 1) / used.length) * 100)}%`;
    }
    if (!imgs.length) { status.className = "small error"; status.textContent = "The back of the vehicle didn't line up across frames. Try a tighter box."; combineBtn.disabled = false; return; }
    C.vehicle.combined = averageFrames(imgs);
    C.vehicle.frames = imgs.length; C.vehicle.scale = scale; C.vehicle.marks = []; C.vehicle.samples = []; C.vehicle.scan = null; C.vehicle.finish = C.vehicle.finish || "Not sure";
    logStep("vehicle_combined", { rear_box: box, frames_combined: imgs.length, detail_factor: scale });
    showDetails();
    combineBtn.disabled = false;
  };
  combineBtn.addEventListener("click", combine);

  const showDetails = () => {
    const v = C.vehicle, W = v.combined.width, H = v.combined.height;
    const pic = h("canvas", { class: "frame", width: W, height: H });
    const over = h("canvas", { class: "overlay" });
    const mode = h("select", {}, h("option", { value: "paint" }, "Drag a box on paint (add a sample)"), h("option", { value: "mark" }, "Tap to pin a distinguishing mark"));
    const finish = h("select", { onchange: () => { v.finish = finish.value; logStep("paint_finish", { finish: v.finish }); } }, FINISHES.map((f) => h("option", { selected: f === v.finish }, f)));
    const markType = h("select", {}, MARK_TYPES.map((t) => h("option", {}, t)));
    const markNote = h("input", { placeholder: "Short note, e.g. 'round sticker, lower left'" });
    const paintOut = h("div", {});
    const list = h("ol", { class: "small" });
    const repaint = () => { pic.getContext("2d").drawImage(markedRear(), 0, 0); };
    const showMarks = () => list.replaceChildren(...v.marks.map((m) => h("li", {}, `${m.type}${m.note ? " — " + m.note : ""} `,
      h("button", { class: "ghost", style: "min-height:28px;padding:2px 8px", onclick: () => { v.marks = v.marks.filter((x) => x !== m).map((x, i) => ({ ...x, n: i + 1 })); logStep("mark_removed", { type: m.type }); repaint(); showMarks(); } }, "Remove"))));
    const showPaint = () => {
      const wb = whiteGains();
      paintOut.replaceChildren(...v.samples.map((sm, i) => h("div", { class: "row", style: "align-items:center;margin-bottom:8px" },
        h("div", { style: "flex:0 0 40px;font-weight:800;color:#f2b84b" }, sm.label),
        h("div", {}, h("div", { style: `height:36px;border-radius:8px;background:${sm.raw.hex};border:1px solid var(--line)` }), h("div", { class: "small muted" }, `As recorded ${sm.raw.hex}`)),
        h("div", {}, h("div", { style: `height:36px;border-radius:8px;background:${sm.corrected.hex};border:1px solid var(--line)` }), h("div", { class: "small" }, `Corrected ${sm.corrected.hex} · `, h("strong", {}, sm.corrected.name))),
        h("div", { class: "small" }, `Surface: ${sm.evenness.label}`, i ? h("div", { class: sm.flag ? "" : "muted" }, sm.flag ? h("span", { class: "pill warn" }, `${sm.delta} different from A: possible repainted or replaced panel`) : `Matches A (difference ${sm.delta})`) : null),
        h("button", { class: "ghost", style: "flex:0 0 auto;min-height:28px;padding:2px 8px", onclick: () => { v.samples = v.samples.filter((x) => x !== sm); relabel(); logStep("paint_sample_removed", { label: sm.label }); repaint(); showPaint(); } }, "Remove"))),
        v.samples.length ? h("p", { class: "small muted" }, `Corrected using the plate's white background as a known white (recorded as ${rgbToHex(wb.reference)}). Night lighting, glare and camera settings still shift colors; names describe the paint, they are not paint codes. A difference over 10 between samples usually shows as a visibly different panel.`)
          : h("p", { class: "small muted" }, "Drag a box over a flat area of paint, away from lights, glare and shadows. Add more samples on other panels (bumper, trunk, each side) to spot repainted or replaced parts."));
    };
    const relabel = () => {
      v.samples.forEach((sm, i) => {
        sm.label = String.fromCharCode(65 + i);
        sm.delta = i ? +deltaE(v.samples[0].corrected.rgb, sm.corrected.rgb).toFixed(1) : 0;
        sm.flag = i > 0 && sm.delta > 10;
      });
      v.paint = v.samples[0] || null;
    };
    const measure = (b) => {
      const raw = medianColor(v.combined, b), wb = whiteGains();
      const corr = raw.map((c, i) => c * wb.gains[i]).map(Math.round);
      const sm = { box: b, raw: { rgb: raw, hex: rgbToHex(raw), name: colorName(raw) }, corrected: { rgb: corr, hex: rgbToHex(corr), name: colorName(corr) }, evenness: evenness(v.combined, b), white_reference_from_plate: wb.reference };
      v.samples.push(sm); relabel();
      logStep("paint_sample", { label: sm.label, box: b, as_recorded: sm.raw.hex, corrected: sm.corrected.hex, name: sm.corrected.name, surface: sm.evenness, difference_from_A: sm.delta, possible_panel_mismatch: sm.flag });
      repaint(); showPaint();
    };
    // paint box drawing or mark pinning on the combined rear image
    let start = null;
    const toImg = (e) => { const r = over.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width * W, 0, W), y: clamp((e.clientY - r.top) / r.height * H, 0, H) }; };
    over.addEventListener("pointerdown", (e) => {
      if (mode.value === "mark") {
        const p = toImg(e), m = { n: v.marks.length + 1, x: Math.round(p.x), y: Math.round(p.y), type: markType.value, note: markNote.value.trim() };
        v.marks.push(m); logStep("mark_added", { n: m.n, type: m.type, note: m.note, at_px: [m.x, m.y] });
        markNote.value = ""; repaint(); showMarks(); return;
      }
      over.setPointerCapture(e.pointerId); start = toImg(e);
    });
    over.addEventListener("pointerup", (e) => {
      if (!start || mode.value !== "paint") return;
      const p = toImg(e), b = { x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)), w: Math.round(Math.abs(p.x - start.x)), h: Math.round(Math.abs(p.y - start.y)) };
      start = null;
      if (b.w >= 4 && b.h >= 4) measure(b);
    });
    repaint(); showMarks(); showPaint();
    const scanOut = h("div", {});
    const showScan = () => {
      const sc = v.scan;
      if (!sc) return;
      scanOut.replaceChildren(
        h("p", { class: "small muted" }, "A camera records only the surface, so this can't see under the paint. It brings out what's faint in the surface: color changes, texture and patterns. Lights, the plate and reflectors will also show up; label them so they're set aside."),
        h("div", { class: "result-imgs" },
          h("figure", { style: "margin:0" }, h("img", { src: outlinedDiff(sc).toDataURL(), alt: "Color difference map" }), h("figcaption", { class: "small muted" }, "Color difference map: yellow to red = paint differs from the main body color (lighting-corrected). Numbered boxes = areas that stand out.")),
          h("figure", { style: "margin:0" }, h("img", { src: canvasFromData(sc.detail).toDataURL(), alt: "Detail map" }), h("figcaption", { class: "small muted" }, "Detail map: fine texture lifted out, showing scratches, dent ripples, stripes, sticker and wrap edges."))),
        h("h3", {}, "Paint print"),
        h("img", { src: sc.printC.toDataURL(), alt: "Paint print", style: "width:100%;max-width:420px;image-rendering:pixelated;border-radius:8px" }),
        h("p", { class: "small muted" }, "The vehicle's corrected colors on an 8 × 4 grid, like a color barcode. Compare it with another case or a suspect vehicle filmed in similar light."),
        h("h3", {}, `Areas that stand out (${sc.areas.length})`),
        sc.areas.length ? h("div", { class: "thumbs" }, sc.areas.map((a) => h("figure", {},
          h("img", { src: a.crop.toDataURL(), alt: `Area ${a.n}` }),
          h("figcaption", {}, `#${a.n} · ${a.color.name} · ${a.difference} diff · ${a.size_pct}%`,
            h("select", { style: "margin-top:4px;padding:4px 6px;font-size:12px", onchange: (e) => { a.label = e.target.value; logStep("pattern_area_labeled", { n: a.n, label: a.label }); } },
              AREA_LABELS.map((l) => h("option", { selected: l === a.label }, l)))))))
          : h("p", { class: "small muted" }, "No areas stood out from the main body color."));
    };
    const scanBtn = h("button", { onclick: async () => {
      scanBtn.disabled = true; scanBtn.textContent = "Scanning…";
      await new Promise((r) => setTimeout(r, 30));
      v.scan = printPatternScan(v);
      logStep("print_pattern_scan", { reference_lab: v.scan.reference_lab, areas: v.scan.areas.map((a) => ({ n: a.n, box: a.box, color: a.color.hex, difference: a.difference, size_pct: a.size_pct })), paint_print: v.scan.cells.map((c) => c.hex) });
      showScan(); scanBtn.disabled = false; scanBtn.textContent = "🔍 Run Print & Pattern scan again";
    } }, v.scan ? "🔍 Run Print & Pattern scan again" : "🔍 Print & Pattern scan");
    showScan();
    work.replaceChildren(
      h("h3", {}, `Back of the vehicle (${v.frames} frames combined)`),
      h("div", { class: "stage" }, pic, over),
      h("div", { class: "row", style: "margin-top:8px" }, h("label", {}, "What to do on the picture", mode), h("label", {}, "Mark type", markType), h("label", {}, "Note", markNote)),
      h("h3", {}, "Paint: color, finish and pattern"),
      h("label", { style: "max-width:420px" }, "Finish / pattern you can see", finish),
      paintOut,
      h("h3", {}, "Print & Pattern"), h("p", { class: "small muted" }, "Tip: take paint sample A on the main body color first; the scan compares everything with it."), scanBtn, scanOut,
      h("h3", {}, "Distinguishing marks"), list,
      h("p", { class: "small muted" }, "Coming in stage 2: make, model and year from the vehicle's shape, and matching the color to manufacturer paint codes."));
  };

  stage.replaceChildren(stepsBar(5), h("h2", {}, "Vehicle details"),
    h("p", { class: "small muted" }, "The rest of the vehicle can identify it even when the plate can't: paint, stickers, damage, hitches and aftermarket parts."),
    h("div", { class: "stage" }, base, overlay), status, combineBtn, h("div", { class: "progress" }, bar), work,
    h("div", { class: "row", style: "margin-top:12px" }, h("button", { onclick: () => packageStep(stage) }, "Next: case package"),
      h("button", { class: "ghost", onclick: () => readStep(stage) }, "◀ Back to reading")));
  if (C.vehicle.combined) showDetails();
}

// ---------- step 6: case package ----------
function packageStep(stage) {
  const status = h("p", { class: "small muted" });
  const build = async () => {
    go.disabled = true; status.textContent = "Building the case package…";
    const zip = new JSZip();
    const manifest = [];
    const add = async (name, canvas) => { const blob = await blobOf(canvas); const buf = await blob.arrayBuffer(); manifest.push({ file: name, sha256: await sha256(buf) }); zip.file(name, buf); };
    await add("combined_enhanced.png", canvasFromData(C.combined));
    await add("combined_raw.png", canvasFromData(C.combinedRaw));
    await add("clearest_single_frame.png", canvasFromData(C.bestEnh));
    const used = C.frames.filter((f) => f.use);
    for (let i = 0; i < used.length; i++) await add(`frames/frame_${String(i + 1).padStart(2, "0")}.png`, canvasFromData(used[i].img));
    if (C.vehicle?.combined) {
      await add("vehicle_rear_combined.png", canvasFromData(C.vehicle.combined));
      await add("vehicle_rear_marked.png", markedRear());
      if (C.vehicle.scan) {
        const sc = C.vehicle.scan;
        await add("print_pattern/color_difference_map.png", outlinedDiff(sc));
        await add("print_pattern/detail_map.png", canvasFromData(sc.detail));
        await add("print_pattern/paint_print.png", sc.printC);
        for (const a of sc.areas) await add(`print_pattern/area_${String(a.n).padStart(2, "0")}.png`, a.crop);
      }
    }
    logStep("package_built", { files: manifest.length });
    const report = {
      tool: VERSION, generated_at: nowIso(), case_no: C.caseNo, examiner: C.examiner, user: S.user.email,
      agency: S.access?.agency || (S.isAdmin ? "PlateTrace admin" : null),
      originals: C.files.map((f) => ({ name: f.name, bytes: f.size, type: f.type, sha256: f.sha256 })),
      plate_box: C.box, reference_time_s: C.refTime ?? null,
      frames: used.map((f, i) => ({ n: i + 1, at: f.at, shift_px: [f.dx, f.dy], match: f.match, sharpness: f.sharp })),
      processing: { ...C.params, alignment: "normalized cross-correlation with sub-pixel parabola fit", combining: "mean of aligned frames" },
      read_settings: C.readSettings, reads: C.reads, candidates: C.candidates,
      vehicle: C.vehicle ? { rear_box: C.vehicle.box, frames_combined: C.vehicle.frames, paint_finish: C.vehicle.finish || null,
        paint_samples: (C.vehicle.samples || []).map((sm) => ({ label: sm.label, box: sm.box, as_recorded: sm.raw, corrected: sm.corrected, surface: sm.evenness, difference_from_A: sm.delta, possible_panel_mismatch: sm.flag })),
        white_reference_from_plate: C.vehicle.samples?.[0]?.white_reference_from_plate || null, marks: C.vehicle.marks,
        print_pattern: C.vehicle.scan ? { method: "lighting-corrected CIE76 color difference vs main body color; high-pass detail map; 8x4 median color grid",
          reference_lab: C.vehicle.scan.reference_lab, paint_print: C.vehicle.scan.cells,
          areas: C.vehicle.scan.areas.map((a) => ({ n: a.n, box: a.box, label: a.label, color: a.color, difference: a.difference, size_pct: a.size_pct, image: `print_pattern/area_${String(a.n).padStart(2, "0")}.png` })) } : null } : null,
      outputs: manifest, log: C.log,
      notice: "Candidates are investigative leads, not identification. Verify against the original footage and agency records. Enhancement only rescales and averages recorded pixels; no generative AI was used.",
    };
    zip.file("case_report.json", JSON.stringify(report, null, 2));
    zip.file("README.txt", [
      `PlateTrace case package — case ${C.caseNo}`, `Generated ${report.generated_at} by ${C.examiner} (${S.user.email})`, "",
      "case_report.json  every step, setting, frame shift, read and candidate, plus SHA-256 fingerprints",
      "combined_enhanced.png / combined_raw.png  the lined-up frames averaged together",
      "clearest_single_frame.png  the sharpest single frame, same enhancement",
      "frames/  each lined-up frame used",
      "vehicle_rear_combined.png / vehicle_rear_marked.png  the back of the vehicle, combined, with numbered marks", "",
      ...(C.vehicle?.samples?.length ? [`Paint finish/pattern: ${C.vehicle.finish || "not noted"}`, ...C.vehicle.samples.map((sm) => `  Sample ${sm.label}: ${sm.corrected.name} ${sm.corrected.hex} (as recorded ${sm.raw.hex}), surface ${sm.evenness.label}${sm.flag ? `, ${sm.delta} different from A: possible repainted/replaced panel` : ""}`)] : []),
      ...(C.vehicle?.scan ? ["Print & Pattern scan: print_pattern/ (difference map, detail map, paint print, area photos)", ...C.vehicle.scan.areas.map((a) => `  Area ${a.n}: ${a.label}, ${a.color.name} ${a.color.hex}, difference ${a.difference}, ${a.size_pct}% of rear`)] : []),
      ...(C.vehicle?.marks?.length ? ["Distinguishing marks:", ...C.vehicle.marks.map((m) => `  ${m.n}. ${m.type}${m.note ? " — " + m.note : ""}`)] : []), "",
      "Top candidates:", ...C.candidates.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.plate}  ${c.agreement}%  ${c.note || ""}`), "",
      "To verify an image: compute its SHA-256 and compare it to case_report.json → outputs.",
      "Original footage fingerprints are in case_report.json → originals.", "",
      report.notice,
    ].join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `PlateTrace_${C.caseNo.replace(/[^\w-]+/g, "_")}_${nowIso().slice(0, 10)}.zip` });
    document.body.append(a); a.click(); a.remove();
    await audit("export", { frames: used.length, top: C.candidates.slice(0, 3).map((c) => c.plate) });
    status.className = "small ok"; status.textContent = "Case package downloaded. This export was recorded in the audit log.";
    go.disabled = false;
  };
  const go = h("button", { onclick: build }, "Download case package (.zip)");
  stage.replaceChildren(stepsBar(6), h("h2", {}, "Case package"),
    h("p", { class: "small muted" }, "One zip with the enhanced images, every frame used, the candidate list and a full report with SHA-256 fingerprints, ready to hand to your forensic video unit or to load into Amped FIVE or iNPUT-ACE."),
    go, status,
    h("h3", {}, "Next steps for the investigation"),
    h("ol", { class: "small" },
      h("li", {}, "Run the top candidates through your agency's plate-camera network (Flock, Vigilant) with the time, place and vehicle description."),
      h("li", {}, "For court, have a certified forensic video analyst review the original footage and this package."),
      h("li", {}, "Keep the original footage unchanged; its SHA-256 is in the report.")),
    h("button", { class: "ghost", style: "margin-top:8px", onclick: () => vehicleStep(stage) }, "◀ Back to vehicle details"));
}

boot();
