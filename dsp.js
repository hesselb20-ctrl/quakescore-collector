/*
 * Streaming on-device feature pipeline for the browser collector.
 *
 * A port of android/dsp-core (org.quakescore.dsp: Spec, GridResampler, AnchoredDecimator, Levelling,
 * Fft, BandAccumulator, SessionProcessor, Packing). The Kotlin is the source of truth; the streaming
 * rules are described in SessionProcessor.kt and mirrored by process_session_streaming in
 * experiments/export_device_vectors.py, which writes the test vectors checked by test_dsp.mjs.
 *
 * Arithmetic is double precision (Number / Float64Array) with the same order of operations as the
 * Kotlin. Window spectra are rounded to float32 before accumulation, and the uploaded means are float32,
 * exactly where the Kotlin rounds.
 *
 * JavaScript notes
 *  - Absolute grid indices are about 3.6e11 (> 2^31): they are plain Numbers (exact below 2^53) and are
 *    only combined with Math.floor / Math.ceil / floorMod below, never with bitwise operators.
 *  - Kotlin Long.MIN_VALUE "unset" sentinels are null here.
 *  - finish() is non-destructive: it runs the Kotlin end-of-session steps on a private copy of the
 *    state, so a snapshot can be taken while the session continues.
 *
 * Single ES module, no DOM, no Node APIs, no dependencies other than the generated fir_taps.js.
 */
import { TAPS2, TAPS4 } from "./fir_taps.js";

// ----------------------------------------------------------------------------- Spec

export const NFFT = 2048;
export const HOP = NFFT / 2;
export const NBINS = NFFT / 2 + 1;

/** Zoom bands and their sample rates, in the Kotlin Band enum order. */
export const BANDS = Object.freeze({ L: 3.125, M: 12.5, H: 50.0 });
const BAND_ORDER = ["L", "M", "H"];

/** Same defaults as the Kotlin StreamConfig. */
export const DEFAULT_CONFIG = Object.freeze({
  warmupSeconds: 120,
  rateProbeSeconds: 10.0,
  maxFlaggedRun: 60,
  gateRmsFactor: 5.0,
  gateTilt: 0.0035,
  flatCos: 0.966,
});

/** Kotlin Status enum, lower-cased names, with the terminal flag. */
const TERMINAL = Object.freeze({
  probing: false, warmup: false, running: false,
  complete: true, ended_flagged_run: true, not_flat: true, too_short: true,
});

/** Math.floorMod for integer-valued Numbers (any magnitude below 2^53). */
function floorMod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

/** Math.rint: round half to even (Python round). */
function rint(x) {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function firForFactor(m) {
  if (m === 4) return TAPS4;
  if (m === 2) return TAPS2;
  throw new Error(`no taps for factor ${m}`);
}

// ----------------------------------------------------------------------------- Levelling, Stats

function norm3(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function cross3(a, b) {
  return new Float64Array([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

/** pipeline.level_rotation: rows are the level-frame axes in the device frame. */
export function levelRotation(g) {
  const gn = norm3(g);
  const z = new Float64Array([g[0] / gn, g[1] / gn, g[2] / gn]);
  const x = new Float64Array([1.0 - z[0] * z[0], 0.0 - z[0] * z[1], 0.0 - z[0] * z[2]]);
  const xn = norm3(x);
  for (let i = 0; i < 3; i++) x[i] /= xn;
  return [x, cross3(z, x), z];
}

/** numpy.median of the first n values. */
function median(values, n = values.length) {
  if (!(n > 0)) throw new Error("median of nothing");
  const s = Float64Array.from(values.subarray ? values.subarray(0, n) : values.slice(0, n));
  s.sort();
  const h = Math.floor(n / 2);
  return n % 2 === 1 ? s[h] : (s[h - 1] + s[h]) / 2.0;
}

// ----------------------------------------------------------------------------- FFT

/** Iterative radix-2 complex FFT, forward sign convention as numpy.fft. */
export class Fft {
  constructor(n) {
    if (!(n >= 2 && (n & (n - 1)) === 0)) throw new Error("n must be a power of two");
    this.n = n;
    let levels = 0;
    while ((1 << levels) < n) levels++;
    this.cosT = new Float64Array(n / 2);
    this.sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cosT[i] = Math.cos(2.0 * Math.PI * i / n);
      this.sinT[i] = Math.sin(2.0 * Math.PI * i / n);
    }
    this.rev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform of (re, im), both Float64Array of length n. */
  transform(re, im) {
    const n = this.n;
    if (re.length !== n || im.length !== n) throw new Error("length mismatch");
    const rev = this.rev, cosT = this.cosT, sinT = this.sinT;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        let t = 0;
        for (let j = start; j < start + half; j++) {
          const l = j + half;
          const c = cosT[t];
          const s = sinT[t];
          const tr = re[l] * c + im[l] * s;
          const ti = im[l] * c - re[l] * s;
          re[l] = re[j] - tr;
          im[l] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
          t += step;
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------- GridResampler

/** Epoch-anchored linear interpolation onto t_i = i / fsG (numpy.interp rules, streaming). */
export class GridResampler {
  constructor(fsG, sink) {
    this.fsG = fsG;
    this.sink = sink;
    this.hasPrev = false;
    this.ta = 0.0; this.xa = 0.0; this.ya = 0.0; this.za = 0.0;
    this.next = 0;
    this.firstIndex = null;
  }

  copyFrom(o) {
    this.hasPrev = o.hasPrev;
    this.ta = o.ta; this.xa = o.xa; this.ya = o.ya; this.za = o.za;
    this.next = o.next;
    this.firstIndex = o.firstIndex;
  }

  push(t, x, y, z) {
    const fsG = this.fsG;
    if (!this.hasPrev) {
      this.ta = t; this.xa = x; this.ya = y; this.za = z;
      this.next = Math.ceil(t * fsG);
      this.firstIndex = this.next;
      this.hasPrev = true;
      return true;
    }
    const ta = this.ta, xa = this.xa, ya = this.ya, za = this.za;
    if (!(t > ta)) return false;
    const dt = t - ta;
    const sx = (x - xa) / dt;
    const sy = (y - ya) / dt;
    const sz = (z - za) / dt;
    for (;;) {
      const tg = this.next / fsG;
      if (!(tg < t)) break;
      if (tg <= ta) {
        this.sink(this.next, xa, ya, za);
      } else {
        const d = tg - ta;
        this.sink(this.next, sx * d + xa, sy * d + ya, sz * d + za);
      }
      this.next++;
    }
    this.ta = t; this.xa = x; this.ya = y; this.za = z;
    return true;
  }

  /** Emits the remaining grid points up to floor(t_last * fsG) with the last value. */
  finish() {
    if (!this.hasPrev) return;
    const last = Math.floor(this.ta * this.fsG);
    while (this.next <= last) {
      this.sink(this.next, this.xa, this.ya, this.za);
      this.next++;
    }
  }
}

// ----------------------------------------------------------------------------- AnchoredDecimator

/** Streaming pipeline.decimate_anchored: output j sits at input absolute index j*m. */
export class AnchoredDecimator {
  constructor(m, sink) {
    this.m = m;
    this.sink = sink;
    this.h = firForFactor(m);
    this.n = this.h.length;
    this.half = (this.n - 1) / 2;
    if ((this.n - 1) % (2 * m) !== 0) throw new Error("numtaps - 1 must be a multiple of 2*m");
    this.rx = new Float64Array(this.n);
    this.ry = new Float64Array(this.n);
    this.rz = new Float64Array(this.n);
    this.first = null;
    this.expected = 0;
  }

  copyFrom(o) {
    this.rx.set(o.rx); this.ry.set(o.ry); this.rz.set(o.rz);
    this.first = o.first;
    this.expected = o.expected;
  }

  push(a, x, y, z) {
    if (this.first === null) {
      this.first = a;
      this.expected = a;
    }
    if (a !== this.expected) throw new Error(`non-consecutive input index ${a}, expected ${this.expected}`);
    this.expected = a + 1;
    const n = this.n, half = this.half, m = this.m;
    const p = floorMod(a, n);
    this.rx[p] = x; this.ry[p] = y; this.rz[p] = z;
    if (floorMod(a - half, m) === 0 && a - 2 * half >= this.first) {
      const h = this.h, rx = this.rx, ry = this.ry, rz = this.rz;
      let sx = 0.0, sy = 0.0, sz = 0.0;
      let q = p;
      for (let k = 0; k < n; k++) {
        const hk = h[k];
        sx += hk * rx[q];
        sy += hk * ry[q];
        sz += hk * rz[q];
        q = q === 0 ? n - 1 : q - 1;
      }
      this.sink((a - half) / m, sx, sy, sz);   // exact: a - half is a multiple of m
    }
  }
}

// ----------------------------------------------------------------------------- BandAccumulator

const FFT = new Fft(NFFT);

/** scipy.signal.get_window("hann", NFFT, fftbins=True), built the way scipy builds it. */
const HANN = (() => {
  const step = (Math.PI - (-Math.PI)) / NFFT;
  const w = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) w[i] = 0.5 + 0.5 * Math.cos(i * step + (-Math.PI));
  return w;
})();
const HANN_SQ_SUM = HANN.reduce((acc, v) => acc + v * v, 0.0);
const CENTRE = (() => {
  const c = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) c[i] = i - (NFFT - 1) / 2.0;
  return c;
})();
const CENTRE_SQ_SUM = CENTRE.reduce((acc, v) => acc + v * v, 0.0);
const SCRATCH_RE = new Float64Array(NFFT);
const SCRATCH_IM = new Float64Array(NFFT);

/** Window accumulator for one zoom band (pipeline.py _window_spectra and the accumulation loop). */
export class BandAccumulator {
  constructor(band) {
    this.band = band;
    this.fs = BANDS[band];
    this.ring = [new Float64Array(NFFT), new Float64Array(NFFT), new Float64Array(NFFT)];
    this.first = null;
    this.pending = [];                      // { k, spectra: Float32Array(3 * NBINS * 2) }, oldest first
    this.pendingHead = 0;
    this.csdSum = new Float64Array(NBINS * 9);
    this.p4Sum = new Float64Array(NBINS * 3);
    this.accepted = 0;
    this.total = 0;
    this.acceptedWindows = [];
  }

  /** Copies the state of another accumulator (pending spectra are immutable and shared). */
  copyFrom(o) {
    for (let a = 0; a < 3; a++) this.ring[a].set(o.ring[a]);
    this.first = o.first;
    this.pending = o.pending.slice(o.pendingHead);
    this.pendingHead = 0;
    this.csdSum.set(o.csdSum);
    this.p4Sum.set(o.p4Sum);
    this.accepted = o.accepted;
    this.total = o.total;
    this.acceptedWindows = o.acceptedWindows.slice();
  }

  /** Adds one levelled band sample at absolute index a. Returns true if a window completed. */
  push(a, x, y, z) {
    if (this.first === null) this.first = a;
    const p = floorMod(a, NFFT);
    this.ring[0][p] = x; this.ring[1][p] = y; this.ring[2][p] = z;
    if (floorMod(a + 1, HOP) !== 0) return false;
    const start = a + 1 - NFFT;
    if (start < this.first) return false;
    this.pending.push({ k: start / HOP, spectra: this.spectra(start) });   // exact division
    this.total++;
    return true;
  }

  spectra(start) {
    const out = new Float32Array(3 * NBINS * 2);
    const s0 = floorMod(start, NFFT);
    const re = SCRATCH_RE, im = SCRATCH_IM;
    for (let axis = 0; axis < 3; axis++) {
      const r = this.ring[axis];
      let sum = 0.0;
      for (let i = 0; i < NFFT; i++) {
        const v = r[(s0 + i) & (NFFT - 1)];       // small ring offsets: bitwise is safe here
        re[i] = v;
        sum += v;
      }
      const mean = sum / NFFT;
      let sn = 0.0;
      for (let i = 0; i < NFFT; i++) {
        re[i] -= mean;
        sn += re[i] * CENTRE[i];
      }
      const slope = sn / CENTRE_SQ_SUM;
      for (let i = 0; i < NFFT; i++) {
        re[i] = (re[i] - slope * CENTRE[i]) * HANN[i];
        im[i] = 0.0;
      }
      FFT.transform(re, im);
      const scale = Math.sqrt(2.0 / (this.fs * HANN_SQ_SUM));
      const base = axis * NBINS * 2;
      for (let f = 0; f < NBINS; f++) {
        out[base + 2 * f] = re[f] * scale;         // Float32Array store rounds to nearest float32
        out[base + 2 * f + 1] = im[f] * scale;
      }
    }
    return out;
  }

  /**
   * Decides pending windows in order. flagCum[s] is the number of flagged seconds before second s,
   * for s in 0..nsec. With final false a window waits until its decision cannot change any more.
   */
  decide(nsec, flagCum, flat, final, secT0) {
    const fs = this.fs;
    while (this.pendingHead < this.pending.length) {
      const w = this.pending[this.pendingHead];
      const tLo = (w.k * HOP) / fs;
      const tHi = tLo + NFFT / fs;
      if (tLo < secT0) {                           // can never be inside
        this.popPending();
        continue;
      }
      const inside = tHi <= secT0 + nsec;
      const rawHi = Math.ceil(tHi - secT0);
      if (!final && (!inside || rawHi > nsec)) return;
      this.popPending();
      if (!inside) continue;
      const sLo = Math.min(Math.max(Math.floor(tLo - secT0), 0), nsec);
      const sHi = Math.min(Math.max(rawHi, 0), nsec);
      if (flat && flagCum[sHi] - flagCum[sLo] === 0) this.accumulate(w);
    }
  }

  popPending() {
    this.pendingHead++;
    if (this.pendingHead > 64 && this.pendingHead * 2 > this.pending.length) {
      this.pending = this.pending.slice(this.pendingHead);
      this.pendingHead = 0;
    }
  }

  accumulate(w) {
    const s = w.spectra;
    const yOff = NBINS * 2;
    const zOff = NBINS * 4;
    const csd = this.csdSum, p4 = this.p4Sum;
    for (let f = 0; f < NBINS; f++) {
      const xr = s[2 * f], xi = s[2 * f + 1];
      const yr = s[yOff + 2 * f], yi = s[yOff + 2 * f + 1];
      const zr = s[zOff + 2 * f], zi = s[zOff + 2 * f + 1];
      const pxx = xr * xr + xi * xi;
      const pyy = yr * yr + yi * yi;
      const pzz = zr * zr + zi * zi;
      const c = 9 * f;
      csd[c] += pxx;
      csd[c + 1] += pyy;
      csd[c + 2] += pzz;
      // G_ab = X_a conj(X_b): re = ar br + ai bi, im = ai br - ar bi
      csd[c + 3] += xr * yr + xi * yi;
      csd[c + 4] += xi * yr - xr * yi;
      csd[c + 5] += xr * zr + xi * zi;
      csd[c + 6] += xi * zr - xr * zi;
      csd[c + 7] += yr * zr + yi * zi;
      csd[c + 8] += yi * zr - yr * zi;
      const q = 3 * f;
      p4[q] += pxx * pxx;
      p4[q + 1] += pyy * pyy;
      p4[q + 2] += pzz * pzz;
    }
    this.accepted++;
    this.acceptedWindows.push(w.k);
  }

  /** Mean one-sided CSD, NBINS x [Gxx Gyy Gzz ReGxy ImGxy ReGxz ImGxz ReGyz ImGyz], float32. */
  csdMean() {
    const out = new Float32Array(NBINS * 9);
    if (this.accepted > 0) for (let i = 0; i < out.length; i++) out[i] = this.csdSum[i] / this.accepted;
    return out;
  }

  /** Mean |X_i|^4 per bin, NBINS x [x y z], float32. */
  p4Mean() {
    const out = new Float32Array(NBINS * 3);
    if (this.accepted > 0) for (let i = 0; i < out.length; i++) out[i] = this.p4Sum[i] / this.accepted;
    return out;
  }
}

// ----------------------------------------------------------------------------- SessionProcessor

export class SessionProcessor {
  /** config: optional overrides of DEFAULT_CONFIG (the Kotlin StreamConfig defaults). */
  constructor(config = {}) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.cfg = Object.freeze(cfg);
    this._status = "probing";
    /** Optional observer of every completed gate second after the warm-up: (index, rms, tilt, flagged). */
    this.secondListener = null;

    // raw stream
    this.nRaw = 0;
    this.nRejectedRaw = 0;
    this.tFirst = NaN;
    this.tLast = NaN;
    this.probe = new Float64Array(4 * 4096);
    this.probeN = 0;
    this.fsProbe = NaN;
    this.fsGrid = NaN;
    this.grid = null;
    this.dec1 = null;

    // 50 Hz stream and gate
    this.j50 = null;
    this.n50 = 0;
    this.block = new Float64Array(150);
    this.blockN = 0;
    this.warmN = cfg.warmupSeconds;
    this.warm = new Float64Array(this.warmN * 50 * 3);
    this.warmRows = 0;
    this.wMean = new Float64Array(this.warmN * 3);
    this.wRms = new Float64Array(this.warmN);
    this.nSecDone = 0;
    this.flagCum = new Int32Array(4096);   // flagCum[s] = flagged seconds before s
    this.nFlags = 0;                       // seconds whose flag is known
    this.run = 0;
    this.gUnit = new Float64Array(3);
    this.rmsMedian = NaN;
    this.gMedian = null;
    this.gLevel = null;
    this.rot = null;
    this.flat = true;

    // bands
    this.bands = { L: new BandAccumulator("L"), M: new BandAccumulator("M"), H: new BandAccumulator("H") };
    this._wireBands();
  }

  _wireBands() {
    const bandL = this.bands.L, bandM = this.bands.M;
    this.decL = new AnchoredDecimator(4, (j, x, y, z) => {
      if (bandL.push(j, x, y, z)) this._decideAll(false);
    });
    this.decM = new AnchoredDecimator(4, (j, x, y, z) => {
      if (bandM.push(j, x, y, z)) this._decideAll(false);
      this.decL.push(j, x, y, z);
    });
  }

  _makeGrid() {
    const d = new AnchoredDecimator(Math.trunc(this.fsGrid / 50.0), (j, x, y, z) => this._on50(j, x, y, z));
    this.dec1 = d;
    this.grid = new GridResampler(this.fsGrid, (i, x, y, z) => d.push(i, x, y, z));
  }

  get status() { return this._status; }
  get ended() { return TERMINAL[this._status]; }

  /** Adds one raw sample: t in UTC seconds, acceleration in m/s^2 in the device frame. */
  push(t, x, y, z) {
    if (!(Number.isFinite(t) && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      this.nRejectedRaw++;
      return;
    }
    if (this.nRaw > 0 && !(t > this.tLast)) {
      this.nRejectedRaw++;
      return;
    }
    if (this.nRaw === 0) this.tFirst = t;
    this.tLast = t;
    this.nRaw++;
    // Samples after the session has ended are counted but not processed.
    if (TERMINAL[this._status]) return;
    const g = this.grid;
    if (g === null) {
      if (this.probeN * 4 + 4 > this.probe.length) {
        const bigger = new Float64Array(this.probe.length * 2);
        bigger.set(this.probe);
        this.probe = bigger;
      }
      const b = this.probeN * 4;
      this.probe[b] = t; this.probe[b + 1] = x; this.probe[b + 2] = y; this.probe[b + 3] = z;
      this.probeN++;
      if (t - this.tFirst >= this.cfg.rateProbeSeconds) this._startGrid();
    } else {
      g.push(t, x, y, z);
    }
  }

  _startGrid() {
    const probe = this.probe;
    const span = probe[(this.probeN - 1) * 4] - probe[0];
    this.fsProbe = (this.probeN - 1) / span;
    this.fsGrid = this.fsProbe >= 190.0 ? 200.0 : 100.0;
    this._makeGrid();
    this._status = "warmup";
    const g = this.grid;
    for (let i = 0; i < this.probeN; i++) {
      const b = i * 4;
      g.push(probe[b], probe[b + 1], probe[b + 2], probe[b + 3]);
      if (TERMINAL[this._status]) break;
    }
    this.probe = new Float64Array(0);
    this.probeN = 0;
  }

  _on50(j, x, y, z) {
    if (TERMINAL[this._status]) return;
    if (this.j50 === null) this.j50 = j;
    this.n50++;
    if (this.rot !== null) {
      this._levelPush(j, x, y, z);
    } else {
      const b = this.warmRows * 3;
      this.warm[b] = x; this.warm[b + 1] = y; this.warm[b + 2] = z;
      this.warmRows++;
    }
    const block = this.block;
    const bb = this.blockN * 3;
    block[bb] = x; block[bb + 1] = y; block[bb + 2] = z;
    this.blockN++;
    if (this.blockN < 50) return;
    this.blockN = 0;
    let mx = 0.0, my = 0.0, mz = 0.0;
    for (let i = 0; i < 50; i++) {
      mx += block[3 * i]; my += block[3 * i + 1]; mz += block[3 * i + 2];
    }
    mx /= 50.0; my /= 50.0; mz /= 50.0;
    let ss = 0.0;
    for (let i = 0; i < 50; i++) {
      const dx = block[3 * i] - mx;
      const dy = block[3 * i + 1] - my;
      const dz = block[3 * i + 2] - mz;
      ss += dx * dx + dy * dy + dz * dz;
    }
    const rms = Math.sqrt(ss / 150.0);
    const s = this.nSecDone;
    this.nSecDone++;
    if (this.rot === null) {
      this.wMean[3 * s] = mx; this.wMean[3 * s + 1] = my; this.wMean[3 * s + 2] = mz;
      this.wRms[s] = rms;
      if (this.nSecDone === this.warmN) this._endWarmup();
      return;
    }
    const tilt = this._tiltOf(mx, my, mz);
    const f = rms > this.cfg.gateRmsFactor * this.rmsMedian || tilt > this.cfg.gateTilt;
    this._addFlag(f);
    if (this.secondListener) this.secondListener(s, rms, tilt, f);
    if (this.run > this.cfg.maxFlaggedRun) this._end("ended_flagged_run"); else this._decideAll(false);
  }

  _tiltOf(mx, my, mz) {
    const g = this.gUnit;
    const nrm = Math.sqrt(mx * mx + my * my + mz * mz);
    const c = (mx * g[0] + my * g[1] + mz * g[2]) / Math.max(nrm, 1e-9);
    return Math.acos(Math.min(Math.max(c, -1.0), 1.0));
  }

  _addFlag(f) {
    if (this.nFlags + 2 > this.flagCum.length) {
      const bigger = new Int32Array(this.flagCum.length * 2);
      bigger.set(this.flagCum);
      this.flagCum = bigger;
    }
    this.flagCum[this.nFlags + 1] = this.flagCum[this.nFlags] + (f ? 1 : 0);
    this.nFlags++;
    this.run = f ? this.run + 1 : 0;
  }

  _endWarmup() {
    const warmN = this.warmN, wMean = this.wMean, wRms = this.wRms, cfg = this.cfg;
    const col = new Float64Array(warmN);
    const gMed = new Float64Array(3);
    for (let a = 0; a < 3; a++) {
      for (let s = 0; s < warmN; s++) col[s] = wMean[3 * s + a];
      gMed[a] = median(col);
    }
    this.gMedian = gMed;
    const gn = norm3(gMed);
    this.gUnit = new Float64Array([gMed[0] / gn, gMed[1] / gn, gMed[2] / gn]);
    this.rmsMedian = median(wRms);
    const flags = new Array(warmN);
    let good = 0;
    for (let s = 0; s < warmN; s++) {
      flags[s] = wRms[s] > cfg.gateRmsFactor * this.rmsMedian ||
        this._tiltOf(wMean[3 * s], wMean[3 * s + 1], wMean[3 * s + 2]) > cfg.gateTilt;
      if (!flags[s]) good++;
    }
    let gVec;
    if (good > 0) {
      const acc = new Float64Array(3);
      for (let s = 0; s < warmN; s++) if (!flags[s]) for (let a = 0; a < 3; a++) acc[a] += wMean[3 * s + a];
      gVec = new Float64Array([acc[0] / good, acc[1] / good, acc[2] / good]);
    } else {
      gVec = Float64Array.from(gMed);
    }
    this.gLevel = gVec;
    if (Math.abs(this.gUnit[2]) < cfg.flatCos) {
      this.flat = false;
      this._status = "not_flat";
      return;
    }
    this.rot = levelRotation(gVec);
    let keep = warmN;
    for (let s = 0; s < warmN; s++) {
      this._addFlag(flags[s]);
      if (this.run > cfg.maxFlaggedRun) {
        keep = s + 1;
        break;
      }
    }
    this._status = "running";
    const warm = this.warm;
    for (let i = 0; i < 50 * keep; i++) {
      this._levelPush(this.j50 + i, warm[3 * i], warm[3 * i + 1], warm[3 * i + 2]);
    }
    if (keep < warmN) this._end("ended_flagged_run"); else this._decideAll(false);
  }

  _levelPush(j, x, y, z) {
    const r = this.rot;
    const hx = r[0][0] * x + r[0][1] * y + r[0][2] * z;
    const hy = r[1][0] * x + r[1][1] * y + r[1][2] * z;
    const hz = r[2][0] * x + r[2][1] * y + r[2][2] * z;
    if (this.bands.H.push(j, hx, hy, hz)) this._decideAll(false);
    this.decM.push(j, hx, hy, hz);
  }

  _decideAll(final) {
    if (this.rot === null) return;
    const secT0 = this.j50 / 50.0;
    for (const b of BAND_ORDER) this.bands[b].decide(this.nFlags, this.flagCum, this.flat, final, secT0);
  }

  _end(s) {
    this._status = s;
    this._decideAll(true);
  }

  /** A deep copy of the processing state, wired to itself (secondListener is not copied). */
  _clone() {
    const c = new SessionProcessor(this.cfg);
    c._status = this._status;
    c.nRaw = this.nRaw;
    c.nRejectedRaw = this.nRejectedRaw;
    c.tFirst = this.tFirst;
    c.tLast = this.tLast;
    c.probe = this.probe.slice();
    c.probeN = this.probeN;
    c.fsProbe = this.fsProbe;
    c.fsGrid = this.fsGrid;
    if (this.grid !== null) {
      c._makeGrid();
      c.dec1.copyFrom(this.dec1);
      c.grid.copyFrom(this.grid);
    }
    c.j50 = this.j50;
    c.n50 = this.n50;
    c.block.set(this.block);
    c.blockN = this.blockN;
    c.warm.set(this.warm);
    c.warmRows = this.warmRows;
    c.wMean.set(this.wMean);
    c.wRms.set(this.wRms);
    c.nSecDone = this.nSecDone;
    c.flagCum = this.flagCum.slice();
    c.nFlags = this.nFlags;
    c.run = this.run;
    c.gUnit = this.gUnit.slice();
    c.rmsMedian = this.rmsMedian;
    c.gMedian = this.gMedian;          // never mutated after the warm-up
    c.gLevel = this.gLevel;
    c.rot = this.rot;
    c.flat = this.flat;
    for (const b of BAND_ORDER) c.bands[b].copyFrom(this.bands[b]);
    c.decL.copyFrom(this.decL);
    c.decM.copyFrom(this.decM);
    return c;
  }

  /**
   * The session features as if the input ended now (Kotlin finish()). Non-destructive: the end-of-input
   * steps run on a copy, so the session can keep receiving samples afterwards.
   */
  finish() {
    if (TERMINAL[this._status]) return this._result();
    const c = this._clone();
    if (c.grid === null && c.probeN >= 2) c._startGrid();
    if (!TERMINAL[c._status] && c.grid !== null) c.grid.finish();
    if (!TERMINAL[c._status]) {
      if (c.rot === null) c._status = "too_short"; else c._end("complete");
    }
    return c._result();
  }

  /** Cheap live snapshot for the UI. seconds = completed one-second gate blocks (warm-up included). */
  stats() {
    const bands = {};
    for (const b of BAND_ORDER) bands[b] = { k: this.bands[b].accepted, nTotal: this.bands[b].total };
    return {
      status: this._status,
      nRaw: this.nRaw,
      nRejectedRaw: this.nRejectedRaw,
      fsProbe: this.fsProbe,
      fsGrid: this.fsGrid,
      seconds: this.nSecDone,
      flaggedSeconds: this.flagCum[this.nFlags],
      bands,
    };
  }

  _result() {
    const flagged = [];
    for (let s = 0; s < this.nFlags; s++) if (this.flagCum[s + 1] > this.flagCum[s]) flagged.push(s);
    let tot = 0, acc = 0;
    const bands = {};
    for (const b of BAND_ORDER) {
      const a = this.bands[b];
      tot += a.total;
      acc += a.accepted;
      bands[b] = { k: a.accepted, nTotal: a.total, windows: a.acceptedWindows.slice(), csd: a.csdMean(), p4: a.p4Mean() };
    }
    const nRaw = this.nRaw;
    return {
      status: this._status,
      tFirst: this.tFirst,
      tLast: this.tLast,
      tStart: 60.0 * rint(this.tFirst / 60.0),
      duration: this.tLast - this.tFirst,
      fsRaw: nRaw >= 2 ? (nRaw - 1) / (this.tLast - this.tFirst) : NaN,
      fsProbe: this.fsProbe,
      fsGrid: this.fsGrid,
      nRaw,
      nRejectedRaw: this.nRejectedRaw,
      j50: this.j50,
      n50: this.n50,
      nSeconds: this.nFlags,
      flaggedSeconds: flagged,
      endSecond: this._status === "ended_flagged_run" ? this.nFlags - 1 : null,
      gMedian: this.gMedian ? Array.from(this.gMedian) : null,
      gLevel: this.gLevel ? Array.from(this.gLevel) : null,
      rmsMedian: this.rmsMedian,
      acceptFraction: acc / Math.max(tot, 1),
      bands,
    };
  }
}

// ----------------------------------------------------------------------------- Packing

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Little-endian float32 bytes as standard base64 with padding (upload schema v1). */
export function toBase64LE(values) {
  const n = values.length;
  const bytes = new Uint8Array(n * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) dv.setFloat32(4 * i, values[i], true);
  const parts = [];
  let chunk = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ""; }
  }
  if (i < len) {
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const v = (bytes[i] << 16) | (b1 << 8);
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < len ? B64[(v >> 6) & 63] : "=") + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

/** Inverse of toBase64LE: standard base64 (padding optional) to a Float32Array. */
export function fromBase64LE(text) {
  const lut = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lut[B64.charCodeAt(i)] = i;
  const clean = text.replace(/[\s=]/g, "");
  const nBytes = Math.floor(clean.length * 3 / 4);
  if (nBytes % 4 !== 0) throw new Error("length is not a multiple of 4");
  const bytes = new Uint8Array(nBytes);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? lut[c] : -1;
    if (v < 0) throw new Error("invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < nBytes) bytes[o++] = (acc >> bits) & 255;
    }
    acc &= (1 << bits) - 1;
  }
  const dv = new DataView(bytes.buffer);
  const out = new Float32Array(nBytes / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(4 * i, true);
  return out;
}
