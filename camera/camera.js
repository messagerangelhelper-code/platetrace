/* PlateTrace Camera: a free camera for the public that takes plate-friendly photos and videos
   and sends them to PlateTrace. Each file is fingerprinted (SHA-256) the moment it is captured,
   with the time and, if allowed, the GPS location. Sending is anonymous unless the person adds
   contact details. Files go to PlateTrace's private storage; the public can't see anyone's tips. */
"use strict";

const SB_URL = "https://wbugdujmydwmzemccbiy.supabase.co";
const SB_KEY = "sb_publishable_4RYit1aVs5Egh3gJsx2bJA_m6Kje0ES";
const BUCKET = "platetrace-tips";
const SB_LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
const MAX_VIDEO_S = 60, MAX_BYTES = 48 * 1024 * 1024;
// The sending library loads in the background after the camera is open, so it never slows the camera down.
let sbP = null;
function getSb() {
  if (sbP) return sbP;
  sbP = new Promise((res) => {
    const make = () => (window.supabase ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, storageKey: "pt-cam-auth", detectSessionInUrl: true } }) : null);
    if (window.supabase) return res(make());
    const el = document.createElement("script"); el.src = SB_LIB; el.async = true;
    el.onload = () => res(make()); el.onerror = () => { sbP = null; res(null); };
    document.head.append(el);
  });
  return sbP;
}
const $app = document.getElementById("app");

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
async function sha256(blob) {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- location (asked once, only used when sending) ----------
let lastFix = null;
function watchLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((p) => (lastFix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy), at: p.timestamp }),
    () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

// ---------- intro ----------
function intro() {
  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" },
    h("h1", {}, "Plate", h("span", {}, "Trace"), " Camera"),
    h("p", { class: "muted" }, "A free camera that takes clearer pictures of license plates and vehicles, and sends them to PlateTrace to help investigators."),
    h("ul", {},
      h("li", {}, "Fit the plate inside the box and hold the phone still."),
      h("li", {}, "Tap the screen on the plate to focus there."),
      h("li", {}, "Glare on the plate? Tap ", h("b", {}, "Anti-glare"), "."),
      h("li", {}, h("b", {}, "Smart burst"), " saves a ", h("b", {}, "First Shot"), " the moment the camera opens, keeps the sharpest frames while you steady your hands, then takes bonus rounds when you tap. The sharpest 3 go on top."),
      h("li", {}, "Video works best when you can follow the vehicle for a few seconds."),
      h("li", {}, "Hands busy? Tap ", h("b", {}, "🎤 Voice"), " and say \"camera activate\" to start recording, \"camera stop\" to finish. You can also say \"photo\", \"burst\", \"zoom in\" or \"anti-glare\".")),
    h("div", { class: "notice" }, h("b", {}, "Stay safe. "), "Never use the camera while driving, never follow or confront anyone, and only film from public places. In an emergency, call 911 first. Tips sent here are not watched in real time."),
    h("p", { class: "small muted" }, "What you send: the photo or video, the time, and your location if you allow it. Sending is anonymous unless you choose to add contact details. Only PlateTrace staff can see what you send."),
    h("button", { style: "width:100%;margin-top:8px", onclick: () => { askMotion(); store.set("pt_cam_seen", "1"); startCamera(); } }, "Open the camera"),
    introVoice(),
    h("div", { style: "margin-top:10px" }, uploadButton(false)),
    h("p", { class: "small muted", style: "margin-top:14px" }, "Tip: add this page to your home screen to use it like an app."),
    accountLine())));
}
function accountLine() {
  const p = getPass(); if (!p) return null;
  const trial = p.status === "trialing" && p.trial_end ? ` · free trial until ${new Date(p.trial_end * 1000).toLocaleDateString()}` : "";
  return h("p", { class: "small muted", style: "margin-top:14px" }, `${p.email} · ${p.plan}${trial} `, h("a", { href: "#", style: "color:var(--accent)", onclick: (e) => { e.preventDefault(); signOut(); } }, "Sign out"));
}

// Hands-free start: listen for "camera activate", then open the camera and start recording.
function introVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const st = h("p", { class: "small muted", style: "text-align:center" });
  const btn = h("button", { class: "ghost", style: "width:100%;margin-top:10px", onclick: () => {
    const rec = new SR(); rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false;
    st.textContent = 'Listening… say "camera activate".'; btn.disabled = true;
    rec.onresult = (e) => { const said = e.results[e.results.length - 1][0].transcript.toLowerCase();
      if (/camera activ|activate camera/.test(said)) { rec.onend = null; rec.stop(); store.set("pt_cam_seen", "1"); activateOnOpen = true; resumeVoice = true; startCamera(); }
      else st.textContent = `Heard "${said}". Say "camera activate".`; };
    rec.onerror = (e) => { st.textContent = e.error === "not-allowed" ? "Microphone blocked. Allow it in your browser settings." : "Voice stopped. Tap to try again."; btn.disabled = false; };
    rec.onend = () => { btn.disabled = false; };
    try { rec.start(); } catch {}
  } }, "🎤 Start by voice");
  return h("div", {}, btn, st);
}

// ---------- camera ----------
let stream = null, track = null, caps = {}, settings = {}, mode = "photo", antiGlare = false, torchOn = false, recorder = null;
let voiceOn = false, voiceRec = null, resumeVoice = false, activateOnOpen = false;
function stopVoice() { voiceOn = false; const r = voiceRec; voiceRec = null; try { r?.stop(); } catch {} document.querySelectorAll(".topbar button").forEach((b) => { if (b.textContent.includes("Voice")) b.className = "ghost"; }); }

async function openStream() {
  const tries = [
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false },
    { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: true, audio: false },
  ];
  let err;
  for (const c of tries) { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { err = e; } }
  throw err;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $app.replaceChildren(h("div", { class: "screen pad" }, h("p", {}, "This browser can't open the camera. Try Chrome on Android or Safari on iPhone."))); return; }
  try { stream = await openStream(); }
  catch (e) {
    $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" }, h("h1", {}, "Camera blocked"),
      h("p", {}, "PlateTrace Camera needs permission to use the camera. Allow camera access for this site in your browser settings, then try again."),
      h("p", { class: "small muted" }, String(e.message || e)), h("button", { onclick: startCamera }, "Try again"))));
    return;
  }
  track = stream.getVideoTracks()[0];
  caps = track.getCapabilities ? track.getCapabilities() : {};
  settings = track.getSettings ? track.getSettings() : {};
  watchLocation();
  if (caps.focusMode?.includes("continuous")) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  viewfinder();
}

function stopCamera() { stopWatch(); stream?.getTracks().forEach((t) => t.stop()); stream = null; track = null; }

async function setAntiGlare(on) {
  antiGlare = on;
  if (caps.exposureCompensation) {
    const { min, step } = caps.exposureCompensation;
    const v = on ? Math.max(min, Math.round((min * 0.6) / (step || 1)) * (step || 1)) : 0;
    await track.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: v }] }).catch(() => {});
  }
}

function viewfinder() {
  const video = h("video", { autoplay: true, playsinline: true, muted: true });
  video.srcObject = stream;
  const dot = h("div", { class: "focus-dot", style: "opacity:0" });
  const status = h("div", { class: "status" });
  const guide = h("div", { class: "guide", "data-label": "Fit the plate here" });
  const view = h("div", { class: "view" }, video, guide, dot, status);

  view.addEventListener("click", async (e) => {
    askMotion();
    if (e.target.closest("button,input")) return;
    const r = video.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; dot.style.opacity = 1; setTimeout(() => (dot.style.opacity = 0), 900);
    const adv = {};
    if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x, y }];
    if (caps.focusMode?.includes("single-shot")) adv.focusMode = "single-shot";
    else if (caps.focusMode?.includes("continuous")) adv.focusMode = "continuous";
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] }).catch(() => {});
  });

  const glareBtn = h("button", { class: antiGlare ? "ghost on" : "ghost", onclick: async () => { await setAntiGlare(!antiGlare); glareBtn.className = antiGlare ? "ghost on" : "ghost"; flash(antiGlare ? "Anti-glare on: darker picture keeps the plate from washing out" : "Anti-glare off"); } }, "Anti-glare");
  if (!caps.exposureCompensation) glareBtn.title = "Your phone doesn't let websites change exposure; hold the phone so the light isn't reflecting straight back.";
  const torchBtn = caps.torch ? h("button", { class: "ghost", onclick: async () => { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {}); torchBtn.className = torchOn ? "ghost on" : "ghost"; } }, "Light") : null;
  const closeBtn = h("button", { class: "ghost", onclick: () => { stopVoice(); stopCamera(); intro(); } }, "✕");

  // Voice commands: "photo", "burst", "record" / "stop", "zoom in" / "zoom out", "anti-glare", "light", "focus".
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceBtn = SR ? h("button", { class: voiceOn ? "ghost on" : "ghost", onclick: () => (voiceOn ? stopVoice() : startVoice()) }, "🎤 Voice") : null;
  function startVoice() {
    voiceOn = true; voiceBtn.className = "ghost on";
    flash('Listening. Say "camera activate" to start recording, "camera stop" to finish, or "photo", "burst", "zoom in", "anti-glare".');
    const rec = new SR(); rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = (e) => { const said = e.results[e.results.length - 1][0].transcript.toLowerCase().trim(); command(said); };
    rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { flash("Microphone blocked. Allow it in your browser settings to use voice."); stopVoice(); } };
    rec.onend = () => { if (voiceOn && voiceRec === rec) try { rec.start(); } catch {} };
    voiceRec = rec; try { rec.start(); } catch {}
  }
  function command(said) {
    const has = (...w) => w.some((x) => said.includes(x));
    if (has("camera activate", "activate camera", "camera active")) { pick("video"); if (!recorder) shutter.click(); flash("🎤 Camera activated: recording. Say \"camera stop\" to finish."); return; }
    if (has("burst")) { pick("burst"); shutter.click(); }
    else if (has("night")) { pick("night"); shutter.click(); }
    else if (has("record", "video", "start")) { pick("video"); if (!recorder) shutter.click(); }
    else if (has("stop", "cut")) { if (recorder) recorder.stop(); }
    else if (has("photo", "picture", "snap", "capture", "shoot", "cheese")) { pick("photo"); shutter.click(); }
    else if (has("zoom in", "closer")) stepZoom(1);
    else if (has("zoom out", "farther", "further")) stepZoom(-1);
    else if (has("glare")) glareBtn.click();
    else if (has("light", "flash", "torch")) torchBtn ? torchBtn.click() : flash("This phone doesn't let websites turn on the light.");
    else if (has("focus")) view.dispatchEvent(new MouseEvent("click", { clientX: innerWidth / 2, clientY: innerHeight * 0.45 }));
    else return flash(`Heard "${said}". Try "photo", "burst" or "record".`);
    flash(`🎤 ${said}`);
  }
  function stepZoom(dir) {
    if (!zoomInput) return flash("This phone doesn't let websites zoom. Move closer if it's safe.");
    const span = caps.zoom.max - caps.zoom.min;
    zoomInput.value = Math.min(caps.zoom.max, Math.max(caps.zoom.min, +zoomInput.value + dir * span * 0.15));
    zoomInput.dispatchEvent(new Event("input"));
  }

  let zoomRow = null, zoomInput = null;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const z = zoomInput = h("input", { type: "range", min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: settings.zoom || caps.zoom.min });
    const zl = h("span", {}, `${(+z.value).toFixed(1)}×`);
    z.addEventListener("input", () => { zl.textContent = `${(+z.value).toFixed(1)}×`; track.applyConstraints({ advanced: [{ zoom: +z.value }] }).catch(() => {}); });
    zoomRow = h("div", { class: "zoomrow" }, "Zoom", z, zl);
  }

  const shutter = h("button", { class: "shutter", "aria-label": "Take photo" });
  const left = h("div", { class: "side" }), right = h("div", { class: "side" });
  const MODES = ["photo", "burst", "night", "video", "special"];
  const pick = (m) => { if (recorder || mode === m) return; mode = m; modeBtns.forEach((b, i) => (b.className = MODES[i] === m ? "sel" : "")); paintShutter(); };
  const modeBtns = MODES.map((m) => h("button", { class: m === mode ? "sel" : "", onclick: () => pick(m) }, { photo: "Photo", burst: "Smart burst", night: "Night", video: "Video", special: "Special light" }[m]));
  const special = specialPanel(() => paintShutter());
  const paintShutter = () => { shutter.className = mode === "video" ? "shutter rec" : "shutter"; shutter.setAttribute("aria-label", mode === "video" ? "Start recording" : "Take photo");
    left.textContent = mode === "burst" ? "First Shot + bonus rounds" : mode === "night" ? "16 frames, stacked" : mode === "video" ? `up to ${MAX_VIDEO_S}s` : mode === "special" ? `${SPECIAL[specialMode].frames} lossless frames` : "";
    special.el.style.display = mode === "special" ? "" : "none"; };
  paintShutter();

  let busy = false;
  shutter.addEventListener("click", async () => {
    askMotion();
    if (mode === "video") { if (recorder) recorder.stop(); else startRecording(shutter, right, status); return; }
    if (busy) return;
    if (mode === "special") {
      if (!special.ready()) { special.fail("Tick the box to confirm the equipment is in use. Without it, this mode records nothing extra."); return; }
      busy = true;
      try { const frames = await captureSpecial(specialMode, video, (t) => (status.textContent = t)); status.textContent = "Saving lossless originals…"; const shots = await packSpecial(specialMode, frames, special.hwDeclared()); status.textContent = ""; review(shots); }
      catch (e) { status.textContent = ""; special.fail("Couldn't capture: " + (e.message || e)); }
      busy = false; return;
    }
    busy = true;
    try {
      if (mode === "burst" || mode === "night") { const shots = await smartBurst(video, (t) => (status.textContent = t), { night: mode === "night" }); status.textContent = ""; review(shots, { autoClear: mode === "night" }); }
      else { const shot = await takePhoto(video); status.textContent = ""; review([shot]); }
    } catch (e) { status.textContent = "Couldn't take the photo: " + (e.message || e); if (!watchTimer) startWatch(video, guide); }
    busy = false;
  });

  function flash(t) { status.textContent = t; setTimeout(() => { if (status.textContent === t) status.textContent = ""; }, 2200); }

  $app.replaceChildren(view);
  startWatch(video, guide);
  (window.requestIdleCallback || ((f) => setTimeout(f, 2500)))(() => getSb());
  if (resumeVoice && voiceBtn) { resumeVoice = false; setTimeout(startVoice, 300); }
  if (activateOnOpen) { activateOnOpen = false; setTimeout(() => { pick("video"); if (!recorder) shutter.click(); flash("🎤 Camera activated: recording. Say \"camera stop\" to finish."); }, 600); }
  const lockBtn = h("button", { class: lockOn ? "ghost on" : "ghost", onclick: () => { lockOn = !lockOn; store.set("pt_cam_lock", lockOn ? "1" : "0"); lockBtn.className = lockOn ? "ghost on" : "ghost";
    if (!lockOn) { curBox = { ...DEF_BOX }; lockSeen = 0; guide.style.cssText = ""; } flash(lockOn ? "Plate lock on: the box finds and follows the plate" : "Plate lock off"); } }, "Plate lock");
  view.append(h("div", { class: "topbar" }, voiceBtn, lockBtn, glareBtn, torchBtn, uploadButton(true), closeBtn),
    h("div", { class: "bottombar" }, special.el, zoomRow, h("div", { class: "modes" }, modeBtns), h("div", { class: "shutterrow" }, left, shutter, right)));
}

async function takePhoto(video) {
  const at = new Date();
  let blob = null;
  if ("ImageCapture" in window) {
    try { blob = await new ImageCapture(track).takePhoto(); } catch { blob = null; }
  }
  if (!blob) {
    const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
  }
  return { kind: "photo", blob, at, sha256: await sha256(blob), mime: blob.type || "image/jpeg" };
}

function pickMime() {
  const opts = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

function startRecording(shutter, right, status) {
  if (!window.MediaRecorder) { status.textContent = "This browser can't record video. Use Photo or Burst."; return; }
  const mime = pickMime(), chunks = [], at = new Date();
  recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 6000000 });
  let bytes = 0, secs = 0;
  recorder.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); bytes += e.data.size; if (bytes > MAX_BYTES && recorder.state === "recording") recorder.stop(); } };
  const tick = setInterval(() => { secs++; right.textContent = `● ${secs}s`; if (secs >= MAX_VIDEO_S && recorder.state === "recording") recorder.stop(); }, 1000);
  recorder.onstop = async () => {
    clearInterval(tick); shutter.classList.remove("recording"); right.textContent = "";
    const type = (recorder.mimeType || mime || "video/webm").split(";")[0];
    recorder = null;
    const blob = new Blob(chunks, { type });
    status.textContent = "Fingerprinting the video…";
    const shot = { kind: "video", blob, at, sha256: await sha256(blob), mime: type, seconds: secs };
    status.textContent = "";
    review([shot]);
  };
  recorder.start(1000);
  shutter.classList.add("recording"); right.textContent = "● 0s";
}

// ---------- special-light capture (only at capture, never on saved files) ----------
// These modes work only on frames grabbed live from the camera stream in this session, kept lossless
// (PNG) and never re-compressed. A browser can't read true sensor RAW; this is the closest original it
// can get. Saved photos, JPEGs and video frames are refused: their lost detail can't come back.
const DERIVATIVE_ERR = "Source is a degraded derivative; special-light recovery requires original capture.";
const SPECIAL = {
  hdr: { label: "HDR / multi-exposure", frames: 3, hw: null,
    info: "Takes 3 lossless frames at darker, normal and brighter exposure, so glare and shadows are both recorded with real light. Hold very still or rest the phone on something." },
  polar: { label: "Polarized light", frames: 4, hw: "A polarizing filter is on the lens (or a polarized light is being used)",
    info: "Needs a polarizing filter on the lens or light. Takes 4 lossless frames; turn the filter about 45° when told. Glare is cut physically, on the real plate." },
  ir: { label: "IR / multispectral", frames: 3, hw: "This camera sees infrared (IR-modified camera or IR light in use)",
    info: "Needs a camera that sees infrared, or an IR light. Can show ink or material differences on the real plate. Pick the IR camera below if your phone lists one." },
  latent: { label: "Low-light amplification", frames: 6, hw: null,
    info: "For very dark scenes. Takes 6 lossless frames at the longest exposure the phone allows and adds them up to collect more real light. Hold very still." },
};
let specialMode = "hdr";

function requireOriginalCapture(src) {
  if (!src || src.origin !== "live_capture" || !src.canvas) throw new Error(DERIVATIVE_ERR);
  return src;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function pngWithRecord(canvas, record) {            // lossless PNG + a "PlateTrace" text record after the header
  const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/png"))).arrayBuffer());
  const text = JSON.stringify(record).replace(/[^\x20-\x7e]/g, "?");
  const data = new Uint8Array([..."PlateTrace"].map((c) => c.charCodeAt(0)).concat([0], [...text].map((c) => c.charCodeAt(0))));
  const typed = new Uint8Array(4 + data.length); typed.set([116, 69, 88, 116]); typed.set(data, 4);   // "tEXt"
  const chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length); chunk.set(typed, 4); dv.setUint32(8 + data.length, crc32(typed));
  return new Blob([png.slice(0, 33), chunk, png.slice(33)], { type: "image/png" });
}
function readPngRecord(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 33 || dv.getUint32(0) !== 0x89504e47) return null;
  for (let o = 8; o + 12 <= dv.byteLength;) {
    const len = dv.getUint32(o), typ = String.fromCharCode(...new Uint8Array(buf, o + 4, 4));
    if (typ === "tEXt") { const raw = new Uint8Array(buf, o + 8, len), z = raw.indexOf(0);
      if (String.fromCharCode(...raw.slice(0, z)) === "PlateTrace") { try { return JSON.parse(String.fromCharCode(...raw.slice(z + 1))); } catch { return null; } } }
    if (typ === "IEND") break; o += 12 + len;
  }
  return null;
}

const camSettings = () => { const s = track?.getSettings?.() || {}; const keep = ["width", "height", "zoom", "exposureMode", "exposureCompensation", "exposureTime", "iso", "whiteBalanceMode", "colorTemperature", "focusMode", "focusDistance", "torch", "deviceId"];
  return Object.fromEntries(keep.filter((k) => s[k] != null).map((k) => [k, k === "deviceId" ? String(s[k]).slice(0, 12) : s[k]])); };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function grabLive(video) {
  let bmp = null;
  if ("ImageCapture" in window) { try { bmp = await new ImageCapture(track).grabFrame(); } catch { bmp = null; } }
  const w = bmp ? bmp.width : video.videoWidth, hgt = bmp ? bmp.height : video.videoHeight;
  const c = document.createElement("canvas"); c.width = w; c.height = hgt;
  c.getContext("2d").drawImage(bmp || video, 0, 0);
  bmp?.close?.();
  return { origin: "live_capture", canvas: c, at: new Date(), settings: camSettings() };
}

// Exposure control: compensation if the phone allows it, else manual exposure time, else nothing.
async function setExposure(level) {
  if (caps.exposureCompensation) {
    const { min, max, step } = caps.exposureCompensation, st = step || 0.1;
    const v = Math.round((level < 0 ? min * 0.8 : level > 0 ? max * 0.8 : 0) / st) * st;
    await track.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: v }] }).catch(() => {});
    return `exposure compensation ${v.toFixed(1)} EV`;
  }
  if (caps.exposureTime && caps.exposureMode?.includes("manual")) {
    const { min, max } = caps.exposureTime, base = settings.exposureTime || Math.min(max, Math.max(min, 333));
    const v = Math.min(max, Math.max(min, Math.round(base * Math.pow(4, level))));
    await track.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: v }] }).catch(() => {});
    return `exposure time ${(v / 10).toFixed(1)} ms`;
  }
  return null;
}
async function restoreExposure() {
  if (caps.exposureMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ exposureMode: "continuous" }] }).catch(() => {});
  await setAntiGlare(antiGlare);
}

async function captureSpecial(mode, video, say) {
  const M = SPECIAL[mode], frames = [];
  try {
    if (mode === "hdr") {
      const levels = [-1, 0, 1];
      for (let i = 0; i < levels.length; i++) {
        say(`Frame ${i + 1} of 3 (${["darker", "normal", "brighter"][i]})… hold still`);
        const how = await setExposure(levels[i]); await settle(450);
        const f = await grabLive(video); f.exposure = how || "this phone doesn't let websites change exposure; same exposure"; frames.push(f);
      }
    } else if (mode === "latent") {
      let how = null;
      if (caps.exposureTime && caps.exposureMode?.includes("manual")) {
        const v = Math.min(caps.exposureTime.max, 1000);
        await track.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: v }] }).catch(() => {});
        how = `manual exposure ${(v / 10).toFixed(1)} ms`;
      } else if (caps.exposureCompensation) how = await setExposure(1);
      await settle(500);
      for (let i = 0; i < M.frames; i++) { say(`Collecting light ${i + 1} of ${M.frames}… hold still`); const f = await grabLive(video); f.exposure = how || "phone's own exposure (it doesn't allow changes)"; frames.push(f); await settle(120); }
    } else if (mode === "polar") {
      for (let i = 0; i < M.frames; i++) {
        say(i === 0 ? "Frame 1 of 4… hold still" : `Turn the filter about 45°, then hold still (frame ${i + 1} of 4)`);
        await settle(i === 0 ? 300 : 2200);
        const f = await grabLive(video); f.filter_turn_deg = i * 45; frames.push(f);
      }
    } else {
      for (let i = 0; i < M.frames; i++) { say(`IR frame ${i + 1} of ${M.frames}… hold still`); frames.push(await grabLive(video)); await settle(200); }
    }
  } finally { await restoreExposure(); }
  return frames;
}

// Processing: each frame must be an original live capture, or it is refused with DERIVATIVE_ERR.
function processSpecial(mode, frames) {
  frames.forEach(requireOriginalCapture);
  const w = frames[0].canvas.width, hgt = frames[0].canvas.height;
  if (frames.some((f) => f.canvas.width !== w || f.canvas.height !== hgt)) throw new Error("The frames are different sizes; take them again without changing zoom or camera.");
  const ctxs = frames.map((f) => f.canvas.getContext("2d", { willReadFrequently: true }));
  const c = document.createElement("canvas"); c.width = w; c.height = hgt; const octx = c.getContext("2d");
  const BAND = 128;                                        // work in strips so 4K frames fit in a phone's memory
  let gain = 1;
  if (mode === "latent") {                                 // brightness gain from a sparse sample of the summed frames
    const lum = [], sx = Math.max(1, Math.floor(w / 160)), sy = Math.max(1, Math.floor(hgt / 90));
    for (let y = 0; y < hgt; y += sy) { const rows = ctxs.map((x) => x.getImageData(0, y, w, 1).data);
      for (let x = 0; x < w; x += sx) { let v = 0; for (const d of rows) v += 0.299 * d[x * 4] + 0.587 * d[x * 4 + 1] + 0.114 * d[x * 4 + 2]; lum.push(v / rows.length); } }
    lum.sort((a, b) => a - b); gain = Math.min(16, 240 / Math.max(1, lum[Math.floor(lum.length * 0.995)]));
  }
  for (let y0 = 0; y0 < hgt; y0 += BAND) {
    const bh = Math.min(BAND, hgt - y0), px = ctxs.map((x) => x.getImageData(0, y0, w, bh).data), out = new ImageData(w, bh), n = w * bh;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (mode === "hdr") {
        let W = 0, r = 0, g = 0, b = 0;
        for (const d of px) { const yv = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255, mx = Math.max(d[j], d[j + 1], d[j + 2]);
          const wt = mx >= 250 || mx <= 5 ? 1e-4 : Math.exp(-((yv - 0.5) ** 2) / 0.08); W += wt; r += wt * d[j]; g += wt * d[j + 1]; b += wt * d[j + 2]; }
        out.data[j] = r / W; out.data[j + 1] = g / W; out.data[j + 2] = b / W;
      } else if (mode === "polar") {
        let best = px[0], bv = 1e9; for (const d of px) { const v = d[j] + d[j + 1] + d[j + 2]; if (v < bv) { bv = v; best = d; } }
        out.data[j] = best[j]; out.data[j + 1] = best[j + 1]; out.data[j + 2] = best[j + 2];
      } else {
        for (let k = 0; k < 3; k++) { let v = 0; for (const d of px) v += d[j + k]; out.data[j + k] = Math.min(255, (v / px.length) * gain); }
      }
      out.data[j + 3] = 255;
    }
    octx.putImageData(out, 0, y0);
  }
  const method = mode === "hdr" ? "exposure fusion: each pixel weighted by how well each frame recorded it (blown-out and pitch-black pixels get almost no weight)"
    : mode === "polar" ? "per-pixel minimum brightness across filter angles (keeps the angle with the least reflected glare)"
    : mode === "latent" ? `sum of ${frames.length} original frames (more real light, less noise), then brightness x${gain.toFixed(2)}`
    : `average of ${frames.length} original IR frames (less noise)`;
  return { canvas: c, method };
}

async function packSpecial(mode, frames, hwDeclared) {
  const M = SPECIAL[mode], shots = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const rec = { origin: "live_capture", mode: M.label, frame: i + 1, of: frames.length, at: f.at.toISOString(), lossless: true, settings: f.settings,
      exposure: f.exposure || null, filter_turn_deg: f.filter_turn_deg ?? null, hardware_declared: hwDeclared || null,
      note: "Lossless frame from the live camera stream (the phone's own image processing still applies; browsers can't read sensor RAW)." };
    const blob = await pngWithRecord(f.canvas, rec);
    shots.push({ kind: "photo", blob, at: f.at, sha256: await sha256(blob), mime: "image/png", special: { ...rec, mode, label: M.label, role: "original" } });
  }
  const res = processSpecial(mode, frames);
  const at = new Date(), rec = { origin: "special_light_output", mode: M.label, method: res.method, from_frames: frames.length, from_sha256: shots.map((s) => s.sha256), at: at.toISOString(),
    note: "Built from the original frames sent with it. The originals are the evidence." };
  const blob = await pngWithRecord(res.canvas, rec);
  shots.push({ kind: "photo", blob, at, sha256: await sha256(blob), mime: "image/png", special: { ...rec, mode, label: M.label, role: "result" } });
  return shots;
}

// A saved file can only go through special-light processing if it is itself an original live capture.
async function checkSavedFiles(files, mode, say) {
  const frames = [];
  for (const file of files) {
    const buf = await file.arrayBuffer(), rec = file.type === "image/png" || /\.png$/i.test(file.name) ? readPngRecord(buf) : null;
    const src = { origin: rec?.origin === "live_capture" ? "live_capture" : "file", canvas: null, at: rec?.at && !isNaN(new Date(rec.at)) ? new Date(rec.at) : new Date(file.lastModified || Date.now()), settings: rec?.settings || {} };
    if (src.origin === "live_capture") {
      const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }));
      src.canvas = document.createElement("canvas"); src.canvas.width = bmp.width; src.canvas.height = bmp.height; src.canvas.getContext("2d").drawImage(bmp, 0, 0); bmp.close?.();
      src.exposure = rec.exposure; src.filter_turn_deg = rec.filter_turn_deg;
    }
    requireOriginalCapture(src);              // throws DERIVATIVE_ERR for JPEGs, videos, screenshots, edited files
    frames.push(src);
  }
  if (frames.length < 2) throw new Error("Choose at least 2 original PlateTrace Camera frames.");
  say("Processing the original frames…");
  return frames;
}

function specialPanel(onMode) {
  const M = () => SPECIAL[specialMode];
  const sel = h("select", {}, Object.entries(SPECIAL).map(([k, v]) => h("option", { value: k }, v.label)));
  sel.value = specialMode;
  const info = h("p", {}), hw = h("input", { type: "checkbox" }), hwText = h("span", {}), hwRow = h("label", { class: "check", style: "margin:6px 0" }, hw, hwText);
  const camRow = h("div", { style: "display:none" });
  const err = h("p", { class: "err", style: "margin:6px 0" });
  const file = h("input", { type: "file", accept: "image/*,video/*", multiple: true, style: "display:none" });
  const fileBtn = h("button", { class: "ghost", style: "min-height:36px;padding:6px 12px;font-size:13px", onclick: () => file.click() }, "Use saved files instead");
  const paint = async (initial) => {
    specialMode = sel.value; info.textContent = M().info; err.textContent = "";
    hwRow.style.display = M().hw ? "" : "none"; hwText.textContent = M().hw || ""; hw.checked = false;
    camRow.style.display = specialMode === "ir" ? "" : "none";
    if (specialMode === "ir" && navigator.mediaDevices?.enumerateDevices) {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const cur = track?.getSettings?.().deviceId;
      const cs = h("select", { onchange: (e) => switchCamera(e.target.value) }, cams.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === cur }, (d.label || `Camera ${i + 1}`) + (/\b(ir|infra)/i.test(d.label) ? " (infrared)" : ""))));
      camRow.replaceChildren(h("span", { class: "small" }, "Camera: "), cs);
    }
    if (initial !== true) onMode();
  };
  sel.addEventListener("change", () => paint(false));
  file.addEventListener("change", async () => {
    err.textContent = "";
    try { const frames = await checkSavedFiles([...file.files], specialMode, (t) => (info.textContent = t)); review(await packSpecial(specialMode, frames, "re-used original captures")); }
    catch (e) { err.textContent = e.message || String(e); }
    file.value = "";
  });
  paint(true);
  return { el: h("div", { class: "special" }, h("label", { class: "small" }, "Special light: ", sel), info, hwRow, camRow, h("div", {}, fileBtn, file), err),
    ready: () => !M().hw || hw.checked, hwDeclared: () => (M().hw && hw.checked ? M().hw : null), fail: (t) => (err.textContent = t) };
}

async function switchCamera(deviceId) {
  stopCamera();
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); }
  catch { stream = await openStream(); }
  track = stream.getVideoTracks()[0]; caps = track.getCapabilities ? track.getCapabilities() : {}; settings = track.getSettings ? track.getSettings() : {};
  mode = "special"; viewfinder();
}

// ---------- review & send ----------
function review(shots, opt = {}) {
  stopWatch();
  const wasVoice = voiceOn; stopVoice(); resumeVoice = wasVoice;
  const isVideo = shots.every((s) => s.kind === "video");
  const urls = shots.map((s) => URL.createObjectURL(s.blob));
  const photos = shots.filter((s) => s.kind === "photo" && !s.special), pUrls = photos.map((s) => urls[shots.indexOf(s)]);
  const vids = shots.filter((s) => s.kind === "video");
  const smart = photos.some((s) => s.smart);
  const bestPhoto = smart ? photos.find((s) => s.smart.rank === 1) || photos[0] : photos[0];
  const chan = bestPhoto && !shots[0].special ? channelPanel(bestPhoto.blob) : null;
  const clear = bestPhoto && !shots[0].special ? clearerPanel(shots, photos, opt.autoClear) : null;
  const pickBtn = isVideo ? h("button", { class: "ghost", style: "width:100%;margin-top:10px", onclick: async () => {
    pickBtn.disabled = true;
    try { const frames = await pickVideoFrames(vids[0], (t) => (pickBtn.textContent = t)); urls.forEach((u) => URL.revokeObjectURL(u)); clearInterval(locTimer); review([...vids, ...frames]); }
    catch (e) { pickBtn.disabled = false; pickBtn.textContent = "Couldn't read the video: " + (e.message || e); }
  } }, "Find the sharpest frames in this video") : null;
  const media = h("div", {},
    vids.map((v) => h("video", { class: "media", src: urls[shots.indexOf(v)], controls: true, playsinline: true, style: "margin-bottom:10px" })),
    !photos.length ? null : smart ? smartReview(photos, pUrls)
      : photos.length === 1 ? h("img", { class: "media", src: pUrls[0], alt: "Your photo" })
      : h("div", { class: "grid" }, pUrls.map((u) => h("img", { src: u, alt: "Burst photo" }))),
    shots[0].special ? h("div", { class: "grid" }, urls.map((u) => h("img", { src: u, alt: "Special light frame" }))) : null, pickBtn);
  const note = h("textarea", { rows: 3, maxlength: 1000, placeholder: "What happened, vehicle color/make, direction it went… (optional)" });
  const anon = h("input", { type: "checkbox", checked: true });
  const contact = h("input", { type: "text", maxlength: 200, placeholder: "Name and phone or email (optional)" });
  const contactBox = h("div", { style: "display:none" }, h("label", {}, "How can investigators reach you?"), contact);
  anon.addEventListener("change", () => (contactBox.style.display = anon.checked ? "none" : ""));
  const useLoc = h("input", { type: "checkbox", checked: true });
  const locText = h("span", { class: "small muted" });
  const paintLoc = () => (locText.textContent = lastFix ? `(about ${lastFix.accuracy_m} m accurate)` : "(waiting for location…)");
  paintLoc(); const locTimer = setInterval(paintLoc, 1500);
  const msg = h("p", { class: "small" }), bar = h("i", {});
  const size = shots.reduce((n, s) => n + s.blob.size, 0);

  const send = async () => {
    sendBtn.disabled = true; retake.disabled = true; msg.className = "small muted"; msg.textContent = "Sending…";
    const sb = await getSb();
    if (!sb) { msg.className = "small err"; msg.textContent = "No connection to PlateTrace right now. Save it to your phone and send it later."; sendBtn.disabled = false; retake.disabled = false; return; }
    const loc = useLoc.checked && lastFix ? lastFix : null;
    const group = uuid();
    try {
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i], ext = s.ext || (s.mime.includes("mp4") ? "mp4" : s.mime.includes("webm") ? "webm" : s.mime.includes("quicktime") ? "mov" : s.mime.includes("png") ? "png" : "jpg");
        const day = s.at.toISOString().slice(0, 10), path = `${day}/${group}_${i + 1}.${ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, s.blob, { contentType: s.mime, upsert: false });
        if (up.error) throw up.error;
        const row = {
          captured_at: s.at.toISOString(), kind: s.kind, file_path: path, sha256: s.sha256, bytes: s.blob.size, mime: s.mime,
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy_m: loc?.accuracy_m ?? null,
          note: note.value.trim() || null, contact: anon.checked ? null : contact.value.trim() || null,
          device: navigator.userAgent.slice(0, 400),
          camera_settings: { group, shot: i + 1, of: shots.length, mode: s.special ? "special" : shots.length > 1 ? "burst" : s.kind, smart_burst: s.smart || null, suggested_view: chan ? chan.view() : null, anti_glare: antiGlare,
            capture_mode: s.special ? SPECIAL[s.special.mode].label : null, special: s.special || null,
            source_type: s.source_type || (s.special ? (s.special.role === "original" ? "raw_capture" : "derivative") : s.kind === "video" ? "video_frame" : "processed_image"), uploaded: s.uploaded || null, clearer_copy: s.clearer || null, zoom: track?.getSettings?.().zoom ?? null,
            width: track?.getSettings?.().width ?? null, height: track?.getSettings?.().height ?? null, seconds: s.seconds ?? null, location_time: loc ? new Date(loc.at).toISOString() : null },
        };
        const ins = await sb.from("platetrace_tips").insert(row);
        if (ins.error) throw ins.error;
        bar.style.width = `${Math.round(((i + 1) / shots.length) * 100)}%`;
      }
      clearInterval(locTimer);
      urls.forEach((u) => URL.revokeObjectURL(u));
      done(shots);
    } catch (e) {
      msg.className = "small err";
      msg.textContent = "Couldn't send: " + (e.message || e) + ". Check your connection and tap Send again, or save it to your phone.";
      sendBtn.disabled = false; retake.disabled = false;
    }
  };
  const sendBtn = h("button", { onclick: send }, "Send to PlateTrace");
  const retake = h("button", { class: "ghost", onclick: () => { clearInterval(locTimer); urls.forEach((u) => URL.revokeObjectURL(u)); stream ? viewfinder() : startCamera(); } }, "Retake");
  const save = h("button", { class: "ghost", onclick: () => shots.forEach((s, i) => { const a = h("a", { href: urls[i], download: `platetrace_${s.at.toISOString().replace(/[:.]/g, "-")}_${i + 1}${s.special ? "_" + s.special.role : ""}.${s.kind === "video" ? (s.mime.includes("mp4") ? "mp4" : "webm") : s.mime.includes("png") ? "png" : "jpg"}` }); document.body.append(a); a.click(); a.remove(); }) }, "Save to phone");

  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "review" },
    h("h2", { style: "margin:4px 0 10px" }, isVideo ? (shots[0].uploaded ? "Your clip" : "Your video") : vids.length && smart ? `Video + ${photos.length} sharpest frames` : smart ? `${photos[0].smart.night ? "Night" : "Smart burst"}: ${shots.length} frames, sharpest 3 on top` : shots[0].special ? `${SPECIAL[shots[0].special.mode].label}: ${shots.length - 1} originals + 1 result` : shots.length > 1 ? `Your ${shots.length} photos` : "Your photo"),
    shots[0].special ? h("p", { class: "kv" }, `Result: ${shots[shots.length - 1].special.method}. The originals are sent too; they are the evidence.`) : null,
    media, clear?.el, chan?.el,
    h("p", { class: "kv" }, `${shots[0].uploaded ? "Uploaded" : "Taken"} ${shots[0].at.toLocaleString()} · ${(size / 1048576).toFixed(1)} MB`),
    h("p", { class: "kv" }, `Fingerprint: ${shots[0].sha256.slice(0, 16)}…`),
    h("label", { class: "check" }, useLoc, h("span", {}, "Include where this was taken ", locText)),
    h("label", {}, "Anything investigators should know?"), note,
    h("label", { class: "check" }, anon, "Send anonymously"), contactBox,
    h("div", { class: "actions" }, sendBtn, retake, save),
    h("div", { class: "progress" }, bar), msg)));
}

function done(shots) {
  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" },
    h("h1", { class: "ok" }, "Sent. Thank you."),
    h("p", {}, `PlateTrace received your ${shots[0].kind === "video" ? "video" : shots.length > 1 ? shots.length + " photos" : "photo"}. Each file was fingerprinted when you took it, so investigators can show it wasn't changed.`),
    h("p", { class: "small muted" }, "Keep your original on your phone too, in case investigators ask for it."),
    h("button", { style: "width:100%", onclick: () => (stream ? viewfinder() : startCamera()) }, "Take another"))));
}

// ---------- Smart burst: First Shot + Bonus Rounds ----------
// The plate is in the camera's view even while the hands are still moving; blur is the same plate smeared
// over the split second the picture took. So the camera saves a First Shot the moment a picture appears,
// keeps the sharpest frames while the person steadies, then takes bonus rounds on tap. Every frame is kept
// and sent (blurry ones still help PlateTrace combine a sharper copy); the sharpest 3 are shown first.
const BONUS_MS = 2500, BONUS_MAX = 12, PREROLL_KEEP = 3, PREROLL_MAX_AGE = 20000, FIRST_MAX_AGE = 30000;
let firstShot = null, preroll = [], watchTimer = null, grabbing = false;
let rot = 0, rotAt = 0, motionAsked = false, prevGray = null, lastMove = 99;

function askMotion() {                       // iPhone needs a tap before it shares the motion sensor
  if (motionAsked) return; motionAsked = true;
  const on = () => window.addEventListener("devicemotion", (e) => { const r = e.rotationRate; if (!r || r.alpha == null) return;
    const m = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0); rot = rot * 0.7 + m * 0.3; rotAt = performance.now(); });
  if (window.DeviceMotionEvent?.requestPermission) DeviceMotionEvent.requestPermission().then((p) => p === "granted" && on()).catch(() => {});
  else if (window.DeviceMotionEvent) on();
}
const sensorLive = () => performance.now() - rotAt < 1000;
const isSteady = () => (sensorLive() ? rot < 10 : lastMove < 3.5);   // degrees/second from the sensor, or picture movement

// Sharpness of the plate area (center of the view): how strongly edges stand out (variance of the Laplacian).
const MW = 480, MH = 136, mc = document.createElement("canvas"); mc.width = MW; mc.height = MH;
const mctx = mc.getContext("2d", { willReadFrequently: true });
const DEF_BOX = { x: 0.25, y: 0.32, w: 0.5, h: 0.26 };
let curBox = { ...DEF_BOX }, lockOn = store.get("pt_cam_lock") !== "0", lockSeen = 0;
function measure(src, w, hgt, box = curBox) {
  mctx.drawImage(src, w * box.x, hgt * box.y, w * box.w, hgt * box.h, 0, 0, MW, MH);
  const d = mctx.getImageData(0, 0, MW, MH).data, g = new Float32Array(MW * MH);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < MH - 1; y++) for (let x = 1, i = y * MW + 1; x < MW - 1; x++, i++) { const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - MW] - g[i + MW]; s += l; s2 += l * l; n++; }
  let move = 99;
  if (prevGray) { let m = 0; for (let i = 0; i < g.length; i += 7) m += Math.abs(g[i] - prevGray[i]); move = m / (g.length / 7); }
  prevGray = g;
  return { sharp: s2 / n - (s / n) ** 2, move };
}
async function grabFrame(video, role, extra) {
  const at = new Date(), c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  const m = measure(c, c.width, c.height), steady = isSteady();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  c.width = c.height = 0;                  // free the memory right away
  return { kind: "photo", blob, at, sha256: await sha256(blob), mime: "image/jpeg",
    smart: { role, sharpness: Math.round(m.sharp), steady, box: { ...curBox }, plate_lock: lockOn && performance.now() - lockSeen < 1500, motion: sensorLive() ? `${rot.toFixed(1)}°/s (motion sensor)` : `${lastMove.toFixed(1)} (picture movement)`, ...extra } };
}

function startWatch(video, guide) {
  stopWatch(); prevGray = null; firstShot = null; preroll = []; curBox = { ...DEF_BOX }; lockSeen = 0;
  watchTimer = setInterval(async () => {
    if (!video.videoWidth || grabbing) return;
    if (lockOn) trackPlate(video, guide);
    const m = measure(video, video.videoWidth, video.videoHeight); lastMove = m.move;
    const locked = lockOn && performance.now() - lockSeen < 1500;
    const st = isSteady(); guide.classList.toggle("steady", st);
    guide.dataset.label = st ? "Steady ✓ good moment" : locked ? "Plate locked" : "Fit the plate here";
    const now = Date.now();
    preroll = preroll.filter((p) => now - p.at < PREROLL_MAX_AGE);
    const worst = preroll.length < PREROLL_KEEP ? -1 : Math.min(...preroll.map((p) => p.smart.sharpness));
    if (!firstShot || m.sharp > worst * 1.05) {
      grabbing = true;
      try {
        if (!firstShot) firstShot = await grabFrame(video, "first_shot");
        else { const f = await grabFrame(video, "steadying"); preroll.push(f); preroll.sort((a, b) => b.smart.sharpness - a.smart.sharpness); preroll = preroll.slice(0, PREROLL_KEEP); }
      } catch {} finally { grabbing = false; }
    }
  }, 120);
}
// ---------- Plate lock: find the plate in the picture and keep the box on it ----------
// A plate is a small area packed with sharp up-and-down edges (the letter strokes). Each tick the camera
// looks for the 2:1 box with the most of those edges; the box follows it, and sharpness is scored there.
const LW = 192, lc = document.createElement("canvas"), lctx = lc.getContext("2d", { willReadFrequently: true });
function findPlate(src, vw, vh) {
  const LH = Math.max(40, Math.round((LW * vh) / vw)); lc.width = LW; lc.height = LH;
  lctx.drawImage(src, 0, 0, LW, LH);
  const d = lctx.getImageData(0, 0, LW, LH).data, g = new Float32Array(LW * LH);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const I = new Float32Array((LW + 1) * (LH + 1)); let tot = 0;
  for (let y = 0; y < LH; y++) { let row = 0;
    for (let x = 0; x < LW; x++) { const e = x > 0 && x < LW - 1 && Math.abs(g[y * LW + x + 1] - g[y * LW + x - 1]) > 28 ? 1 : 0; row += e; tot += e;
      I[(y + 1) * (LW + 1) + x + 1] = I[y * (LW + 1) + x + 1] + row; } }
  const sum = (x, y, w, hh) => I[(y + hh) * (LW + 1) + x + w] - I[y * (LW + 1) + x + w] - I[(y + hh) * (LW + 1) + x] + I[y * (LW + 1) + x];
  const mean = tot / (LW * LH); let best = null;
  for (const sc of [0.2, 0.28, 0.38, 0.5]) {
    const w = Math.round(LW * sc), hh = Math.max(6, Math.round(w / 2.2));
    if (hh >= LH) continue;
    for (let y = 0; y + hh <= LH; y += 2) for (let x = 0; x + w <= LW; x += 2) {
      const dens = sum(x, y, w, hh) / (w * hh), score = dens * (1 + 0.35 * sc);
      if (!best || score > best.score) best = { score, dens, x, y, w, hh };
    }
  }
  if (!best || best.dens < 0.09 || best.dens < mean * 2.2) return null;
  const pad = 0.12;
  const bx = Math.max(0, best.x - best.w * pad), by = Math.max(0, best.y - best.hh * pad * 2);
  const bw = Math.min(LW - bx, best.w * (1 + 2 * pad)), bh = Math.min(LH - by, best.hh * (1 + 4 * pad));
  return { x: bx / LW, y: by / LH, w: bw / LW, h: bh / LH };
}
function trackPlate(video, guide) {
  const f = findPlate(video, video.videoWidth, video.videoHeight), now = performance.now();
  if (f) { lockSeen = now; for (const k of ["x", "y", "w", "h"]) curBox[k] += (f[k] - curBox[k]) * 0.35; }
  else if (now - lockSeen > 1500) for (const k of ["x", "y", "w", "h"]) curBox[k] += (DEF_BOX[k] - curBox[k]) * 0.2;
  placeGuide(video, guide, now - lockSeen < 1500);
}
function placeGuide(video, guide, locked) {
  if (!locked && !lockOn) { guide.style.cssText = ""; return; }
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  const sc = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * sc) / 2, oy = (r.height - vh * sc) / 2;   // object-fit: cover
  guide.style.cssText = `left:${ox + curBox.x * vw * sc}px;top:${oy + curBox.y * vh * sc}px;width:${curBox.w * vw * sc}px;height:${curBox.h * vh * sc}px;transform:none;max-width:none;aspect-ratio:auto;${locked ? "border-color:var(--accent)" : ""}`;
}

function stopWatch() { clearInterval(watchTimer); watchTimer = null; document.querySelector(".guide")?.classList.remove("steady"); }

async function smartBurst(video, say, opt = {}) {
  clearInterval(watchTimer); watchTimer = null;
  while (grabbing) await settle(30);
  const tap = Date.now(), shots = [];
  if (firstShot && tap - firstShot.at < FIRST_MAX_AGE) shots.push(firstShot);
  shots.push(...preroll);
  const end = performance.now() + (opt.night ? 4000 : BONUS_MS), max = opt.night ? 16 : BONUS_MAX;
  for (let i = 1; i <= max && performance.now() < end; i++) {
    say(opt.night ? `Night frame ${i}… hold very still` : `Bonus round ${i}… hold still`);
    if (lockOn) trackPlate(video, document.querySelector(".guide"));
    const m = measure(video, video.videoWidth, video.videoHeight); lastMove = m.move;
    shots.push(await grabFrame(video, "bonus", { round: i }));
    await settle(60);
  }
  shots.sort((a, b) => a.at - b.at);
  shots.forEach((s) => (s.smart.seconds_before_tap = +((tap - s.at) / 1000).toFixed(1)));
  [...shots].sort((a, b) => b.smart.sharpness - a.smart.sharpness).forEach((s, i) => (s.smart.rank = i + 1));
  if (opt.night) shots.forEach((s) => (s.smart.night = true));
  firstShot = null; preroll = [];
  return shots;
}

const roleName = (s) => (s.smart.role === "first_shot" ? "First Shot" : s.smart.role === "steadying" ? "While steadying" : s.smart.role === "video_frame" ? `Video at ${s.smart.time_s}s`
  : s.smart.night ? `Night frame ${s.smart.round}` : `Bonus round ${s.smart.round}`);
function smartReview(shots, urls) {
  const top = Math.max(...shots.map((s) => s.smart.sharpness), 1);
  const best = shots.map((s, i) => ({ s, u: urls[i] })).filter((x) => x.s.smart.rank <= 3).sort((a, b) => a.s.smart.rank - b.s.smart.rank);
  return h("div", {},
    h("div", { class: "best" }, best.map(({ s, u }) => h("figure", {},
      h("img", { src: u, alt: `Sharpest #${s.smart.rank}` }),
      h("span", { class: s.smart.rank === 1 ? "tag top" : "tag" }, `#${s.smart.rank} sharpest`),
      h("figcaption", {}, `${roleName(s)}${s.smart.seconds_before_tap == null ? "" : s.smart.seconds_before_tap > 0 ? " · " + s.smart.seconds_before_tap + "s before tap" : " · after tap"}${s.smart.steady ? " · steady ✓" : ""}`,
        h("div", { class: "meter" }, h("i", { style: `width:${Math.round((s.smart.sharpness / top) * 100)}%` })))))),
    h("p", { class: "small muted" }, `All ${shots.length} frames, in order. All of them are sent: blurry ones still help build a sharper copy.`),
    h("div", { class: "grid" }, shots.map((s, i) => h("figure", {}, h("img", { src: urls[i], alt: roleName(s) }),
      h("span", { class: s.smart.rank === 1 ? "tag top" : "tag" }, s.smart.role === "first_shot" ? "1st" : `#${s.smart.rank}`)))));
}

// ---------- Upload a clip or photo (dashcam, doorbell camera, phone gallery) ----------
// The original file is fingerprinted as it is chosen and sent unchanged. It was not taken by this camera,
// so it is marked "uploaded_file" for investigators; detail lost before upload can't come back.
function uploadButton(small) {
  const input = h("input", { type: "file", accept: "video/*,image/*", style: "display:none" });
  input.addEventListener("change", async () => { const f = input.files[0]; input.value = ""; if (f) await handleUpload(f); });
  const btn = h("button", { class: "ghost", style: small ? "" : "width:100%", onclick: () => input.click() }, small ? "Upload" : "⬆ Upload a dashcam / doorbell clip or photo");
  return h("span", {}, btn, input);
}
async function handleUpload(file) {
  stopVoice(); stopCamera();
  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" }, h("h1", {}, "Reading your file…"), h("p", { class: "muted" }, file.name))));
  if (file.size > MAX_BYTES) return uploadError(`That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${MAX_BYTES / 1048576} MB; trim the clip to the seconds with the vehicle and try again.`);
  const isVid = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
  const ext = (file.name.match(/\.([a-z0-9]{2,5})$/i) || [, isVid ? "mp4" : "jpg"])[1].toLowerCase();
  const shot = { kind: isVid ? "video" : "photo", blob: file, at: new Date(file.lastModified || Date.now()), sha256: await sha256(file), mime: file.type || (isVid ? "video/mp4" : "image/jpeg"), ext,
    source_type: "uploaded_file", uploaded: { name: file.name.slice(0, 120), bytes: file.size, file_modified: new Date(file.lastModified || Date.now()).toISOString(), chosen_at: new Date().toISOString() } };
  if (!isVid) return review([shot]);
  try {
    const frames = await pickVideoFrames(shot, (t) => $app.querySelector("p").textContent = t);
    review([shot, ...frames]);
  } catch (e) { review([shot]); }
}
function uploadError(t) { $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" }, h("h1", {}, "Can't use that file"), h("p", {}, t), h("button", { style: "width:100%", onclick: () => go() }, "Back")))); }

// ---------- Video frame picker: the sharpest moments in a video ----------
async function pickVideoFrames(vshot, say) {
  const url = URL.createObjectURL(vshot.blob), v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("this phone can't open that video type")); setTimeout(() => rej(new Error("the video took too long to open")), 15000); });
  const dur = isFinite(v.duration) ? v.duration : 0;
  if (!dur || !v.videoWidth) { URL.revokeObjectURL(url); throw new Error("the video has no readable frames"); }
  const seek = (t) => new Promise((res) => { v.onseeked = () => res(); v.currentTime = t; });
  const N = Math.min(80, Math.max(8, Math.round(dur * 6))), scored = [];
  const saveBox = curBox; curBox = { ...DEF_BOX };
  for (let i = 0; i < N; i++) {
    const t = Math.min(dur - 0.05, ((i + 0.5) / N) * dur); await seek(t);
    const f = findPlate(v, v.videoWidth, v.videoHeight), box = f || DEF_BOX;
    prevGray = null; const m = measure(v, v.videoWidth, v.videoHeight, box);
    scored.push({ t, sharp: m.sharp, box, locked: !!f });
    say(`Checking frame ${i + 1} of ${N}…`);
  }
  // keep the 6 sharpest, at least 0.3 s apart
  const keep = [];
  for (const c of scored.slice().sort((a, b) => b.sharp - a.sharp)) { if (keep.every((k) => Math.abs(k.t - c.t) > 0.3)) keep.push(c); if (keep.length === 6) break; }
  keep.sort((a, b) => a.t - b.t);
  const out = [];
  for (const k of keep) {
    await seek(k.t);
    const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95)); c.width = c.height = 0;
    out.push({ kind: "photo", blob, at: new Date(vshot.at.getTime() + k.t * 1000), sha256: await sha256(blob), mime: "image/jpeg", source_type: "derivative",
      smart: { role: "video_frame", time_s: +k.t.toFixed(2), sharpness: Math.round(k.sharp), box: k.box, plate_lock: k.locked, from_video_sha256: vshot.sha256 } });
  }
  [...out].sort((a, b) => b.smart.sharpness - a.smart.sharpness).forEach((s, i) => (s.smart.rank = i + 1));
  curBox = saveBox; URL.revokeObjectURL(url);
  return out;
}

// ---------- Clearer copy: stack → measure the blur → unblur preview → Texas Match ----------
// 1. Line up the sharpest frames on the plate and average them (night frames get brightened after).
// 2. Measure the blur from the gray ramp at the letter edges (PlateTrace's own measurement).
// 3. Unblur with Richardson–Lucy using that measured blur; nothing is drawn in.
// 4. Texas Match: real Texas letter shapes, blurred the same way, compared with the plate. Leads only.
const loaded = {};
function loadScript(src) { return (loaded[src] ||= new Promise((res, rej) => { const e = document.createElement("script"); e.src = src; e.onload = res; e.onerror = () => { delete loaded[src]; rej(new Error("couldn't load " + src)); }; document.head.append(e); })); }
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);
const STATES = [["tx", "Texas (Classic ABC-1234)"]];   // more states are added the same way, one letter-shape set each

async function plateCrop(shot, W) {
  const bmp = await createImageBitmap(shot.blob), b = shot.smart?.box || DEF_BOX;
  const pad = 0.08, x = Math.max(0, (b.x - b.w * pad) * bmp.width), y = Math.max(0, (b.y - b.h * pad) * bmp.height);
  const w = Math.min(bmp.width - x, b.w * (1 + 2 * pad) * bmp.width), hh = Math.min(bmp.height - y, b.h * (1 + 2 * pad) * bmp.height);
  const H = Math.round((W * hh) / w), c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.imageSmoothingQuality = "high"; ctx.drawImage(bmp, x, y, w, hh, 0, 0, W, H); bmp.close?.();
  return { img: ctx.getImageData(0, 0, W, H), scale: W / w };
}
function grayOfImg(img) { const g = new Float32Array(img.width * img.height); for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2]; return g; }
function bestShift(ref, g, W, H, R, step, cx = 0, cy = 0) {
  let best = { dx: cx, dy: cy, e: Infinity };
  const x0 = Math.floor(W * 0.15), x1 = Math.floor(W * 0.85), y0 = Math.floor(H * 0.15), y1 = Math.floor(H * 0.85);
  for (let dy = cy - R; dy <= cy + R; dy++) for (let dx = cx - R; dx <= cx + R; dx++) {
    let e = 0, n = 0;
    for (let y = y0; y < y1; y += step) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let x = x0; x < x1; x += step) { const xx = x + dx; if (xx < 0 || xx >= W) continue; e += Math.abs(ref[y * W + x] - g[yy * W + xx]); n++; } }
    e /= Math.max(1, n); if (e < best.e) best = { dx, dy, e };
  }
  return best;
}
async function stackFrames(shots, W, night, say) {
  const ref = await plateCrop(shots[0], W), Hh = ref.img.height, rg = grayOfImg(ref.img);
  const acc = new Float32Array(W * Hh * 3), cnt = new Float32Array(W * Hh), used = [];
  const add = (img, dx, dy, wt) => { for (let y = 0; y < Hh; y++) { const yy = y + dy; if (yy < 0 || yy >= Hh) continue;
    for (let x = 0; x < W; x++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const j = (yy * W + xx) * 4, i = y * W + x;
      acc[i * 3] += wt * img.data[j]; acc[i * 3 + 1] += wt * img.data[j + 1]; acc[i * 3 + 2] += wt * img.data[j + 2]; cnt[i] += wt; } } };
  add(ref.img, 0, 0, 1); used.push({ sha256: shots[0].sha256, dx: 0, dy: 0 });
  for (let k = 1; k < shots.length; k++) {
    say(`Lining up frame ${k + 1} of ${shots.length}…`); await settle(0);
    const c = await plateCrop(shots[k], W); if (c.img.height !== Hh) continue;
    const g = grayOfImg(c.img), R = Math.round(W * 0.04);
    let s1 = bestShift(rg, g, W, Hh, R, 4); s1 = bestShift(rg, g, W, Hh, 2, 1, s1.dx, s1.dy);
    if (s1.e > 40) continue;                          // didn't line up (different scene): leave it out
    const wt = night ? 1 : clampN((shots[k].smart?.sharpness || 1) / (shots[0].smart?.sharpness || 1), 0.4, 1);
    add(c.img, s1.dx, s1.dy, wt); used.push({ sha256: shots[k].sha256, dx: s1.dx, dy: s1.dy, weight: +wt.toFixed(2) });
  }
  const out = new ImageData(W, Hh);
  for (let i = 0; i < W * Hh; i++) { const n = cnt[i] || 1; out.data[i * 4] = acc[i * 3] / n; out.data[i * 4 + 1] = acc[i * 3 + 1] / n; out.data[i * 4 + 2] = acc[i * 3 + 2] / n; out.data[i * 4 + 3] = 255; }
  let gain = null;
  if (night) {                                        // brighten: stretch the 1%–99% brightness range of the real pixels
    const g = grayOfImg(out), srt = Float32Array.from(g).sort(), lo = srt[Math.floor(srt.length * 0.01)], hi = srt[Math.floor(srt.length * 0.99)], span = Math.max(8, hi - lo);
    for (let j = 0; j < out.data.length; j += 4) for (let c = 0; c < 3; c++) out.data[j + c] = clampN(((out.data[j + c] - lo) / span) * 255, 0, 255);
    gain = { from: [Math.round(lo), Math.round(hi)], to: [0, 255] };
  }
  return { img: out, used, scale: ref.scale, gain };
}
function gaussBlurF(src, w, hh, sig) {
  const r = Math.max(1, Math.ceil(sig * 3)), k = []; let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sig * sig)); k.push(v); s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + clampN(x + i, 0, w - 1)]; tmp[y * w + x] = a; }
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * tmp[clampN(y + i, 0, hh - 1) * w + x]; out[y * w + x] = a; }
  return out;
}
async function unblurGray(img, sigma, iters, say) {      // Richardson–Lucy, Gaussian blur of the measured size
  const w = img.width, hh = img.height, obs = grayOfImg(img).map((v) => v + 1);
  let est = Float32Array.from(obs);
  for (let it = 0; it < iters; it++) {
    const conv = gaussBlurF(est, w, hh, sigma), ratio = new Float32Array(obs.length);
    for (let i = 0; i < obs.length; i++) ratio[i] = obs[i] / (conv[i] + 1e-3);
    const corr = gaussBlurF(ratio, w, hh, sigma);
    for (let i = 0; i < est.length; i++) est[i] = clampN(est[i] * corr[i], 0, 400);
    say(`Unblurring… ${Math.round(((it + 1) / iters) * 100)}%`); await settle(0);
  }
  const out = new ImageData(w, hh);
  for (let i = 0; i < est.length; i++) { const v = clampN(est[i] - 1, 0, 255); out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255; }
  return out;
}
// The Match test needs the plate itself, edge to edge: find the bright plate rectangle inside the crop.
function tightPlate(img) {
  const w = img.width, hh = img.height, g = grayOfImg(img), hist = new Float32Array(256);
  for (const v of g) hist[Math.round(v)]++;
  let sum = 0, sumB = 0, wB = 0, best = 0, thr = 128; for (let i = 0; i < 256; i++) sum += i * hist[i];
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = g.length - wB; if (!wF) break; sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } }   // Otsu
  const span = (prof, lim) => { let bi = 0; for (let i = 0; i < prof.length; i++) if (prof[i] > prof[bi]) bi = i;
    let a = bi, b = bi; while (a > 0 && prof[a - 1] > lim) a--; while (b < prof.length - 1 && prof[b + 1] > lim) b++; return [a, b]; };
  const rows = new Float32Array(hh); for (let y = 0; y < hh; y++) { let n = 0; for (let x = 0; x < w; x++) if (g[y * w + x] > thr) n++; rows[y] = n / w; }
  const [y0, y1] = span(rows, 0.3);
  const cols = new Float32Array(w); for (let x = 0; x < w; x++) { let n = 0; for (let y = y0; y <= y1; y++) if (g[y * w + x] > thr) n++; cols[x] = n / (y1 - y0 + 1); }
  const sm = cols.map((_, x) => Math.max(cols[Math.max(0, x - 3)], cols[x], cols[Math.min(w - 1, x + 3)]));
  const [x0, x1] = span(sm, 0.45);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < w * 0.3 || bh < hh * 0.3 || bw / bh < 1.4 || bw / bh > 3.2) return img;          // no clear plate: use the whole crop
  const c = document.createElement("canvas"); c.width = w; c.height = hh; c.getContext("2d").putImageData(img, 0, 0);
  return c.getContext("2d").getImageData(x0, y0, bw, bh);
}
const imgCanvas = (img) => { const c = h("canvas", {}); c.width = img.width; c.height = img.height; c.getContext("2d").putImageData(img, 0, 0); return c; };

function clearerPanel(allShots, photos, auto) {
  const night = photos.some((s) => s.smart?.night);
  const stateSel = h("select", {}, STATES.map(([k, l]) => h("option", { value: k }, l)), h("option", { value: "", disabled: true }, "Other states: coming soon"));
  const status = h("p", { class: "small muted" }, photos.length > 1 ? `Lines up the ${Math.min(8, photos.length)} sharpest frames on the plate, measures the blur, then unblurs and checks the letters.` : "Measures the blur on this photo, then unblurs it and checks the letters.");
  const out = h("div", {});
  const go = h("button", { style: "width:100%;margin-top:6px", onclick: () => run() }, night ? "Build night copy" : "Build clearer copy");
  async function run() {
    go.disabled = true; out.replaceChildren(); const say = (t) => (status.textContent = t);
    try {
      say("Loading PlateTrace's measuring tools…");
      await Promise.all([loadScript("../integrity.js"), loadScript("../match.js")]);
      const use = photos.filter((s) => s.smart || photos.length === 1).sort((a, b) => (a.smart?.rank || 1) - (b.smart?.rank || 1)).slice(0, night ? 16 : 8);
      const first = await plateCrop(use[0], 100), nat = 100 / first.scale;   // native crop width in original pixels
      const W = Math.round(clampN(nat * 2, 240, 900));
      const st = await stackFrames(use, W, night, say);
      const up = st.scale;
      say("Measuring the blur from the gray at the letter edges…"); await settle(0);
      const A = PTIntegrity.assess({ img: st.img, frames: null, source_type: use[0].source_type === "uploaded_file" ? "processed_image" : "processed_image", ops: ["frame stacking"], up });
      const sigW = A.measurements.blur_sigma_px != null ? A.measurements.blur_sigma_px * up : null;
      let ub = null;
      if (sigW && sigW >= 0.6 && A.measurements.edges_measured >= 20) ub = await unblurGray(st.img, Math.min(sigW, 12), 14, say);
      let M = null;
      if (stateSel.value === "tx") { say("Texas Match: comparing real Texas letter shapes, blurred the same way…"); M = await PTMatch.run(tightPlate(ub || st.img), {}, (f) => say(`Texas Match… ${Math.round(f * 100)}%`)); }
      say("");
      const conf = Math.round((A.confidence || 0) * 100);
      out.replaceChildren(
        h("p", { class: "small", style: "margin:8px 0 4px" }, h("b", {}, `Combined copy (${st.used.length} frame${st.used.length === 1 ? "" : "s"}${night ? ", brightened" : ""})`)), imgCanvas(st.img),
        ub ? h("p", { class: "small", style: "margin:10px 0 4px" }, h("b", {}, "Unblurred preview")) : null, ub ? imgCanvas(ub) : null,
        h("p", { class: "small muted" }, A.measurements.blur_sigma_px != null
          ? `Blur measured: about ${A.blur_radius_est} px wide in the original, from ${A.measurements.edges_measured} letter edges. Letter strokes: ${A.stroke_width_est ?? "not measurable"} px. ${A.signal_present ? "The letters are wider than the blur, so real detail is there to recover." : "The blur is as wide as the letters or the edges are too faint, so detail may not be recoverable."} Confidence ${conf}%.`
          : "Not enough clear letter edges to measure the blur, so no unblur was run. Try a closer or steadier capture."),
        M ? h("div", { class: "match" }, h("p", { class: "small", style: "margin:10px 0 4px" }, h("b", {}, "Texas Match (lead, not an identification)")),
          h("div", { class: "plate" }, [...M.mask].map((ch, i) => h("span", { class: ch === "?" ? "q" : "" }, ch, i === 2 ? h("i", {}, "") : null))),
          h("p", { class: "small muted" }, `Fit ${Math.round(M.fit * 100)}%${M.enough_detail ? "" : " (too weak to call any letter)"}. "?" means no single letter clearly won. Top choices: ` + M.positions.map((p) => `${p.pos}: ${p.top.map((t) => t.ch).join("/")}`).join(" · "))) : null,
        h("p", { class: "small muted" }, "Built only from the recorded pixels: lined up, averaged and unblurred by the measured amount. Nothing is drawn in. The original frames are always sent; this copy is extra."),
        h("button", { class: "ghost", style: "width:100%;margin-top:8px", onclick: async (e) => {
          e.target.disabled = true;
          const pick = ub || st.img, c = imgCanvas(pick), blob = await new Promise((r) => c.toBlob(r, "image/png"));
          const rec = { method: `${st.used.length}-frame stack${night ? " + brightness stretch" : ""}${ub ? ` + Richardson–Lucy unblur (Gaussian sigma ${sigW.toFixed(2)} px, 14 iterations)` : ""}`, frames: st.used, brightness: st.gain,
            assessment: { blur_radius_px: A.blur_radius_est, stroke_px: A.stroke_width_est, signal_present: A.signal_present, confidence: A.confidence, failed_checks: A.failed_checks },
            texas_match: M ? { plate: M.plate, fit: M.fit, enough_detail: M.enough_detail, lead_only: true } : null };
          allShots.push({ kind: "photo", blob, at: new Date(), sha256: await sha256(blob), mime: "image/png", source_type: "derivative", clearer: rec });
          e.target.textContent = "Added ✓ (sent with the originals)";
        } }, "Add this copy to what I send"));
    } catch (e) { say("Couldn't build it: " + (e.message || e)); }
    go.disabled = false;
  }
  if (auto) setTimeout(run, 300);
  return { el: h("div", { class: "chan" }, h("h3", {}, night ? "Night copy" : "Clearer copy"), h("label", { class: "small" }, "Plate style: ", stateSel), status, go, out) };
}

// ---------- Color channels (a viewing aid; the original photos are never changed) ----------
// Every pixel is red + green + blue light. Plate letters often stand out much more in one of the three.
function channelPanel(blob) {
  const cv = h("canvas", {}), boost = h("input", { type: "range", min: 1, max: 4, step: 0.1, value: 1.6 }), bl = h("span", {}, "1.6×");
  const info = h("p", { class: "small muted", style: "margin:6px 0 0" }, "Loading…");
  const VIEWS = [["orig", "Original"], ["r", "Red"], ["g", "Green"], ["b", "Blue"], ["color", "Color only"], ["ink", "Ink map"], ["blur", "Blur gray"]];
  const HELP = {
    ink: "Ink map: each pixel shown as how much black letter ink is in it (darker = more ink). Colored pixels (plate art, glare, reflections) can't be letter ink, so they're hidden as white.",
    blur: "Blur gray: only the in-between grays, the letter smeared into the background. Solid letter is blue, background and colored pixels are white. The grays are spread out so small differences show.",
  };
  let view = "orig", base = null, best = null, bg0 = 220, ink0 = 30, blurPct = 0, baseInfo = "";
  const CH = 35;                                                       // more color spread than this = not black/white/gray
  const lum = (d, j) => 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  const chroma = (d, j) => Math.max(d[j], d[j + 1], d[j + 2]) - Math.min(d[j], d[j + 1], d[j + 2]);
  const inkOf = (d, j) => Math.min(1, Math.max(0, (bg0 - lum(d, j)) / Math.max(1, bg0 - ink0)));
  const btns = VIEWS.map(([k, label]) => h("button", { class: k === view ? "sel" : "", onclick: () => { view = k; btns.forEach((b, i) => (b.className = VIEWS[i][0] === k ? "sel" : ""));
    info.textContent = HELP[k] ? HELP[k] + (k === "blur" ? ` About ${blurPct}% of the plate area is blur gray.` : "") + " Original photo is sent unchanged." : baseInfo; draw(); } }, label));
  boost.addEventListener("input", () => { bl.textContent = `${(+boost.value).toFixed(1)}×`; draw(); });
  const pick = (d, j, k) => (k === "r" ? d[j] : k === "g" ? d[j + 1] : k === "b" ? d[j + 2] : Math.max(d[j], d[j + 1], d[j + 2]) - Math.min(d[j], d[j + 1], d[j + 2]));
  function draw() {
    if (!base) return;
    const ctx = cv.getContext("2d");
    if (view === "orig") { ctx.putImageData(base, 0, 0); return; }
    if (view === "ink" || view === "blur") {
      const d = base.data, out = new ImageData(base.width, base.height), o = out.data, k = +boost.value;
      for (let j = 0; j < d.length; j += 4) {
        let r, g, b;
        if (chroma(d, j) > CH) r = g = b = 255;                          // colored: not letter ink
        else {
          const ink = inkOf(d, j);
          if (view === "ink") { let v = 128 + ((1 - ink) * 255 - 128) * k; r = g = b = v < 0 ? 0 : v > 255 ? 255 : v; }
          else if (ink >= 0.88) { r = 30; g = 70; b = 160; }             // solid letter
          else if (ink <= 0.12) r = g = b = 255;                           // clean background
          else { let v = 128 + ((1 - (ink - 0.12) / 0.76) * 255 - 128) * k; r = g = b = v < 0 ? 0 : v > 255 ? 255 : v; }
        }
        o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255;
      }
      ctx.putImageData(out, 0, 0); return;
    }
    const d = base.data, out = new ImageData(base.width, base.height), o = out.data, hist = new Uint32Array(256), n = d.length / 4;
    for (let j = 0; j < d.length; j += 4) hist[pick(d, j, view)]++;
    let lo = 0, hi = 255, c = 0;                                       // stretch the 2%–98% range, then boost
    for (; lo < 255 && (c += hist[lo]) < n * 0.02; lo++); c = 0;
    for (; hi > 0 && (c += hist[hi]) < n * 0.02; hi--);
    const span = Math.max(1, hi - lo), k = +boost.value;
    for (let j = 0; j < d.length; j += 4) { let v = ((pick(d, j, view) - lo) / span) * 255; v = 128 + (v - 128) * k; v = v < 0 ? 0 : v > 255 ? 255 : v; o[j] = o[j + 1] = o[j + 2] = v; o[j + 3] = 255; }
    ctx.putImageData(out, 0, 0);
  }
  createImageBitmap(blob).then((bmp) => {
    const sc = Math.min(1, 1100 / bmp.width); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
    const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
    base = ctx.getImageData(0, 0, cv.width, cv.height);
    // Which layer has the most contrast in the plate area (center)?
    const W = cv.width, H = cv.height, sd = {};
    for (const k of ["r", "g", "b"]) { let s = 0, s2 = 0, n = 0;
      for (let y = Math.floor(H * 0.32); y < H * 0.58; y += 2) for (let x = Math.floor(W * 0.25); x < W * 0.75; x += 2) { const v = pick(base.data, (y * W + x) * 4, k); s += v; s2 += v * v; n++; }
      sd[k] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)); }
    best = Object.keys(sd).sort((a, b) => sd[b] - sd[a])[0];
    // Measure this photo's own "black" (letters) and "white" (background) from the gray pixels in the plate area.
    const hist = new Uint32Array(256); let gn = 0;
    for (let y = Math.floor(H * 0.32); y < H * 0.58; y++) for (let x = Math.floor(W * 0.25); x < W * 0.75; x++) { const j = (y * W + x) * 4; if (chroma(base.data, j) <= CH) { hist[Math.round(lum(base.data, j))]++; gn++; } }
    const pct = (p) => { let c = 0; for (let v = 0; v < 256; v++) if ((c += hist[v]) >= gn * p) return v; return 255; };
    if (gn > 50) { ink0 = pct(0.03); bg0 = Math.max(ink0 + 20, pct(0.95)); }
    let bc = 0, bt = 0;
    for (let y = Math.floor(H * 0.32); y < H * 0.58; y += 2) for (let x = Math.floor(W * 0.25); x < W * 0.75; x += 2) { const j = (y * W + x) * 4; bt++; if (chroma(base.data, j) <= CH) { const i = inkOf(base.data, j); if (i > 0.12 && i < 0.88) bc++; } }
    blurPct = Math.round((bc / Math.max(1, bt)) * 100);
    const name = { r: "Red", g: "Green", b: "Blue" };
    btns.forEach((b, i) => { if (VIEWS[i][0] === best) b.textContent = `${name[best]} ★`; });
    info.textContent = baseInfo = `Letters measured at ${ink0}, background at ${bg0} (0 = black, 255 = white). ★ ${name[best]} has the most contrast in the plate area. Tap each layer and pick the one where the letters are clearest. This is only a view: the original photo is sent unchanged.`;
    draw();
  }).catch(() => (info.textContent = "This phone couldn't open the photo for color layers."));
  return { el: h("div", { class: "chan" }, h("h3", {}, "Color channels"), cv, h("div", { class: "views" }, btns), h("div", { class: "row" }, "Color boost", boost, bl), info),
    view: () => ({ view, boost: +boost.value, highest_contrast: best, letter_level: ink0, background_level: bg0, blur_gray_pct: blurPct }) };
}

// ---------- account & monthly plan ($2.99/month, 3-day free trial) ----------
// The camera opens instantly when the phone already has a recent plan check saved; the plan is
// re-checked quietly in the background. Without one, the person signs in and the plan is checked first.
const PLAN_URL = "https://buy.stripe.com/7sY7sNceAfWx54Z7XPak00d";
const PASS_KEY = "pt_cam_pass", DAY = 864e5;
const getPass = () => { try { return JSON.parse(store.get(PASS_KEY) || "null"); } catch { return null; } };
const passOk = () => { const p = getPass(); return p && p.until > Date.now() ? p : null; };

async function checkPlan() {
  const sb = await getSb();
  if (!sb) return { offline: true };
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { signin: true };
  const { data, error } = await sb.functions.invoke("platetrace-billing", { body: {} });
  if (data?.camera) {
    const c = data.camera;
    store.set(PASS_KEY, JSON.stringify({ until: Date.now() + DAY, checked: Date.now(), plan: c.plan, status: c.status, trial_end: c.trial_end || null, email: session.user.email }));
    return { ok: true };
  }
  if (error && !data) return { offline: true };
  store.set(PASS_KEY, "");
  return { plans: true, email: session.user.email, id: session.user.id };
}

function screen(...kids) { $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "intro" }, ...kids))); }
const go = () => (store.get("pt_cam_seen") ? startCamera() : intro());

async function gate() {
  screen(h("h1", {}, "Plate", h("span", {}, "Trace"), " Camera"), h("p", { class: "muted" }, "Checking your plan…"));
  const r = await checkPlan();
  if (r.ok) return go();
  if (r.signin) return signIn();
  if (r.plans) return plansScreen(r);
  const p = getPass();                                      // no signal: allow a recent subscriber for up to 7 days
  if (p?.checked && Date.now() - p.checked < 7 * DAY) return go();
  screen(h("h1", {}, "No connection"), h("p", {}, "PT Camera needs the internet to check your plan. Connect and try again."), h("button", { style: "width:100%", onclick: gate }, "Try again"));
}

function signIn(msgText) {
  let creating = false;
  const email = h("input", { type: "email", placeholder: "Email", autocomplete: "email", class: "field" });
  const pass = h("input", { type: "password", placeholder: "Password (8+ characters)", autocomplete: "current-password", class: "field" });
  const msg = h("p", { class: "small" }, msgText || "");
  const title = h("h1", {}, "Sign in");
  const mainBtn = h("button", { style: "width:100%;margin-top:10px" }, "Sign in");
  const swap = h("button", { class: "ghost", style: "width:100%;margin-top:10px" }, "New here? Create an account");
  const forgot = h("button", { class: "ghost", style: "width:100%;margin-top:10px" }, "Forgot password");
  swap.onclick = () => { creating = !creating; title.textContent = creating ? "Create your account" : "Sign in"; mainBtn.textContent = creating ? "Create account" : "Sign in";
    swap.textContent = creating ? "Have an account? Sign in" : "New here? Create an account"; pass.autocomplete = creating ? "new-password" : "current-password"; msg.textContent = ""; };
  mainBtn.onclick = async () => {
    const e = email.value.trim(), pw = pass.value;
    if (!e || pw.length < 8) { msg.className = "small err"; msg.textContent = "Enter your email and a password of 8 or more characters."; return; }
    mainBtn.disabled = true; msg.className = "small muted"; msg.textContent = creating ? "Creating your account…" : "Signing in…";
    const sb = await getSb();
    if (!sb) { mainBtn.disabled = false; msg.className = "small err"; msg.textContent = "No connection. Try again when you have signal."; return; }
    const res = creating ? await sb.auth.signUp({ email: e, password: pw, options: { emailRedirectTo: location.href.split("#")[0] } }) : await sb.auth.signInWithPassword({ email: e, password: pw });
    mainBtn.disabled = false;
    if (res.error) { msg.className = "small err"; msg.textContent = res.error.message; return; }
    if (!res.data.session) { msg.className = "small ok"; msg.textContent = "Check your email and tap the link to confirm your account, then come back and sign in."; return; }
    gate();
  };
  forgot.onclick = async () => {
    const e = email.value.trim();
    if (!e) { msg.className = "small err"; msg.textContent = "Type your email first."; return; }
    const sb = await getSb(); if (!sb) return;
    const { error } = await sb.auth.resetPasswordForEmail(e, { redirectTo: location.href.split("#")[0] });
    msg.className = error ? "small err" : "small ok"; msg.textContent = error ? error.message : "Check your email for a link to set a new password.";
  };
  screen(title, h("p", { class: "muted" }, "PT Camera is $2.99 a month with a 3-day free trial. Sign in or create an account to start."), email, pass, mainBtn, msg, swap, forgot);
}

function newPassword() {
  const pass = h("input", { type: "password", placeholder: "New password (8+ characters)", autocomplete: "new-password", class: "field" }), msg = h("p", { class: "small" });
  screen(h("h1", {}, "Set a new password"), pass, h("button", { style: "width:100%;margin-top:10px", onclick: async () => {
    if (pass.value.length < 8) { msg.className = "small err"; msg.textContent = "Use 8 or more characters."; return; }
    const { error } = await (await getSb()).auth.updateUser({ password: pass.value });
    if (error) { msg.className = "small err"; msg.textContent = error.message; } else gate();
  } }, "Save password"), msg);
}

function plansScreen(r) {
  const q = new URLSearchParams({ prefilled_email: String(r.email || "").toLowerCase(), client_reference_id: r.id || "" });
  screen(h("h1", {}, "Start your free trial"),
    h("div", { class: "plancard" },
      h("div", { class: "planname" }, "PT Camera"),
      h("div", { class: "planprice" }, "$2.99", h("span", { class: "small muted" }, " / month")),
      h("ul", {}, h("li", {}, "Smart burst: First Shot + bonus rounds, sharpest 3 on top"), h("li", {}, "Color channels, Ink map and Blur gray"),
        h("li", {}, "Special light modes and anti-glare"), h("li", {}, "Send photos and videos to PlateTrace, fingerprinted")),
      h("p", { class: "small muted" }, "3 days free, then $2.99 a month plus any sales tax. Cancel any time before the trial ends and you won't be charged."),
      h("a", { class: "btnlink", href: `${PLAN_URL}?${q}`, target: "_blank", rel: "noopener" }, "Start 3-day free trial")),
    h("p", { class: "small muted" }, `Use ${r.email} at checkout so your plan is linked to this account.`),
    h("button", { class: "ghost", style: "width:100%;margin-top:10px", onclick: gate }, "I've subscribed, check again"),
    h("button", { class: "ghost", style: "width:100%;margin-top:10px", onclick: signOut }, "Sign out"));
}

async function signOut() { stopVoice(); stopCamera(); store.set(PASS_KEY, ""); const sb = await getSb(); await sb?.auth.signOut().catch(() => {}); signIn(); }

function boot() {
  if (/type=recovery/.test(location.hash)) {                // came back from a "set a new password" email
    getSb().then((sb) => sb && sb.auth.onAuthStateChange((ev) => { if (ev === "PASSWORD_RECOVERY") newPassword(); }));
    return screen(h("p", { class: "muted" }, "One moment…"));
  }
  if (passOk()) {
    go();
    setTimeout(() => checkPlan().catch(() => {}), 4000);    // refresh quietly; a lapsed plan is caught on the next open
  } else gate();
}

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
