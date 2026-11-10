// PlateTrace preview tutorial: a "How it works" button in the header opens a short slide walkthrough.
(function () {
  const ic = (body) => `<svg viewBox="0 0 320 150" class="tut-art" aria-hidden="true">${body}</svg>`;
  const plate = (x, y, w, txt, blur) => `<g ${blur ? 'filter="url(#tb)"' : ""}><rect x="${x}" y="${y}" width="${w}" height="${w * 0.45}" rx="6" fill="#f4f1de" stroke="#223" stroke-width="2"/><text x="${x + w / 2}" y="${y + w * 0.32}" text-anchor="middle" font-family="monospace" font-weight="700" font-size="${w * 0.22}" fill="#1b2340">${txt}</text></g>`;
  const defs = `<defs><filter id="tb"><feGaussianBlur stdDeviation="2.2"/></filter></defs>`;
  const car = `<rect x="70" y="30" width="180" height="100" rx="18" fill="#26375f"/><rect x="95" y="38" width="130" height="34" rx="8" fill="#0f1726"/><rect x="78" y="80" width="26" height="14" rx="3" fill="#e5484d"/><rect x="216" y="80" width="26" height="14" rx="3" fill="#e5484d"/>`;
  const SLIDES = [
    { t: "Welcome to PlateTrace", p: "PlateTrace pulls a clearer license plate out of blurry video or photos, reads it, and documents the whole back of the vehicle, ready for a case file. Everything runs on your device; footage is never uploaded.",
      a: ic(defs + plate(30, 45, 110, "KP?48?", true) + `<path d="M150 72h30" stroke="#4fb3ff" stroke-width="4" marker-end="url(#ta)"/><defs><marker id="ta" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#4fb3ff"/></marker></defs>` + plate(190, 45, 110, "KPD4825")) },
    { t: "1 · Open a case and mark the plate", p: "Type a case number, add the video (or several photos), then drag a box around the plate. On video, slide to a moment where the plate is visible first.",
      a: ic(defs + car + plate(125, 92, 70, "KPD4825", true) + `<rect x="119" y="87" width="82" height="42" fill="none" stroke="#4fb3ff" stroke-width="3" stroke-dasharray="6 4"/>`) },
    { t: "2 · Gather every frame of the plate", p: "Far away or blurry? That's what PlateTrace is for. Pick Zoom closer (4×, 6× or 8×) and it finds the plate in every nearby frame and lines each one up to a fraction of a pixel. In far / blurry mode no frame is thrown away for blur: sharper frames just count more.",
      a: ic(defs + [0, 1, 2, 3].map((i) => `<g transform="translate(${20 + i * 75},40)">${plate(0, 0, 65, "KPD4825", i % 2 === 0)}<text x="32" y="55" text-anchor="middle" font-size="11" fill="${i % 2 ? "#3ccf8e" : "#f2b84b"}">${i % 2 ? "counts more" : "counts less"}</text></g>`).join("")) },
    { t: "3 · Combine, zoom and unblur", p: "The lined-up frames are combined into one closer, cleaner picture: together they hold more detail than any single frame. Then Unblur (a published math method) can reverse focus or motion blur. Nothing is guessed or drawn in; only recorded pixels are used.",
      a: ic(defs + [0, 1, 2].map((i) => plate(20 + i * 10, 30 + i * 10, 90, "KPD4825", true)).join("") + `<text x="160" y="85" font-size="28" fill="#4fb3ff">=</text>` + plate(190, 50, 110, "KPD4825")) },
    { t: "4 · Read the plate", p: "Pick the state's plate layout (or 'Try all'). Know some characters? Type them and use ? for the rest, like KPD4?2?. You get ranked candidates plus a partial-plate search list of every plate that fits, downloadable as a spreadsheet.",
      a: ic(`<rect x="20" y="20" width="280" height="110" rx="10" fill="#0d1117" stroke="#2a3442"/><text x="36" y="48" font-family="monospace" font-size="16" fill="#e6edf3">KPD4?2?</text>` + ["KPD4825", "KPD4820", "KPD4826"].map((x, i) => `<text x="36" y="${78 + i * 20}" font-family="monospace" font-size="14" fill="#e6edf3">${i + 1}. ${x}</text><rect x="150" y="${68 + i * 20}" width="${120 - i * 40}" height="10" rx="5" fill="#4fb3ff"/>`).join("")) },
    { t: "5 · Vehicle details: Print & Pattern", p: "Box the whole back of the vehicle. PlateTrace combines it, corrects the color using the plate's white background, and samples the paint (A, B, C) to flag a repainted panel. The Print & Pattern scan finds odd areas (stickers, primer, damage) and photographs each one. Tap to number distinguishing marks.",
      a: ic(car + `<rect x="200" y="36" width="34" height="34" fill="#3f5594" stroke="#f2b84b" stroke-width="2"/><text x="208" y="30" font-size="12" fill="#f2b84b">B</text><rect x="110" y="44" width="40" height="20" fill="none" stroke="#f2b84b" stroke-width="2"/><text x="112" y="40" font-size="12" fill="#f2b84b">A</text><circle cx="96" cy="114" r="9" fill="#f2b84b"/><text x="92" y="118" font-size="11" fill="#111">1</text>`) },
    { t: "6 · Case package and court report", p: "Download one zip with a court-ready PDF report, every image and frame, the candidate and partial-plate lists, and SHA-256 fingerprints so anyone can prove nothing was altered. Every export is recorded in the audit log.",
      a: ic(`<rect x="60" y="20" width="110" height="120" rx="6" fill="#f4f6fa"/><rect x="72" y="34" width="70" height="8" fill="#0b5c96"/>` + [0, 1, 2, 3, 4, 5].map((i) => `<rect x="72" y="${52 + i * 12}" width="${86 - (i % 3) * 14}" height="5" fill="#9aa4b2"/>`).join("") + `<text x="78" y="134" font-size="10" fill="#0b5c96" font-weight="700">REPORT.PDF</text><rect x="190" y="50" width="80" height="70" rx="6" fill="#26375f"/><text x="230" y="92" text-anchor="middle" font-size="14" fill="#e6edf3" font-weight="700">.zip</text>`) },
    { t: "Good to know", p: "• Results are investigative leads, not an identification. Confirm against the original footage and your records.\n• PlateTrace never looks up vehicle owners.\n• For court, have a certified forensic video analyst review the package.\n• Tip: steady, close footage with several frames of the plate gives the best results.",
      a: ic(`<path d="M160 20l90 32v34c0 30-40 50-90 60c-50-10-90-30-90-60V52z" fill="#0b5c96" stroke="#4fb3ff" stroke-width="3"/><path d="M125 82l25 25l45-50" fill="none" stroke="#3ccf8e" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`) },
  ];

  let i = 0, box = null, playing = true, timer = null;
  const SECS = 8;
  function schedule() {
    clearTimeout(timer);
    const bar = box && box.querySelector(".tut-time i");
    if (bar) { bar.style.transition = "none"; bar.style.width = "0%"; }
    if (!box || !playing || i >= SLIDES.length - 1) { if (box) box.querySelector(".tut-play").textContent = playing && i < SLIDES.length - 1 ? "❚❚ Pause" : "▶ Play"; return; }
    box.querySelector(".tut-play").textContent = "❚❚ Pause";
    requestAnimationFrame(() => requestAnimationFrame(() => { if (bar) { bar.style.transition = `width ${SECS}s linear`; bar.style.width = "100%"; } }));
    timer = setTimeout(() => step(1), SECS * 1000);
  }
  function togglePlay() { if (!playing && i >= SLIDES.length - 1) i = 0; playing = !playing; show(); }
  function show() {
    const s = SLIDES[i];
    box.querySelector(".tut-art-wrap").innerHTML = s.a;
    box.querySelector("h2").textContent = s.t;
    const p = box.querySelector(".tut-text"); p.textContent = s.p;
    box.querySelector(".tut-dots").innerHTML = SLIDES.map((_, k) => `<button aria-label="Slide ${k + 1}" class="${k === i ? "on" : ""}" data-k="${k}"></button>`).join("");
    box.querySelector(".tut-prev").disabled = i === 0;
    box.querySelector(".tut-next").textContent = i === SLIDES.length - 1 ? "Done" : "Next ▶";
    schedule();
  }
  function close() { clearTimeout(timer); if (box) { box.remove(); box = null; document.removeEventListener("keydown", onKey); } try { localStorage.setItem("pt_tutorial_seen", "1"); } catch (e) {} }
  function onKey(e) { if (e.key === " ") { e.preventDefault(); togglePlay(); } if (e.key === "Escape") close(); if (e.key === "ArrowRight") step(1); if (e.key === "ArrowLeft") step(-1); }
  function step(d) { if (i + d >= SLIDES.length) return close(); i = Math.max(0, i + d); show(); }
  function open() {
    if (box) return; i = 0; playing = true;
    box = document.createElement("div"); box.className = "tut-back";
    box.innerHTML = `<div class="tut" role="dialog" aria-modal="true" aria-label="PlateTrace tutorial">
      <button class="tut-x" aria-label="Close">✕</button><div class="tut-art-wrap"></div><h2></h2><p class="tut-text"></p>
      <div class="tut-time"><i></i></div><div class="tut-dots"></div><div class="tut-nav"><button class="ghost tut-prev">◀ Back</button><button class="ghost tut-play">❚❚ Pause</button><button class="tut-next">Next ▶</button></div></div>`;
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest(".tut-x")) return close();
      if (e.target.closest(".tut-prev")) return step(-1);
      if (e.target.closest(".tut-next")) return step(1);
      if (e.target.closest(".tut-play")) return togglePlay();
      const d = e.target.closest(".tut-dots button"); if (d) { i = +d.dataset.k; show(); }
    });
    let x0 = null;
    box.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
    box.addEventListener("touchend", (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); x0 = null; });
    document.body.append(box); document.addEventListener("keydown", onKey); show();
  }
  window.openTutorial = open;
  const btn = document.createElement("button");
  btn.className = "ghost tut-btn"; btn.type = "button"; btn.textContent = "▶ How it works"; btn.onclick = open;
  document.querySelector("header.top .brand").after(btn);
  let seen = false; try { seen = localStorage.getItem("pt_tutorial_seen") === "1"; } catch (e) {}
  if (!seen) setTimeout(open, 600);
})();
