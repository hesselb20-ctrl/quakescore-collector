// QuakeScore browser collector: reads DeviceMotion while the page is open, runs the same
// signal processing as the app on the phone, and saves one session file. Nothing is sent anywhere.
import { SessionProcessor } from "./dsp.js";
import { APP_VERSION, LsbTracker, buildPayload, fileName, noiseFloorUg, slug } from "./session_file.js";

const $ = (id) => document.getElementById(id);
const SNAPSHOT_KEY = "qs.snapshot";
const SECRET_KEY = "qs.secret";
const GAP_SECONDS = 2;                 // a pause this long in the sensor stream ends the session

let proc = null, lsb = null, startedAt = 0, lastT = 0, running = false;
let wakeLock = null, uiTimer = 0, snapTimer = 0, noEventTimer = 0;
let lastNoise = null, finalPayload = null, sessionMeta = null, endNote = "";

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function setPill(text, tone) { $("pill").textContent = text; $("pill").dataset.tone = tone || ""; }
function show(id, on) { $(id).hidden = !on; }
function fmtClock(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function uuid4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// A random secret that never leaves this browser makes the contributor id unlinkable across buildings.
async function contributorId(buildingId) {
  let secret = null;
  try { secret = localStorage.getItem(SECRET_KEY); } catch (e) { /* private mode */ }
  if (!secret) {
    secret = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(SECRET_KEY, secret); } catch (e) { /* keep it for this page load only */ }
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + buildingId));
  return [...new Uint8Array(digest)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function batteryPercent() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return Math.round(b.level * 100);
  } catch (e) { return null; }
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { wakeLock = null; }
}

function onMotion(e) {
  if (!running) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  // event time on the page's clock; some older browsers report epoch milliseconds directly
  const t = (e.timeStamp > 1e11 ? e.timeStamp : performance.timeOrigin + e.timeStamp) / 1000;
  if (lastT && t - lastT > GAP_SECONDS) {
    end("The page was in the background or the sensor paused, so the session ended there.");
    return;
  }
  lastT = t;
  lsb.push(a.x, a.y, a.z);
  proc.push(t, a.x, a.y, a.z);
  if (proc.ended) end("");
}

function statusText(status) {
  switch (status) {
    case "warmup": return ["Warming up: keep the phone still", "warn"];
    case "running": return ["Recording", "good"];
    case "complete": return ["Finished", "good"];
    case "not_flat": return ["The phone is not lying flat", "bad"];
    case "ended_flagged_run": return ["Movement ended the session", "bad"];
    case "too_short": return ["Too short", "bad"];
    default: return ["Measuring the sensor rate", ""];
  }
}

function refresh() {
  if (!proc) return;
  const st = proc.stats();
  const [text, tone] = statusText(st.status);
  $("phase").textContent = text;
  setPill(running ? text.split(":")[0] : "Finished", tone);
  $("elapsed").textContent = fmtClock((Date.now() - startedAt) / 1000);
  const fs = st.fsProbe || (st.nRaw > 60 ? st.nRaw / ((Date.now() - startedAt) / 1000) : 0);
  $("rate").textContent = fs ? fs.toFixed(1) : "-";
  $("windows").textContent = `${st.bands.L.k} / ${st.bands.M.k} / ${st.bands.H.k}`;
  $("flagged").textContent = String(st.flaggedSeconds);
  $("noise").textContent = lastNoise == null ? "-" : lastNoise.toFixed(0);
  $("hint").textContent = st.status === "running"
    ? "Leave the phone where it is. You can dim the screen below."
    : "Put the phone down flat now and leave it alone.";
  const d = new Date();
  $("nightClock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  $("nightState").textContent = text.split(":")[0];
}

async function currentPayload() {
  const result = proc.finish();
  lastNoise = noiseFloorUg(result) ?? lastNoise;
  const meta = { ...sessionMeta, lsb: lsb.value, batteryEnd: await batteryPercent() };
  return [buildPayload(result, meta), result];
}

async function snapshot() {
  if (!running) return;
  try {
    const [payload, result] = await currentPayload();
    if (result.duration >= 60) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (e) { /* storage full or blocked: the live session is unaffected */ }
}

async function start() {
  const label = $("building").value;
  const id = slug(label);
  if (!id) { $("setupMsg").textContent = "Type a building name first."; return; }
  const floor = Math.round(Number($("floor").value));
  if (!Number.isFinite(floor) || floor < -10 || floor > 200) { $("setupMsg").textContent = "Enter the floor as a whole number."; return; }
  if (typeof DeviceMotionEvent === "undefined") { $("setupMsg").textContent = "This browser has no motion sensor access."; return; }
  if (typeof DeviceMotionEvent.requestPermission === "function") {       // iOS asks once, on a tap
    let ans = "denied";
    try { ans = await DeviceMotionEvent.requestPermission(); } catch (e) { ans = "denied"; }
    if (ans !== "granted") { $("setupMsg").textContent = "Motion access was not allowed. Allow it in the prompt to measure."; return; }
  }
  const buildingId = `test:${id}`;
  sessionMeta = {
    sessionId: uuid4(), buildingId, contributor: await contributorId(buildingId),
    phoneModel: isIOS ? "iPhone (browser)" : "Android (browser)", floor, charging: $("charging").checked,
    platform: isIOS ? "ios" : "android", batteryStart: await batteryPercent(),
  };
  proc = new SessionProcessor();
  lsb = new LsbTracker();
  startedAt = Date.now(); lastT = 0; lastNoise = null; finalPayload = null; endNote = ""; running = true;
  window.addEventListener("devicemotion", onMotion);
  await keepAwake();
  show("setup", false); show("intro", false); show("done", false); show("run", true);
  refresh();
  uiTimer = setInterval(refresh, 1000);
  snapTimer = setInterval(snapshot, 60000);
  noEventTimer = setTimeout(() => {
    if (running && proc.stats().nRaw === 0) {
      stopListening();
      show("run", false); show("setup", true); show("intro", true);
      setPill("Ready");
      $("setupMsg").textContent = "No motion data arrived. This device or browser may not provide it, or the page needs to be opened over https.";
    }
  }, 4000);
}

function stopListening() {
  running = false;
  window.removeEventListener("devicemotion", onMotion);
  clearInterval(uiTimer); clearInterval(snapTimer); clearTimeout(noEventTimer);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  show("night", false);
}

async function end(note) {
  if (!running) return;
  endNote = note;
  stopListening();
  const [payload, result] = await currentPayload();
  const [text] = statusText(result.status);
  const st = proc.stats();
  show("run", false); show("done", true);
  setPill("Finished");
  const usable = result.duration >= 60 && (st.bands.H.k + st.bands.M.k + st.bands.L.k) > 0;
  finalPayload = usable ? payload : null;
  if (usable) { try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload)); } catch (e) { /* ignore */ } }
  $("doneTitle").textContent = usable ? "Session finished" : "Nothing usable was recorded";
  const noise = lastNoise == null ? "" : ` Phone noise about ${lastNoise.toFixed(0)} µg/√Hz.`;
  $("doneText").textContent = usable
    ? `${fmtClock(result.duration)} recorded at ${result.fsRaw.toFixed(1)} samples per second. Windows kept: ${st.bands.L.k} slow, ${st.bands.M.k} mid, ${st.bands.H.k} fast.${noise}`
    : `${text}. A session needs the phone flat and still for at least a few minutes.`;
  $("doneMsg").textContent = note || (result.status === "complete" ? "" : text + ".");
  $("save").disabled = !usable;
  const file = usable ? new File([JSON.stringify(payload)], fileName(payload), { type: "application/json" }) : null;
  show("share", !!(file && navigator.canShare && navigator.canShare({ files: [file] })));
}

function saveFile(payload) {
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName(payload);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function shareFile(payload) {
  const file = new File([JSON.stringify(payload)], fileName(payload), { type: "application/json" });
  try { await navigator.share({ files: [file], title: "QuakeScore session" }); } catch (e) { /* cancelled */ }
}

function storedSnapshot() {
  try { const s = localStorage.getItem(SNAPSHOT_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

// ---- wiring
$("start").addEventListener("click", () => { $("setupMsg").textContent = ""; start(); });
$("stop").addEventListener("click", () => end(""));
$("save").addEventListener("click", () => { if (finalPayload) { saveFile(finalPayload); $("doneMsg").textContent = "Saved. Look in Files or Downloads."; } });
$("share").addEventListener("click", () => { if (finalPayload) shareFile(finalPayload); });
$("again").addEventListener("click", () => { show("done", false); show("setup", true); show("intro", true); setPill("Ready"); show("recover", !!storedSnapshot()); });
$("recover").addEventListener("click", () => { const p = storedSnapshot(); if (p) { saveFile(p); $("setupMsg").textContent = "Saved the last session again."; } });
$("nightBtn").addEventListener("click", () => show("night", true));
let lastTap = 0;
$("night").addEventListener("pointerup", () => { const now = Date.now(); if (now - lastTap < 450) show("night", false); lastTap = now; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && running) keepAwake(); });
show("recover", !!storedSnapshot());
try { const b = localStorage.getItem("qs.building"); if (b) $("building").value = b; } catch (e) { /* ignore */ }
$("building").addEventListener("change", () => { try { localStorage.setItem("qs.building", $("building").value); } catch (e) { /* ignore */ } });
document.title = `QuakeScore collector ${APP_VERSION}`;
