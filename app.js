/* PlateTrace demo (stage 1): verified-agency access, frame combining, honest enhancement,
   multi-read plate candidates, evidence log and case package. Footage never leaves the device. */
"use strict";

const SB_URL = "https://wbugdujmydwmzemccbiy.supabase.co";
const SB_KEY = "sb_publishable_4RYit1aVs5Egh3gJsx2bJA_m6Kje0ES";
const ADMIN_EMAILS = ["cashcowaiadmin@gmail.com"];
const VERSION = "PlateTrace demo 0.1";
const UP = 4;                                   // default detail factor ("zoom closer") for combined images
const upNow = () => (C && C.up) || UP;

const sb = window.supabase.createClient(SB_URL, SB_KEY);
const $app = document.getElementById("app");
const $who = document.getElementById("who");

const S = { user: null, access: null, isAdmin: false, ocr: null, publicMode: false };
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

// ---------- subscription plans (Stripe checkout, 14-day free trial) ----------
const PLANS = [
  { name: "Starter", price: 99, for: "Private investigators and small departments", url: "https://buy.stripe.com/7sYeVf2E0bGh9lffqhak006" },
  { name: "Agency", price: 199, for: "Mid-size departments and investigation firms", url: "https://buy.stripe.com/fZu14p0vS4dP40Vba1ak007" },
  { name: "Enterprise", price: 299, for: "Large agencies and multi-unit teams", url: "https://buy.stripe.com/5kQcN70vS6lX9lfdi9ak008" },
];
function plansCard() {
  return h("div", { class: "card", id: "plans" },
    h("h2", {}, "Plans"),
    h("p", { class: "small muted" }, "Every plan starts with a 14-day free trial. Cancel any time before it ends and you won't be charged."),
    h("div", { class: "plans" }, PLANS.map((p) => h("div", { class: "plan" },
      h("h3", { style: "margin:0" }, p.name),
      h("div", { class: "plan-price" }, `$${p.price}`, h("span", { class: "small muted" }, " / month")),
      h("p", { class: "small muted", style: "margin:4px 0 10px" }, p.for),
      h("a", { class: "btn", href: p.url, target: "_blank", rel: "noopener" }, "Start free trial")))));
}

// ---------- working indicator ----------
// Heavy steps run on this page, so they pause briefly (tick) to let the screen
// update and scroll, and a bar at the bottom shows what is happening.
const tick = () => new Promise((r) => setTimeout(r, 0));
let busyEl = null;
function busy(text, pct) {
  if (!text) { if (busyEl) busyEl.remove(); busyEl = null; return; }
  if (!busyEl) {
    busyEl = h("div", { class: "busy", role: "status", "aria-live": "polite" },
      h("span", { class: "spin" }), h("span", { class: "busy-text" }), h("div", { class: "busy-bar" }, h("i", {})));
    document.body.append(busyEl);
  }
  busyEl.querySelector(".busy-text").textContent = text;
  const bar = busyEl.querySelector(".busy-bar");
  bar.style.display = pct == null ? "none" : "";
  if (pct != null) bar.firstChild.style.width = `${Math.round(clamp(pct, 0, 1) * 100)}%`;
}
// Runs a button's job with the button disabled, its label changed and the bar showing.
async function working(btn, label, job) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label; busy(label, null);
  await tick(); await new Promise((r) => requestAnimationFrame(() => r()));
  try { return await job(); }
  finally { busy(null); if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}
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
let resetting = false;
async function boot() {
  // Arrived from a "reset password" email: show the new-password form once signed in.
  if (new URLSearchParams(location.search).get("reset") === "1" || /type=recovery/.test(location.hash)) resetting = true;
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
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === "PASSWORD_RECOVERY") resetting = true;
    const was = S.user?.id;
    S.user = session?.user || null;
    if ((S.user?.id || null) !== (was || null)) route();
  });
  route();
}

async function route() {
  $who.replaceChildren();
  if (!S.user) return renderSignIn();
  if (resetting) return renderNewPassword();
  S.isAdmin = ADMIN_EMAILS.includes(String(S.user.email || "").toLowerCase());
  $who.append(S.user.email, h("button", { class: "ghost", onclick: async () => { await sb.auth.signOut(); } }, "Sign out"));
  const { data, error } = await sb.from("platetrace_access").select("*").eq("user_id", S.user.id).maybeSingle();
  if (error) return renderMessage("Can't check your access", "The access table isn't set up yet, or the connection failed. " + error.message);
  S.access = data;
  const set = await sb.from("platetrace_settings").select("public_mode").eq("id", 1).maybeSingle();
  S.publicMode = !!set.data?.public_mode;
  if (S.isAdmin) return renderTool(true);
  if (data?.status === "approved") return renderTool(false);
  if (S.publicMode) return renderTool(false);
  if (!data) return renderRequest();
  if (data.status === "rejected") return renderMessage("Access not approved", data.note || "Your request wasn't approved. Contact PlateTrace if you think this is a mistake.");
  renderMessage("Verification in progress", `Thanks, ${data.full_name}. We verify every agency before turning access on, usually within 1–2 business days. We may call your supervisor at the number you gave.`);
}

function renderNewPassword() {
  const p1 = h("input", { type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password" });
  const p2 = h("input", { type: "password", placeholder: "Type it again", autocomplete: "new-password" });
  const msg = h("p", { class: "small" });
  const save = async (e) => {
    e.preventDefault();
    if (p1.value.length < 8) { msg.className = "small error"; msg.textContent = "Use at least 8 characters."; return; }
    if (p1.value !== p2.value) { msg.className = "small error"; msg.textContent = "The two passwords don't match."; return; }
    const { error } = await sb.auth.updateUser({ password: p1.value });
    if (error) { msg.className = "small error"; msg.textContent = error.message; return; }
    resetting = false;
    history.replaceState(null, "", location.pathname);
    msg.className = "small ok"; msg.textContent = "Password saved. Opening PlateTrace…";
    setTimeout(route, 900);
  };
  $app.replaceChildren(h("form", { class: "card narrow", onsubmit: save },
    h("h1", {}, "Set a new password"),
    h("p", { class: "muted" }, "Signed in as " + (S.user?.email || "") + ". Choose a new password you'll use from now on."),
    h("label", {}, "New password", p1),
    h("label", {}, "Confirm", p2),
    h("button", { type: "submit", style: "margin-top:12px;width:100%" }, "Save password"),
    msg));
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
  const forgot = async () => {
    const v = addr(); if (!v) return;
    const { error } = await sb.auth.resetPasswordForEmail(v, { redirectTo: location.origin + "/?reset=1" });
    if (error) say(false, /rate|seconds/i.test(error.message) ? "Please wait a minute, then try again." : error.message);
    else say(true, "Sent. Open the newest \"Reset password\" email and tap its link. You'll come back here to choose a new password.");
  };
  $app.replaceChildren(h("form", { class: "card narrow", onsubmit: withPassword },
    h("h1", {}, "PlateTrace"),
    h("p", { class: "muted" }, "Plate enhancement and candidate reading for verified law enforcement and licensed investigators."),
    h("label", {}, "Work email", email),
    h("label", {}, "Password", pass),
    h("p", { class: "small muted", style: "margin:4px 0 0" }, "Same password as your CashCow dashboard, if you have one."),
    h("button", { type: "submit", style: "margin-top:12px;width:100%" }, "Sign in"),
    h("button", { type: "button", class: "ghost", style: "margin-top:8px;width:100%", onclick: forgot }, "Forgot password? Email me a reset link"),
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

async function renderTips(box, start) {
  box.replaceChildren(h("p", { class: "small muted" }, "Loading tips…"));
  const { data, error } = await sb.from("platetrace_tips").select("*").neq("status", "dismissed").order("created_at", { ascending: false }).limit(60);
  if (error) { box.replaceChildren(h("p", { class: "small error" }, "Couldn't load tips: " + error.message)); return; }
  if (!data.length) { box.replaceChildren(h("p", { class: "small muted" }, "No tips yet.")); return; }
  const groups = [];
  for (const r of data) { const g = r.camera_settings?.group || r.id; let G = groups.find((x) => x.g === g); if (!G) groups.push((G = { g, rows: [] })); G.rows.push(r); }
  groups.forEach((G) => G.rows.sort((a, b) => (a.camera_settings?.shot || 1) - (b.camera_settings?.shot || 1)));
  const fetchFiles = async (G) => Promise.all(G.rows.map(async (r) => {
    const { data: blob, error: e } = await sb.storage.from("platetrace-tips").download(r.file_path);
    if (e) throw e;
    return new File([blob], r.file_path.split("/").pop(), { type: r.mime || blob.type });
  }));
  const setStatus = async (G, status) => { await sb.from("platetrace_tips").update({ status }).in("id", G.rows.map((r) => r.id)); renderTips(box, start); };
  box.replaceChildren(...groups.slice(0, 30).map((G) => {
    const r = G.rows[0], prev = h("div", {}), note = h("p", { class: "small error" });
    const when = new Date(r.captured_at || r.created_at).toLocaleString();
    const where = r.lat != null ? h("a", { href: `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}`, target: "_blank", rel: "noopener", style: "color:var(--accent)" }, `map (±${Math.round(r.accuracy_m)} m)`) : "no location";
    const label = r.camera_settings?.capture_mode ? `Special light: ${r.camera_settings.capture_mode} · ${G.rows.length} file(s)` : r.kind === "video" ? `Video${r.camera_settings?.seconds ? ` · ${r.camera_settings.seconds}s` : ""}` : G.rows.length > 1 ? `${G.rows.length} photos (burst)` : "Photo";
    return h("div", { style: "border-top:1px solid var(--line);padding:10px 0" },
      h("div", { class: "row", style: "align-items:center" },
        h("div", {}, h("b", {}, label), " ", h("span", { class: r.status === "new" ? "pill warn" : "pill" }, r.status),
          h("div", { class: "small muted" }, `${when} · `, where, ` · ${(G.rows.reduce((n, x) => n + (x.bytes || 0), 0) / 1048576).toFixed(1)} MB`),
          r.note ? h("div", { class: "small" }, `“${r.note}”`) : null,
          h("div", { class: "small muted" }, r.contact ? `Contact: ${r.contact}` : "Anonymous")),
        h("button", { class: "ghost", onclick: async () => {
          prev.replaceChildren(h("p", { class: "small muted" }, "Loading…"));
          try {
            const urls = await Promise.all(G.rows.map(async (x) => (await sb.storage.from("platetrace-tips").createSignedUrl(x.file_path, 600)).data?.signedUrl));
            prev.replaceChildren(...urls.map((u) => r.kind === "video" ? h("video", { src: u, controls: true, playsinline: true, style: "width:100%;max-width:520px;border-radius:8px" }) : h("img", { src: u, style: "width:100%;max-width:260px;border-radius:8px;margin:4px" })));
            if (r.status === "new") sb.from("platetrace_tips").update({ status: "reviewed" }).in("id", G.rows.map((x) => x.id)).then(() => {});
          } catch (e) { prev.replaceChildren(h("p", { class: "small error" }, e.message || String(e))); }
        } }, "View"),
        h("button", { onclick: async (e) => {
          e.target.disabled = true; note.textContent = "";
          // Special-light results are built from the originals in the same tip, so only the originals are stacked.
          try { const rows = G.rows.filter((x) => x.camera_settings?.special?.role !== "result"), files = await fetchFiles({ rows }); await sb.from("platetrace_tips").update({ status: "used" }).in("id", G.rows.map((x) => x.id)); await start({ rows, files }); }
          catch (err) { note.textContent = "Couldn't open it: " + (err.message || err); e.target.disabled = false; }
        } }, "Open as case"),
        h("button", { class: "danger", onclick: () => { if (confirm("Hide this tip from the list? The files are kept.")) setStatus(G, "dismissed"); } }, "Dismiss")),
      prev, note);
  }));
}

function renderTool(isAdmin) {
  C = null;
  const caseNo = h("input", { placeholder: "e.g. 2026-004512" });
  const examiner = h("input", { value: S.access?.full_name || "" });
  const file = h("input", { type: "file", accept: "video/*,image/*", multiple: true });
  const msg = h("p", { class: "small" });
  const start = async (tip) => {
    if (tip && !caseNo.value.trim()) caseNo.value = `TIP-${tip.rows[0].id.slice(0, 8)}`;
    if (!caseNo.value.trim() || !examiner.value.trim()) {
      msg.className = "small error"; msg.textContent = "Enter the case number and examiner name first.";
      (examiner.value.trim() ? caseNo : examiner).focus(); (examiner.value.trim() ? caseNo : examiner).scrollIntoView({ block: "center" });
      if (tip) throw new Error("Type your name in the Examiner box at the top, then tap Open as case again.");
      return;
    }
    const files = tip ? tip.files : [...file.files];
    if (!files.length) { msg.className = "small error"; msg.textContent = "Choose a video, or one or more photos."; return; }
    msg.className = "small muted"; msg.textContent = "Fingerprinting the original file (SHA-256)…";
    C = { caseNo: caseNo.value.trim(), examiner: examiner.value.trim(), files: [], log: [], frames: [], box: null, kind: "", combined: null };
    for (const [i, f] of files.entries()) {
      busy(`Opening case: fingerprinting file ${i + 1} of ${files.length} (${f.name})…`, i / files.length); await tick();
      C.files.push({ name: f.name, size: f.size, type: f.type, sha256: await sha256(await f.arrayBuffer()), file: f });
    }
    busy("Opening case: reading file facts…", null); await tick();
    C.fileHash = C.files[0].sha256;
    C.kind = files[0].type.startsWith("video/") ? "video" : "images";
    logStep("case_opened", { case_no: C.caseNo, examiner: C.examiner, user: S.user.email, version: VERSION });
    C.files.forEach((f) => logStep("original_file", { name: f.name, bytes: f.size, sha256: f.sha256 }));
    if (tip) {
      C.tip = tip.rows.map((r) => ({ id: r.id, received_at: r.created_at, captured_at: r.captured_at, kind: r.kind, sha256_at_capture: r.sha256, location: r.lat != null ? { lat: r.lat, lng: r.lng, accuracy_m: r.accuracy_m } : null, note: r.note, contact_given: !!r.contact, camera: r.camera_settings }));
      C.files.forEach((f, i) => { const r = tip.rows[i]; logStep("public_tip", { tip_id: r.id, sha256_at_capture: r.sha256, matches_file: r.sha256 === f.sha256, captured_at: r.captured_at, location: r.lat != null ? `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} (±${r.accuracy_m} m)` : "not shared" }); });
      if (C.files.some((f, i) => f.sha256 !== tip.rows[i].sha256)) { msg.className = "small error"; msg.textContent = "Warning: a file's fingerprint doesn't match the one taken on the phone. It may have been changed."; }
    }
    if (!msg.classList.contains("error")) { msg.className = "small muted"; msg.textContent = "Reading file facts (provenance)…"; }
    try {
      C.provenance = await PTIntegrity.provenance(C.files, C.tip);
      C.sourceType = PTIntegrity.caseSource(C.provenance);
      C.provenance.forEach((p) => logStep("provenance", { file: p.file, source_type: p.source_type, rule: p.rule, container: p.container, compression: p.compression, resolution: p.width ? `${p.width}x${p.height}` : null, jpeg_quality_est: p.jpeg_quality_est ?? null, codec: p.codec ?? null, exif: p.exif || null }));
    } catch (e) { C.provenance = []; C.sourceType = "derivative"; logStep("provenance", { error: String(e.message || e), source_type: "derivative (could not read file facts)" }); }
    audit("open", { files: C.files.map((f) => ({ name: f.name, sha256: f.sha256 })) });
    renderWork();
  };
  const openBtn = h("button", { style: "margin-top:12px", onclick: () => working(openBtn, "Opening case…", () => start()).catch((e) => { msg.className = "small error"; msg.textContent = "Couldn't open the case: " + (e.message || e); }) }, "Open case");
  const adminBox = h("div", {}), tipsBox = h("div", {});
  const switchMsg = h("p", { class: "small muted" });
  const switchBtn = h("button", { class: S.publicMode ? "" : "ghost", onclick: async () => {
    const next = !S.publicMode;
    if (next && !confirm("Turn on PUBLIC TEST MODE? Anyone who signs in can use PlateTrace without verification.")) return;
    switchBtn.disabled = true;
    const { error } = await sb.from("platetrace_settings").update({ public_mode: next, updated_at: nowIso() }).eq("id", 1);
    switchBtn.disabled = false;
    if (error) { switchMsg.className = "small error"; switchMsg.textContent = "Couldn't change it: " + error.message; return; }
    S.publicMode = next; renderTool(true);
  } }, S.publicMode ? "Public test mode: ON (tap to make private)" : "Private: verified only (tap to make public)");
  const testBanner = !isAdmin && S.publicMode && S.access?.status !== "approved"
    ? h("div", { class: "card", style: "border:2px solid #f5a623" }, h("strong", {}, "Test mode. "),
        h("span", { class: "small" }, "PlateTrace is open for testing right now. Full access still needs agency verification."))
    : null;
  $app.replaceChildren(...[
    isAdmin ? h("div", { class: "card" }, h("h2", {}, "Who can use PlateTrace"),
      h("p", { class: "small muted" }, "Private = only verified agencies. Public = anyone who signs in can test it."), switchBtn, switchMsg) : null,
    testBanner,
    isAdmin ? h("div", { class: "card" }, h("h2", {}, "Tips from the public"),
      h("p", { class: "small muted" }, "Photos and videos sent from PlateTrace Camera (", h("a", { href: "camera/", target: "_blank", style: "color:var(--accent)" }, location.origin + "/camera/"), "). Fingerprinted on the phone when taken."), tipsBox) : null,
    isAdmin ? h("div", { class: "card" }, h("h2", {}, "Access requests"), adminBox) : null,
    h("div", { class: "card" },
      h("h1", {}, "New case"),
      h("p", { class: "muted small" }, "Load a video clip, or several photos of the same vehicle. Nothing is uploaded; processing happens on this device."),
      h("div", { class: "row" }, h("label", {}, "Case number", caseNo), h("label", {}, "Examiner", examiner)),
      h("label", {}, "Footage", file),
      openBtn, msg),
    plansCard()].filter(Boolean));
  if (isAdmin) { renderAdmin(adminBox); renderTips(tipsBox, start); }
}

function stepsBar(on) {
  const names = ["1 Mark plate", "2 Clearest frames", "3 Combine", "4 Read", "5 Vehicle details", "6 Case package"];
  return h("div", { class: "steps" }, names.map((n, i) => h("span", { class: i + 1 < on ? "done" : i + 1 === on ? "on" : "" }, n)));
}

async function renderWork() {
  const head = h("div", { class: "card" },
    h("div", { class: "row" }, h("div", {}, h("h2", {}, `Case ${C.caseNo}`), h("div", { class: "small muted" }, `${C.files.length} file(s) · ${C.files[0].name} · SHA-256 ${C.fileHash.slice(0, 16)}…`),
        h("div", { class: "small", title: PTIntegrity.LABELS.provenance }, `Source type: ${C.sourceType || "unknown"} · ${(C.provenance || []).map((p) => [p.container, p.width ? `${p.width}×${p.height}` : null, p.compression, p.jpeg_quality_est != null ? `JPEG quality ≈${p.jpeg_quality_est}` : null, p.codec].filter(Boolean).join(", ")).slice(0, 2).join(" | ")}`)),
      h("button", { class: "ghost", onclick: () => { if (confirm("Close this case? Unsaved work is lost.")) renderTool(S.isAdmin); } }, "Close case")));
  const stage = h("div", { class: "card" });
  const logCard = h("div", { class: "card" }, h("h3", { style: "margin-top:0" }, "Evidence log"), h("div", { class: "log", id: "log" }));
  $app.replaceChildren(head, stage, logCard);
  window.scrollTo({ top: 0 });
  head.append(h("p", { class: "small", style: "margin:8px 0 0;color:var(--good)" }, `✓ Case opened. ${C.files.length} file(s) fingerprinted. Next: mark the plate below.`));
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
  const keep = h("input", { type: "number", min: 1, max: 40, value: 12, disabled: true });
  const far = h("input", { type: "checkbox", checked: true, style: "width:auto" });
  far.addEventListener("change", () => (keep.disabled = far.checked));
  const zoom = h("select", {}, [4, 6, 8].map((z) => h("option", { value: z }, `${z}× ${z === 4 ? "(standard)" : z === 6 ? "(far away)" : "(very far / tiny plate)"}`)));
  const bar = h("i", {});
  const status = h("p", { class: "small muted" });
  const thumbs = h("div", { class: "thumbs" });
  const next = h("button", { disabled: true, onclick: () => working(next, "Combining…", () => combineStep(stage)).catch((e) => { status.className = "small error"; status.textContent = "Combining failed: " + (e.message || e); }) }, "Next: combine the frames");
  const run = async () => {
    go.disabled = true; next.disabled = true; thumbs.replaceChildren();
    const box = C.box;
    C.up = clamp(+zoom.value, 2, 8);
    while (C.up > 2 && box.w * C.up > 1800) C.up -= 2;          // keep very large plate boxes manageable
    C.farMode = far.checked;
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
    busy(isVideo ? "Finding the clearest frames…" : "Lining up the photos…", 0);
    for (let k = 0; k < times.length; k++) {
      await tick();
      await grab(times[k]);
      const al = alignTo(ref, box, fctx, srcW, srcH);
      const big = canvasOf(box.w * C.up, box.h * C.up);
      const bctx = big.getContext("2d", { willReadFrequently: true });
      bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = "high";
      bctx.drawImage(frameCanvas, box.x + al.dx, box.y + al.dy, box.w, box.h, 0, 0, big.width, big.height);
      const g = grayRegion(fctx, Math.round(box.x + al.dx), Math.round(box.y + al.dy), box.w, box.h);
      found.push({ key: times[k], at: isVideo ? +times[k].toFixed(3) : C.files[times[k]].name, dx: +al.dx.toFixed(2), dy: +al.dy.toFixed(2), match: +al.match.toFixed(3), sharp: +sharpness(g, box.w, box.h).toFixed(1), img: bctx.getImageData(0, 0, big.width, big.height) });
      bar.style.width = `${Math.round(((k + 1) / times.length) * 100)}%`;
      status.textContent = `Checked ${k + 1} of ${times.length} frames…`;
      busy(`Checked ${k + 1} of ${times.length} frames…`, (k + 1) / times.length);
    }
    busy(null);
    // keep frames that really line up with the plate, then the sharpest of those
    // Far / blurry mode: every frame that shows the plate is used; sharper frames simply count more when combined.
    const good = found.filter((f) => f.match >= (C.farMode ? 0.4 : 0.5));
    const dropped = found.length - good.length;
    good.sort((a, b) => b.sharp - a.sharp);
    C.frames = (C.farMode ? good : good.slice(0, clamp(Math.round(+keep.value), 1, 40))).map((f) => ({ ...f, use: true }));
    const maxSharp = Math.max(1e-6, ...C.frames.map((f) => f.sharp));
    C.frames.forEach((f) => (f.weight = C.farMode ? +(0.25 + 0.75 * (f.sharp / maxSharp)).toFixed(3) : 1));
    logStep("frames_scanned", { checked: found.length, dropped_poor_match: dropped, kept: C.frames.length, far_blurry_mode: C.farMode, zoom: C.up, range: isVideo ? [+from.value, +to.value] : "all photos" });
    C.frames.forEach((f, i) => logStep("frame_kept", { n: i + 1, frame: f.at, shift_px: [f.dx, f.dy], match: f.match, sharpness: f.sharp, weight: f.weight }));
    status.textContent = C.frames.length
      ? (C.farMode ? `Using all ${C.frames.length} frames that show the plate, at ${C.up}× zoom; sharper frames count more` : `Kept the ${C.frames.length} clearest well-matched frames`) + `${dropped ? ` (${dropped} skipped because the plate didn't line up)` : ""}. Untick any that look wrong.`
      : "No frames lined up with the plate. Try a smaller time range or re-mark the plate.";
    C.frames.forEach((f, i) => {
      const cb = h("input", { type: "checkbox", checked: true, style: "width:auto", onchange: (e) => { f.use = e.target.checked; next.disabled = !C.frames.some((x) => x.use); } });
      thumbs.append(h("figure", {}, h("img", { src: canvasFromData(f.img).toDataURL(), alt: `Frame ${i + 1}` }),
        h("figcaption", {}, h("label", { style: "display:flex;gap:6px;align-items:center;margin:0;font-weight:400" }, cb, `#${i + 1} · ${isVideo ? f.at + " s" : f.at}`),
          `match ${f.match} · sharp ${f.sharp}${C.farMode ? ` · counts ${Math.round(f.weight * 100)}%` : ""}`)));
    });
    next.disabled = !C.frames.length; go.disabled = false;
  };
  const go = h("button", { onclick: run }, isVideo ? "Find the clearest frames" : "Line up the photos");
  stage.replaceChildren(stepsBar(2), h("h2", {}, "Find the clearest frames"),
    isVideo ? h("div", { class: "row" }, h("label", {}, "From (seconds)", from), h("label", {}, "To (seconds)", to), h("label", {}, "Frames to check", samples), h("label", {}, "Keep the best (when far mode is off)", keep))
      : h("p", { class: "small muted" }, `${C.images.length} photo(s) will be lined up to the first one.`),
    h("div", { class: "row", style: "margin-top:8px" }, h("label", {}, "Zoom closer", zoom),
      h("label", { style: "display:flex;gap:8px;align-items:center" }, far, "Far away or blurry footage: use every frame that shows the plate (sharper frames count more)")),
    h("p", { class: "small muted" }, "For a small or distant plate, use 6× or 8× and check more frames (e.g. 60). Each frame is placed to a fraction of a pixel, so together they hold more detail than any one frame. Nothing is guessed or drawn in."),
    h("div", { style: "margin-top:10px" }, go), h("div", { class: "progress" }, bar), status, thumbs, h("div", { style: "margin-top:12px" }, next));
}

// ---------- step 3: combine and enhance ----------
function averageFrames(frames) {               // weighted mean (weights are 1 unless far / blurry mode set them)
  const w = frames[0].img.width, hgt = frames[0].img.height, acc = new Float32Array(w * hgt * 3);
  let W = 0;
  for (const f of frames) { const wt = f.weight ?? 1; W += wt; const d = f.img.data; for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { acc[i] += wt * d[j]; acc[i + 1] += wt * d[j + 1]; acc[i + 2] += wt * d[j + 2]; } }
  const out = new ImageData(w, hgt);
  for (let i = 0, j = 0; j < out.data.length; i += 3, j += 4) { out.data[j] = acc[i] / W; out.data[j + 1] = acc[i + 1] / W; out.data[j + 2] = acc[i + 2] / W; out.data[j + 3] = 255; }
  return out;
}

// ---------- unblur: Richardson-Lucy deconvolution ----------
// A standard, published method (also used in forensic video tools). It reverses a known blur
// shape mathematically; it does not add or predict detail. Every setting is logged.
function blurKernel(kind, size, angleDeg) {
  if (kind === "focus") {                       // out-of-focus / distance blur: Gaussian, sigma = size
    const r = Math.max(1, Math.ceil(size * 3)), k = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * size * size)));
    const s = k.reduce((a, b) => a + b, 0); return { kind, r, k: k.map((v) => v / s) };
  }
  const L = Math.max(2, Math.round(size)), a = (angleDeg * Math.PI) / 180, pts = [];   // motion: straight streak
  for (let i = 0; i < L; i++) { const t = i - (L - 1) / 2; pts.push([t * Math.cos(a), -t * Math.sin(a)]); }
  return { kind, pts };
}
function convolve(src, w, hgt, K) {
  const out = new Float32Array(src.length);
  if (K.kind === "focus") {
    const tmp = new Float32Array(src.length), { r, k } = K;
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + clamp(x + i, 0, w - 1)]; tmp[y * w + x] = s; }
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * tmp[clamp(y + i, 0, hgt - 1) * w + x]; out[y * w + x] = s; }
    return out;
  }
  const n = K.pts.length;
  const pts = K.pts.map(([dx, dy]) => { const fx = Math.floor(dx), fy = Math.floor(dy); return [fx, fy, dx - fx, dy - fy]; });
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (const [fx, fy, ax, ay] of pts) {
      const x0 = clamp(x + fx, 0, w - 1), x1 = clamp(x + fx + 1, 0, w - 1), y0 = clamp(y + fy, 0, hgt - 1), y1 = clamp(y + fy + 1, 0, hgt - 1);
      s += (src[y0 * w + x0] * (1 - ax) + src[y0 * w + x1] * ax) * (1 - ay) + (src[y1 * w + x0] * (1 - ax) + src[y1 * w + x1] * ax) * ay;
    }
    out[y * w + x] = s / n;
  }
  return out;
}
function richardsonLucy(img, opt) {
  if (!opt || opt.kind === "off") return img;
  const w = img.width, hgt = img.height, K = blurKernel(opt.kind, opt.size, opt.angle || 0), out = new ImageData(w, hgt);
  for (let c = 0; c < 3; c++) {
    const obs = new Float32Array(w * hgt); for (let i = 0; i < obs.length; i++) obs[i] = img.data[i * 4 + c] + 1;
    let est = Float32Array.from(obs);
    for (let it = 0; it < opt.iterations; it++) {
      const conv = convolve(est, w, hgt, K), ratio = new Float32Array(obs.length);
      for (let i = 0; i < obs.length; i++) ratio[i] = obs[i] / (conv[i] + 1e-3);
      const corr = convolve(ratio, w, hgt, K);   // both blur shapes are symmetric, so the mirror kernel is the same
      for (let i = 0; i < est.length; i++) est[i] = clamp(est[i] * corr[i], 0, 400);
    }
    for (let i = 0; i < est.length; i++) out.data[i * 4 + c] = clamp(est[i] - 1, 0, 255);
  }
  for (let i = 0; i < w * hgt; i++) out.data[i * 4 + 3] = 255;
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
  const ch = C && C.channel && C.channel !== "lum" ? C.channel : null;
  const chans = gray ? [ch ? PTIntegrity.grayOf(img, ch) : toGray(img)] : [0, 1, 2].map((c) => { const a = new Float32Array(w * hgt); for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + c]; return a; });
  const lum = gray ? chans[0] : toGray(img), sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)] || 255, span = Math.max(1, hi - lo);
  const out = new ImageData(w, hgt);
  const res = chans.map((ch) => {
    const st = ch.map((v) => clamp(((v - lo) / span) * 255, 0, 255));
    if (!amount) return st;
    const rr = Math.max(1, Math.round(upNow() / 2)), bl = boxBlur(boxBlur(st, w, hgt, rr), w, hgt, rr);
    return st.map((v, i) => clamp(v + amount * (v - bl[i]), 0, 255));
  });
  for (let i = 0; i < w * hgt; i++) {
    out.data[i * 4] = res[0][i]; out.data[i * 4 + 1] = (res[1] || res[0])[i]; out.data[i * 4 + 2] = (res[2] || res[0])[i]; out.data[i * 4 + 3] = 255;
  }
  return out;
}


// Automatic light & dark combining. The plate is black letters on a white background, so in every
// frame PlateTrace measures how bright "white" and how dark "black" look, rescales the frame so
// white = white and black = black, and then builds each pixel only from frames where that pixel was
// recorded well (not blown out by glare, not crushed to black). Pixels no frame recorded well are
// flagged as "no data" on the coverage map; nothing is painted in.
async function smartCombine(frames, onProgress) {
  const w = frames[0].img.width, hgt = frames[0].img.height, n = w * hgt;
  const CLIP = 250, CRUSH = 6;
  const stats = frames.map((f) => {
    const d = f.img.data, vals = [];
    const x0 = Math.round(w * 0.1), x1 = Math.round(w * 0.9), y0 = Math.round(hgt * 0.1), y1 = Math.round(hgt * 0.9);
    let clipped = 0, tot = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const j = (y * w + x) * 4, mx = Math.max(d[j], d[j + 1], d[j + 2]), g = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      tot++; if (mx >= CLIP) clipped++; else if (mx > CRUSH) vals.push(g);
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 128;
    const black = q(0.08), white = q(0.8), span = white - black;
    return { black, white, span, clipped_pct: Math.round((clipped / Math.max(1, tot)) * 100), weight: (f.weight ?? 1) * Math.max(0.15, Math.min(1, span / 120)), usable: span >= 12 };
  });
  const anyUsable = stats.some((s) => s.usable);
  // Glare is usually a patch of extra light, not a whole-frame change, so white and black are also
  // measured locally (around each spot) and the frame is evened out spot by spot.
  const R = Math.max(3, Math.round(hgt * 0.2));
  const slide = (src, fn) => {
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let v = src[y * w + x]; for (let i = Math.max(0, x - R); i <= Math.min(w - 1, x + R); i++) v = fn(v, src[y * w + i]); tmp[y * w + x] = v; }
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { let v = tmp[y * w + x]; for (let i = Math.max(0, y - R); i <= Math.min(hgt - 1, y + R); i++) v = fn(v, tmp[i * w + x]); out[y * w + x] = v; }
    return boxBlur(out, w, hgt, R);
  };
  const acc = new Float32Array(n * 3), wsum = new Float32Array(n), good = new Uint16Array(n), fall = new Float32Array(n * 3), fallW = new Float32Array(n);
  for (const [k, f] of frames.entries()) {
    if (onProgress) { onProgress(k, frames.length); await tick(); }
    const s = stats[k]; if (anyUsable && !s.usable) continue;
    const d = f.img.data, gray = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const wl = slide(gray, Math.max), bl = slide(gray, Math.min);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
      const ls = wl[i] - bl[i], local = ls >= 25;
      const lo = local ? bl[i] : s.black, span = Math.max(1, local ? ls : s.span);
      const r = (d[j] - lo) / span, g = (d[j + 1] - lo) / span, b = (d[j + 2] - lo) / span;
      if (mx >= CLIP || mx <= CRUSH && mn <= CRUSH) { fall[i * 3] += r; fall[i * 3 + 1] += g; fall[i * 3 + 2] += b; fallW[i]++; continue; }
      const near = Math.min(1, (CLIP - mx) / 40);          // almost blown out: trust it less
      const wt = s.weight * near * (local ? Math.min(1, ls / 80) : 0.3);
      acc[i * 3] += wt * r; acc[i * 3 + 1] += wt * g; acc[i * 3 + 2] += wt * b; wsum[i] += wt; good[i]++;
    }
  }
  const out = new ImageData(w, hgt), map = new ImageData(w, hgt), most = frames.length;
  let nodata = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    for (let c = 0; c < 3; c++) {
      const v = wsum[i] ? acc[i * 3 + c] / wsum[i] : fallW[i] ? fall[i * 3 + c] / fallW[i] : 1;
      out.data[j + c] = clamp(v * 230 + 12, 0, 255);
    }
    out.data[j + 3] = 255;
    if (!good[i]) { nodata++; map.data.set([220, 40, 40, 255], j); }
    else { const t = good[i] / most; map.data.set([20, Math.round(60 + 180 * t), 60, 255], j); }
  }
  return { img: out, map, nodata_pct: Math.round((nodata / n) * 1000) / 10,
    frames: stats.map((s, k) => ({ n: k + 1, white_level: Math.round(s.white), black_level: Math.round(s.black), blown_out_pct: s.clipped_pct, used: !anyUsable || s.usable, weight: +s.weight.toFixed(3) })) };
}

async function combineStep(stage) {
  const used = C.frames.filter((f) => f.use);
  C.smart = await smartCombine(used, (k, n) => busy(`Combining frame ${k + 1} of ${n}…`, k / n));
  busy("Measuring the result…", 1); await tick();
  C.combinedRaw = C.smart.img;
  C.best = used[0];
  C.channel = C.channel || "lum";
  const L = PTIntegrity.LABELS;
  const note = (t) => h("p", { class: "small muted", style: "margin:4px 0 0;font-style:italic" }, t);
  // Measure the footage before anything cosmetic happens.
  const stack = PTIntegrity.stackStats(used);
  C.chan = PTIntegrity.channelReport(C.combinedRaw);
  const first = PTIntegrity.assess({ img: C.combinedRaw, frames: used, smart: C.smart, source_type: C.sourceType, up: upNow(), ops: [] });
  const sigmaZoom = first.measurements.blur_sigma_px != null ? first.measurements.blur_sigma_px * upNow() : null;
  const amount = h("input", { type: "range", min: 0, max: 2.5, step: 0.1, value: 1.2 });
  const gray = h("input", { type: "checkbox", checked: true, style: "width:auto" });
  const chanSel = h("select", { disabled: !C.chan.distinct },
    h("option", { value: "lum" }, "Normal (all colors)"), h("option", { value: "r" }, "Red only"), h("option", { value: "g" }, "Green only"), h("option", { value: "b" }, "Blue only"));
  chanSel.value = C.chan.distinct ? C.channel : "lum"; if (!C.chan.distinct) C.channel = "lum";
  const imgBest = h("img", { alt: "Clearest single frame" }), imgComb = h("img", { alt: "Combined frames, enhanced" });
  const ub = { kind: h("select", {}, h("option", { value: "off" }, "Off"), h("option", { value: "focus" }, "Out of focus / far away"), h("option", { value: "motion" }, "Motion streak (car moving)")),
    size: h("input", { type: "range", min: 0.5, max: 3 * upNow(), step: 0.5, value: sigmaZoom ? clamp(Math.round(sigmaZoom * 2) / 2, 0.5, 3 * upNow()) : upNow() / 2 }), angle: h("input", { type: "range", min: 0, max: 175, step: 5, value: 0 }),
    iter: h("input", { type: "range", min: 5, max: 40, step: 5, value: 15 }) };
  const ubInfo = h("span", { class: "small muted" });
  const ubAngleRow = h("label", { style: "display:none" }, "Streak direction", ub.angle);
  const ubStatus = h("p", { class: "small muted" });
  const assessBox = h("div", {});
  let deblurred = C.combinedRaw, deblurredBest = C.best.img, unblurUsed = null;
  const ubOpt = () => ({ kind: ub.kind.value, size: +ub.size.value, iterations: +ub.iter.value, angle: +ub.angle.value });
  const ubLabel = () => { const o = ubOpt(); ubAngleRow.style.display = o.kind === "motion" ? "" : "none";
    ubInfo.textContent = o.kind === "off" ? "" : o.kind === "focus" ? `blur size ${o.size} px · ${o.iterations} rounds` : `streak ${o.size} px at ${o.angle}° · ${o.iterations} rounds`; };
  const unblurBasis = (o) => {
    if (o.kind === "motion") return "chosen by the examiner (motion streak; the edge measurement assumes round blur and can't confirm a streak)";
    if (sigmaZoom && Math.abs(o.size - sigmaZoom) <= Math.max(0.5, sigmaZoom * 0.25)) return `estimated from the footage's own edges (measured ${sigmaZoom.toFixed(1)} px at zoom; used ${o.size} px)`;
    return `chosen by the examiner (${o.size} px at zoom; the footage's edges measured ${sigmaZoom ? sigmaZoom.toFixed(1) + " px" : "nothing reliable"})`;
  };
  const opsList = () => [
    `multi-frame stacking (${stack.genuine_frames} genuine of ${stack.frames_given})`,
    "contrast stretch / levels",
    ...(C.channel !== "lum" ? [`color channel: ${({ r: "red", g: "green", b: "blue" })[C.channel]}`] : []),
    ...(unblurUsed ? [`deconvolution (${unblurUsed.kind === "focus" ? "Gaussian" : "motion"}, ${unblurUsed.size} px)`] : []),
    ...(+amount.value ? [`unsharp mask ${amount.value} (cosmetic)`] : []),
  ];
  const yes = (b) => h("b", { style: `color:${b ? "var(--good,#3ccf8e)" : "var(--bad,#ff6b6b)"}` }, b ? "yes" : "no");
  const reassess = () => {
    // Judged on the recorded data (before unblur and sharpening), so processing can't talk itself into "signal present".
    C.assess = PTIntegrity.assess({ img: C.combinedRaw, channel: C.channel === "lum" ? null : C.channel, frames: used, smart: C.smart, source_type: C.sourceType, up: upNow(),
      unblur: unblurUsed ? { basis: unblurBasis(unblurUsed) } : null, ops: opsList() });
    const A = C.assess;
    assessBox.replaceChildren(
      h("table", {},
        h("tr", {}, h("td", {}, "Detail survived the blur (signal_present)"), h("td", {}, yes(A.signal_present))),
        h("tr", {}, h("td", {}, "Evidence grade"), h("td", {}, yes(A.evidence_grade))),
        h("tr", {}, h("td", {}, "Recovery type"), h("td", {}, A.recovery_type)),
        h("tr", {}, h("td", {}, "Source type"), h("td", {}, A.source_type)),
        h("tr", {}, h("td", {}, "Blur radius (est.)"), h("td", {}, A.blur_radius_est == null ? "not measurable" : `${A.blur_radius_est} px`)),
        h("tr", {}, h("td", {}, "Stroke width (est.)"), h("td", {}, A.stroke_width_est == null ? "not measurable" : `${A.stroke_width_est} px`)),
        h("tr", {}, h("td", {}, "Confidence"), h("td", {}, `${Math.round(A.confidence * 100)}%`)),
        h("tr", {}, h("td", {}, "Stacking"), h("td", { class: "small" }, `${A.stacking.genuine_frames} genuine frame(s)${A.stacking.duplicates.length ? `, ${A.stacking.duplicates.length} duplicate(s) counted once` : ""}; noise ÷${A.stacking.noise_reduction_factor}; stacking confidence ${Math.round(A.stacking.confidence * 100)}%`))),
      h("p", { class: "small muted" }, "Sizes are in original-footage pixels. If the blur radius reaches the stroke width, the characters did not survive and nothing can honestly bring them back."),
      ...A.failed_checks.map((t) => h("p", { class: "small error", style: "margin:2px 0" }, "✗ " + t)),
      ...A.flags.map((t) => h("p", { class: "small", style: "margin:2px 0;color:#f2b84b" }, "⚠ " + t)),
      note(A.stacking.note));
  };
  const paint = () => {
    const o = ubOpt();
    C.params = { frames_combined: used.length, detail_factor: upNow(), far_blurry_mode: !!C.farMode, weighting: (C.farMode ? "sharpness-weighted" : "equal-weight") + " automatic light & dark combining (each frame rescaled to its own local white and black levels; blown-out and crushed pixels skipped per frame, nearly blown-out pixels trusted less)",
      no_data_pct: C.smart.nodata_pct, frame_levels: C.smart.frames,
      unblur: !unblurUsed ? null : { method: "Richardson-Lucy deconvolution", blur: unblurUsed.kind === "focus" ? "Gaussian (out of focus / distance)" : "straight motion streak", size_px_at_zoom: unblurUsed.size, angle_deg: unblurUsed.kind === "motion" ? unblurUsed.angle : null, iterations: unblurUsed.iterations, kernel_basis: unblurBasis(unblurUsed), uncertainty: "partial sharpening only; character accuracy not guaranteed" },
      contrast: "stretch 1st-99th percentile (makes faint-but-present edges visible; does not reveal absent detail)", sharpen_amount: +amount.value, sharpen_note: "cosmetic only; not recovery", grayscale: gray.checked,
      color_channel: C.channel === "lum" ? "all colors (luminance)" : C.channel, channel_check: C.chan,
      stacking: stack, operation_labels: L, assessment: C.assess };
    C.combined = enhance(deblurred, +amount.value, gray.checked);
    C.bestEnh = enhance(deblurredBest, +amount.value, gray.checked);
    imgComb.src = canvasFromData(C.combined).toDataURL();
    imgBest.src = canvasFromData(C.bestEnh).toDataURL();
  };
  const applyUnblur = async () => {
    const o = ubOpt(); ubBtn.disabled = true;
    if (o.kind === "off") { deblurred = C.combinedRaw; deblurredBest = C.best.img; unblurUsed = null; ubStatus.textContent = "Unblur is off."; }
    else {
      ubStatus.textContent = "Unblurring… (this can take a few seconds)"; busy("Unblurring… (this can take a few seconds)", null);
      await tick(); await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      deblurred = richardsonLucy(C.combinedRaw, o); deblurredBest = richardsonLucy(C.best.img, o); unblurUsed = o;
      ubStatus.textContent = `Unblur applied in ${((performance.now() - t0) / 1000).toFixed(1)} s. Blur shape ${unblurBasis(o)}. Result is uncertain: compare with the single frame; if edges ring or look doubled, lower the blur size or rounds.`;
      logStep("unblur", { kind: o.kind, size_px_at_zoom: o.size, angle: o.kind === "motion" ? o.angle : null, iterations: o.iterations, kernel_basis: unblurBasis(o) });
    }
    reassess(); paint(); busy(null); ubBtn.disabled = false;
  };
  const ubBtn = h("button", { class: "ghost", onclick: applyUnblur }, "Apply unblur");
  [ub.kind, ub.size, ub.angle, ub.iter].forEach((el) => el.addEventListener("input", ubLabel));
  ubLabel();
  amount.addEventListener("input", paint); gray.addEventListener("change", paint);
  chanSel.addEventListener("change", () => { C.channel = chanSel.value; logStep("color_channel", { channel: C.channel }); reassess(); paint(); });
  reassess(); paint();
  const next = h("button", { onclick: () => { C.params.assessment = C.assess; logStep("combined", C.params); logStep("recovery_assessment", { ...C.assess, method: undefined, operations: C.assess.operations }); readStep(stage); } }, "Next: read the plate");
  stage.replaceChildren(stepsBar(3), h("h2", {}, "Combine and enhance"),
    h("p", { class: "small muted" }, `${used.length} lined-up frames combined automatically at ${upNow()}× zoom${C.farMode ? " (sharper frames count more)" : ""}. Each frame is evened out to the same white and black, and glare-blown or pitch-black spots are skipped frame by frame. ${C.smart.frames.filter((f) => f.blown_out_pct > 5).length} frame(s) had glare. Combining lowers noise; it doesn't invent detail.`),
    note(L.stacking), note(L.contrast),
    h("div", { class: "result-imgs" }, h("figure", { style: "margin:0" }, imgBest, h("figcaption", { class: "small muted" }, "Clearest single frame")),
      h("figure", { style: "margin:0" }, imgComb, h("figcaption", { class: "small muted" }, `Combined (${stack.genuine_frames} genuine frames)`)),
      h("figure", { style: "margin:0" }, h("img", { alt: "Coverage map", src: canvasFromData(C.smart.map).toDataURL() }),
        h("figcaption", { class: "small muted" }, `Coverage: brighter green = more frames recorded that spot well. Red = no frame did (${C.smart.nodata_pct}% of the plate); it is left as recorded, not filled in.`))),
    h("div", { class: "row", style: "margin-top:10px" }, h("label", {}, "Sharpen (cosmetic)", amount), h("label", { style: "display:flex;gap:8px;align-items:center" }, gray, "Black & white")),
    note(L.sharpen),
    h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Color channels"),
      h("label", {}, "Use for black & white", chanSel), h("p", { class: "small" }, C.chan.note),
      h("p", { class: "small muted" }, `Red ${C.chan.channels[0].contrast} contrast, ${C.chan.channels[0].clipped_pct}% glare · Green ${C.chan.channels[1].contrast}, ${C.chan.channels[1].clipped_pct}% · Blue ${C.chan.channels[2].contrast}, ${C.chan.channels[2].clipped_pct}%`),
      note(L.channels)),
    h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Unblur"),
      h("p", { class: "small muted" }, "Reverses blur with a published math method (Richardson–Lucy). It does not guess letters or draw anything in." + (sigmaZoom ? ` The blur size starts at the value measured from this footage's edges (${sigmaZoom.toFixed(1)} px at zoom).` : " No reliable blur measurement was possible, so any setting is the examiner's choice.")),
      note(L.deconvolution),
      h("div", { class: "row" }, h("label", {}, "Kind of blur", ub.kind), h("label", {}, "Blur size", ub.size), ubAngleRow, h("label", {}, "Rounds", ub.iter)),
      h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px" }, ubBtn, ubInfo), ubStatus),
    h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Recovery check"),
      h("p", { class: "small muted" }, "Measured on the combined recording before unblur and sharpening, so processing can't make it look better than the footage is. Goes into the report."), assessBox),
    h("div", { style: "margin-top:12px" }, next));
  stage.scrollIntoView({ block: "start" });
}


// ---------- reflection search ----------
// Looks across whole frames for a second view of the plate: mirrored (shop window, shiny paint),
// upside down (puddle, wet road), smaller or larger. Only reports places that match the marked plate;
// a person must confirm each one by eye.
async function grabFullFrames(max) {
  const isVideo = C.kind === "video", out = [];
  const W = isVideo ? C.video.videoWidth : C.images[0].width, H = isVideo ? C.video.videoHeight : C.images[0].height;
  const keys = isVideo ? [C.refTime, ...C.frames.filter((f) => f.use).map((f) => f.key)] : C.images.map((_, i) => i);
  const seen = new Set();
  for (const k of keys) {
    const id = isVideo ? k.toFixed(2) : k; if (seen.has(id)) continue; seen.add(id);
    const c = canvasOf(W, H), x = c.getContext("2d");
    if (isVideo) { await seekTo(C.video, k); x.drawImage(C.video, 0, 0); } else x.drawImage(C.images[k], 0, 0);
    out.push({ at: isVideo ? +k.toFixed(3) : C.files[k].name, canvas: c });
    if (out.length >= max) break;
  }
  return out;
}
function grayOf(canvas, w, hgt) {
  const c = canvasOf(w, hgt), x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(canvas, 0, 0, w, hgt);
  return grayRegion(x, 0, 0, w, hgt);
}
async function reflectionSearch(onProgress) {
  const frames = await grabFullFrames(2), b = C.box;
  const W = frames[0].canvas.width, H = frames[0].canvas.height, f = Math.min(1, 640 / W), sw = Math.round(W * f), sh = Math.round(H * f);
  const ref = frames[0].canvas, flips = [["as is", 1, 1], ["mirrored left-right", -1, 1], ["upside down", 1, -1], ["mirrored and upside down", -1, -1]];
  const soft = (g, w, hh) => boxBlur(boxBlur(g, w, hh, 1), w, hh, 1);   // a little softening so near-miss sizes still match on the first pass
  const makeTpl = (s, fx, fy, blur) => {
    const tw = Math.round(b.w * f * s), th = Math.round(b.h * f * s), c = canvasOf(tw, th), x = c.getContext("2d");
    x.translate(fx < 0 ? tw : 0, fy < 0 ? th : 0); x.scale(fx, fy); x.imageSmoothingQuality = "high"; x.drawImage(ref, b.x, b.y, b.w, b.h, 0, 0, tw, th);
    const g = grayRegion(c.getContext("2d"), 0, 0, tw, th);
    return { tw, th, g: blur ? soft(g, tw, th) : g };
  };
  const scales = [];
  for (let s = 0.25; s <= 2.01; s *= 1.22) if (b.w * f * s >= 14 && b.h * f * s >= 6 && b.w * f * s < sw * 0.6) scales.push(+s.toFixed(3));
  const hits = []; let done = 0;
  const total = frames.length * scales.length * flips.length;
  for (const fr of frames) {
    const g = grayOf(fr.canvas, sw, sh), gs = soft(g, sw, sh);
    for (const s of scales) for (const [name, fx, fy] of flips) {
      const t = makeTpl(s, fx, fy, true), st = t.tw * t.th > 600 ? 2 : 1, found = [];
      for (let y = 0; y + t.th <= sh; y += 2) for (let x = 0; x + t.tw <= sw; x += 2) {
        const v = nccAt(t.g, t.tw, t.th, gs, sw, x, y, st);
        if (v >= 0.6) found.push({ x, y, v });
      }
      found.sort((p, q) => q.v - p.v);
      for (const p of found.slice(0, 8)) {
        // second pass, unsoftened: try nearby sizes and every pixel around the spot
        let best = { v: -1 };
        for (const s2 of [s * 0.9, s * 0.94, s * 0.97, s, s * 1.03, s * 1.06, s * 1.1]) {
          const t2 = makeTpl(s2, fx, fy, false);
          for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const x = p.x + dx, y = p.y + dy; if (x < 0 || y < 0 || x + t2.tw > sw || y + t2.th > sh) continue;
            const v = nccAt(t2.g, t2.tw, t2.th, g, sw, x, y, 1); if (v > best.v) best = { x, y, v, tw: t2.tw, th: t2.th, s: s2 };
          }
        }
        if (best.v < 0.6) continue;
        const box = { x: Math.round(best.x / f), y: Math.round(best.y / f), w: Math.round(best.tw / f), h: Math.round(best.th / f) };
        const ov = Math.max(0, Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x)) * Math.max(0, Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y));
        if (ov > 0.2 * Math.min(box.w * box.h, b.w * b.h)) continue;          // that's the plate itself
        hits.push({ at: fr.at, frame: fr, box, match: +best.v.toFixed(3), view: name, scale: +best.s.toFixed(2), fx, fy });
      }
      onProgress(++done / total); if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  hits.sort((p, q) => q.match - p.match);
  const keep = [];
  for (const h1 of hits) {
    if (keep.some((k) => k.at === h1.at && Math.abs(k.box.x - h1.box.x) < h1.box.w * 0.6 && Math.abs(k.box.y - h1.box.y) < h1.box.h * 0.6)) continue;
    keep.push(h1); if (keep.length >= 6) break;
  }
  return keep.map((k, i) => {
    const up = Math.max(1, Math.round(160 / k.box.w)), c = canvasOf(k.box.w * up, k.box.h * up), x = c.getContext("2d");
    x.imageSmoothingEnabled = false;
    x.translate(k.fx < 0 ? c.width : 0, k.fy < 0 ? c.height : 0); x.scale(k.fx, k.fy);       // turn it back to normal reading direction
    x.drawImage(k.frame.canvas, k.box.x, k.box.y, k.box.w, k.box.h, 0, 0, c.width, c.height);
    return { n: i + 1, at: k.at, box: k.box, match: k.match, view: k.view, size_vs_plate: k.scale, crop: c };
  });
}

// ---------- step 4: read the plate ----------
// Standard passenger layouts. Vanity, specialty, dealer and older plates differ: use "Custom" or "Any" for those.
const FORMATS = {
  any: { label: "Any state / unknown", pattern: [] },
  tx: { label: "Texas passenger (ABC1234, no vowels or Q)", pattern: ["LLLNNNN"] },
  ca: { label: "California passenger (1ABC234)", pattern: ["NLLLNNN"] },
  l3n4: { label: "ABC1234: AZ, GA, MI, NY, NC, OH, PA, VA, WA and others", pattern: ["LLLNNNN"] },
  md: { label: "1AB2345: Maryland", pattern: ["NLLNNNN"] },
  il: { label: "AB12345: Illinois", pattern: ["LLNNNNN"] },
  nj: { label: "A12BCD: New Jersey", pattern: ["LNNLLL"] },
  l3n3: { label: "ABC123: many states", pattern: ["LLLNNN"] },
  n3l3: { label: "123ABC: many older plates", pattern: ["NNNLLL"] },
  common: { label: "Try all of the layouts above", pattern: ["LLLNNNN", "NLLLNNN", "NLLNNNN", "LLNNNNN", "LNNLLL", "LLLNNN", "NNNLLL"] },
  custom: { label: "Custom pattern (L = letter, N = number)", pattern: [] },
};
const patternsFor = (fmt, custom) => fmt === "custom" ? [String(custom || "").toUpperCase().replace(/[^LN]/g, "")].filter(Boolean) : FORMATS[fmt].pattern;
const NO_IOQ = /[IOQ]/;
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

function fitFormat(cands, fmt, customPattern, noIOQ) {
  const pats = patternsFor(fmt, customPattern);
  if (!pats.length) return cands.filter((c) => !noIOQ || !NO_IOQ.test(c.plate)).map((c) => ({ ...c, note: "" }));
  const res = [];
  for (const c of cands) for (const pattern of pats) {
    if (c.plate.length !== pattern.length) continue;
    let s = "", changed = 0, ok = true;
    [...c.plate].forEach((ch, i) => {
      const want = pattern[i];
      if (want === "L" && /[0-9]/.test(ch)) { if (TO_LETTER[ch]) { s += TO_LETTER[ch]; changed++; } else ok = false; }
      else if (want === "N" && /[A-Z]/.test(ch)) { if (TO_DIGIT[ch]) { s += TO_DIGIT[ch]; changed++; } else ok = false; }
      else s += ch;
    });
    if (ok && noIOQ && [...s].some((ch, i) => pattern[i] === "L" && NO_IOQ.test(ch))) ok = false;
    if (ok) res.push({ ...c, plate: s, agreement: c.agreement * Math.pow(0.85, changed), note: (changed ? `adjusted ${changed} look-alike character${changed > 1 ? "s" : ""} to fit` : "fits") + (pats.length > 1 ? ` ${pattern}` : " format") });
  }
  return res;
}

// ---------- partial-plate search list ----------
// Every plate that fits the known characters and the layout, ranked by how often the reader saw each character in each spot.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", DIGITS = "0123456789";
function partialList(maskStr, fmt, customPattern, noIOQ, reads) {
  const mask = maskStr.toUpperCase().replace(/[^A-Z0-9?]/g, "");
  if (!mask.includes("?")) return null;
  const L = mask.length;
  let pats = patternsFor(fmt, customPattern).filter((p) => p.length === L);
  if (!patternsFor(fmt, customPattern).length) pats = [""];
  if (!pats.length) return { mask, total: 0, list: [], error: `None of the chosen layouts has ${L} characters. Check the known characters or pick another layout.` };
  const group = reads.filter((r) => r.text.length === L);
  const out = new Map(); let total = 0, ranked = true;
  for (const pat of pats) {
    let okMask = true;
    const opts = [...mask].map((ch, i) => {
      const want = pat[i] || "";
      let pool = want === "L" ? LETTERS : want === "N" ? DIGITS : LETTERS + DIGITS;
      if (noIOQ && want === "L") pool = pool.replace(/[IOQ]/g, "");
      if (fmt === "tx" && want === "L") pool = pool.replace(/[AEIOUQ]/g, "");   // Texas general issue: no vowels, no Q
      if (ch !== "?") { if (!pool.includes(ch)) okMask = false; return [[ch, 1]]; }
      const votes = {}; let sum = 0;
      group.forEach((r) => {
        let c = r.text[i];
        if (want === "L" && DIGITS.includes(c)) c = TO_LETTER[c] || c;
        if (want === "N" && LETTERS.includes(c)) c = TO_DIGIT[c] || c;
        const w = 0.2 + r.conf / 100; if (pool.includes(c)) { votes[c] = (votes[c] || 0) + w; sum += w; }
      });
      return [...pool].map((c) => [c, ((votes[c] || 0) + 0.05) / (sum + 0.05 * pool.length)]).sort((a, b) => b[1] - a[1]);
    });
    if (!okMask) continue;
    const count = opts.reduce((n, o) => n * o.length, 1); total += count;
    const keep = count <= 200000 ? Infinity : 20000; if (keep !== Infinity) ranked = false;
    let beam = [["", 1]];
    opts.forEach((o) => { beam = beam.flatMap(([s, p]) => o.map(([c, q]) => [s + c, p * q])); if (beam.length > keep) beam = beam.sort((a, b) => b[1] - a[1]).slice(0, keep); });
    beam.forEach(([s, p]) => { if (!out.has(s) || out.get(s) < p) out.set(s, p); });
  }
  const list = [...out.entries()].sort((a, b) => b[1] - a[1]).map(([plate, p]) => ({ plate, score: p }));
  const top = list[0]?.score || 1;
  return { mask, layouts: pats.filter(Boolean), total, complete: ranked, read_versions_used: group.length,
    list: list.slice(0, 20000).map((x) => ({ plate: x.plate, rank_score: Math.round((x.score / top) * 1000) / 10 })) };
}
function partialCsv(pl) {
  return "rank,plate,relative_score\n" + pl.list.map((x, i) => `${i + 1},${x.plate},${x.rank_score}`).join("\n") + "\n";
}
function downloadText(name, text, type) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
function partialView(pl) {
  if (!pl) return null;
  if (pl.error) return h("p", { class: "error" }, pl.error);
  return h("div", { class: "card", style: "margin-top:12px" },
    h("h3", {}, "Partial-plate search list"),
    h("p", { class: "small muted" }, `${pl.total.toLocaleString()} possible plates fit "${pl.mask}"${pl.layouts.length ? " in layout " + pl.layouts.join(" / ") : ""}. ` +
      (pl.read_versions_used ? `Ranked by what the reader saw in each unknown spot (${pl.read_versions_used} reads of this length).` : "No reads had this length, so the order is alphabetical-equal; add more known characters to shrink the list.") +
      (pl.complete ? "" : ` Too many to list them all, so the top ${pl.list.length.toLocaleString()} are kept; add another known character to get the full list.`)),
    h("p", { class: "small" }, "Run this list against your agency's plate-camera and records systems with the time, place and vehicle description. Every entry is a lead, not an identification."),
    h("div", { class: "chips" }, pl.list.slice(0, 40).map((x, i) => h("span", { class: "chip plate", title: `relative score ${x.rank_score}` }, `${i + 1}. ${x.plate}`))),
    h("button", { class: "ghost", style: "margin-top:8px", onclick: () => { downloadText(`PlateTrace_${C.caseNo.replace(/[^\w-]+/g, "_")}_partial_${pl.mask.replace(/\?/g, "x")}.csv`, partialCsv(pl), "text/csv"); audit("partial_list_download", { mask: pl.mask, rows: pl.list.length }); } },
      `Download the full list (${pl.list.length.toLocaleString()} rows, .csv)`));
}

function readStep(stage) {
  const fmt = h("select", {}, Object.entries(FORMATS).map(([k, f]) => h("option", { value: k }, f.label)));
  const custom = h("input", { placeholder: "e.g. LLLNNNN", style: "display:none" });
  fmt.addEventListener("change", () => (custom.style.display = fmt.value === "custom" ? "" : "none"));
  const mask = h("input", { placeholder: "e.g. 7?K4?2 (optional)" });
  const noIOQ = h("input", { type: "checkbox" });
  const status = h("p", { class: "small muted" });
  const bar = h("i", {});
  const results = h("div", {});
  const next = h("button", { disabled: true, onclick: () => vehicleStep(stage) }, "Next: same vehicle — paint & Print & Pattern ▶");
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
      let cands = fitFormat(buildCandidates(reads, mask.value), fmt.value, custom.value, noIOQ.checked);
      const m = mask.value.toUpperCase().replace(/[^A-Z0-9?]/g, "");
      if (m) cands = cands.filter((c) => c.plate.length === m.length && [...m].every((ch, i) => ch === "?" || ch === c.plate[i]));
      const seen = new Set();
      cands = cands.sort((a, b) => b.agreement - a.agreement).filter((c) => !seen.has(c.plate) && seen.add(c.plate)).slice(0, 10);
      C.reads = reads; C.candidates = cands.map((c) => ({ ...c, agreement: Math.round(c.agreement * 100) }));
      C.readSettings = { format: FORMATS[fmt.value].label, layouts: patternsFor(fmt.value, custom.value), custom_pattern: custom.value || null, mask: m || null, no_I_O_Q: noIOQ.checked };
      C.partial = partialList(m, fmt.value, custom.value, noIOQ.checked, reads);
      if (C.partial && !C.partial.error) logStep("partial_list", { mask: C.partial.mask, possible: C.partial.total, kept: C.partial.list.length, top: C.partial.list.slice(0, 3).map((x) => x.plate) });
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
          h("table", {}, reads.map((r) => h("tr", {}, h("td", { class: "small muted" }, r.source), h("td", { class: "plate", style: "font-size:14px" }, r.text || "—"), h("td", { class: "small muted" }, `${r.conf}%`))))),
        partialView(C.partial) || "");
      next.disabled = false;
    } catch (e) {
      status.className = "small error"; status.textContent = "The plate reader couldn't run: " + (e.message || e);
    }
    go.disabled = false;
  };
  const go = h("button", { onclick: run }, "Read the plate");

  // Match test: compare against real Texas Classic character shapes, blurred like the footage.
  const mStatus = h("p", { class: "small muted" }), mBar = h("i", {}), mOut = h("div", {});
  const mGo = h("button", { class: "ghost", onclick: async () => {
    mGo.disabled = true; mOut.replaceChildren(); mStatus.className = "small muted"; mStatus.textContent = "Comparing against Texas plate shapes… (can take up to a minute on a phone)";
    try {
      const r = await PTMatch.run(C.combinedRaw, {}, (f) => (mBar.style.width = `${Math.round(f * 100)}%`));
      C.match = { ...r, integrity: PTIntegrity.generativeTag({ basis: "re-blurred Texas character shapes scored against the footage" }) };
      logStep("match_test", { result: r.plate, fit: r.fit, blur_sigma_px: r.blur_sigma_px, positions: r.positions.map((p) => `${p.pos}:${p.result} (${p.top.map((t) => t.ch + " " + t.share + "%").join(", ")}; stable ${p.stable})`) });
      const known = r.mask.replace(/\?/g, "").length;
      mStatus.textContent = r.enough_detail ? `Fit with the footage: ${Math.round(r.fit * 100)}%. ${known} of 7 characters passed every check.` : `Fit with the footage is only ${Math.round(r.fit * 100)}%, so no characters are reported. The footage may not hold enough detail, or this may not be a Texas Classic plate.`;
      mOut.replaceChildren(
        h("p", { class: "plate", style: "font-size:28px;letter-spacing:4px;margin:6px 0" }, r.plate),
        h("table", {}, h("tr", {}, h("th", {}, "Spot"), h("th", {}, "Result"), h("th", {}, "Best matches (share)"), h("th", {}, "Stable")),
          r.positions.map((p) => h("tr", {}, h("td", {}, p.pos), h("td", { class: "plate" }, p.result),
            h("td", { class: "small" }, p.top.map((t) => `${t.ch} ${t.share}%`).join(" · ")), h("td", { class: "small muted" }, p.stable)))),
        h("p", { class: "small muted" }, r.rule), h("div", { class: "notice", style: "margin-top:8px" }, PTIntegrity.DISCLAIMER_GENERATIVE),
        known && known < 7 ? h("button", { class: "ghost", style: "margin-top:8px", onclick: () => { fmt.value = "tx"; mask.value = r.mask; run(); } }, `Use ${r.mask} as known characters and build the search list`) : "");
    } catch (e) { mStatus.className = "small error"; mStatus.textContent = "The Match test couldn't run: " + (e.message || e); }
    mGo.disabled = false;
  } }, "Run Match test (Texas Classic)");
  // Lead list: every Texas plate that could have produced this footage, ranked.
  const lStatus = h("p", { class: "small muted" }), lBar = h("i", {}), lOut = h("div", {});
  const leadCsv = (L) => "rank,plate,relative_score\n" + L.list.map((x, i) => `${i + 1},${x.plate},${x.rank_score}`).join("\n") + "\n";
  const lGo = h("button", { class: "ghost", onclick: async () => {
    lGo.disabled = true; lOut.replaceChildren(); lStatus.className = "small muted"; lStatus.textContent = "Copying the camera's damage onto test plates… (can take a minute or two on a phone)";
    try {
      const L = await PTMatch.leads(C.combinedRaw, { originalHeight: C.combinedRaw.height / upNow() }, (f) => (lBar.style.width = `${Math.round(f * 100)}%`));
      C.leads = { ...L, integrity: PTIntegrity.generativeTag({ basis: "camera damage simulated on candidate plates; ranked by fit" }) };
      logStep("lead_list", { plausible_plates: L.plausible_total, fit: L.fit, kept_per_spot: L.positions.map((p) => `${p.pos}:${p.kept}`), top: L.list.slice(0, 5).map((x) => x.plate) });
      const narrowed = L.positions.some((p) => p.ruled_out);
      lStatus.textContent = narrowed
        ? `${L.plausible_total.toLocaleString()} Texas plates could have produced this footage (out of 80,000,000). Ranked best fit first.`
        : `The fit with the footage is only ${Math.round(L.fit * 100)}%, so no plates are ruled out. The list below is still ranked by fit, but treat the order as weak.`;
      lOut.replaceChildren(
        h("table", {}, h("tr", {}, h("th", {}, "Spot"), h("th", {}, "Still possible"), h("th", {}, "Ruled out")),
          L.positions.map((p) => h("tr", {}, h("td", {}, p.pos), h("td", { class: "plate", style: "font-size:13px" }, p.kept), h("td", { class: "small muted" }, p.ruled_out || "none")))),
        h("div", { class: "chips", style: "margin-top:8px" }, L.list.slice(0, 40).map((x, i) => h("span", { class: "chip plate", title: `relative score ${x.rank_score}` }, `${i + 1}. ${x.plate}`))),
        h("p", { class: "small" }, "Check the top of this list against plate-camera hits near the time and place, and against registrations matching the vehicle (step 5). Every entry is a lead, not an identification."), h("div", { class: "notice", style: "margin-top:8px" }, PTIntegrity.DISCLAIMER_GENERATIVE),
        h("button", { class: "ghost", style: "margin-top:8px", onclick: () => { downloadText(`PlateTrace_${C.caseNo.replace(/[^\w-]+/g, "_")}_lead_list.csv`, leadCsv(L), "text/csv"); audit("lead_list_download", { rows: L.list.length }); } },
          `Download the ranked list (${L.list.length.toLocaleString()} rows, .csv)`));
    } catch (e) { lStatus.className = "small error"; lStatus.textContent = "The lead list couldn't be built: " + (e.message || e); }
    lGo.disabled = false;
  } }, "Build lead list (Texas Classic)");
  const leadCard = h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Lead list (Texas Classic plates)"),
    h("p", { class: "small muted" }, "For footage too poor to read. PlateTrace copies the camera's damage (low resolution, blur, glare) onto every possible Texas plate and keeps the ones that could have produced this image, best fit first. It never rules a plate out unless the footage clearly contradicts it."),
    lGo, h("div", { class: "progress" }, lBar), lStatus, lOut);
  const rStatus = h("p", { class: "small muted" }), rBar = h("i", {}), rOut = h("div", {});
  const rGo = h("button", { class: "ghost", onclick: async () => {
    rGo.disabled = true; rOut.replaceChildren(); rStatus.className = "small muted"; rStatus.textContent = "Searching the whole picture for another view of the plate…";
    try {
      const R = await reflectionSearch((f) => (rBar.style.width = `${Math.round(f * 100)}%`));
      C.reflections = R;
      logStep("reflection_search", { method: "normalized cross-correlation of the marked plate (as is, mirrored, upside down; 6 sizes) across whole frames", found: R.map((r) => ({ n: r.n, frame: r.at, box: r.box, match: r.match, view: r.view })) });
      rStatus.textContent = R.length ? `Found ${R.length} place(s) that look like the plate. They're turned back to normal reading direction below. Check each by eye: it may be a reflection, or just another plate or sign.` : "No second view of the plate was found in these frames.";
      rOut.replaceChildren(h("div", { class: "result-imgs" }, R.map((r) => h("figure", { style: "margin:0" }, r.crop,
        h("figcaption", { class: "small muted" }, `#${r.n} · ${r.view} · ${Math.round(r.match * 100)}% match · ${typeof r.at === "number" ? r.at + " s" : r.at} · at ${r.box.x},${r.box.y}`)))));
    } catch (e) { rStatus.className = "small error"; rStatus.textContent = "The reflection search couldn't run: " + (e.message || e); }
    rGo.disabled = false;
  } }, "Search for reflections");
  const reflCard = h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Reflections"),
    h("p", { class: "small muted" }, "Looks across the whole picture for another view of the same plate: mirrored in a window or shiny paint, upside down in a puddle, smaller or bigger. Any hit must be checked by eye."),
    rGo, h("div", { class: "progress" }, rBar), rStatus, rOut);
  const matchCard = h("div", { class: "card", style: "margin-top:12px" }, h("h3", { style: "margin-top:0" }, "Match test (Texas Classic plates)"),
    h("p", { class: "small muted" }, "Compares the combined image against real Texas plate letters and numbers, blurred to match the footage. It doesn't guess: a spot shows ? unless one character clearly wins and keeps winning when the fit is re-run. For the white Texas Classic plate (ABC-1234 with the Texas outline) only."),
    mGo, h("div", { class: "progress" }, mBar), mStatus, mOut);
  stage.replaceChildren(stepsBar(4), h("h2", {}, "Read the plate"),
    h("div", { class: "row" }, h("label", {}, "State / plate layout", fmt, custom), h("label", {}, "Known characters (? = unknown)", mask)),
    h("label", { class: "small", style: "display:flex;gap:8px;align-items:center;margin-top:6px" }, noIOQ, "This state doesn't issue the letters I, O or Q (many don't; check yours). Removes them from the guesses."),
    h("p", { class: "small muted" }, "Tip: type the characters you can see and put ? for the ones you can't (e.g. 7?K4?2). PlateTrace then lists every plate that fits, ranked."),
    h("div", { style: "margin-top:10px" }, go), h("div", { class: "progress" }, bar), status, results, matchCard, leadCard, reflCard, h("div", { style: "margin-top:12px" }, next));
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

// ---------- court-ready report (PDF) ----------
const pdfSafe = (t) => String(t ?? "").replace(/[\u2192]/g, "->").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, "...")
  .replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2022]/g, "?");
async function buildReportPdf(report, images) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(`PlateTrace examination report, case ${report.case_no}`); doc.setAuthor(pdfSafe(report.examiner)); doc.setCreator(VERSION);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), mono = await doc.embedFont(StandardFonts.Courier);
  const W = 612, H = 792, M = 54, TW = W - 2 * M;
  let page, y;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (hgt) => { if (y - hgt < M + 20) newPage(); };
  const wrap = (text, f, size, width) => {
    const out = [];
    pdfSafe(text).split("\n").forEach((para) => {
      let line = "";
      para.split(/(\s+)/).forEach((w) => {
        const t = line + w;
        if (f.widthOfTextAtSize(t, size) > width && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
        else line = t;
        while (f.widthOfTextAtSize(line, size) > width) { let k = line.length - 1; while (k > 1 && f.widthOfTextAtSize(line.slice(0, k), size) > width) k--; out.push(line.slice(0, k)); line = line.slice(k); }
      });
      out.push(line.trimEnd());
    });
    return out;
  };
  const text = (t, { f = font, size = 10, color = rgb(0.1, 0.1, 0.12), indent = 0, gap = 3 } = {}) => {
    for (const ln of wrap(t, f, size, TW - indent)) { need(size + gap); page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color }); y -= size + gap; }
  };
  const heading = (t) => { need(80); y -= 10; page.drawText(pdfSafe(t), { x: M, y: y - 13, size: 13, font: bold, color: rgb(0.05, 0.2, 0.45) }); y -= 18;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: rgb(0.7, 0.75, 0.82) }); y -= 8; };
  const kv = (k, v) => { need(14); page.drawText(pdfSafe(k), { x: M, y: y - 10, size: 10, font: bold }); const lines = wrap(v, font, 10, TW - 140);
    lines.forEach((ln, i) => { if (i) need(13); page.drawText(ln, { x: M + 140, y: y - 10, size: 10, font }); y -= 13; }); };
  const table = (cols, rows, widths, size = 9) => {
    const row = (cells, f) => {
      const wrapped = cells.map((c, i) => wrap(c, f === bold ? bold : (cols[i].mono ? mono : font), size, widths[i] - 6));
      const hgt = Math.max(...wrapped.map((w) => w.length)) * (size + 2) + 4; need(hgt);
      let x = M; wrapped.forEach((w, i) => { w.forEach((ln, j) => page.drawText(ln, { x: x + 3, y: y - size - 2 - j * (size + 2), size, font: f === bold ? bold : (cols[i].mono ? mono : font) })); x += widths[i]; });
      y -= hgt; page.drawLine({ start: { x: M, y }, end: { x: M + widths.reduce((a, b) => a + b, 0), y }, thickness: 0.3, color: rgb(0.8, 0.8, 0.85) });
    };
    row(cols.map((c) => c.label), bold); rows.forEach((r) => row(r.map(String), font));
  };
  const image = async (title, bytes, maxH = 260) => {
    const img = await doc.embedPng(bytes); const sc = Math.min(TW / img.width, maxH / img.height, 3);
    const w = img.width * sc, hgt = img.height * sc; need(hgt + 30);
    page.drawText(pdfSafe(title), { x: M, y: y - 10, size: 10, font: bold }); y -= 16;
    page.drawImage(img, { x: M, y: y - hgt, width: w, height: hgt }); page.drawRectangle({ x: M, y: y - hgt, width: w, height: hgt, borderWidth: 0.5, borderColor: rgb(0.5, 0.5, 0.55) }); y -= hgt + 12;
  };

  newPage();
  page.drawText("PlateTrace Examination Report", { x: M, y: y - 20, size: 20, font: bold, color: rgb(0.05, 0.2, 0.45) }); y -= 30;
  text("Video and image enhancement and candidate plate reading. Investigative leads only; not an identification.", { size: 10, color: rgb(0.35, 0.35, 0.4) }); y -= 6;
  kv("Case number", report.case_no); kv("Examiner", report.examiner); kv("Signed-in account", report.user); kv("Agency", report.agency || "-");
  kv("Report generated", report.generated_at); kv("Tool and version", report.tool);

  heading("1. Summary");
  const used = report.frames.length, top = report.candidates.slice(0, 3);
  text(`${report.originals.length} original file(s) were examined. ${used} frame(s) showing the license plate were lined up with each other and averaged into one combined image, which was then sharpened. ` +
    `The plate reader read ${report.reads.length} versions of the plate (combined and single frames, normal and black/white) and the reads were combined character by character.` +
    (top.length ? ` The leading candidates are ${top.map((c) => `${c.plate} (${c.agreement}% agreement)`).join(", ")}.` : " No candidate fit the chosen plate layout.") +
    (report.partial_list && !report.partial_list.error ? ` A partial-plate search list for "${report.partial_list.mask}" contains ${report.partial_list.total.toLocaleString()} possible plates; the top entries are listed in section 5.` : "") +
    (report.vehicle ? " The back of the vehicle was also combined and its paint and distinguishing marks were documented (section 6)." : ""));
  const RA = report.recovery_assessment?.combined_image;
  if (RA) {
    y -= 4; text(`Recovery check: ${RA.evidence_grade ? "EVIDENCE-GRADE ENHANCEMENT" : "NOT EVIDENCE-GRADE"}. Detail survived the blur: ${RA.signal_present ? "yes" : "no"}. Blur radius ${RA.blur_radius_est ?? "not measurable"} px vs character stroke ${RA.stroke_width_est ?? "not measurable"} px (original pixels). Source type: ${RA.source_type}. Recovery type: ${RA.recovery_type}. Confidence ${Math.round(RA.confidence * 100)}%.`, { size: 10, f: bold });
    RA.failed_checks.forEach((t) => text("- " + t, { size: 9, indent: 8 }));
    RA.flags.forEach((t) => text("- " + t, { size: 9, indent: 8 }));
  }

  heading("2. Original evidence");
  text("Each original file was fingerprinted with SHA-256 before any processing. The originals were never changed or uploaded; all processing ran on the examiner's own device.", { size: 9 });
  table([{ label: "File" }, { label: "Size (bytes)" }, { label: "SHA-256", mono: true }], report.originals.map((o) => [o.name, o.bytes.toLocaleString(), o.sha256]), [150, 70, TW - 220], 8);
  if (report.public_tip?.length) {
    y -= 4; text("Source: submitted by a member of the public through PlateTrace Camera. Each file was fingerprinted (SHA-256) on the submitter's phone at the moment of capture; the fingerprint below is compared with the file examined here.", { size: 8.5 });
    table([{ label: "Tip" }, { label: "Captured" }, { label: "Location" }, { label: "Fingerprint matches" }],
      report.public_tip.map((t, i) => [t.id.slice(0, 8), t.captured_at || "-", t.location ? `${t.location.lat.toFixed(5)}, ${t.location.lng.toFixed(5)} (±${Math.round(t.location.accuracy_m)} m)` : "not shared", report.originals[i] && report.originals[i].sha256 === t.sha256_at_capture ? "yes" : "NO"]), [60, 130, 170, TW - 360], 8);
    const n = report.public_tip.find((t) => t.note)?.note; if (n) text(`Submitter's note: "${n}"`, { size: 8.5 });
  }

  if (report.provenance?.length) {
    y -= 4; text("Provenance (facts read from each file; nothing inferred beyond the stated rule):", { size: 9, f: bold });
    table([{ label: "File" }, { label: "Format / compression" }, { label: "Resolution" }, { label: "Capture record" }, { label: "Source type (rule)" }],
      report.provenance.map((p) => [p.file, [p.container, p.compression, p.jpeg_quality_est != null ? `quality ~${p.jpeg_quality_est}` : null, p.codec].filter(Boolean).join(", "), p.width ? `${p.width} x ${p.height}` : "-",
        p.exif ? Object.entries(p.exif).map(([k, v]) => `${k}: ${v}`).join("; ") : p.platetrace_capture ? `PlateTrace ${p.platetrace_capture.mode || "capture"} ${p.platetrace_capture.at || ""}` : "none", `${p.source_type} (${p.rule})`]), [86, 110, 60, 120, TW - 376], 7.5);
  }
  if (RA) {
    y -= 4; text("Recovery assessment of the combined image:", { size: 9, f: bold });
    table([{ label: "Field" }, { label: "Value" }], [["recovery_type", RA.recovery_type], ["signal_present", String(RA.signal_present)], ["blur_radius_est", String(RA.blur_radius_est)], ["stroke_width_est", String(RA.stroke_width_est)],
      ["source_type", RA.source_type], ["confidence", String(RA.confidence)], ["evidence_grade", String(RA.evidence_grade)], ["edge SNR / noise", `${RA.measurements.edge_snr} / ${RA.measurements.noise_sigma}`],
      ["stacking", RA.stacking ? `${RA.stacking.genuine_frames} genuine of ${RA.stacking.frames_given}; sub-pixel diversity ${RA.stacking.subpixel_shift_diversity}; confidence ${RA.stacking.confidence}` : "-"], ["operations", RA.operations.join("; ") || "none"]], [120, TW - 120], 8);
    text("Method: " + RA.method, { size: 7.5 });
    (report.recovery_assessment.generative_outputs || []).forEach((g) => text(`${g.output}: recovery_type=generative, evidence_grade=false. ${g.disclaimer}`, { size: 8 }));
  }

  heading("3. Method (plain English)");
  [
    `Marking: the examiner drew a box around the plate${report.reference_time_s != null ? ` at ${Number(report.reference_time_s).toFixed(2)} s into the video` : ""}.`,
    "Finding frames: nearby frames were searched for the same plate using normalized cross-correlation (a standard pattern-matching measure). Each frame's sharpness was scored, and blurry or poorly matching frames were left out.",
    "Lining up: each kept frame was shifted, to a fraction of a pixel, so the plate sits in the same place in every frame. The shifts are listed in the case report.",
    `Combining: the lined-up frames were enlarged ${report.processing.detail_factor || UP}x and ${report.processing.far_blurry_mode ? "combined with a sharpness-weighted average (far/blurry mode: every frame showing the plate was used; sharper frames counted more, none were dropped for blur)" : "averaged"}. Before combining, each frame was evened out to its own measured white (plate) and black (letters) levels, and pixels blown out by glare or crushed to black in a frame were left out for that frame only${report.processing.no_data_pct != null ? `; ${report.processing.no_data_pct}% of the plate was not recorded well in any frame and is marked red on the coverage map, left as recorded` : ""}. Combining reduces random noise; it cannot create detail that was not recorded.`,
    ...(report.processing.unblur ? [`Unblur: Richardson-Lucy deconvolution (${report.processing.unblur.blur}, size ${report.processing.unblur.size_px_at_zoom} px at zoom${report.processing.unblur.angle_deg != null ? `, angle ${report.processing.unblur.angle_deg} degrees` : ""}, ${report.processing.unblur.iterations} rounds). This published method mathematically reverses a known blur shape; it does not add or predict detail.`] : []),
    `Enhancing: contrast stretch and unsharp-mask sharpening (amount ${report.processing.sharpen_amount ?? "-"}) were applied. These are standard, reversible adjustments.`,
    ...Object.values(report.processing.operation_labels || {}).map((t) => "Limit - " + t),
    ...(report.processing.unblur ? [`Unblur blur shape: ${report.processing.unblur.kernel_basis}. ${report.processing.unblur.uncertainty}.`] : []),
    `Reading: open-source optical character recognition (Tesseract) read each version. Characters were combined by weighted vote at each position${report.read_settings?.layouts?.length ? `, then fitted to the layout ${report.read_settings.layouts.join(" / ")}` : ""}; look-alike characters (for example 0/O, 8/B) were only swapped where the layout requires it, and every swap is noted.`,
    "No generative AI was used on any image. No pixels were invented, painted in or predicted; every image comes only from the recorded pixels. The Match test and Lead list (if run) are model-based hypotheses, labelled generative, and are never evidence.",
  ].forEach((t) => text("\u2022 " + t, { size: 9.5, indent: 6 }));

  heading("4. Images");
  for (const [title, bytes, mh] of images) await image(title, bytes, mh);

  heading("5. Plate candidates");
  text(`Layout: ${report.read_settings?.format || "-"}. Known characters: ${report.read_settings?.mask || "none"}.${report.read_settings?.no_I_O_Q ? " Letters I, O and Q excluded." : ""}`, { size: 9 });
  if (report.candidates.length) table([{ label: "#" }, { label: "Candidate", mono: true }, { label: "Agreement" }, { label: "Notes" }],
    report.candidates.map((c, i) => [i + 1, c.plate, c.agreement + "%", c.note || ""]), [24, 100, 66, TW - 190]);
  else text("No candidate fit the chosen layout.", { size: 9.5 });
  if (report.partial_list && !report.partial_list.error) {
    y -= 6; text(`Partial-plate search list for "${report.partial_list.mask}": ${report.partial_list.total.toLocaleString()} possible plates${report.partial_list.complete ? "" : " (top " + report.partial_list.list.length.toLocaleString() + " kept)"}. Top 30 shown; the full list is in partial_plate_list.csv.`, { size: 9 });
    const pl = report.partial_list.list.slice(0, 30);
    table([{ label: "Rank" }, { label: "Plate", mono: true }, { label: "Score" }, { label: "Rank" }, { label: "Plate", mono: true }, { label: "Score" }],
      Array.from({ length: Math.ceil(pl.length / 2) }, (_, i) => [i + 1, pl[i].plate, pl[i].rank_score, pl[i + 15] ? i + 16 : "", pl[i + 15]?.plate || "", pl[i + 15]?.rank_score ?? ""]), [40, 90, 54, 40, 90, 54]);
  }
  if (report.match_test) {
    const mt = report.match_test;
    y -= 6; text(`Match test (Texas Classic): ${mt.plate}`, { size: 10, f: bold });
    text(`Method: ${mt.method}. Character shapes: ${mt.templates}. Fit with the footage ${Math.round(mt.fit * 100)}%, estimated blur ${mt.blur_sigma_px} px. ${mt.rule}`, { size: 8.5 });
    text(PTIntegrity.DISCLAIMER_GENERATIVE, { size: 8.5, f: bold });
    table([{ label: "Spot" }, { label: "Result", mono: true }, { label: "Best matches (share)" }, { label: "Stable" }],
      mt.positions.map((p) => [p.pos, p.result, p.top.map((t) => `${t.ch} ${t.share}%`).join(", "), p.stable]), [36, 50, TW - 140, 54], 8.5);
  }
  if (report.lead_list) {
    const L = report.lead_list;
    y -= 6; text(`Lead list (Texas Classic): ${L.plausible_total.toLocaleString()} plates could have produced the footage`, { size: 10, f: bold });
    text(`Method: ${L.method}. ${L.rule} Fit ${Math.round(L.fit * 100)}%. Full ranked list in lead_list.csv.`, { size: 8.5 });
    text(PTIntegrity.DISCLAIMER_GENERATIVE, { size: 8.5, f: bold });
    table([{ label: "Spot" }, { label: "Still possible", mono: true }, { label: "Ruled out", mono: true }], L.positions.map((p) => [p.pos, p.kept, p.ruled_out || "none"]), [36, TW / 2 - 18, TW / 2 - 18], 8.5);
    const t = L.list.slice(0, 30);
    table([{ label: "Rank" }, { label: "Plate", mono: true }, { label: "Score" }, { label: "Rank" }, { label: "Plate", mono: true }, { label: "Score" }],
      Array.from({ length: Math.ceil(t.length / 2) }, (_, i) => [i + 1, t[i].plate, t[i].rank_score, t[i + 15] ? i + 16 : "", t[i + 15]?.plate || "", t[i + 15]?.rank_score ?? ""]), [40, 90, 54, 40, 90, 54]);
  }
  y -= 6; text("All reads (for transparency):", { size: 9, f: bold });
  table([{ label: "Version read" }, { label: "Text", mono: true }, { label: "Reader confidence" }], report.reads.map((r) => [r.source, r.text || "-", r.conf + "%"]), [220, 140, TW - 360], 8.5);

  if (report.vehicle) {
    const v = report.vehicle;
    heading("6. Vehicle details");
    kv("Rear frames combined", String(v.frames_combined ?? "-")); kv("Paint finish noted", v.paint_finish || "not noted");
    if (v.paint_samples?.length) table([{ label: "Sample" }, { label: "Color (corrected)" }, { label: "As recorded" }, { label: "Surface" }, { label: "vs A" }],
      v.paint_samples.map((s) => [s.label, `${s.corrected.name} ${s.corrected.hex}`, s.as_recorded.hex, s.surface?.label || "-", s.difference_from_A != null ? `${s.difference_from_A}${s.possible_panel_mismatch ? " possible mismatched panel" : ""}` : "-"]), [46, 140, 76, 90, TW - 352], 8.5);
    if (v.marks?.length) { y -= 4; text("Distinguishing marks:", { size: 9, f: bold }); v.marks.forEach((m) => text(`${m.n}. ${m.type}${m.note ? ": " + m.note : ""}`, { size: 9, indent: 8 })); }
    if (v.print_pattern?.areas?.length) { y -= 4; text("Print & Pattern scan areas (lighting-corrected color difference from the main body color):", { size: 9, f: bold });
      table([{ label: "Area" }, { label: "Label" }, { label: "Color" }, { label: "Difference" }, { label: "% of rear" }], v.print_pattern.areas.map((a) => [a.n, a.label, `${a.color.name} ${a.color.hex}`, a.difference, a.size_pct]), [40, 150, 130, 70, TW - 390], 8.5); }
  }

  heading(`${report.vehicle ? 7 : 6}. Step-by-step record`);
  table([{ label: "Time (UTC)" }, { label: "Step" }, { label: "Details", mono: true }], report.log.map(({ time, step, ...rest }) => [time.replace("T", " ").replace("Z", ""), step, JSON.stringify(rest)]), [110, 90, TW - 200], 7);

  heading(`${report.vehicle ? 8 : 7}. Output files and fingerprints`);
  table([{ label: "File" }, { label: "SHA-256", mono: true }], report.outputs.map((o) => [o.file, o.sha256]), [190, TW - 190], 7.5);

  heading(`${report.vehicle ? 9 : 8}. Limitations`);
  ["Candidates are investigative leads, not an identification. Confirm any candidate against the original footage and agency records before acting on it.",
   "Agreement percentages show how consistently the reads agreed; they are not a statistical probability that the plate is correct.",
   "Results depend on the recorded detail. If the plate is only a few pixels wide, the true characters may not be recoverable.",
   "For court use, have a certified forensic video analyst review the original footage and this report.",
  ].forEach((t) => text("\u2022 " + t, { size: 9.5, indent: 6 }));
  need(110); y -= 30;
  const sig = (label, x) => { page.drawLine({ start: { x, y }, end: { x: x + 220, y }, thickness: 0.6 }); page.drawText(label, { x, y: y - 12, size: 8.5, font }); };
  sig("Examiner signature / date", M); sig("Reviewed by (forensic video analyst) / date", M + 270);

  const pages = doc.getPages();
  pages.forEach((pg, i) => pg.drawText(pdfSafe(`PlateTrace  |  Case ${report.case_no}  |  Page ${i + 1} of ${pages.length}`), { x: M, y: 28, size: 8, font, color: rgb(0.45, 0.45, 0.5) }));
  return doc.save();
}

// ---------- step 6: case package ----------
function packageStep(stage) {
  const status = h("p", { class: "small muted" });
  const build = async () => {
    go.disabled = true; status.textContent = "Building the case package…";
    const zip = new JSZip();
    const manifest = [];
    const pics = [];
    const add = async (name, canvas, pdfTitle, maxH) => { const blob = await blobOf(canvas); const buf = await blob.arrayBuffer(); manifest.push({ file: name, sha256: await sha256(buf) }); zip.file(name, buf); if (pdfTitle) pics.push([`${pdfTitle} (${name})`, buf, maxH]); };
    await add("combined_enhanced.png", canvasFromData(C.combined), "Combined and enhanced plate", 180);
    await add("combined_raw.png", canvasFromData(C.combinedRaw), "Combined plate, no sharpening", 180);
    for (const r of C.reflections || []) await add(`reflections/reflection_${r.n}.png`, r.crop, `Possible reflection #${r.n} (${r.view}, ${Math.round(r.match * 100)}% match, frame ${r.at}) - must be confirmed by eye`, 120);
    if (C.smart) await add("coverage_map.png", canvasFromData(C.smart.map), "Coverage map (green = recorded well in more frames, red = no frame recorded it well)", 120);
    await add("clearest_single_frame.png", canvasFromData(C.bestEnh), "Clearest single frame, same enhancement", 180);
    const used = C.frames.filter((f) => f.use);
    for (let i = 0; i < used.length; i++) await add(`frames/frame_${String(i + 1).padStart(2, "0")}.png`, canvasFromData(used[i].img));
    if (C.vehicle?.combined) {
      await add("vehicle_rear_combined.png", canvasFromData(C.vehicle.combined));
      await add("vehicle_rear_marked.png", markedRear(), "Back of the vehicle with paint samples and numbered marks", 300);
      if (C.vehicle.scan) {
        const sc = C.vehicle.scan;
        await add("print_pattern/color_difference_map.png", outlinedDiff(sc), "Print & Pattern: color difference map", 260);
        await add("print_pattern/detail_map.png", canvasFromData(sc.detail));
        await add("print_pattern/paint_print.png", sc.printC);
        for (const a of sc.areas) await add(`print_pattern/area_${String(a.n).padStart(2, "0")}.png`, a.crop);
      }
    }
    if (C.leads) { const buf = new TextEncoder().encode("rank,plate,relative_score\n" + C.leads.list.map((x, i) => `${i + 1},${x.plate},${x.rank_score}`).join("\n") + "\n"); manifest.push({ file: "lead_list.csv", sha256: await sha256(buf) }); zip.file("lead_list.csv", buf); }
    if (C.partial && !C.partial.error) { const buf = new TextEncoder().encode(partialCsv(C.partial)); manifest.push({ file: "partial_plate_list.csv", sha256: await sha256(buf) }); zip.file("partial_plate_list.csv", buf); }
    logStep("package_built", { files: manifest.length + 1 });
    const report = {
      tool: VERSION, generated_at: nowIso(), case_no: C.caseNo, examiner: C.examiner, user: S.user.email,
      agency: S.access?.agency || (S.isAdmin ? "PlateTrace admin" : null),
      originals: C.files.map((f) => ({ name: f.name, bytes: f.size, type: f.type, sha256: f.sha256 })),
      plate_box: C.box, reference_time_s: C.refTime ?? null,
      frames: used.map((f, i) => ({ n: i + 1, at: f.at, shift_px: [f.dx, f.dy], match: f.match, sharpness: f.sharp, weight: f.weight ?? 1 })),
      provenance: C.provenance || [], source_type: C.sourceType || null,
      recovery_assessment: C.assess ? { combined_image: C.assess, generative_outputs: [C.match ? { output: "match_test", ...C.match.integrity } : null, C.leads ? { output: "lead_list", ...C.leads.integrity } : null].filter(Boolean) } : null,
      processing: { ...C.params, alignment: "normalized cross-correlation with sub-pixel parabola fit", combining: "mean of aligned frames" },
      read_settings: C.readSettings, reads: C.reads, candidates: C.candidates, match_test: C.match || null,
      public_tip: C.tip || null,
      reflections: (C.reflections || []).map((r) => ({ n: r.n, frame: r.at, box: r.box, match: r.match, view: r.view, size_vs_plate: r.size_vs_plate, image: `reflections/reflection_${r.n}.png` })),
      lead_list: C.leads ? { ...C.leads, list: C.leads.list.slice(0, 200), full_list_file: "lead_list.csv" } : null,
      partial_list: C.partial ? { ...C.partial, list: C.partial.list?.slice(0, 200) || [], full_list_file: C.partial.error ? null : "partial_plate_list.csv" } : null,
      vehicle: C.vehicle ? { rear_box: C.vehicle.box, frames_combined: C.vehicle.frames, paint_finish: C.vehicle.finish || null,
        paint_samples: (C.vehicle.samples || []).map((sm) => ({ label: sm.label, box: sm.box, as_recorded: sm.raw, corrected: sm.corrected, surface: sm.evenness, difference_from_A: sm.delta, possible_panel_mismatch: sm.flag })),
        white_reference_from_plate: C.vehicle.samples?.[0]?.white_reference_from_plate || null, marks: C.vehicle.marks,
        print_pattern: C.vehicle.scan ? { method: "lighting-corrected CIE76 color difference vs main body color; high-pass detail map; 8x4 median color grid",
          reference_lab: C.vehicle.scan.reference_lab, paint_print: C.vehicle.scan.cells,
          areas: C.vehicle.scan.areas.map((a) => ({ n: a.n, box: a.box, label: a.label, color: a.color, difference: a.difference, size_pct: a.size_pct, image: `print_pattern/area_${String(a.n).padStart(2, "0")}.png` })) } : null } : null,
      outputs: manifest, log: C.log,
      notice: "Candidates are investigative leads, not identification. Verify against the original footage and agency records. Image enhancement only rescales, averages and deconvolves recorded pixels; no generative AI was used on any image. The Match test and Lead list are model-based hypotheses (recovery_type: generative), carry the generative disclaimer and are never evidence-grade.",
    };
    let pdfBytes = null;
    try {
      status.textContent = "Writing the court report (PDF)…";
      const pdfReport = { ...report, partial_list: C.partial || null };
      pdfBytes = await buildReportPdf(pdfReport, pics);
      zip.file("PlateTrace_report.pdf", pdfBytes);
      report.report_pdf = { file: "PlateTrace_report.pdf", sha256: await sha256(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)) };
      lastPdf = pdfBytes;
    } catch (e) { report.report_pdf = { error: String(e.message || e) }; }
    zip.file("case_report.json", JSON.stringify(report, null, 2));
    zip.file("README.txt", [
      `PlateTrace case package — case ${C.caseNo}`, `Generated ${report.generated_at} by ${C.examiner} (${S.user.email})`, "",
      "PlateTrace_report.pdf  court-ready report: summary, method in plain English, images, candidates, full step record, fingerprints, signature lines",
      "case_report.json  every step, setting, frame shift, read and candidate, plus SHA-256 fingerprints",
      ...(C.partial && !C.partial.error ? [`partial_plate_list.csv  every plate fitting "${C.partial.mask}", ranked (${C.partial.list.length} rows)`] : []),
      "combined_enhanced.png / combined_raw.png  the lined-up frames averaged together",
      "clearest_single_frame.png  the sharpest single frame, same enhancement",
      "frames/  each lined-up frame used",
      "vehicle_rear_combined.png / vehicle_rear_marked.png  the back of the vehicle, combined, with numbered marks", "",
      ...(C.vehicle?.samples?.length ? [`Paint finish/pattern: ${C.vehicle.finish || "not noted"}`, ...C.vehicle.samples.map((sm) => `  Sample ${sm.label}: ${sm.corrected.name} ${sm.corrected.hex} (as recorded ${sm.raw.hex}), surface ${sm.evenness.label}${sm.flag ? `, ${sm.delta} different from A: possible repainted/replaced panel` : ""}`)] : []),
      ...(C.vehicle?.scan ? ["Print & Pattern scan: print_pattern/ (difference map, detail map, paint print, area photos)", ...C.vehicle.scan.areas.map((a) => `  Area ${a.n}: ${a.label}, ${a.color.name} ${a.color.hex}, difference ${a.difference}, ${a.size_pct}% of rear`)] : []),
      ...(C.vehicle?.marks?.length ? ["Distinguishing marks:", ...C.vehicle.marks.map((m) => `  ${m.n}. ${m.type}${m.note ? " — " + m.note : ""}`)] : []), "",
      ...(C.assess ? [`Recovery check: signal_present=${C.assess.signal_present}, evidence_grade=${C.assess.evidence_grade}, recovery_type=${C.assess.recovery_type}, source_type=${C.assess.source_type}, blur ${C.assess.blur_radius_est ?? "?"} px vs stroke ${C.assess.stroke_width_est ?? "?"} px, confidence ${Math.round(C.assess.confidence * 100)}%`, ""] : []),
      "Top candidates:", ...C.candidates.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.plate}  ${c.agreement}%  ${c.note || ""}`), "",
      "To verify an image: compute its SHA-256 and compare it to case_report.json → outputs.",
      "Original footage fingerprints are in case_report.json → originals.", "",
      report.notice,
    ].join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `PlateTrace_${C.caseNo.replace(/[^\w-]+/g, "_")}_${nowIso().slice(0, 10)}.zip` });
    document.body.append(a); a.click(); a.remove();
    await audit("export", { frames: used.length, top: C.candidates.slice(0, 3).map((c) => c.plate) });
    status.className = "small ok"; status.textContent = "Case package downloaded (includes the PDF report). This export was recorded in the audit log.";
    if (!pdfBytes) { status.className = "small error"; status.textContent = "Case package downloaded, but the PDF report couldn't be made: " + report.report_pdf.error; }
    go.disabled = false; pdfBtn.disabled = !pdfBytes;
  };
  let lastPdf = null;
  const pdfBtn = h("button", { class: "ghost", disabled: true, style: "margin-left:8px", onclick: () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([lastPdf], { type: "application/pdf" })), download: `PlateTrace_${C.caseNo.replace(/[^\w-]+/g, "_")}_report.pdf` });
    document.body.append(a); a.click(); a.remove(); audit("report_pdf_download", {});
  } }, "Download the PDF report alone");
  const go = h("button", { onclick: build }, "Download case package (.zip)");
  stage.replaceChildren(stepsBar(6), h("h2", {}, "Case package"),
    h("p", { class: "small muted" }, "One zip with the court-ready PDF report, the enhanced images, every frame used, the candidate list and a full record with SHA-256 fingerprints, ready to hand to your forensic video unit or to load into Amped FIVE or iNPUT-ACE."),
    h("div", {}, go, pdfBtn), status,
    h("h3", {}, "Next steps for the investigation"),
    h("ol", { class: "small" },
      h("li", {}, "Run the top candidates through your agency's plate-camera network (Flock, Vigilant) with the time, place and vehicle description."),
      h("li", {}, "For court, have a certified forensic video analyst review the original footage and this package."),
      h("li", {}, "Keep the original footage unchanged; its SHA-256 is in the report.")),
    h("button", { class: "ghost", style: "margin-top:8px", onclick: () => vehicleStep(stage) }, "◀ Back to vehicle details"));
}

boot();
