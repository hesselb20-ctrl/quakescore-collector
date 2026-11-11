// Builds the session file (upload schema v1) from a finished SessionProcessor result.
// Pure functions, no DOM: the same code runs in the page and in the Node tests.
import { NBINS, toBase64LE } from "./dsp.js";

export const APP_VERSION = "web-0.1.0";
const UG = 9.80665e-6;                       // one micro-g in m/s^2
const BAND_FS = { L: 3.125, M: 12.5, H: 50.0 };
const NFFT = 2048;

/** Lower-case id fragment from a typed building name: letters, digits and dashes only. */
export function slug(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Power response of linear interpolation from the raw rate; the server divides it out, so do we. */
function droop(f, fsRaw) {
  const x = Math.PI * f / fsRaw;
  const s = x === 0 ? 1 : Math.sin(x) / x;
  return s * s * s * s;
}

/**
 * Phone noise density in micro-g per root hertz: the median horizontal power spectral density between
 * 5 and 18 Hz, per axis. Returns null until band H has a few windows. In a quiet building this is
 * the sensor's own noise floor, which is the number the detection limit depends on most.
 */
export function noiseFloorUg(result) {
  const h = result.bands && result.bands.H;
  if (!h || h.k < 3 || !(result.fsRaw > 0)) return null;
  const df = BAND_FS.H / NFFT;
  const vals = [];
  for (let i = Math.ceil(5 / df); i <= Math.floor(18 / df) && i < NBINS; i++) {
    const trace = h.csd[9 * i] + h.csd[9 * i + 1];
    vals.push(trace / 2 / droop(i * df, result.fsRaw));
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)];
  return med > 0 ? Math.sqrt(med) / UG : null;
}

/** Estimates the sensor's quantisation step as the smallest non-zero change seen on any axis. */
export class LsbTracker {
  constructor() { this.prev = null; this.min = Infinity; }
  push(x, y, z) {
    const p = this.prev;
    if (p) {
      for (const d of [Math.abs(x - p[0]), Math.abs(y - p[1]), Math.abs(z - p[2])]) {
        if (d > 1e-9 && d < this.min) this.min = d;
      }
    }
    this.prev = [x, y, z];
  }
  get value() { return Number.isFinite(this.min) ? Math.min(Math.max(this.min, 1e-6), 1) : 1e-4; }
}

/**
 * The session file. `meta`: sessionId, buildingId, contributor, phoneModel, floor, charging,
 * platform ("ios" or "android"), lsb, batteryStart, batteryEnd (numbers or null).
 * The browser has no trustworthy clock-sync estimate, so sync_source is "none" and sync_sigma_ms -1.
 */
export function buildPayload(result, meta) {
  const bands = {};
  for (const name of ["L", "M", "H"]) {
    const b = result.bands[name];
    bands[name] = { k: b.k, csd: toBase64LE(b.csd), p4: toBase64LE(b.p4) };
  }
  return {
    schema: 1,
    session_id: meta.sessionId,
    building_id: meta.buildingId,
    contributor: meta.contributor,
    phone_model: meta.phoneModel,
    sensor_name: "devicemotion",
    floor: meta.floor,
    floor_method: "manual",
    t_start: 60 * Math.round(result.tStart / 60),
    duration: result.duration,
    fs_raw: result.fsRaw,
    lsb: meta.lsb,
    sync_source: "none",
    sync_sigma_ms: -1,
    accept_fraction: result.acceptFraction,
    temp_c: null,
    battery_start: meta.batteryStart ?? null,
    battery_end: meta.batteryEnd ?? null,
    charging: !!meta.charging,
    platform: meta.platform,
    app_version: APP_VERSION,
    bands,
  };
}

/** File name for a saved session, safe on every platform. */
export function fileName(payload) {
  const d = new Date(payload.t_start * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `quakescore_${payload.building_id.replace(/[^a-z0-9]+/gi, "-")}_${stamp}.json`;
}
