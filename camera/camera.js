/* PlateTrace Camera: a free camera for the public that takes plate-friendly photos and videos
   and sends them to PlateTrace. Each file is fingerprinted (SHA-256) the moment it is captured,
   with the time and, if allowed, the GPS location. Sending is anonymous unless the person adds
   contact details. Files go to PlateTrace's private storage; the public can't see anyone's tips. */
"use strict";

const SB_URL = "https://wbugdujmydwmzemccbiy.supabase.co";
const SB_KEY = "sb_publishable_4RYit1aVs5Egh3gJsx2bJA_m6Kje0ES";
const BUCKET = "platetrace-tips";
const MAX_VIDEO_S = 60, MAX_BYTES = 48 * 1024 * 1024, BURST = 5;
const sb = window.supabase ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;   // camera still works offline; sending needs this
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
      h("li", {}, "Use ", h("b", {}, "Burst"), " for 5 quick photos. More shots help PlateTrace combine a sharper copy."),
      h("li", {}, "Video works best when you can follow the vehicle for a few seconds."),
      h("li", {}, "Hands busy? Tap ", h("b", {}, "🎤 Voice"), " and say \"camera activate\" to start recording, \"camera stop\" to finish. You can also say \"photo\", \"burst\", \"zoom in\" or \"anti-glare\".")),
    h("div", { class: "notice" }, h("b", {}, "Stay safe. "), "Never use the camera while driving, never follow or confront anyone, and only film from public places. In an emergency, call 911 first. Tips sent here are not watched in real time."),
    h("p", { class: "small muted" }, "What you send: the photo or video, the time, and your location if you allow it. Sending is anonymous unless you choose to add contact details. Only PlateTrace staff can see what you send."),
    h("button", { style: "width:100%;margin-top:8px", onclick: () => { store.set("pt_cam_seen", "1"); startCamera(); } }, "Open the camera"),
    introVoice(),
    h("p", { class: "small muted", style: "margin-top:14px" }, "Tip: add this page to your home screen to use it like an app."))));
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

function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; track = null; }

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
  const view = h("div", { class: "view" }, video, h("div", { class: "guide" }), dot, status);

  view.addEventListener("click", async (e) => {
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
  const MODES = ["photo", "burst", "video", "special"];
  const pick = (m) => { if (recorder || mode === m) return; mode = m; modeBtns.forEach((b, i) => (b.className = MODES[i] === m ? "sel" : "")); paintShutter(); };
  const modeBtns = MODES.map((m) => h("button", { class: m === mode ? "sel" : "", onclick: () => pick(m) }, { photo: "Photo", burst: "Burst ×5", video: "Video", special: "Special light" }[m]));
  const special = specialPanel(() => paintShutter());
  const paintShutter = () => { shutter.className = mode === "video" ? "shutter rec" : "shutter"; shutter.setAttribute("aria-label", mode === "video" ? "Start recording" : "Take photo");
    left.textContent = mode === "burst" ? "5 quick photos" : mode === "video" ? `up to ${MAX_VIDEO_S}s` : mode === "special" ? `${SPECIAL[specialMode].frames} lossless frames` : "";
    special.el.style.display = mode === "special" ? "" : "none"; };
  paintShutter();

  let busy = false;
  shutter.addEventListener("click", async () => {
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
      const shots = [];
      const n = mode === "burst" ? BURST : 1;
      for (let i = 0; i < n; i++) { status.textContent = n > 1 ? `Photo ${i + 1} of ${n}…` : ""; shots.push(await takePhoto(video)); if (n > 1) await new Promise((r) => setTimeout(r, 180)); }
      status.textContent = "";
      review(shots);
    } catch (e) { status.textContent = "Couldn't take the photo: " + (e.message || e); }
    busy = false;
  });

  function flash(t) { status.textContent = t; setTimeout(() => { if (status.textContent === t) status.textContent = ""; }, 2200); }

  $app.replaceChildren(view);
  if (resumeVoice && voiceBtn) { resumeVoice = false; setTimeout(startVoice, 300); }
  if (activateOnOpen) { activateOnOpen = false; setTimeout(() => { pick("video"); if (!recorder) shutter.click(); flash("🎤 Camera activated: recording. Say \"camera stop\" to finish."); }, 600); }
  view.append(h("div", { class: "topbar" }, voiceBtn, glareBtn, torchBtn, closeBtn),
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
function review(shots) {
  const wasVoice = voiceOn; stopVoice(); resumeVoice = wasVoice;
  const isVideo = shots[0].kind === "video";
  const urls = shots.map((s) => URL.createObjectURL(s.blob));
  const media = isVideo ? h("video", { class: "media", src: urls[0], controls: true, playsinline: true })
    : shots.length === 1 ? h("img", { class: "media", src: urls[0], alt: "Your photo" })
    : h("div", { class: "grid" }, urls.map((u) => h("img", { src: u, alt: "Burst photo" })));
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
    if (!sb) { msg.className = "small err"; msg.textContent = "No connection to PlateTrace right now. Save it to your phone and send it later."; sendBtn.disabled = false; retake.disabled = false; return; }
    const loc = useLoc.checked && lastFix ? lastFix : null;
    const group = uuid();
    try {
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i], ext = s.mime.includes("mp4") ? "mp4" : s.mime.includes("webm") ? "webm" : s.mime.includes("png") ? "png" : "jpg";
        const day = s.at.toISOString().slice(0, 10), path = `${day}/${group}_${i + 1}.${ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, s.blob, { contentType: s.mime, upsert: false });
        if (up.error) throw up.error;
        const row = {
          captured_at: s.at.toISOString(), kind: s.kind, file_path: path, sha256: s.sha256, bytes: s.blob.size, mime: s.mime,
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy_m: loc?.accuracy_m ?? null,
          note: note.value.trim() || null, contact: anon.checked ? null : contact.value.trim() || null,
          device: navigator.userAgent.slice(0, 400),
          camera_settings: { group, shot: i + 1, of: shots.length, mode: s.special ? "special" : shots.length > 1 ? "burst" : s.kind, anti_glare: antiGlare,
            capture_mode: s.special ? SPECIAL[s.special.mode].label : null, special: s.special || null,
            source_type: s.special ? (s.special.role === "original" ? "raw_capture" : "derivative") : s.kind === "video" ? "video_frame" : "processed_image", zoom: track?.getSettings?.().zoom ?? null,
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
  const retake = h("button", { class: "ghost", onclick: () => { clearInterval(locTimer); urls.forEach((u) => URL.revokeObjectURL(u)); viewfinder(); } }, "Retake");
  const save = h("button", { class: "ghost", onclick: () => shots.forEach((s, i) => { const a = h("a", { href: urls[i], download: `platetrace_${s.at.toISOString().replace(/[:.]/g, "-")}_${i + 1}${s.special ? "_" + s.special.role : ""}.${s.kind === "video" ? (s.mime.includes("mp4") ? "mp4" : "webm") : s.mime.includes("png") ? "png" : "jpg"}` }); document.body.append(a); a.click(); a.remove(); }) }, "Save to phone");

  $app.replaceChildren(h("div", { class: "screen" }, h("div", { class: "review" },
    h("h2", { style: "margin:4px 0 10px" }, isVideo ? "Your video" : shots[0].special ? `${SPECIAL[shots[0].special.mode].label}: ${shots.length - 1} originals + 1 result` : shots.length > 1 ? `Your ${shots.length} photos` : "Your photo"),
    shots[0].special ? h("p", { class: "kv" }, `Result: ${shots[shots.length - 1].special.method}. The originals are sent too; they are the evidence.`) : null,
    media,
    h("p", { class: "kv" }, `Taken ${shots[0].at.toLocaleString()} · ${(size / 1048576).toFixed(1)} MB`),
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
    h("button", { style: "width:100%", onclick: viewfinder }, "Take another"))));
}

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
if (store.get("pt_cam_seen")) startCamera(); else intro();
