const SAMPLE_URL = './prototype-red-blocks-sample.png';
const SAMPLE_NAME = 'prototype-red-blocks-sample.png';
const stage = document.querySelector('#stage');
const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const fxCanvas = document.querySelector('#fxCanvas');
const imageInput = document.querySelector('#imageInput');
const sampleButton = document.querySelector('#sampleButton');
const resetButton = document.querySelector('#resetButton');
const dropZone = document.querySelector('#dropZone');
const loading = document.querySelector('#loading');
const filename = document.querySelector('#filename');
const hint = document.querySelector('#hint');
const modeLabel = document.querySelector('#modeLabel');
const modeImageButton = document.querySelector('#modeImageButton');
const modeCameraButton = document.querySelector('#modeCameraButton');
const opMultiplyButton = document.querySelector('#opMultiplyButton');
const opAddButton = document.querySelector('#opAddButton');
const opSubtractButton = document.querySelector('#opSubtractButton');
const imageToolbar = document.querySelector('#imageToolbar');
const cameraToolbar = document.querySelector('#cameraToolbar');
const startCameraButton = document.querySelector('#startCameraButton');
const stopCameraButton = document.querySelector('#stopCameraButton');
const cameraSelect = document.querySelector('#cameraSelect');
const liveBadge = document.querySelector('#liveBadge');
const torchStatusEl = document.querySelector('#torchStatus');
const torchEnabledInput = document.querySelector('#torchEnabled');
const video = document.querySelector('#video');
const cameraMessage = document.querySelector('#cameraMessage');
const controls = {
  strength: document.querySelector('#redStrength'),
  minArea: document.querySelector('#minArea'),
  bridge: document.querySelector('#bridge')
};
const cardValueEl = document.querySelector('#cardValue');
const cardDetailEl = document.querySelector('#cardDetail');
const cardBadge = document.querySelector('#cardBadge');
const cardZoneEnabledInput = document.querySelector('#cardZoneEnabled');
const cardContrastInput = document.querySelector('#cardContrast');
const cardContrastOutput = document.querySelector('#cardContrastOutput');
const debugModeInput = document.querySelector('#debugMode');
const useMarkersInput = document.querySelector('#useMarkers');
const mascotEl = document.querySelector('#mascot');
const mascotFaceEl = document.querySelector('#mascotFace');
const scoreHud = document.querySelector('#scoreHud');
const scoreValueEl = document.querySelector('#scoreValue');
const settingsButton = document.querySelector('#settingsButton');
const settingsDrawer = document.querySelector('#settingsDrawer');
const drawerScrim = document.querySelector('#drawerScrim');
const closeSettingsButton = document.querySelector('#closeSettingsButton');
const scanRingProgressEl = document.querySelector('#scanRingProgress');
const cardHudWrap = document.querySelector('#cardHudWrap');
const cardFeedbackEl = document.querySelector('#cardFeedback');
const SCAN_RING_CIRCUMFERENCE = 2 * Math.PI * 18;
scanRingProgressEl.style.strokeDasharray = String(SCAN_RING_CIRCUMFERENCE);
scanRingProgressEl.style.strokeDashoffset = String(SCAN_RING_CIRCUMFERENCE);
let sourceImage = null;
// The camera is the primary experience now; static-image mode is a
// secondary "test the algorithm on a photo" tool tucked into the settings
// drawer (see #modeImageButton), not the default view.
let mode = 'camera';
// Which arithmetic problem the live camera is reading. Orthogonal to
// `mode` above (image-test mode only ever exercises multiplication — it's
// a detector-accuracy tool, not part of the "game"). 'multiply' keeps the
// original rows×cols grid pipeline untouched; 'add'/'subtract' use the
// two-zone marker-counting pipeline instead (see computeProblem()).
let operation = 'multiply';

video.playsInline = true;
video.muted = true;

// `silent` skips the loading-spinner toggling — used for the initial
// background preload of the bundled sample image so it doesn't flash a
// "loading" overlay over the camera start screen on first paint.
function loadUrl(url, name, { silent = false } = {}) {
  if (!silent) loading.classList.remove('hidden');
  const image = new Image();
  image.onload = () => {
    sourceImage = image;
    filename.textContent = name;
    if (mode === 'image') analyze();
    if (!silent) loading.classList.add('hidden');
  };
  image.onerror = () => {
    if (!silent) loading.textContent = 'Could not load the image. Please choose a different photo.';
  };
  image.src = url;
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (mode !== 'image') setMode('image');
  const url = URL.createObjectURL(file);
  loadUrl(url, file.name);
}

// The block face is red/magenta with a blue undertone (R and B both notably
// above G), which is what separates it from the warm orange/brown wood desk
// (R above G and B, but B well below G there). Both channel gaps are scaled
// by `strength` so the slider moves them together: higher = stricter.
function redPixel(r, g, b, strength) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  return r > 42 && saturation > 0.14 &&
    r - g > strength && g - b < strength * 0.6 && r > b * 1.02;
}

function dilate(mask, width, height, radius) {
  if (!radius) return mask;
  const horizontal = new Uint8Array(mask.length);
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    let active = 0;
    for (let x = 0; x < width; x++) {
      const add = x + radius;
      const remove = x - radius - 1;
      if (add < width) active += mask[y * width + add];
      if (remove >= 0) active -= mask[y * width + remove];
      horizontal[y * width + x] = active > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let active = 0;
    for (let y = 0; y < height; y++) {
      const add = y + radius;
      const remove = y - radius - 1;
      if (add < height) active += horizontal[add * width + x];
      if (remove >= 0) active -= horizontal[remove * width + x];
      result[y * width + x] = active > 0 ? 1 : 0;
    }
  }
  return result;
}

// Returns every connected blob above the noise floor, regardless of size —
// including ones far bigger than a single block (multiple touching blocks
// merged into one region). The caller (runDetection) decides whether a
// blob is single-block-sized or needs further splitting.
function components(mask, originalMask, width, height, minAreaFraction) {
  const seen = new Uint8Array(mask.length);
  const found = [];
  const minPixels = width * height * minAreaFraction;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0, area = 0, matched = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p / width) | 0;
      area++;
      matched += originalMask[p];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const neighbors = [p - 1, p + 1, p - width, p + width];
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const boxArea = w * h;
    if (boxArea >= minPixels && matched >= Math.max(12, boxArea * .015)) {
      found.push({ x: minX, y: minY, w, h, cx: minX + w / 2, cy: minY + h / 2, matched, boxArea, aspect: w / h });
    }
  }
  return found.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
}

// Groups 1D positions into rows/columns by looking for a natural jump in
// the gaps between consecutive sorted values, instead of a fixed tolerance
// derived from box size. A fixed size-based tolerance made row/col grouping
// far too strict for the yellow-marker mode (the marker is much smaller
// than the actual block pitch, so `medianSize * .7` was tighter than any
// realistic placement wobble) and it doesn't adapt to how neatly the blocks
// are actually placed. Here, the within-row/column jitter just needs to be
// clearly smaller than the gap to the next row/column — not smaller than
// some fraction of the block's own size — which holds even for fairly
// sloppy placement as long as rows/columns don't visually merge together.
function clusterAdaptive(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2) return sorted.map(v => ({ mean: v, values: [v] }));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  let cutIndex = -1, bestRatio = 1;
  for (let i = 1; i < sortedGaps.length; i++) {
    const ratio = (sortedGaps[i] + 1) / (sortedGaps[i - 1] + 1);
    if (ratio > bestRatio) { bestRatio = ratio; cutIndex = i; }
  }
  // Require a clear jump (not just gradually-increasing gaps) before
  // treating it as a real row/column boundary rather than noise.
  const threshold = cutIndex >= 0 && bestRatio > 1.8
    ? (sortedGaps[cutIndex - 1] + sortedGaps[cutIndex]) / 2
    : Infinity;
  const groups = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > threshold) { groups.push(current); current = [sorted[i]]; }
    else current.push(sorted[i]);
  }
  groups.push(current);
  return groups.map(g => ({ mean: g.reduce((a, b) => a + b, 0) / g.length, values: g }));
}

// Coefficient-of-variation based regularity score in [0,1]; 1 = perfectly
// uniform values, falling toward 0 as spacing/size/fill becomes irregular.
// Used to keep noisy camera frames from confirming grids that only look
// grid-shaped by coincidence (see GRID_CONFIDENCE_THRESHOLD below).
function regularity(values) {
  if (values.length < 2) return 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, 1 - cv * 2);
}

const GRID_CONFIDENCE_THRESHOLD = 0.45;

function gridConfidence(boxes, rowCenters, colCenters) {
  const widths = boxes.map(b => b.w);
  const heights = boxes.map(b => b.h);
  const densities = boxes.map(b => b.matched / (b.w * b.h));
  const rowSteps = rowCenters.slice(1).map((v, i) => v - rowCenters[i]);
  const colSteps = colCenters.slice(1).map((v, i) => v - colCenters[i]);
  const sizeScore = (regularity(widths) + regularity(heights)) / 2;
  const densityUniformity = regularity(densities);
  const avgDensity = Math.min(1, densities.reduce((a, b) => a + b, 0) / densities.length);
  const spacingScore = (regularity(rowSteps) + regularity(colSteps)) / 2;
  return Math.max(0, Math.min(1,
    0.3 * spacingScore + 0.25 * sizeScore + 0.25 * densityUniformity + 0.2 * avgDensity
  ));
}

// A single row/column of *evenly-spaced* boxes is exactly the case
// clusterAdaptive can't split: its gap-ratio method looks for a gap that's
// dramatically bigger than the others (the within-row/column repetition a
// real 2D grid has makes that contrast obvious), but N evenly-spaced,
// never-repeated positions along one line have no such contrast — every
// consecutive gap looks the same, so it (correctly, for its purpose)
// refuses to split at all and returns one big cluster. So a 1×N line is
// detected directly here instead of by asking clusterAdaptive to produce
// N column clusters from a single row.
function inferLineGrid(boxes) {
  const avgW = boxes.reduce((s, b) => s + b.w, 0) / boxes.length;
  const avgH = boxes.reduce((s, b) => s + b.h, 0) / boxes.length;
  const cys = boxes.map(b => b.cy), cxs = boxes.map(b => b.cx);
  const isSingleRow = Math.max(...cys) - Math.min(...cys) < avgH * 0.5;
  const isSingleCol = Math.max(...cxs) - Math.min(...cxs) < avgW * 0.5;
  if (!isSingleRow && !isSingleCol) return null;
  const axisValues = (isSingleRow ? cxs : cys).slice().sort((a, b) => a - b);
  const minGap = (isSingleRow ? avgW : avgH) * 0.3;
  for (let i = 1; i < axisValues.length; i++) {
    // Positions too close together read as one duplicate detection, not
    // two distinct blocks.
    if (axisValues[i] - axisValues[i - 1] < minGap) return null;
  }
  const rowCenters = isSingleRow ? [cys[0]] : axisValues;
  const colCenters = isSingleRow ? axisValues : [cxs[0]];
  const confidence = gridConfidence(boxes, rowCenters, colCenters);
  if (confidence < GRID_CONFIDENCE_THRESHOLD) return null;
  return isSingleRow
    ? { rows: 1, cols: boxes.length, confidence }
    : { rows: boxes.length, cols: 1, confidence };
}

function inferGrid(boxes) {
  if (boxes.length < 2) return null;
  const line = inferLineGrid(boxes);
  if (line) return line;
  // A genuine 2D grid needs at least 4 boxes — with fewer, a coincidental
  // scatter could too easily look like a tiny grid by chance.
  if (boxes.length < 4) return null;
  const rows = clusterAdaptive(boxes.map(b => b.cy));
  const cols = clusterAdaptive(boxes.map(b => b.cx));
  if (rows.length < 2 || cols.length < 2 || rows.length * cols.length !== boxes.length) return null;
  const occupancy = new Set();
  for (const box of boxes) {
    const r = rows.reduce((best, g, i) => Math.abs(g.mean-box.cy) < best.d ? {i,d:Math.abs(g.mean-box.cy)} : best, {i:-1,d:Infinity}).i;
    const c = cols.reduce((best, g, i) => Math.abs(g.mean-box.cx) < best.d ? {i,d:Math.abs(g.mean-box.cx)} : best, {i:-1,d:Infinity}).i;
    occupancy.add(`${r}:${c}`);
  }
  if (occupancy.size !== boxes.length) return null;
  const rowCenters = rows.map(g => g.mean).sort((a, b) => a - b);
  const colCenters = cols.map(g => g.mean).sort((a, b) => a - b);
  const confidence = gridConfidence(boxes, rowCenters, colCenters);
  if (confidence < GRID_CONFIDENCE_THRESHOLD) return null;
  return { rows: rows.length, cols: cols.length, confidence };
}

function smoothProjection(values, radius) {
  const sums = new Float64Array(values.length + 1);
  const result = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) sums[i + 1] = sums[i] + values[i];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    result[i] = (sums[hi + 1] - sums[lo]) / (hi - lo + 1);
  }
  return result;
}

function projectionPeaks(values, minDimension) {
  const smoothed = smoothProjection(values, Math.max(3, Math.round(minDimension * .025)));
  const maxValue = Math.max(...smoothed);
  const candidates = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] >= smoothed[i - 1] && smoothed[i] > smoothed[i + 1] && smoothed[i] > maxValue * .26) {
      candidates.push(i);
    }
  }
  candidates.sort((a, b) => smoothed[b] - smoothed[a]);
  const chosen = [];
  const minDistance = Math.max(12, Math.round(minDimension * .18));
  for (const value of candidates) {
    if (chosen.every(other => Math.abs(value - other) >= minDistance)) chosen.push(value);
  }
  return chosen.sort((a, b) => a - b);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// When neighboring blocks touch, connected components become one large red
// blob. In that case, find the repeated square centers from the red density
// peaks on the X and Y axes — the shadow seam between blocks thins out the
// mask there even when it doesn't fully break pixel connectivity.
//
// `region` (in full-mask pixel coords) scopes the projection to just one
// blob's own bounding box, so the smoothing/peak spacing below — which is
// sized as a *fraction of the scanned area* — tracks that blob's actual
// pixel size instead of the whole camera frame. Without this, blocks that
// are small on screen (far from the camera) get smoothed into a single flat
// hump: the shadow gaps between them are only a few pixels wide, but a
// frame-sized smoothing radius averages right over them.
function detectTouchingGrid(mask, width, height, region) {
  const rx0 = region ? region.x0 : 0;
  const ry0 = region ? region.y0 : 0;
  const rx1 = region ? region.x1 : width;
  const ry1 = region ? region.y1 : height;
  const rw = rx1 - rx0, rh = ry1 - ry0;
  const xProjection = new Uint32Array(rw);
  const yProjection = new Uint32Array(rh);
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      if (mask[y * width + x]) { xProjection[x - rx0]++; yProjection[y - ry0]++; }
    }
  }
  const minDimension = Math.min(rw, rh);
  const localXs = projectionPeaks(xProjection, minDimension);
  const localYs = projectionPeaks(yProjection, minDimension);
  // A 1×N or N×1 strip of touching blocks has no internal gap on its short
  // axis (it's just one uniform band), so that axis legitimately produces
  // only 1 peak — only reject when NEITHER axis found the 2+ peaks needed
  // to prove there's more than one block here at all.
  if (localXs.length < 1 || localYs.length < 1 ||
    (localXs.length < 2 && localYs.length < 2) ||
    localXs.length > 12 || localYs.length > 12) return null;
  const xs = localXs.map(x => x + rx0);
  const ys = localYs.map(y => y + ry0);

  const stepX = xs.length > 1 ? median(xs.slice(1).map((x, i) => x - xs[i])) : rw;
  const stepY = ys.length > 1 ? median(ys.slice(1).map((y, i) => y - ys[i])) : rh;
  const sampleW = Math.max(12, stepX * .68);
  const sampleH = Math.max(12, stepY * .68);
  const scored = [];
  for (const cy of ys) for (const cx of xs) {
    const x0 = Math.max(0, Math.round(cx - sampleW / 2));
    const x1 = Math.min(width, Math.round(cx + sampleW / 2));
    const y0 = Math.max(0, Math.round(cy - sampleH / 2));
    const y1 = Math.min(height, Math.round(cy + sampleH / 2));
    let matched = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) matched += mask[y * width + x];
    scored.push({ cx, cy, density: matched / ((x1 - x0) * (y1 - y0)), matched });
  }
  const maxDensity = Math.max(...scored.map(cell => cell.density));
  const occupied = scored.filter(cell => cell.density >= maxDensity * .30);
  if (occupied.length !== xs.length * ys.length) return null;

  const boxW = stepX * .88;
  const boxH = stepY * .88;
  const confidence = gridConfidence(
    occupied.map(cell => ({ w: boxW, h: boxH, matched: cell.matched })),
    ys, xs
  );
  if (confidence < GRID_CONFIDENCE_THRESHOLD) return null;
  return {
    rows: ys.length,
    cols: xs.length,
    confidence,
    boxes: occupied.map(cell => ({
      x: cell.cx - boxW / 2, y: cell.cy - boxH / 2,
      w: boxW, h: boxH, cx: cell.cx, cy: cell.cy, matched: cell.matched
    }))
  };
}

// Yellow center-marker mode (opt-in): a small piece of yellow tape stuck to
// the middle of each block face. Shadow-based separation (detectTouchingGrid
// below) has proven unreliable across real lighting — this restores the
// original, already-proven P1 strategy (a distinct marker per block,
// independent of subtle shadow contrast) for anyone willing to add tape.
// Markers from neighboring blocks never touch even when the blocks
// themselves do (there's always a red margin around each marker), so plain
// connected-component detection is enough — no touching-grid step needed.
// Uses the same yellowPixel() classifier as the answer-block detection
// further down, since it's the same color of tape.

// The marker sits in the middle of a block face, so the ring checked here
// has to reach out far enough (relative to the marker's own size) to find
// the surrounding red — not just a thin border immediately around it.
function hasRedSurround(frame, blob, strength) {
  const pad = Math.max(6, Math.min(blob.w, blob.h) * 0.9);
  const x0 = Math.max(0, Math.round(blob.x - pad));
  const x1 = Math.min(frame.width, Math.round(blob.x + blob.w + pad));
  const y0 = Math.max(0, Math.round(blob.y - pad));
  const y1 = Math.min(frame.height, Math.round(blob.y + blob.h + pad));
  let red = 0, total = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    if (x >= blob.x && x <= blob.x + blob.w && y >= blob.y && y <= blob.y + blob.h) continue;
    const i = (y * frame.width + x) * 4;
    total++;
    if (redPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2], strength)) red++;
  }
  return total > 0 && red / total > 0.35;
}

function detectMarkedBlocks(frame, strength) {
  const width = frame.width, height = frame.height;
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    mask[p] = yellowPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2], 20) ? 1 : 0;
  }
  const maxMarkerPixels = width * height * 0.05;
  const blobs = components(mask, mask, width, height, 0.00005);
  return blobs.filter(b =>
    b.boxArea <= maxMarkerPixels && b.aspect > .45 && b.aspect < 2.2 && hasRedSurround(frame, b, strength)
  );
}

function runDetection(width, height, strength, minAreaFraction, bridgeRadius, frame, useMarkers) {
  const imageData = frame || ctx.getImageData(0, 0, width, height);

  if (useMarkers) {
    const markers = detectMarkedBlocks(imageData, strength);
    return { boxes: markers, grid: inferGrid(markers) };
  }

  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    mask[p] = redPixel(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2], strength) ? 1 : 0;
  }
  const joined = dilate(mask, width, height, bridgeRadius);
  const blobs = components(joined, mask, width, height, minAreaFraction);

  // Always try to resolve each blob into a grid first, scoped to just its
  // own region — a genuinely single block simply has one red hump on each
  // axis, so detectTouchingGrid finds 1 peak per axis and reports nothing,
  // and the blob falls back to being one box. Blob *size* alone isn't a
  // reliable way to tell "one block" from "several touching blocks merged":
  // a whole distant cluster can still be smaller, in pixels, than a single
  // block held close to the camera.
  const boxes = [];
  for (const blob of blobs) {
    // No padding around the blob's own box: the gap between two touching
    // blocks can be just a couple of pixels (see detectTouchingGrid's
    // comment), so any padding here risks reaching past it into a
    // neighboring blob and corrupting the projection with its edge.
    const region = { x0: blob.x, y0: blob.y, x1: blob.x + blob.w, y1: blob.y + blob.h };
    const resolved = detectTouchingGrid(mask, width, height, region);
    if (resolved && resolved.boxes.length > 1) {
      boxes.push(...resolved.boxes);
    } else if (blob.aspect > .42 && blob.aspect < 2.35) {
      boxes.push(blob);
    }
  }

  const grid = inferGrid(boxes);
  return { boxes, grid };
}

// --- Addition / subtraction: two counting zones -------------------------
//
// Multiplication has a clean physical shape (rows × columns). Addition and
// subtraction don't, so instead: the screen shows two marked zones with a
// +/− symbol between them, and each zone's block count is read
// independently — reusing the same corner-marker detection multiplication
// already relies on (detectMarkedBlocks), which finds each block by its own
// marker regardless of layout, no grid inference needed. Left − right (or
// left + right) becomes the hidden answer, exactly like rows × cols does
// for multiplication: the operands are shown, the result isn't.
// Laid out left-to-right as three zones (operand, operand, answer) since
// the app is landscape-first — a wide camera frame has the room for this
// without stacking anything, and it mirrors reading the equation left to
// right: [A] + [B] = [answer goes here].
const COUNT_ZONE_LEFT = { left: .03, top: .16, width: .27, height: .52 };
const COUNT_ZONE_RIGHT = { left: .365, top: .16, width: .27, height: .52 };
const ANSWER_ZONE_ADDSUB = { left: .70, top: .16, width: .27, height: .52 };

function fracRect(frac) {
  return { x: canvas.width * frac.left, y: canvas.height * frac.top, w: canvas.width * frac.width, h: canvas.height * frac.height };
}

function boxCenterInZone(box, zone) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h;
}

function detectCountZones(frame, strength) {
  const markers = detectMarkedBlocks(frame, strength);
  const leftZone = fracRect(COUNT_ZONE_LEFT), rightZone = fracRect(COUNT_ZONE_RIGHT);
  const answerZone = fracRect(ANSWER_ZONE_ADDSUB);
  return {
    leftBoxes: markers.filter(b => boxCenterInZone(b, leftZone)),
    rightBoxes: markers.filter(b => boxCenterInZone(b, rightZone)),
    leftZone, rightZone, answerZone
  };
}

function drawBoxesOverlay(boxes) {
  const line = Math.max(2, canvas.width / 420);
  ctx.font = `700 ${Math.max(14, canvas.width / 58)}px sans-serif`;
  ctx.textBaseline = 'middle';
  boxes.forEach((box, index) => {
    const pad = Math.max(5, Math.min(box.w, box.h) * .12);
    ctx.strokeStyle = '#00c897';
    ctx.lineWidth = line;
    ctx.strokeRect(box.x-pad, box.y-pad, box.w+pad*2, box.h+pad*2);
    ctx.fillStyle = '#00c897';
    ctx.beginPath(); ctx.arc(box.cx, box.cy, line*2.2, 0, Math.PI*2); ctx.fill();
    const label = String(index + 1);
    const labelW = ctx.measureText(label).width + 14;
    ctx.fillRect(box.x-pad, box.y-pad-28, labelW, 28);
    ctx.fillStyle = '#08261e';
    ctx.fillText(label, box.x-pad+7, box.y-pad-14);
  });
}

function drawResults(boxes) {
  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  drawBoxesOverlay(boxes);
}

function analyze() {
  if (!sourceImage) return;
  const scale = Math.min(1, 1100 / sourceImage.naturalWidth);
  canvas.width = Math.round(sourceImage.naturalWidth * scale);
  canvas.height = Math.round(sourceImage.naturalHeight * scale);
  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  const strength = Number(controls.strength.value);
  const minAreaFraction = Number(controls.minArea.value) / 100000;
  const bridgeRadius = Number(controls.bridge.value);
  const { boxes, grid } = runDetection(canvas.width, canvas.height, strength, minAreaFraction, bridgeRadius, undefined, useMarkersInput.checked);
  drawResults(boxes);
  updateResult(boxes, grid);
}

function updateResult(boxes, grid) {
  document.querySelector('#count').textContent = boxes.length;
  const equation = document.querySelector('#equation');
  const arrangement = document.querySelector('#arrangement');
  if (grid) {
    equation.textContent = `${grid.rows} × ${grid.cols} = ${grid.rows * grid.cols}`;
    arrangement.textContent = `Recognized as ${grid.rows} row${grid.rows === 1 ? '' : 's'} × ${grid.cols} column${grid.cols === 1 ? '' : 's'}.`;
  } else {
    equation.textContent = boxes.length ? 'Arrange them in a grid to see an equation' : 'No red blocks found';
    arrangement.textContent = boxes.length ? 'Not arranged in a grid, so only the count is shown.' : 'Try adjusting the sliders, or pick a different photo.';
  }
}

function updateLabels() {
  document.querySelector('#redOutput').value = controls.strength.value;
  document.querySelector('#areaOutput').value = `${(Number(controls.minArea.value)/1000).toFixed(3)}%`;
  document.querySelector('#bridgeOutput').value = controls.bridge.value;
}

// --- Temporal stabilization -------------------------------------------
//
// Both the block grid and the answer cards need the same treatment: don't
// trust a single frame, wait for a recent window of readings to agree, and
// hold the last confirmed reading through brief noise/occlusion. This one
// helper drives both (see blockStabilizer / cardStabilizer below).

function createStabilizer({ windowMs, holdMs, ratio, ignore = () => false }) {
  let entries = [];
  let confirmed = null;
  return {
    reset() { entries = []; confirmed = null; },
    tick(now, signature, payload) {
      entries.push({ t: now, signature, payload });
      const cutoff = now - windowMs;
      entries = entries.filter(e => e.t >= cutoff);

      const counts = new Map();
      for (const e of entries) counts.set(e.signature, (counts.get(e.signature) || 0) + 1);
      let majoritySig = null, majorityCount = 0;
      for (const [sig, c] of counts) { if (c > majorityCount) { majoritySig = sig; majorityCount = c; } }
      const windowSpan = entries.length ? now - entries[0].t : 0;
      const majorityFraction = entries.length ? majorityCount / entries.length : 0;

      if (windowSpan >= windowMs * 0.85 && majoritySig != null && !ignore(majoritySig) && majorityFraction >= ratio) {
        const rep = [...entries].reverse().find(e => e.signature === majoritySig);
        confirmed = { signature: majoritySig, payload: rep.payload, confirmedAt: now };
      }

      const holdActive = !!confirmed && (now - confirmed.confirmedAt) < holdMs;
      const isCurrentlyStable = holdActive && signature === confirmed.signature && majorityFraction >= ratio;
      // A 0-1 "how close to confirming" readout for the AR scan ring/reticle
      // — combines how much of the confirmation window has elapsed with how
      // consistent (majority-agreeing) the recent readings have been. Stays
      // at 0 while the majority reading is an ignored one (e.g. "no boxes"),
      // since that can never actually confirm.
      const majorityIgnored = majoritySig != null && ignore(majoritySig);
      const progress = isCurrentlyStable
        ? 1
        : (majorityIgnored ? 0 : Math.min(1, windowSpan / windowMs) * Math.min(1, majorityFraction / ratio));
      return { confirmed, holdActive, isCurrentlyStable, progress };
    }
  };
}

// --- Live camera (P2: block grid) --------------------------------------

let cameraStream = null;
let cameraActive = false;
let rafId = null;
let lastAnalysisTime = 0;
const ANALYSIS_INTERVAL_MS = 130; // ~7.7 Hz, within the 5-10/sec target
const CONFIRM_WINDOW_MS = 2000; // "about 2 seconds" stability requirement
const HOLD_MS = 1600; // how long a confirmed reading survives a brief occlusion
const STABILITY_RATIO = 0.7; // fraction of recent readings that must agree

const blockStabilizer = createStabilizer({
  windowMs: CONFIRM_WINDOW_MS, holdMs: HOLD_MS, ratio: STABILITY_RATIO,
  // Never confirm a totally-empty reading, for any operation (0 blocks for
  // multiply, or nothing in either zone for add/subtract) — everything
  // else (even a lopsided "3 in the left zone, nothing in the right yet")
  // is a legitimate, confirmable "still working on it" state.
  ignore: sig => sig === 'm:n0' || sig === 'a:0x0' || sig === 's:0x0'
});

let lastOverlayBoxes = [];
let lastOverlayBbox = null; // current-frame (unstabilized) bounding box, for the AR scan reticle
let lastBlockProgress = 0;
let lastBlockConfirmedForReticle = false;
let lastConfirmedGridInfo = null; // { grid, bbox } while a grid is confirmed+held, for the dimension brackets (multiply only)
let lastZoneDisplay = null; // { leftZone, rightZone, leftCount, rightCount, symbol, confirmed } (add/subtract only)
let lastEquationBanner = null; // { bbox, text } — the big on-canvas "2 × 3 = ?" readout, all three operations

// --- "Game" layer: counting reveal animation + correct-answer celebration
//
// These are purely presentational — they read the same confirmed state the
// panels already use, they don't feed back into detection at all.

let revealAnimation = null; // { startedAt, boxes, perStepMs }
let lastRevealedSignature = null;
let celebration = null; // { startedAt, answer, confetti }
// Intermittent detection (a dropped frame or two) briefly flips
// isCurrentlyStable off and back on even while the *held* reading never
// actually changed — previously that momentary blip reset
// lastCelebratedKey, so the very next tick looked like "a brand new
// match" and re-fired the chime/score/gem. Fix: a given equation+answer
// key, once celebrated, stays "already celebrated" until it genuinely
// changes to something else (the blocks are rearranged into a different
// shape) or the page reloads — no time-based expiry, by design: the
// reward is for solving the problem once, not for leaving the answer
// sitting there.
let lastCelebratedKey = null;
// What actually re-arms lastCelebratedKey: the *red blocks'* own confirmed
// signature (from blockStabilizer — multiplication's grid, addition's two
// zones, or subtraction's pile) genuinely changing to a new held value.
// This is immune to flicker the same way lastCelebratedKey now is — a
// dropped frame doesn't change what the stabilizer is currently holding —
// but still correctly re-arms if the child rebuilds the blocks into a
// different shape and back. A digit card changing on its own (without the
// blocks changing) deliberately does NOT re-arm it, per the same
// intent: only the physical blocks changing shape should unlock a repeat.
let lastConfirmedBlockSigSeen = null;
function noteBlockSignature(confirmedSignature) {
  if (confirmedSignature != null && confirmedSignature !== lastConfirmedBlockSigSeen) {
    lastConfirmedBlockSigSeen = confirmedSignature;
    lastCelebratedKey = null;
  }
}
let audioCtx = null;

// Both stabilizers key the game layer (brackets read the block signature,
// celebration reads both), so any manual stabilizer reset (settings change,
// device switch) needs to drop this too — otherwise a stale bracket/reveal
// keeps rendering against a grid that no longer matches what's confirmed.
function resetGameLayer() {
  lastConfirmedGridInfo = null;
  lastZoneDisplay = null;
  lastEquationBanner = null;
  document.querySelector('.equation-pill').classList.remove('hidden');
  lastSubtractDisplay = null;
  subtractLockedStart = null;
  lastPileCountBeforeRemoval = null;
  takenAwayStabilizer.reset();
  revealAnimation = null;
  lastRevealedSignature = null;
  celebration = null;
  lastCelebratedKey = null;
  lastConfirmedBlockSigSeen = null;
  // The 3D layer's own render loop only runs while the camera's rAF loop
  // is running, so clearing `celebration` alone isn't enough — without
  // this, a frozen gem frame would stay on fxCanvas after the camera stops.
  if (fx3D) { fx3D.renderer.clear(); fx3D.wasActive = false; }
}

// --- Mascot companion --------------------------------------------------
//
// A cheap, robust stand-in for "the app is looking at you and reacting" —
// just an emoji + CSS animation per state, no image assets or canvas
// character rendering needed.
const MASCOT_FACES = {
  sleep: '💤', scanning: '👀', thinking: '🤔', ready: '🙂', mismatch: '🧐', celebrate: '🎉'
};
function setMascotState(state) {
  mascotFaceEl.textContent = MASCOT_FACES[state] || MASCOT_FACES.scanning;
  mascotEl.className = 'mascot state-' + state;
}

// --- Score (lifetime correct-answer count, on-device only) -------------

let sessionScore = 0;
try { sessionScore = Number(localStorage.getItem('pbScore')) || 0; } catch (e) { /* storage unavailable — score just won't persist */ }

function updateScoreDisplay() {
  scoreValueEl.textContent = String(sessionScore);
}

function incrementScore() {
  sessionScore++;
  updateScoreDisplay();
  try { localStorage.setItem('pbScore', String(sessionScore)); } catch (e) { /* ignore */ }
  scoreHud.classList.remove('pop');
  void scoreHud.offsetWidth; // restart the pop animation even on back-to-back scores
  scoreHud.classList.add('pop');
}

// The canvas is displayed with `object-fit: cover`, so whenever its
// internal (video-resolution) aspect ratio doesn't match the on-screen box
// (portrait phone showing a landscape-ish camera feed, say), the sides get
// cropped off. Canvas-drawn content that needs to stay fully visible
// on-screen (e.g. centered banner text) should size itself against this,
// not against the full canvas.width.
function visibleCanvasWidth() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return canvas.width;
  const boxAspect = rect.width / rect.height;
  const srcAspect = canvas.width / canvas.height;
  return srcAspect > boxAspect ? canvas.height * boxAspect : canvas.width;
}

// Maps a point in the detection canvas's internal pixel space (e.g. a
// digit card's on-screen position) to on-screen CSS pixels within the
// shared canvas-wrap box — accounting for the same object-fit:cover
// scale/crop as above. #fxCanvas fills that exact same box, so this is
// also the correct coordinate space for placing a Three.js effect at a
// specific detected position rather than dead-center.
function canvasPointToDisplayPixels(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: cx, y: cy };
  const scale = Math.max(rect.width / canvas.width, rect.height / canvas.height);
  const offsetX = (canvas.width * scale - rect.width) / 2;
  const offsetY = (canvas.height * scale - rect.height) / 2;
  return { x: cx * scale - offsetX, y: cy * scale - offsetY };
}

// The score gem counter is a plain HTML element, already in on-screen CSS
// pixel space — no canvas/object-fit conversion needed, just its own
// bounding box.
function elementCenterDisplayPixels(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// --- AR-style scanning reticle -------------------------------------------
//
// Corner brackets around the current (unstabilized) detection area, like a
// camera-app/AR object-scanner frame — amber and pulsing while still
// gathering readings, snapping to a solid green lock the instant the grid
// is confirmed. Falls back to a generic centered guide frame when nothing
// is detected yet, to hint where to place blocks.
function drawScanReticle(progress, isConfirmed, bbox, timestamp) {
  const box = bbox || {
    minX: canvas.width * 0.16, minY: canvas.height * 0.22,
    maxX: canvas.width * 0.84, maxY: canvas.height * 0.78
  };
  const inset = Math.max(6, canvas.width * 0.012);
  const x0 = box.minX - inset, y0 = box.minY - inset, x1 = box.maxX + inset, y1 = box.maxY + inset;
  const len = Math.max(16, Math.min(x1 - x0, y1 - y0) * 0.16);
  const pulse = isConfirmed ? 1 : 0.55 + 0.45 * Math.sin(timestamp / 260);
  ctx.save();
  ctx.strokeStyle = isConfirmed
    ? 'rgba(0,226,120,0.95)'
    : `rgba(255,178,0,${(0.3 + 0.55 * Math.max(0, Math.min(1, progress))) * pulse})`;
  ctx.lineWidth = Math.max(3, canvas.width / 260) * (isConfirmed ? 1.3 : 1);
  ctx.lineCap = 'round';
  [
    [x0, y0, x0 + len, y0, x0, y0 + len],
    [x1, y0, x1 - len, y0, x1, y0 + len],
    [x0, y1, x0 + len, y1, x0, y1 - len],
    [x1, y1, x1 - len, y1, x1, y1 - len]
  ].forEach(([cx, cy, ax, ay, bx, by]) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(cx, cy); ctx.lineTo(bx, by);
    ctx.stroke();
  });
  ctx.restore();
}

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* Web Audio unavailable — celebration will just be silent */ }
}

// A quiz-show-style two-note "ding-dong" chime, synthesized locally (no
// audio asset to ship or license).
function playCorrectChime() {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    [{ freq: 880, start: 0, dur: 0.16 }, { freq: 1318.5, start: 0.15, dur: 0.4 }].forEach(n => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0.0001, t0 + n.start);
      gain.gain.exponentialRampToValueAtTime(0.32, t0 + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + n.start);
      osc.stop(t0 + n.start + n.dur + 0.05);
    });
  } catch (e) { /* ignore */ }
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t)) - 1;
  return 1 + x * x * x;
}

function roundRectPath(x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A straight dimension line with end ticks and a pill label at its
// midpoint — showing "how many span this edge" the way an engineering
// drawing's dimension line does (a simpler, more robust cousin of the
// curly-brace annotation this was modeled on).
function drawDimensionLine(x1, y1, x2, y2, label, color) {
  const tickLen = Math.max(10, canvas.width / 70);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, canvas.width / 400);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.moveTo(x1 - nx * tickLen / 2, y1 - ny * tickLen / 2);
  ctx.lineTo(x1 + nx * tickLen / 2, y1 + ny * tickLen / 2);
  ctx.moveTo(x2 - nx * tickLen / 2, y2 - ny * tickLen / 2);
  ctx.lineTo(x2 + nx * tickLen / 2, y2 + ny * tickLen / 2);
  ctx.stroke();

  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const fontSize = Math.max(16, canvas.width / 30);
  ctx.font = `800 ${fontSize}px sans-serif`;
  const textW = ctx.measureText(label).width;
  const padX = 10, padY = 6;
  const pillW = textW + padX * 2, pillH = fontSize + padY * 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  roundRectPath(mx - pillW / 2, my - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my + 1);
  ctx.restore();
}

// Which side (top/bottom) the grid's "cols" dimension line lands on — the
// same room comparison drawGridDimensionBrackets uses below, pulled out so
// the equation banner can ask for it and deliberately take the other side
// instead of running the same comparison and landing on top of it.
function gridColsBracketSide(bbox) {
  const gap = Math.max(24, canvas.width * 0.035);
  const topSpace = bbox.minY - gap - 20;
  const bottomSpace = canvas.height - (bbox.maxY + gap + 20);
  return (bottomSpace >= 0 || bottomSpace >= topSpace) ? 'bottom' : 'top';
}

// Shows "how many across / how many down" as two dimension lines around
// the confirmed grid's bounding box — placed on whichever side (left vs
// right, above vs below) actually has room on screen.
function drawGridDimensionBrackets(bbox, rows, cols) {
  const gap = Math.max(24, canvas.width * 0.035);
  const color = 'rgba(0,105,72,0.92)';
  const leftSpace = bbox.minX - gap - 20;
  const rightSpace = canvas.width - (bbox.maxX + gap + 20);
  if (leftSpace >= 0 || leftSpace >= rightSpace) {
    drawDimensionLine(bbox.minX - gap, bbox.minY, bbox.minX - gap, bbox.maxY, String(rows), color);
  } else {
    drawDimensionLine(bbox.maxX + gap, bbox.minY, bbox.maxX + gap, bbox.maxY, String(rows), color);
  }
  if (gridColsBracketSide(bbox) === 'bottom') {
    drawDimensionLine(bbox.minX, bbox.maxY + gap, bbox.maxX, bbox.maxY + gap, String(cols), color);
  } else {
    drawDimensionLine(bbox.minX, bbox.minY - gap, bbox.maxX, bbox.minY - gap, String(cols), color);
  }
}

// The big "here's what was recognized" readout, placed right next to the
// blocks themselves (above or below) instead of only appearing in the small
// top-left HUD text — easy to miss while a child is looking at the blocks,
// not the corner of the screen. Never includes the answer (callers pass
// "… = ?"), same rule as the HUD text.
//
// `preferSide` ('top' | 'bottom') lets the caller steer clear of whichever
// side another overlay (the multiply row/col dimension brackets, or the
// add/subtract per-zone counts) already occupies, instead of independently
// re-running the same "which side has more room" check and landing on the
// same side as that other label. Falls back to auto (more-room) if the
// preferred side has no room at all.
function drawEquationBanner(bbox, text, preferSide) {
  if (!bbox) return;
  const fontSize = Math.max(26, Math.min(64, canvas.width / 11));
  ctx.save();
  ctx.font = `800 ${fontSize}px sans-serif`;
  const textW = ctx.measureText(text).width;
  const padX = fontSize * 0.6, padY = fontSize * 0.34;
  const pillW = textW + padX * 2, pillH = fontSize + padY * 2;
  const gap = Math.max(20, canvas.height * 0.04);
  const topSpace = bbox.minY - gap - pillH;
  const bottomSpace = canvas.height - (bbox.maxY + gap + pillH);
  const useBottom = preferSide === 'top' && topSpace >= 0 ? false
    : preferSide === 'bottom' && bottomSpace >= 0 ? true
    : bottomSpace >= 0 || bottomSpace >= topSpace;
  const cy = useBottom ? bbox.maxY + gap + pillH / 2 : bbox.minY - gap - pillH / 2;
  const bboxCenterX = (bbox.minX + bbox.maxX) / 2;
  const cx = Math.min(canvas.width - pillW / 2 - 8, Math.max(pillW / 2 + 8, bboxCenterX));
  ctx.fillStyle = 'rgba(17,17,17,0.88)';
  ctx.beginPath();
  roundRectPath(cx - pillW / 2, cy - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + fontSize * 0.03);
  ctx.restore();
}

// Plays once whenever a grid *freshly* confirms: each block pops in in
// order, one by one, instead of the whole grid just appearing — a cheap,
// 2D stand-in for an "AR is actively noticing this" feel, without needing
// real camera-pose tracking. Deliberately does NOT label the blocks with
// a running number (1, 2, 3…) — the final badge would just spell out the
// total block count, i.e. the multiplication answer, before a digit card
// has even been placed.
function revealTotalDuration(anim) {
  return anim.boxes.length * anim.perStepMs + 320;
}

function drawBlockRevealAnimation(anim, now) {
  const elapsed = now - anim.startedAt;
  anim.boxes.forEach((box, index) => {
    const localT = elapsed - index * anim.perStepMs;
    if (localT < 0) return;
    const revealDur = 260;
    const scale = easeOutBack(Math.min(1, localT / revealDur));
    const alpha = Math.min(1, localT / 120);
    const pad = Math.max(5, Math.min(box.w, box.h) * .12);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffb200';
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
    const baseR = Math.max(10, canvas.width / 70) * scale;
    ctx.strokeStyle = 'rgba(255,178,0,0.9)';
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.beginPath(); ctx.arc(box.cx, box.cy, baseR, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  });
}

// Must outlast ABSORB_DURATION_MS + FX3D_DURATION_MS (600 + 1900 = 2500ms
// below) — this used to be 2200, which nulled `celebration` before the gem
// animation reached GEM_ARRIVE_MS, so incrementScore() never ran.
const CELEBRATION_DURATION_MS = 2600;
const ABSORB_DURATION_MS = 600;

// Single source of truth for where the "Correct!" banner (see
// drawCelebrationOverlay) sits — also where the absorbed blocks fly to and
// where the 3D gem bursts from, so the reward visibly comes from the
// celebration itself rather than an unrelated spot on screen.
function celebrationBannerPoint() {
  return { x: canvas.width / 2, y: canvas.height * 0.32 };
}

// The blocks that were just counted fly toward the digit card's actual
// on-screen position and vanish there — first flashing to signal "this one
// counted", then shrinking into a dot that travels to `celebration.sinkPoint`
// — instead of the count just disappearing with no visual connection to the
// answer that was placed. Staggered per block so it reads as counting them
// off, not everything popping at once.
function drawAbsorbAnimation(cel, now) {
  const boxes = cel.absorbBoxes;
  if (!boxes || !boxes.length) return;
  const t = now - cel.startedAt;
  if (t > ABSORB_DURATION_MS) return;
  const perStepMs = Math.max(20, Math.min(60, 380 / boxes.length));
  boxes.forEach((box, i) => {
    const localT = Math.max(0, Math.min(1, (t - i * perStepMs) / 220));
    if (localT <= 0) return;
    const flashA = Math.max(0, 1 - localT / 0.35);
    if (flashA > 0) {
      ctx.save();
      ctx.globalAlpha = flashA;
      ctx.fillStyle = '#00e278';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }
    const flyT = Math.max(0, (localT - 0.3) / 0.7);
    if (flyT > 0) {
      const x = box.cx + (cel.sinkPoint.x - box.cx) * flyT;
      const y = box.cy + (cel.sinkPoint.y - box.cy) * flyT;
      const size = Math.max(2, Math.min(box.w, box.h) * (1 - flyT) * 0.9);
      ctx.save();
      ctx.globalAlpha = 1 - flyT;
      ctx.fillStyle = '#00e278';
      ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  });
}

// A short "Correct!" banner + confetti burst, triggered once per newly
// achieved match between the confirmed block equation and the confirmed
// digit-card answer (see processCameraTick).
function drawCelebrationOverlay(now) {
  if (!celebration) return;
  const elapsed = now - celebration.startedAt;
  if (elapsed > CELEBRATION_DURATION_MS) { celebration = null; return; }
  let scale = elapsed < 260 ? easeOutBack(elapsed / 260) : 1;
  let alpha = elapsed > CELEBRATION_DURATION_MS - 300 ? Math.max(0, (CELEBRATION_DURATION_MS - elapsed) / 300) : 1;

  if (!celebration.confetti) {
    const cx = canvas.width / 2, cy = canvas.height * 0.32;
    celebration.confetti = Array.from({ length: 26 }, () => ({
      x: cx + (Math.random() - 0.5) * 60,
      y: cy,
      vx: (Math.random() - 0.5) * 280,
      vy: -Math.random() * 260 - 80,
      color: ['#ffb200', '#00c897', '#3b82f6', '#ff5c8a'][Math.floor(Math.random() * 4)],
      size: 3 + Math.random() * 4
    }));
  }
  const tSec = elapsed / 1000, g = 520;
  ctx.save();
  ctx.globalAlpha = alpha;
  celebration.confetti.forEach(p => {
    const x = p.x + p.vx * tSec;
    const y = p.y + p.vy * tSec + 0.5 * g * tSec * tSec;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(x, y, p.size, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();

  const cx = canvas.width / 2, cy = canvas.height * 0.32;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const text = `Correct! ${celebration.answer}`;
  // Shrink to fit: canvas.width is the internal (video-resolution) backing
  // size, but the canvas is displayed with `object-fit: cover`, which
  // crops it to match the on-screen box's aspect ratio (e.g. a landscape
  // webcam feed filling a tall phone screen loses most of its width). A
  // fixed width-relative font size assumed the whole canvas.width was
  // visible and overflowed off-screen — measure against the actually
  // *visible* width instead.
  let fontSize = Math.max(26, canvas.width / 17);
  const maxTextW = visibleCanvasWidth() * 0.86;
  ctx.font = `900 ${fontSize}px sans-serif`;
  let textW = ctx.measureText(text).width;
  if (textW > maxTextW) {
    fontSize *= maxTextW / textW;
    ctx.font = `900 ${fontSize}px sans-serif`;
    textW = ctx.measureText(text).width;
  }
  const padX = 26, padY = 16;
  const boxW = textW + padX * 2, boxH = fontSize + padY * 2;
  ctx.fillStyle = 'rgba(0,150,90,0.95)';
  ctx.beginPath();
  roundRectPath(-boxW / 2, -boxH / 2, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

// A friendly, hard-to-miss nudge for a wrong answer — previously just a
// small pill tucked under the answer HUD, easy for a young child to miss
// entirely. Shown at the same prominent spot as the "Correct!" banner
// (drawn only while celebration isn't active, since the two states are
// mutually exclusive) with a gentle bob so it feels alive, not scary —
// no red, no "wrong", just an encouraging "try again".
function drawTryAgainOverlay(now) {
  const cx = canvas.width / 2, cy = canvas.height * 0.32 + Math.sin(now / 260) * 6;
  const text = '🤔 Try again!';
  let fontSize = Math.max(24, canvas.width / 19);
  const maxTextW = visibleCanvasWidth() * 0.86;
  ctx.save();
  ctx.font = `800 ${fontSize}px sans-serif`;
  let textW = ctx.measureText(text).width;
  if (textW > maxTextW) {
    fontSize *= maxTextW / textW;
    ctx.font = `800 ${fontSize}px sans-serif`;
    textW = ctx.measureText(text).width;
  }
  const padX = 24, padY = 14;
  const boxW = textW + padX * 2, boxH = fontSize + padY * 2;
  ctx.translate(cx, cy);
  ctx.fillStyle = 'rgba(255,178,0,0.95)';
  ctx.beginPath();
  roundRectPath(-boxW / 2, -boxH / 2, boxW, boxH, boxH / 2);
  ctx.fill();
  ctx.fillStyle = '#3a2400';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 2);
  ctx.restore();
}

// --- 3D "pop out" celebration (Three.js) --------------------------------
//
// The flat 2D confetti/banner above reads as "cute" but not as an AR-style
// reward moment. This adds a real WebGL layer on top of it: a faceted gem
// flies out of the screen toward the viewer, spins, and recedes again —
// using true perspective (the object gets bigger as it approaches the
// camera) rather than a faked 2D scale trick. It lives entirely on its own
// transparent canvas (#fxCanvas, stacked between the detection canvas and
// the HUD) and never touches detection state — purely decorative, reading
// `celebration` the same way drawCelebrationOverlay does.
let fx3D = null; // lazily built the first time a celebration actually fires
const FX3D_DURATION_MS = 1900; // finishes a little before CELEBRATION_DURATION_MS
const FX3D_HOVER_END_MS = 1150; // burst + hover phases end here, flight to the score badge starts here
const FX3D_FLIGHT_MS = 700; // duration of the flight-to-score-badge phase
// The gem's on-screen position finishes traveling to the score badge at this
// fraction of the flight — well before its opacity/scale fade completes —
// so it visibly arrives while still solid, then does a quick "absorbed into
// the badge" shrink-fade in place. Reaching 0% opacity at the same instant
// the position reaches 100% (the old behavior) reads as the gem vanishing
// mid-journey instead of arriving.
const FX3D_ARRIVE_FRACTION = 0.72;
// The exact moment (ms since celebration.startedAt) the gem visually
// reaches the score badge — used to credit the point and pop the score
// number exactly when the reward "lands," not the instant the match was
// detected. Computed independently of the 3D renderer (which may fail to
// load) so scoring stays correct even without WebGL.
const GEM_ARRIVE_MS = ABSORB_DURATION_MS + FX3D_HOVER_END_MS + FX3D_FLIGHT_MS * FX3D_ARRIVE_FRACTION;

function ensureFx3D() {
  if (fx3D || typeof THREE === 'undefined') return fx3D;
  const renderer = new THREE.WebGLRenderer({ canvas: fxCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const point = new THREE.PointLight(0xeaf7ff, 1.4);
  point.position.set(2, 3, 4);
  scene.add(point);

  // A blue faceted diamond, matching the 💎 score badge — an octahedron
  // (two pyramids base-to-base) reads as a classic gem-cut silhouette much
  // more than a round icosahedron did, and the earlier orange/gold color
  // didn't match the score badge's icon at all.
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.45, 0),
    new THREE.MeshStandardMaterial({ color: 0x4fc3f7, metalness: 0.25, roughness: 0.15, emissive: 0x0d3a52, emissiveIntensity: 0.4 })
  );
  const sparkle = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.48, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 })
  );
  gem.add(sparkle);
  scene.add(gem);

  fx3D = { renderer, scene, camera, gem, lastW: 0, lastH: 0 };
  return fx3D;
}

function resizeFx3D(fx) {
  const w = fxCanvas.clientWidth, h = fxCanvas.clientHeight;
  if (!w || !h || (w === fx.lastW && h === fx.lastH)) return;
  fx.lastW = w; fx.lastH = h;
  fx.renderer.setSize(w, h, false);
  fx.camera.aspect = w / h;
  fx.camera.updateProjectionMatrix();
}

// The gem bursts out starting where the absorb animation's dots converged
// (the digit card's real screen position), not the center of the screen.
// To keep it visually anchored to that same screen spot as it travels
// through depth (z), its world X/Y have to be recomputed every frame from
// its current distance to the camera — a fixed world X/Y would drift
// sideways on screen as perspective scaling changes with depth.
function worldPointAtDepth(ndcX, ndcY, camera, distanceFromCamera) {
  const halfH = distanceFromCamera * Math.tan((camera.fov * Math.PI / 180) / 2);
  const halfW = halfH * camera.aspect;
  return { x: ndcX * halfW, y: ndcY * halfH };
}

function renderFx3D(now) {
  const t = celebration ? now - celebration.startedAt - ABSORB_DURATION_MS : -1;
  const active = celebration && t >= 0 && t < FX3D_DURATION_MS;
  if (!active) {
    if (fx3D && fx3D.wasActive) { fx3D.renderer.clear(); fx3D.wasActive = false; }
    return;
  }
  const fx = ensureFx3D();
  if (!fx) return; // THREE failed to load — celebration still works without the 3D layer
  if (!fx.wasActive) { fx.spinAxisTilt = (Math.random() - 0.5) * 0.6; fx.wasActive = true; }
  resizeFx3D(fx);

  // Phase 1 (0-350ms): burst from far away toward the viewer.
  // Phase 2 (350-1150ms): hover at a modest distance, spinning steadily.
  // Phase 3 (1150-1850ms): fly across the screen to the score gem counter
  // and shrink into it — a visible "your score just grew" connection,
  // rather than just vanishing into the distance with no link to the
  // score number that already ticked up.
  // A small, clearly-a-gem accent, not something that should ever fill the
  // screen — HOVER_Z is deliberately conservative, and the approach is
  // clamped so easeOutBack's overshoot can't fling it any closer (bigger)
  // than the intended hover distance.
  const HOVER_Z = 1.6;
  const spawnAnchor = celebration.sinkPoint && fx.lastW && fx.lastH
    ? canvasPointToDisplayPixels(celebration.sinkPoint.x, celebration.sinkPoint.y)
    : null;
  const spawnNdcX = spawnAnchor ? (spawnAnchor.x / fx.lastW) * 2 - 1 : 0;
  const spawnNdcY = spawnAnchor ? 1 - (spawnAnchor.y / fx.lastH) * 2 : 0.06;

  let z = HOVER_Z, opacity = 1, ndcX = spawnNdcX, ndcY = spawnNdcY, scale = 1;
  if (t <= 350) {
    z = Math.min(HOVER_Z, -6 + (HOVER_Z - -6) * easeOutBack(t / 350));
    scale = 0.4 + 0.6 * (t / 350);
  } else if (t > FX3D_HOVER_END_MS) {
    const flyT = Math.min(1, (t - FX3D_HOVER_END_MS) / FX3D_FLIGHT_MS);
    // Position eases to 100% by FX3D_ARRIVE_FRACTION of the flight (a quick,
    // decisive arrival), then holds still at the badge for the remainder —
    // the settle phase — while it shrinks and fades in place.
    const posT = easeOutCubic(Math.min(1, flyT / FX3D_ARRIVE_FRACTION));
    const scoreAnchor = elementCenterDisplayPixels(scoreHud);
    const scoreNdcX = (scoreAnchor.x / fx.lastW) * 2 - 1;
    const scoreNdcY = 1 - (scoreAnchor.y / fx.lastH) * 2;
    ndcX = spawnNdcX + (scoreNdcX - spawnNdcX) * posT;
    ndcY = spawnNdcY + (scoreNdcY - spawnNdcY) * posT;
    const settleT = flyT <= FX3D_ARRIVE_FRACTION ? 0 : (flyT - FX3D_ARRIVE_FRACTION) / (1 - FX3D_ARRIVE_FRACTION);
    scale = Math.max(0.02, 1 - 0.9 * settleT);
    opacity = Math.max(0, 1 - settleT);
  }

  const world = worldPointAtDepth(ndcX, ndcY, fx.camera, fx.camera.position.z - z);
  fx.gem.position.set(world.x, world.y, z);
  fx.gem.scale.setScalar(scale);
  fx.gem.rotation.y = t * 0.0035;
  fx.gem.rotation.x = fx.spinAxisTilt + Math.sin(t * 0.002) * 0.15;
  fx.gem.children[0].material.opacity = 0.5 * opacity;
  fx.gem.material.opacity = opacity;
  fx.gem.material.transparent = opacity < 1;

  fx.renderer.render(fx.scene, fx.camera);
}

function boxesBoundingBox(boxes) {
  return boxes.length ? {
    minX: Math.min(...boxes.map(b => b.x)), minY: Math.min(...boxes.map(b => b.y)),
    maxX: Math.max(...boxes.map(b => b.x + b.w)), maxY: Math.max(...boxes.map(b => b.y + b.h))
  } : null;
}

// Runs whichever detection pipeline the current `operation` needs and
// normalizes the result into one shape the rest of processCameraTick can
// stay agnostic about: a signature to stabilize on, a payload to hold once
// confirmed, and the boxes/bbox the overlays draw. `payload.kind` is what
// describePayload()/answerFromPayload() branch on later.
// Handles 'multiply' and 'add' only — 'subtract' has its own dedicated
// pile-based flow (see processSubtractTick) since a two-zone "combine
// them" model doesn't fit take-away subtraction, and is intercepted
// earlier in processCameraTick before this is ever called.
function computeProblem(frame, strength, minAreaFraction, bridgeRadius) {
  if (operation === 'multiply') {
    const { boxes, grid } = runDetection(canvas.width, canvas.height, strength, minAreaFraction, bridgeRadius, frame, useMarkersInput.checked);
    return {
      boxes, bbox: boxesBoundingBox(boxes),
      signature: grid ? `m:${grid.rows}x${grid.cols}` : `m:n${boxes.length}`,
      payload: { kind: 'multiply', grid, boxesCount: boxes.length, bbox: boxesBoundingBox(boxes) }
    };
  }
  const { leftBoxes, rightBoxes, leftZone, rightZone, answerZone } = detectCountZones(frame, strength);
  const boxes = leftBoxes.concat(rightBoxes);
  return {
    boxes, bbox: boxesBoundingBox(boxes),
    signature: `a:${leftBoxes.length}x${rightBoxes.length}`,
    payload: { kind: 'add', leftCount: leftBoxes.length, rightCount: rightBoxes.length, leftZone, rightZone, answerZone, bbox: boxesBoundingBox(boxes) }
  };
}

// The hidden answer — only non-null once both operands are actually
// present, so an empty zone never reads as "the answer is 0" and an
// unfinished multiplication grid never reads as "the answer is null grid".
function answerFromPayload(payload) {
  if (payload.kind === 'multiply') return payload.grid ? payload.grid.rows * payload.grid.cols : null;
  return (payload.leftCount > 0 && payload.rightCount > 0) ? payload.leftCount + payload.rightCount : null;
}

// The HUD text for a confirmed+held payload — always shows the operands
// (what the child physically placed, which they can already see and count
// themselves), never the result.
function describePayload(payload) {
  if (payload.kind === 'multiply') {
    const { grid, boxesCount } = payload;
    if (grid) {
      return {
        equationText: `${grid.rows} × ${grid.cols} = ?`,
        subText: `Arranged as ${grid.rows} row${grid.rows === 1 ? '' : 's'} × ${grid.cols} column${grid.cols === 1 ? '' : 's'}. What's the answer?`
      };
    }
    return {
      equationText: boxesCount ? 'Line the blocks up into rows and columns' : 'No red blocks found',
      subText: 'Not arranged in a grid yet.'
    };
  }
  const { leftCount, rightCount } = payload;
  if (leftCount > 0 && rightCount > 0) {
    return {
      equationText: `${leftCount} + ${rightCount} = ?`,
      subText: `Left box: ${leftCount}. Right box: ${rightCount}. What's the answer?`
    };
  }
  return {
    equationText: 'Put blocks in both boxes',
    subText: 'Place at least one block in the left box and the right box.'
  };
}

function updateLivePanel(confirmed, holdActive, isCurrentlyStable, progress) {
  const equation = document.querySelector('#equation');
  const arrangement = document.querySelector('#arrangement');
  scanRingProgressEl.style.strokeDashoffset = String(SCAN_RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, progress || 0))));
  scanRingProgressEl.classList.toggle('is-confirmed', isCurrentlyStable);
  // This is the live "game" HUD, so it must never print the hidden
  // result — once operands are confirmed (a grid, or both zones filled),
  // count/sum/difference == the answer, and showing it here would give it
  // away before a digit card is even placed. Only the operands (rows &
  // columns, or left & right zone counts) are shown via describePayload().
  if (confirmed && holdActive) {
    const { equationText, subText } = describePayload(confirmed.payload);
    equation.textContent = equationText;
    arrangement.textContent = subText;
    liveBadge.textContent = isCurrentlyStable ? 'Locked in' : 'Reading…';
    liveBadge.classList.toggle('is-confirmed', isCurrentlyStable);
  } else {
    equation.textContent = 'Hold still for a moment…';
    arrangement.textContent = 'Keep the blocks still for about 2 seconds.';
    liveBadge.textContent = 'Reading…';
    liveBadge.classList.remove('is-confirmed');
  }
}

// --- Live camera (answer cards) ----------------------------------------
//
// Yellow-wrapped cubes with a black square sticker bearing a white Futura
// Bold digit (0-9) on every face. Ported from the standalone Air Writing
// prototype's "cards" mode (CODEX_PROMPT.md) and adapted to run on the same
// camera frame the block detector already captures — no second
// getUserMedia(). There is no physical orientation mark on the sticker, so
// the cube is expected to be placed digit-up; decodeDigitCard() decodes at
// 0° only (see the 6/9 caveat below and in the README — trying other
// rotations made a correctly-placed "6" get misread as "9").

function cardDarkPixel(r, g, b, strength) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  const saturation = max === 0 ? 0 : (max - min) / max;
  return brightness < strength && saturation < 0.35;
}

// Yellow wrapping: R and G both well above B, with G reasonably close to R
// (distinguishes it from the more orange/brown wood desk, where G sits
// further below R). Real camera footage tends to render less saturated
// than a synthetic/printed sample, so this is deliberately lenient.
// Ratio-based rather than absolute-difference-based: an earlier version
// used `r - b > strength`, which a bright wood/tan desk can satisfy just
// as easily as true yellow (wood has a big absolute r-b gap too, just at a
// less extreme *ratio*). True yellow's blue channel is only a small
// fraction of its red/green; tan wood's blue is a much larger fraction of
// its red/green even though the raw gap looks similar. Ratios separate
// the two cleanly regardless of overall brightness.
function yellowPixel(r, g, b, strength) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const safeB = Math.max(1, b);
  const rbRatio = r / safeB, gbRatio = g / safeB;
  return r > 80 && saturation > 0.15 && g > r * 0.6 &&
    rbRatio > 1.7 + strength * 0.02 && gbRatio > 1.35 + strength * 0.02;
}

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let below = 0, sumBelow = 0, best = 110, bestVariance = -1;
  for (let i = 0; i < 256; i++) {
    below += hist[i];
    if (!below) continue;
    const above = total - below;
    if (!above) break;
    sumBelow += i * hist[i];
    const a = sumBelow / below, b = (sum - sumBelow) / above;
    const variance = below * above * (a - b) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = i; }
  }
  return best;
}

// Estimates a black/white split point from the region's own brightness
// distribution (1st percentile vs median) rather than a fixed value, so it
// tracks the camera's actual lighting instead of a hardcoded brightness.
function cardContrastThreshold(frame, x0, y0, x1, y1, offset) {
  const values = [];
  for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
    const i = (y * frame.width + x) * 4;
    const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (!hi || (hi - lo) / hi < 0.35) values.push((r + g + b) / 3);
  }
  values.sort((a, b) => a - b);
  if (!values.length) return 80;
  const low = values[Math.floor(values.length * 0.01)];
  const mid = values[Math.floor(values.length * 0.5)];
  return Math.max(15, Math.min(180, low + (mid - low) * 0.30 + offset));
}

// Splits the scanned area into tiles and computes cardContrastThreshold
// separately per tile, instead of one threshold for the whole area. A
// single global threshold breaks down when a large unrelated dark region
// (e.g. a hand's shadow covering much of the frame) skews the brightness
// percentiles used to estimate it — the shadow can end up misread as "the
// dark subject" while the much smaller real sticker doesn't stand out from
// its own (brighter) local surroundings enough to be told apart. Each tile
// only sees its own local contrast, so a shadow elsewhere in the shot can't
// throw off the sticker's own tile.
function buildLocalDarkMask(frame, x0, y0, x1, y1, step, offset, tileSize) {
  const w = x1 - x0, h = y1 - y0;
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step);
  const mask = new Uint8Array(gw * gh);
  const tilesX = Math.max(1, Math.round(w / tileSize));
  const tilesY = Math.max(1, Math.round(h / tileSize));
  const tileW = w / tilesX, tileH = h / tilesY;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tx0 = x0 + Math.round(tx * tileW), tx1 = x0 + Math.round((tx + 1) * tileW);
      const ty0 = y0 + Math.round(ty * tileH), ty1 = y0 + Math.round((ty + 1) * tileH);
      const threshold = cardContrastThreshold(frame, tx0, ty0, tx1, ty1, offset);
      const gx0 = Math.max(0, Math.floor((tx0 - x0) / step)), gx1 = Math.min(gw, Math.ceil((tx1 - x0) / step));
      const gy0 = Math.max(0, Math.floor((ty0 - y0) / step)), gy1 = Math.min(gh, Math.ceil((ty1 - y0) / step));
      for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++) {
        const x = x0 + Math.min(w - 1, gx * step);
        const y = y0 + Math.min(h - 1, gy * step);
        const i = (y * frame.width + x) * 4;
        if (cardDarkPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2], threshold)) mask[gy * gw + gx] = 1;
      }
    }
  }
  return { mask, gw, gh };
}

// Finds each digit cube's face first — a big solid-color area — and only
// then looks for the black sticker inside that cube's own bounding box.
// Earlier versions found dark blobs first and checked for a thin ring of
// a distinguishing color immediately around them, which reliably worked up
// close but failed at exactly the same distances where the red-block
// detection kept working fine. The reason: a real camera's optical blur,
// sensor noise and video compression smear away *thin* color features (a
// narrow border) long before they affect a *large solid* area — so a small
// ring-sampling check degrades with distance far faster than checking one
// big region ever does. Flipping the order to "find the big solid area
// first" puts the digit-cube detector on the same solid footing as the
// (distance-robust) red-block and yellow-marker detectors, which have only
// ever relied on large areas, never thin edges.
//
// Digit cubes are wrapped in the same red paper as the multiplication
// blocks (tape supply made a dedicated yellow wrapper impractical) — the
// only difference is what's stuck on the face: multiplication blocks carry
// a small yellow corner marker, digit cubes carry a large black-and-white
// sticker. So this searches for red faces (`redPixel`, same classifier and
// strength as the block detector) and only keeps ones whose largest dark
// sub-blob is a substantial share of the face — big enough to be a digit
// sticker, not just a small marker, shadow fleck or gap.
function detectAnswerCards(frame, roi, offset, strength) {
  const x0 = roi ? Math.max(0, Math.round(roi.x)) : 0;
  const y0 = roi ? Math.max(0, Math.round(roi.y)) : 0;
  const x1 = roi ? Math.min(frame.width, Math.round(roi.x + roi.w)) : frame.width;
  const y1 = roi ? Math.min(frame.height, Math.round(roi.y + roi.h)) : frame.height;
  const w = x1 - x0, h = y1 - y0;
  if (w < 16 || h < 16) return [];

  const cubeMask = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * frame.width + x) * 4;
      cubeMask[(y - y0) * w + (x - x0)] = redPixel(frame.data[i], frame.data[i + 1], frame.data[i + 2], strength) ? 1 : 0;
    }
  }
  const cubes = components(cubeMask, cubeMask, w, h, 0.0003);

  // Digit cubes are usually pushed together for a multi-digit answer (e.g.
  // "61"), so their red wrapping merges into one connected blob just like
  // touching multiplication blocks do. Loosened aspect/size bounds accept
  // a blob spanning up to ~3 merged cubes; every qualifying sticker found
  // inside it is kept (not just the largest), so a 2- or 3-digit answer
  // reads as that many separate cards instead of collapsing to one.
  const cards = [];
  for (const cube of cubes) {
    if (cube.aspect < .3 || cube.aspect > 3.5 || cube.boxArea > w * h * 0.5) continue;
    const cx0 = x0 + cube.x, cy0 = y0 + cube.y;
    const cx1 = cx0 + cube.w, cy1 = cy0 + cube.h;
    const step = 2;
    const { mask: darkMask, gw, gh } = buildLocalDarkMask(
      frame, cx0, cy0, cx1, cy1, step, offset, Math.max(30, Math.min(cube.w, cube.h))
    );
    const stickerBlobs = components(darkMask, darkMask, gw, gh, 0.06);
    for (const s of stickerBlobs) {
      // The camera shoots the digit sticker's face straight-on, so it's
      // basically square (1:1) — a wide .5-2 tolerance let clearly
      // non-square blobs (closer to 1:2) through and cost confidence in
      // borderline reads. Narrowed to just enough margin for real
      // perspective/lens skew, not enough to admit a genuinely elongated
      // shape that isn't actually the sticker.
      if (s.aspect < .65 || s.aspect > 1.55) continue;
      // A digit sticker covers a large share of a single face; a small
      // yellow corner marker (or noise) does not — this is what tells a
      // digit cube apart from a plain multiplication block on the same
      // red background. Compared against the whole (possibly
      // multi-cube) blob's area, so this still holds when 2-3 cubes are
      // merged together.
      if ((s.boxArea * step * step) < cube.boxArea * 0.12) continue;
      cards.push({
        x: cx0 + s.x * step, y: cy0 + s.y * step,
        w: s.w * step, h: s.h * step,
        count: s.matched
      });
    }
  }
  return cards.sort((a, b) => a.x - b.x);
}

const cardCropCanvas = document.createElement('canvas');
cardCropCanvas.width = cardCropCanvas.height = 96;
const cardCropCtx = cardCropCanvas.getContext('2d', { willReadFrequently: true });

// Debug view: tints each pixel by what the detector currently thinks it is
// (red block / yellow wrapper / dark sticker candidate), so color-threshold
// problems can be diagnosed from a screenshot instead of guessed at from a
// photo of the physical blocks. Uses the actual local adaptive dark mask
// (buildLocalDarkMask), not a fixed guess, so it reflects what
// detectAnswerCards really sees.
const debugCanvas = document.createElement('canvas');
const debugCtx = debugCanvas.getContext('2d', { willReadFrequently: true });

function updateDebugOverlay(frame, strength, cardOffset) {
  if (debugCanvas.width !== frame.width || debugCanvas.height !== frame.height) {
    debugCanvas.width = frame.width;
    debugCanvas.height = frame.height;
  }
  const step = 2;
  const { mask: darkMask, gw, gh } = buildLocalDarkMask(frame, 0, 0, frame.width, frame.height, step, cardOffset, 140);
  const overlay = debugCtx.createImageData(frame.width, frame.height);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(frame.width - 1, gx * step);
      const y = Math.min(frame.height - 1, gy * step);
      const i = (y * frame.width + x) * 4;
      const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
      let oR = 0, oG = 0, oB = 0, oA = 0;
      if (redPixel(r, g, b, strength)) { oR = 0; oG = 255; oB = 120; oA = 130; }
      else if (yellowPixel(r, g, b, 20)) { oR = 255; oG = 170; oB = 0; oA = 130; }
      else if (darkMask[gy * gw + gx]) { oR = 40; oG = 110; oB = 255; oA = 130; }
      if (!oA) continue;
      for (let dy = 0; dy < step && y + dy < frame.height; dy++) {
        for (let dx = 0; dx < step && x + dx < frame.width; dx++) {
          const j = ((y + dy) * frame.width + (x + dx)) * 4;
          overlay.data[j] = oR; overlay.data[j + 1] = oG; overlay.data[j + 2] = oB; overlay.data[j + 3] = oA;
        }
      }
    }
  }
  debugCtx.putImageData(overlay, 0, 0);
}

const debugInfoEl = document.querySelector('#debugInfo');

// Lets a tap on the live view show the exact RGB/ratio numbers for that one
// pixel, instead of guessing thresholds from photos. Reads from
// `lastRawFrame` (captured before any overlay drawing) rather than the
// visible canvas, so the tint from the debug overlay itself never gets
// sampled by mistake.
function sampleDebugPixel(clientX, clientY) {
  if (!lastRawFrame) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.round((clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.round((clientY - rect.top) * (canvas.height / rect.height));
  if (x < 0 || y < 0 || x >= lastRawFrame.width || y >= lastRawFrame.height) return;
  const i = (y * lastRawFrame.width + x) * 4;
  const r = lastRawFrame.data[i], g = lastRawFrame.data[i + 1], b = lastRawFrame.data[i + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  const safeB = Math.max(1, b);
  const rbRatio = r / safeB, gbRatio = g / safeB;
  const brightness = (r + g + b) / 3;
  const strength = Number(controls.strength.value);
  const isRed = redPixel(r, g, b, strength);
  const isYellow = yellowPixel(r, g, b, 20);
  const isDarkRough = brightness < 110 && saturation < 0.35; // rough guide only; the real check is per-tile adaptive
  debugInfoEl.textContent =
    `Tapped: RGB(${r},${g},${b}) brightness ${brightness.toFixed(0)} saturation ${saturation.toFixed(2)} ` +
    `R/B ${rbRatio.toFixed(2)} G/B ${gbRatio.toFixed(2)} → red:${isRed ? 'yes' : 'no'} yellow:${isYellow ? 'yes' : 'no'} dark:${isDarkRough ? 'yes' : 'no'}`;
  debugInfoEl.classList.remove('hidden');
}

canvas.addEventListener('click', e => {
  if (!debugModeInput.checked || mode !== 'camera' || !cameraActive) return;
  sampleDebugPixel(e.clientX, e.clientY);
});

// No orientation mark exists on the sticker, and the physical design
// assumes the cube is always placed digit-up — so this decodes at 0°
// only. (Deliberately NOT trying other rotations and keeping whichever
// scores highest: testing showed that approach actively misreads a
// correctly-placed "6" as "9", because Futura's "6" rotated 180° reads as
// a very confident "9" — trying that comparison creates a wrong-answer
// risk that trusting the "always upright" assumption avoids. If a cube
// genuinely does end up sideways, this should show up as low confidence
// rather than a confident wrong digit, except for 6/9 specifically — see
// the README caveat.)
function decodeDigitCard(card) {
  const side = cardCropCanvas.width;
  cardCropCtx.fillStyle = '#000';
  cardCropCtx.fillRect(0, 0, side, side);
  cardCropCtx.drawImage(canvas, card.x, card.y, card.w, card.h, 2, 2, side - 4, side - 4);
  const data = cardCropCtx.getImageData(0, 0, side, side).data;
  const hist = new Uint32Array(256);
  let total = 0;
  for (let y = 3; y < side - 3; y++) for (let x = 3; x < side - 3; x++) {
    const i = (y * side + x) * 4;
    hist[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)]++;
    total++;
  }
  const threshold = otsuThreshold(hist, total);
  const raw = new Uint8Array(side * side);
  for (let i = 0; i < raw.length; i++) raw[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 > threshold ? 1 : 0;
  const pixels = window.CardDigitModel.normalizeCardGlyphPixels(raw, side, side);
  return window.CardDigitModel.predictCardPixels(pixels)[0];
}

function recognizeAnswerCards(frame, roi, offset, strength) {
  // The 10 digit SVGs load asynchronously; until CardDigitModel finishes
  // building templates from them, skip digit recognition entirely rather
  // than match against an empty/partial template set.
  if (!window.CardDigitModel || !window.CardDigitModel.isReady) return [];
  const cards = detectAnswerCards(frame, roi, offset, strength);
  return cards.map(card => ({ card, top: decodeDigitCard(card) })).filter(r => r.top);
}

const CARD_CONFIDENCE_THRESHOLD = 0.35; // per-card minimum to count toward a sequence
// Real footage showed the per-frame detection itself (not the digit
// decode confidence, which was often 90%+) dropping out intermittently
// frame-to-frame — the cube/sticker simply isn't found some frames, even
// while stationary. A longer window with a lower agreement bar rides out
// that dropout instead of needing near-constant detection.
const CARD_CONFIRM_WINDOW_MS = 2200;
const CARD_HOLD_MS = 2000;
const CARD_STABILITY_RATIO = 0.4;

const cardStabilizer = createStabilizer({
  windowMs: CARD_CONFIRM_WINDOW_MS, holdMs: CARD_HOLD_MS, ratio: CARD_STABILITY_RATIO,
  ignore: sig => sig === '' || sig === '?'
});

// --- Subtraction: move blocks away, don't declare a number ---------------
//
// Addition's "two zones, add them" model doesn't fit subtraction: showing
// 4-3 would need 7 physical blocks laid out as if they were two separate
// groups, which isn't what subtraction actually *is* (you start with a
// pile and take some away). The first version of this asked for a digit
// card to say how many would be removed — but that meant the pile's own
// live count had to stay on screen too, and once blocks started actually
// leaving the pile, that live count *was* the answer, spoiled in plain
// sight. Fixed by making the "how many are you taking away" step physical
// instead of symbolic: a second zone where the child moves the blocks
// they're removing, counted directly — no digit card, no card needed for
// the subtrahend, and nothing that reveals the shrinking pile's count.
// Only two numbers are ever shown once locked: the frozen starting count
// and how many were moved away — both things the child already chose/
// knows, exactly like multiplication's rows/cols or addition's operands.
// The single remaining digit card is the final answer (what's left).
const SUBTRACT_PILE_ZONE = { left: .03, top: .16, width: .30, height: .55 };
const SUBTRACT_TAKEN_ZONE = { left: .38, top: .16, width: .24, height: .55 };
const SUBTRACT_ANSWER_ZONE = { left: .67, top: .16, width: .30, height: .55 };

const takenAwayStabilizer = createStabilizer({
  windowMs: CONFIRM_WINDOW_MS, holdMs: HOLD_MS, ratio: STABILITY_RATIO,
  ignore: sig => sig === 'w:0'
});

let subtractLockedStart = null; // the pile's count, frozen the moment blocks first appear in the "taken away" zone
let lastPileCountBeforeRemoval = null; // tracks the pile's own last stable reading while nothing has been taken away yet
let lastSubtractDisplay = null; // { pileZone, takenZone, answerZone, pileCount, takenCount, locked, confirmed }

// A left-side vertical strip by default, matching the demonstrated layout
// (digit cubes stacked on the left, multiplication blocks on the right).
// Tune this constant (or disable the zone) if the physical layout differs.
const CARD_ZONE = { left: .02, top: .04, width: .30, height: .92 };
function cardZoneRect() {
  return {
    x: canvas.width * CARD_ZONE.left,
    y: canvas.height * CARD_ZONE.top,
    w: canvas.width * CARD_ZONE.width,
    h: canvas.height * CARD_ZONE.height
  };
}

function cardSequenceOf(results) {
  if (!results.length) return '';
  if (results.some(r => r.top.confidence < CARD_CONFIDENCE_THRESHOLD)) return '?';
  return results.map(r => String(r.top.value)).join('');
}

let lastEmittedCardSeq = null;

// Integration contract (see CODEX_PROMPT.md): fires once per newly
// confirmed sequence with { value, confidence, confirmed, cards[] }.
function emitCardResult(sequence, results) {
  const confidence = results.reduce((s, r) => s + r.top.confidence, 0) / results.length;
  const detail = {
    value: Number(sequence),
    confidence,
    confirmed: true,
    cards: results.map(r => ({ value: r.top.value, confidence: r.top.confidence, x: r.card.x, y: r.card.y, w: r.card.w, h: r.card.h }))
  };
  window.dispatchEvent(new CustomEvent('airwritingresult', { detail }));
  return detail;
}

function updateCardPanel(cardState, liveResults) {
  const { confirmed, holdActive, isCurrentlyStable } = cardState;
  if (confirmed && holdActive) {
    const results = confirmed.payload;
    cardValueEl.textContent = confirmed.signature;
    cardDetailEl.textContent = results.map(r => `${r.top.value} (${Math.round(r.top.confidence * 100)}%)`).join('  ');
    cardBadge.textContent = isCurrentlyStable ? 'Locked in' : 'Reading…';
    cardBadge.classList.toggle('is-confirmed', isCurrentlyStable);
    if (isCurrentlyStable && lastEmittedCardSeq !== confirmed.signature) {
      lastEmittedCardSeq = confirmed.signature;
      emitCardResult(confirmed.signature, results);
    }
  } else {
    cardValueEl.textContent = liveResults.length ? 'Reading…' : '–';
    cardDetailEl.textContent = liveResults.length
      ? liveResults.map(r => `${r.top.value} (${Math.round(r.top.confidence * 100)}%)`).join('  ')
      : 'Show a digit block to the camera.';
    cardBadge.textContent = 'Reading…';
    cardBadge.classList.remove('is-confirmed');
    lastEmittedCardSeq = null;
  }
}

function resetCardPanel() {
  cardValueEl.textContent = '–';
  cardDetailEl.textContent = 'Start the camera to begin.';
  cardBadge.classList.add('hidden');
  cardBadge.classList.remove('is-confirmed');
  cardHudWrap.classList.remove('mismatch');
  cardFeedbackEl.textContent = '';
  cardFeedbackEl.classList.add('hidden');
  lastCardOverlayResults = [];
  lastEmittedCardSeq = null;
}

let lastCardOverlayResults = [];

function drawCardZone(roi) {
  if (!roi) return;
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(2, canvas.width / 380);
  strokeAnswerZone(roi);
  ctx.setLineDash([]);
  ctx.font = `700 ${Math.max(12, canvas.width / 70)}px sans-serif`;
  ctx.textBaseline = 'top';
  fillAnswerText('Number', roi.x + 8, roi.y + 6);
  ctx.restore();
}

// Zone outline colors are a placement guide, not a status indicator —
// confirmation feedback already lives in the scan ring, the badge text,
// and the mascot, so the zone color can just mean "what goes here": red
// like the physical counting blocks, black like the digit block's sticker.
// (An earlier version colored zones green/orange for confirm state, which
// meant a red block's zone was blue — matching neither block's own color,
// and confusing about where anything actually belongs.)
const BLOCK_ZONE_COLOR = 'rgba(220,38,38,0.9)';
const ANSWER_ZONE_COLOR = 'rgba(20,20,20,0.92)';

// Black reads poorly against a dark tabletop/shadow with no contrast
// help — a soft white glow keeps the outline legible without turning it
// into some other color.
function strokeAnswerZone(zone) {
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 6;
  ctx.strokeStyle = ANSWER_ZONE_COLOR;
  ctx.strokeRect(zone.x, zone.y, zone.w, zone.h);
  ctx.restore();
}
function fillAnswerText(text, x, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 5;
  ctx.fillStyle = ANSWER_ZONE_COLOR;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// The two counting zones for addition/subtraction mode, drawn every frame
// as a placement guide.
function drawCountZones(z) {
  const color = BLOCK_ZONE_COLOR;
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(2, canvas.width / 300);
  ctx.strokeStyle = color;
  [z.leftZone, z.rightZone].forEach(zone => ctx.strokeRect(zone.x, zone.y, zone.w, zone.h));
  strokeAnswerZone(z.answerZone);
  ctx.setLineDash([]);

  // Vertical offsets are sized against canvas.height, not .width — in the
  // landscape layout this is drawn for, width is the abundant dimension,
  // so a width-relative offset could push labels below the visible area.
  ctx.fillStyle = color;
  ctx.font = `800 ${Math.max(18, canvas.height / 11)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelY = z.leftZone.y + z.leftZone.h + Math.max(20, canvas.height / 11);
  ctx.fillText(String(z.leftCount), z.leftZone.x + z.leftZone.w / 2, labelY);
  ctx.fillText(String(z.rightCount), z.rightZone.x + z.rightZone.w / 2, labelY);

  // Inside the top of the box, not above it — the zone can already sit
  // close to the top of the visible (cropped) canvas, and a label placed
  // above it risks landing off-screen.
  ctx.font = `700 ${Math.max(13, canvas.height / 18)}px sans-serif`;
  ctx.textBaseline = 'top';
  fillAnswerText('Number', z.answerZone.x + z.answerZone.w / 2, z.answerZone.y + Math.max(6, canvas.height / 60));
  ctx.textBaseline = 'middle';

  ctx.fillStyle = color;
  ctx.font = `900 ${Math.max(26, canvas.height / 7)}px sans-serif`;
  const symbolY = z.leftZone.y + z.leftZone.h / 2;
  ctx.fillText(z.symbol, (z.leftZone.x + z.leftZone.w + z.rightZone.x) / 2, symbolY);
  fillAnswerText('=', (z.rightZone.x + z.rightZone.w + z.answerZone.x) / 2, symbolY);
  ctx.restore();
}

// Blocks → Taken away → Answer, read left to right with an arrow instead
// of a wordy instruction: move blocks from the left zone into the middle
// zone to take them away, then show what's left as a digit card on the
// right. The left zone's own count is deliberately never drawn once
// locked — see the block comment above SUBTRACT_PILE_ZONE — only the
// frozen starting count and the taken-away count (both already-known
// operands) ever appear as numbers.
function drawSubtractZones(d) {
  // Both the pile and the taken-away zone hold the same red physical
  // blocks, so both get the same red outline — the arrow between them
  // (not a color difference) is what shows "these are two piles of the
  // same kind of block, and this is the direction they move."
  const color = BLOCK_ZONE_COLOR;
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(2, canvas.width / 300);
  ctx.strokeStyle = color;
  ctx.strokeRect(d.pileZone.x, d.pileZone.y, d.pileZone.w, d.pileZone.h);
  ctx.strokeRect(d.takenZone.x, d.takenZone.y, d.takenZone.w, d.takenZone.h);
  strokeAnswerZone(d.answerZone);
  ctx.setLineDash([]);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelSize = Math.max(13, canvas.height / 18);
  const labelPad = Math.max(6, canvas.height / 60);
  ctx.font = `700 ${labelSize}px sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText('Blocks', d.pileZone.x + d.pileZone.w / 2, d.pileZone.y + labelPad);
  ctx.fillText('Taken away', d.takenZone.x + d.takenZone.w / 2, d.takenZone.y + labelPad);
  fillAnswerText('Number', d.answerZone.x + d.answerZone.w / 2, d.answerZone.y + labelPad);

  ctx.textBaseline = 'middle';
  const symbolY = d.pileZone.y + d.pileZone.h / 2;

  // The pile's own count is the whole point of the secret — only ever
  // shown while nothing has been taken away yet (still just "how many
  // blocks did you start with", the same as any other visible operand).
  if (!d.locked) {
    ctx.fillStyle = color;
    ctx.font = `800 ${Math.max(18, canvas.height / 11)}px sans-serif`;
    ctx.fillText(String(d.pileCount), d.pileZone.x + d.pileZone.w / 2, d.pileZone.y + d.pileZone.h + Math.max(20, canvas.height / 11));
  }

  // A simple arrow instead of a sentence: blocks move this way.
  ctx.font = `900 ${Math.max(22, canvas.height / 8)}px sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText('➡', (d.pileZone.x + d.pileZone.w + d.takenZone.x) / 2, symbolY);

  ctx.font = `800 ${Math.max(18, canvas.height / 11)}px sans-serif`;
  ctx.fillText(String(d.takenCount), d.takenZone.x + d.takenZone.w / 2, d.takenZone.y + d.takenZone.h + Math.max(20, canvas.height / 11));

  ctx.font = `900 ${Math.max(26, canvas.height / 7)}px sans-serif`;
  fillAnswerText('=', (d.takenZone.x + d.takenZone.w + d.answerZone.x) / 2, symbolY);
  ctx.restore();
}

function drawCardOverlay(results) {
  const line = Math.max(2, canvas.width / 420);
  ctx.font = `700 ${Math.max(14, canvas.width / 58)}px sans-serif`;
  ctx.textBaseline = 'middle';
  results.forEach(r => {
    const { card, top } = r;
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = line;
    ctx.strokeRect(card.x, card.y, card.w, card.h);
    const label = `${top.value} ${Math.round(top.confidence * 100)}%`;
    const labelW = ctx.measureText(label).width + 14;
    ctx.fillStyle = '#141414';
    ctx.fillRect(card.x, card.y - 26, labelW, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, card.x + 7, card.y - 13);
  });
}

// --- Camera tick (drives both the block grid and the answer cards) -----

let lastRawFrame = null; // undecorated frame, for the tap-to-sample debug tool below

// Subtraction's own tick, separate from the shared multiply/add path above
// (computeProblem/answerFromPayload/describePayload) since it needs extra
// state — a locked starting count and a second, independent block-count
// reading — that those weren't designed to carry. See the block comment
// above SUBTRACT_PILE_ZONE for the interaction this implements.
function processSubtractTick(now, frame, strength) {
  const pileZone = fracRect(SUBTRACT_PILE_ZONE);
  const takenZone = fracRect(SUBTRACT_TAKEN_ZONE);
  const answerZone = fracRect(SUBTRACT_ANSWER_ZONE);

  const markers = detectMarkedBlocks(frame, strength);
  const pileBoxes = markers.filter(b => boxCenterInZone(b, pileZone));
  const takenBoxes = markers.filter(b => boxCenterInZone(b, takenZone));
  lastOverlayBoxes = pileBoxes.concat(takenBoxes);
  lastOverlayBbox = boxesBoundingBox(lastOverlayBoxes);
  lastConfirmedGridInfo = null;
  lastZoneDisplay = null;

  const pileState = blockStabilizer.tick(now, `p:${pileBoxes.length}`, { kind: 'subtract-pile', pileCount: pileBoxes.length });
  const takenState = takenAwayStabilizer.tick(now, `w:${takenBoxes.length}`, { takenCount: takenBoxes.length });
  noteBlockSignature(pileState.confirmed && `${pileState.confirmed.signature}/${takenState.confirmed ? takenState.confirmed.signature : ''}`);
  lastBlockProgress = pileState.progress;
  lastBlockConfirmedForReticle = pileState.isCurrentlyStable;
  scanRingProgressEl.style.strokeDashoffset = String(SCAN_RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, pileState.progress || 0))));
  scanRingProgressEl.classList.toggle('is-confirmed', pileState.isCurrentlyStable);

  // The taken-away count is what's currently *held* (rides out flicker the
  // same way every other reading here does), defaulting to 0 before
  // anything has ever stabilized there.
  const takenAwayCount = takenState.confirmed ? takenState.confirmed.payload.takenCount : 0;

  // Lock the starting count the moment blocks first appear in the
  // taken-away zone, using whatever the pile's own last stable reading was
  // *before* that — i.e. before any were moved. Re-arms if every taken-away
  // block is moved back (taken count returns to 0): a deliberate reset,
  // ready for a new problem.
  if (subtractLockedStart !== null && takenAwayCount === 0) subtractLockedStart = null;
  if (subtractLockedStart === null) {
    if (takenAwayCount === 0 && pileState.confirmed) lastPileCountBeforeRemoval = pileState.confirmed.payload.pileCount;
    else if (takenAwayCount > 0 && lastPileCountBeforeRemoval !== null) subtractLockedStart = lastPileCountBeforeRemoval;
  }
  const expectedRemaining = subtractLockedStart !== null ? subtractLockedStart - takenAwayCount : null;

  const cardOffset = Number(cardContrastInput.value);
  const answerResults = recognizeAnswerCards(frame, answerZone, cardOffset, strength);
  lastCardOverlayResults = answerResults;
  const cardState = cardStabilizer.tick(now, cardSequenceOf(answerResults), answerResults);
  updateCardPanel(cardState, answerResults);

  const equation = document.querySelector('#equation');
  const arrangement = document.querySelector('#arrangement');
  if (subtractLockedStart !== null) {
    // Never the pile's own live count here — once locked, that number IS
    // the answer. Only the frozen start and the taken-away count (both
    // already chosen/known by the child) are shown.
    equation.textContent = `${subtractLockedStart} − ${takenAwayCount} = ?`;
    arrangement.textContent = "Count what's left, then show your answer.";
  } else if (pileBoxes.length > 0) {
    equation.textContent = `${pileBoxes.length} block${pileBoxes.length === 1 ? '' : 's'} — move some away when ready`;
    arrangement.textContent = 'Move red blocks to the middle box to take them away.';
  } else {
    equation.textContent = 'Set up your starting pile of blocks';
    arrangement.textContent = 'Place red blocks in the left box.';
  }
  liveBadge.textContent = pileState.isCurrentlyStable ? 'Locked in' : 'Reading…';
  liveBadge.classList.toggle('is-confirmed', pileState.isCurrentlyStable);

  // Same frozen `subtractLockedStart` as the HUD text above — the banner
  // must not flash a different (shrinking) number as blocks move to the
  // taken-away zone, since that number is the whole point of the problem.
  // preferSide 'top': the pile/taken-away counts are drawn below their
  // zones, so the banner stays above to avoid landing on them.
  lastEquationBanner = subtractLockedStart !== null
    ? { bbox: lastOverlayBbox, text: `${subtractLockedStart} − ${takenAwayCount} = ?`, preferSide: 'top' }
    : null;

  lastSubtractDisplay = {
    pileZone, takenZone, answerZone,
    pileCount: pileBoxes.length, takenCount: takenAwayCount,
    locked: subtractLockedStart !== null,
    confirmed: pileState.isCurrentlyStable
  };

  const cardAnswer = (cardState.isCurrentlyStable && /^\d+$/.test(cardState.confirmed.signature))
    ? Number(cardState.confirmed.signature) : null;
  // Correct only once ALL of these agree: the pile actually shrank to the
  // right amount (not just assumed), and the answer card matches what's
  // actually left.
  const isReadyToCheck = expectedRemaining !== null && cardAnswer !== null && pileState.isCurrentlyStable;
  const isCorrect = isReadyToCheck && pileBoxes.length === expectedRemaining && cardAnswer === expectedRemaining;
  const isMismatch = isReadyToCheck && !isCorrect;
  cardHudWrap.classList.toggle('mismatch', isMismatch);
  cardFeedbackEl.textContent = isMismatch ? 'Not quite — try again!' : '';
  cardFeedbackEl.classList.toggle('hidden', !isMismatch);

  if (isCorrect) {
    const key = `sub:${subtractLockedStart}-${takenAwayCount}=${cardAnswer}`;
    if (key !== lastCelebratedKey) {
      lastCelebratedKey = key;
      celebration = {
        startedAt: now, answer: expectedRemaining, confetti: null,
        absorbBoxes: lastOverlayBoxes.slice(), sinkPoint: celebrationBannerPoint(),
        scoreCredited: false
      };
      playCorrectChime();
    }
  }
  // See processCameraTick's matching comment: lastCelebratedKey is not
  // reset just because isCorrect lapsed for a tick or two.

  const celebrationActive = !!celebration && (now - celebration.startedAt) < CELEBRATION_DURATION_MS;
  let mascotPhase = 'scanning';
  if (celebrationActive) mascotPhase = 'celebrate';
  else if (isMismatch) mascotPhase = 'mismatch';
  else if (pileState.isCurrentlyStable && subtractLockedStart !== null) mascotPhase = 'ready';
  else if (pileState.confirmed && pileState.holdActive) mascotPhase = 'thinking';
  setMascotState(mascotPhase);

  if (debugModeInput.checked) updateDebugOverlay(frame, strength, cardOffset);
}

function processCameraTick(now) {
  const strength = Number(controls.strength.value);
  const minAreaFraction = Number(controls.minArea.value) / 100000;
  const bridgeRadius = Number(controls.bridge.value);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  lastRawFrame = frame;

  if (operation === 'subtract') { processSubtractTick(now, frame, strength); return; }

  const problem = computeProblem(frame, strength, minAreaFraction, bridgeRadius);
  lastOverlayBoxes = problem.boxes;
  lastOverlayBbox = problem.bbox;
  const blockState = blockStabilizer.tick(now, problem.signature, problem.payload);
  noteBlockSignature(blockState.confirmed && blockState.confirmed.signature);
  updateLivePanel(blockState.confirmed, blockState.holdActive, blockState.isCurrentlyStable, blockState.progress);
  lastBlockProgress = blockState.progress;
  lastBlockConfirmedForReticle = blockState.isCurrentlyStable;

  lastConfirmedGridInfo = (operation === 'multiply' && blockState.confirmed && blockState.holdActive && blockState.confirmed.payload.grid && blockState.confirmed.payload.bbox)
    ? { grid: blockState.confirmed.payload.grid, bbox: blockState.confirmed.payload.bbox }
    : null;

  lastZoneDisplay = (operation === 'add')
    ? {
        leftZone: problem.payload.leftZone, rightZone: problem.payload.rightZone,
        answerZone: problem.payload.answerZone,
        leftCount: problem.payload.leftCount, rightCount: problem.payload.rightCount,
        symbol: '+',
        confirmed: blockState.isCurrentlyStable
      }
    : null;

  lastEquationBanner = lastConfirmedGridInfo
    // Deliberately the opposite side from wherever the "cols" dimension
    // bracket landed (see gridColsBracketSide) — both would otherwise run
    // the same room comparison and stack on the same edge.
    ? {
        bbox: lastConfirmedGridInfo.bbox,
        text: `${lastConfirmedGridInfo.grid.rows} × ${lastConfirmedGridInfo.grid.cols} = ?`,
        preferSide: gridColsBracketSide(lastConfirmedGridInfo.bbox) === 'bottom' ? 'top' : 'bottom'
      }
    : (operation === 'add' && blockState.confirmed && blockState.holdActive &&
       blockState.confirmed.payload.leftCount > 0 && blockState.confirmed.payload.rightCount > 0 && blockState.confirmed.payload.bbox)
      // The left/right operand counts are drawn below their zones, so the
      // banner takes the top to stay clear of them.
      ? { bbox: blockState.confirmed.payload.bbox, text: `${blockState.confirmed.payload.leftCount} + ${blockState.confirmed.payload.rightCount} = ?`, preferSide: 'top' }
      : null;

  // Counting-reveal animation: plays once per newly confirmed grid, not
  // on every tick it stays confirmed.
  if (blockState.isCurrentlyStable && blockState.confirmed.signature !== lastRevealedSignature) {
    lastRevealedSignature = blockState.confirmed.signature;
    revealAnimation = { startedAt: now, boxes: lastOverlayBoxes, perStepMs: Math.max(50, Math.min(110, 900 / Math.max(1, lastOverlayBoxes.length))) };
  }

  // Addition always has a dedicated answer zone (drawn by drawCountZones)
  // — it's not optional there the way the multiplication answer zone is,
  // since without it there's nowhere obvious to place the digit card once
  // two operand zones are already occupying the frame.
  const roi = operation === 'add'
    ? lastZoneDisplay.answerZone
    : (cardZoneEnabledInput.checked ? cardZoneRect() : null);
  const cardOffset = Number(cardContrastInput.value);
  const cardResults = recognizeAnswerCards(frame, roi, cardOffset, strength);
  lastCardOverlayResults = cardResults;
  const cardSignature = cardSequenceOf(cardResults);
  const cardState = cardStabilizer.tick(now, cardSignature, cardResults);
  updateCardPanel(cardState, cardResults);

  // Correct-answer celebration: fires once per newly achieved match
  // between the confirmed equation (whichever operation is active) and the
  // confirmed digit-card answer. Requires both to be *currently* stable
  // (both showing "Locked in"), not just held over from a moment ago.
  const blockAnswer = blockState.isCurrentlyStable ? answerFromPayload(blockState.confirmed.payload) : null;
  const cardAnswer = (cardState.isCurrentlyStable && /^\d+$/.test(cardState.confirmed.signature))
    ? Number(cardState.confirmed.signature)
    : null;
  // Explicit right/wrong feedback is the whole point of the "game": once a
  // digit card is confirmed against a confirmed grid, say so plainly —
  // "Try again!" on a mismatch, never the correct answer itself (that
  // would just hand it over on a wrong guess).
  const isMismatch = blockAnswer !== null && cardAnswer !== null && blockAnswer !== cardAnswer;
  cardHudWrap.classList.toggle('mismatch', isMismatch);
  cardFeedbackEl.textContent = isMismatch ? 'Not quite — try again!' : '';
  cardFeedbackEl.classList.toggle('hidden', !isMismatch);
  if (blockAnswer !== null && cardAnswer !== null && blockAnswer === cardAnswer) {
    const key = `${blockState.confirmed.signature}=${cardState.confirmed.signature}`;
    if (key !== lastCelebratedKey) {
      lastCelebratedKey = key;
      // The blocks fly into and vanish at the "Correct!" banner's own
      // spot, and that's also where the 3D gem bursts out from — the
      // reward visibly comes from the celebration itself, not from a
      // location tied to wherever the answer card happened to be sitting.
      celebration = {
        startedAt: now, answer: blockAnswer, confetti: null,
        absorbBoxes: lastOverlayBoxes.slice(),
        sinkPoint: celebrationBannerPoint(),
        scoreCredited: false
      };
      playCorrectChime();
    }
  }
  // Note: lastCelebratedKey is deliberately NOT reset when the match
  // briefly lapses (e.g. a dropped detection frame) — that used to be
  // exactly what caused repeat celebrations on flickery detection. It
  // only changes when a genuinely different equation is celebrated.

  const celebrationActive = !!celebration && (now - celebration.startedAt) < CELEBRATION_DURATION_MS;
  let mascotPhase = 'scanning';
  if (celebrationActive) mascotPhase = 'celebrate';
  else if (isMismatch) mascotPhase = 'mismatch';
  else if (blockState.isCurrentlyStable) mascotPhase = 'ready';
  else if (blockState.confirmed && blockState.holdActive) mascotPhase = 'thinking';
  setMascotState(mascotPhase);

  if (debugModeInput.checked) updateDebugOverlay(frame, strength, cardOffset);
}

// Credit the point exactly when the gem visually arrives at the score
// badge, not the instant the match was detected — a plain function
// (not inlined in renderFx3D) so scoring stays correct even if
// THREE.js/WebGL never initializes and the 3D layer is skipped entirely.
function maybeCreditCelebrationScore(now) {
  if (celebration && !celebration.scoreCredited && (now - celebration.startedAt) >= GEM_ARRIVE_MS) {
    celebration.scoreCredited = true;
    incrementScore();
  }
}

function cameraTick(timestamp) {
  if (!cameraActive) return;
  const scale = Math.min(1, 1100 / video.videoWidth);
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (timestamp - lastAnalysisTime >= ANALYSIS_INTERVAL_MS) {
    lastAnalysisTime = timestamp;
    processCameraTick(timestamp);
  }

  if (debugModeInput.checked && debugCanvas.width === canvas.width && debugCanvas.height === canvas.height) {
    ctx.drawImage(debugCanvas, 0, 0);
  }
  drawScanReticle(lastBlockProgress, lastBlockConfirmedForReticle, lastOverlayBbox, timestamp);
  if (revealAnimation && (timestamp - revealAnimation.startedAt) < revealTotalDuration(revealAnimation)) {
    drawBlockRevealAnimation(revealAnimation, timestamp);
  } else {
    revealAnimation = null;
    drawBoxesOverlay(lastOverlayBoxes);
  }
  if (lastConfirmedGridInfo) drawGridDimensionBrackets(lastConfirmedGridInfo.bbox, lastConfirmedGridInfo.grid.rows, lastConfirmedGridInfo.grid.cols);
  if (lastZoneDisplay) drawCountZones(lastZoneDisplay);
  if (lastSubtractDisplay) drawSubtractZones(lastSubtractDisplay);
  if (operation === 'multiply' && cardZoneEnabledInput.checked) drawCardZone(cardZoneRect());
  drawCardOverlay(lastCardOverlayResults);
  // Once the big on-canvas banner is showing the equation, the small
  // top-left pill saying the exact same thing is just clutter — hide it,
  // and bring it back for the pre-confirmation "Reading…"/prompt states
  // the banner doesn't cover.
  document.querySelector('.equation-pill').classList.toggle('hidden', !!lastEquationBanner);
  if (lastEquationBanner) drawEquationBanner(lastEquationBanner.bbox, lastEquationBanner.text, lastEquationBanner.preferSide);
  if (celebration) { drawAbsorbAnimation(celebration, timestamp); drawCelebrationOverlay(timestamp); }
  else if (cardHudWrap.classList.contains('mismatch')) { drawTryAgainOverlay(timestamp); }
  renderFx3D(timestamp);
  maybeCreditCelebrationScore(timestamp);
  rafId = requestAnimationFrame(cameraTick);
}

function supportsCamera() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function showCameraMessage(text) {
  cameraMessage.textContent = text;
  cameraMessage.classList.remove('hidden');
}

function hideCameraMessage() {
  cameraMessage.classList.add('hidden');
}

function cameraErrorMessage(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera access was not allowed. Please allow camera access for this site in your browser settings.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Please check that a camera is connected.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Could not start the camera. Please check that no other app is using it.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'No camera matching the requested settings was found.';
  }
  return 'An error occurred while starting the camera.';
}

async function populateCameraSelect() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    if (videoInputs.length > 1) {
      cameraSelect.innerHTML = '';
      videoInputs.forEach((d, i) => {
        const option = document.createElement('option');
        option.value = d.deviceId;
        option.textContent = d.label || `Camera ${i + 1}`;
        cameraSelect.appendChild(option);
      });
      const currentTrack = cameraStream && cameraStream.getVideoTracks()[0];
      const currentId = currentTrack && currentTrack.getSettings().deviceId;
      if (currentId) cameraSelect.value = currentId;
      cameraSelect.classList.remove('hidden');
    } else {
      cameraSelect.classList.add('hidden');
    }
  } catch (e) {
    cameraSelect.classList.add('hidden');
  }
}

// Best-effort: forces continuous autofocus where the browser exposes that
// control (mainly Chrome/Android; support elsewhere, including iOS Safari,
// is inconsistent and this silently no-ops if the constraint isn't there).
// A phone's default camera driver normally autofocuses continuously on its
// own regardless of this, so this is a small nudge, not a guaranteed fix
// for blurry close-up shots — see the README's focus/distance notes.
async function enableAutofocusIfSupported(stream) {
  const track = stream.getVideoTracks()[0];
  const capabilities = track && track.getCapabilities ? track.getCapabilities() : null;
  if (!capabilities || !capabilities.focusMode || !capabilities.focusMode.includes('continuous')) return;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (e) {
    // Not supported in practice despite being advertised; ignore.
  }
}

// Manual torch (flashlight) toggle, tucked into the settings drawer and
// off by default — most lighting is fine without it, but some rooms/blocks
// need the extra light for reliable detection, so it's an opt-in switch
// rather than an always-on auto-behavior. The MediaTrack `torch`
// constraint is boolean only (no cross-browser way to dim it).
function setTorchStatus(state) {
  if (state === 'on') {
    torchStatusEl.textContent = 'Light ON';
    torchStatusEl.classList.remove('hidden');
  } else if (state === 'unsupported') {
    torchStatusEl.textContent = 'Light not supported on this camera';
    torchStatusEl.classList.remove('hidden');
  } else if (state === 'off') {
    torchStatusEl.textContent = 'Light OFF';
    torchStatusEl.classList.remove('hidden');
  } else {
    torchStatusEl.classList.add('hidden');
  }
}

async function applyTorch(stream, enabled) {
  const track = stream && stream.getVideoTracks()[0];
  const capabilities = track && track.getCapabilities ? track.getCapabilities() : null;
  if (!capabilities || !capabilities.torch) {
    setTorchStatus('unsupported');
    return;
  }
  try {
    await track.applyConstraints({ advanced: [{ torch: enabled }] });
    setTorchStatus(enabled ? 'on' : 'off');
  } catch (e) {
    setTorchStatus('unsupported');
  }
}

async function enableTorchIfSupported(stream) {
  if (!torchEnabledInput.checked) {
    setTorchStatus('hidden');
    return;
  }
  await applyTorch(stream, true);
}

function attachStream(stream) {
  cameraStream = stream;
  video.srcObject = stream;
  video.onloadedmetadata = () => {
    video.play().catch(() => {});
    cameraActive = true;
    startCameraButton.disabled = true;
    stopCameraButton.disabled = false;
    liveBadge.classList.remove('hidden');
    cardBadge.classList.remove('hidden');
    blockStabilizer.reset();
    cardStabilizer.reset();
    resetGameLayer();
    lastAnalysisTime = 0;
    stage.classList.add('camera-running');
    setMascotState('scanning');
    scoreHud.classList.remove('hidden');
    updateScoreDisplay();
    rafId = requestAnimationFrame(cameraTick);
    populateCameraSelect();
    enableTorchIfSupported(stream);
    enableAutofocusIfSupported(stream);
  };
}

async function startCamera(deviceId) {
  hideCameraMessage();
  if (!window.isSecureContext) {
    showCameraMessage('Camera access requires HTTPS or localhost. Please open this page over localhost while developing.');
    return;
  }
  if (!supportsCamera()) {
    showCameraMessage('Your browser does not support camera access. Please try a recent version of Chrome or Safari.');
    return;
  }
  // A modest resolution bump over whatever the browser would default to,
  // without asking for more than the video pipeline can comfortably decode
  // every frame. An earlier version of this requested 4K "ideal", which
  // measurably slowed the live view down (decoding a 4K video stream at
  // ~60fps just to immediately downscale it to 1100px for analysis is not
  // a good trade) — 720p is a much lighter, well-worn default for
  // real-time web video work, while still usually beating an
  // unconstrained getUserMedia() call's chosen resolution.
  const resolutionHint = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId }, ...resolutionHint }
    : { facingMode: { ideal: 'environment' }, ...resolutionHint };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    attachStream(stream);
  } catch (err) {
    if (!deviceId && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
      try {
        attachStream(await navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
        return;
      } catch (err2) {
        showCameraMessage(cameraErrorMessage(err2));
        return;
      }
    }
    showCameraMessage(cameraErrorMessage(err));
    resetLivePanel();
    resetCardPanel();
  }
}

function stopCamera() {
  cameraActive = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  startCameraButton.disabled = false;
  stopCameraButton.disabled = true;
  blockStabilizer.reset();
  cardStabilizer.reset();
  liveBadge.classList.add('hidden');
  liveBadge.classList.remove('is-confirmed');
  setTorchStatus('hidden');
  debugInfoEl.classList.add('hidden');
  lastRawFrame = null;
  resetGameLayer();
  stage.classList.remove('camera-running');
  setMascotState('sleep');
  scoreHud.classList.add('hidden');
  if (mode === 'camera') { resetLivePanel(); resetCardPanel(); }
}

function setMode(newMode) {
  if (mode === newMode) return;
  mode = newMode;
  stage.dataset.mode = mode;
  modeImageButton.classList.toggle('is-active', mode === 'image');
  modeImageButton.setAttribute('aria-selected', String(mode === 'image'));
  modeCameraButton.classList.toggle('is-active', mode === 'camera');
  modeCameraButton.setAttribute('aria-selected', String(mode === 'camera'));
  imageToolbar.classList.toggle('hidden', mode !== 'image');
  cameraToolbar.classList.toggle('hidden', mode !== 'camera');
  modeLabel.textContent = mode === 'image' ? 'Photo test mode' : 'Live camera mode';
  hint.textContent = mode === 'image'
    ? 'Red blocks are outlined in teal. You can also drag a different photo in here.'
    : 'Start the camera to detect red blocks and digit blocks in real time. Use the ×/+/− chip at the top to switch problem type.';
  if (mode === 'image') {
    stopCamera();
    hideCameraMessage();
    loading.classList.add('hidden');
    if (sourceImage) analyze();
  } else {
    resetLivePanel();
    resetGameLayer();
  }
  resetCardPanel();
}

// Only meaningful in camera mode (image-test mode is a fixed multiplication
// detector-accuracy tool — see setMode), but harmless to call regardless.
function setOperation(newOp) {
  if (operation === newOp) return;
  operation = newOp;
  [['multiply', opMultiplyButton], ['add', opAddButton], ['subtract', opSubtractButton]].forEach(([op, btn]) => {
    btn.classList.toggle('is-active', op === newOp);
    btn.setAttribute('aria-selected', String(op === newOp));
  });
  blockStabilizer.reset();
  // The answer-card stabilizer is otherwise only reset on camera
  // start/stop and mode switches — without resetting it here too, a
  // digit card already in view could carry a stale confirmed reading
  // (or a false match) straight across an operation switch.
  cardStabilizer.reset();
  resetGameLayer();
  resetLivePanel();
  resetCardPanel();
}

function resetLivePanel() {
  document.querySelector('#count').textContent = '';
  document.querySelector('#equation').textContent = 'Start the camera to begin';
  document.querySelector('#arrangement').textContent = 'Show your blocks to the camera to check the arrangement.';
  liveBadge.classList.add('hidden');
  liveBadge.classList.remove('is-confirmed');
  scanRingProgressEl.style.strokeDashoffset = String(SCAN_RING_CIRCUMFERENCE);
  scanRingProgressEl.classList.remove('is-confirmed');
}

Object.values(controls).forEach(control => control.addEventListener('input', () => {
  updateLabels();
  if (mode === 'image') analyze();
  else { blockStabilizer.reset(); resetGameLayer(); }
}));
imageInput.addEventListener('change', e => loadFile(e.target.files[0]));
sampleButton.addEventListener('click', () => loadUrl(SAMPLE_URL, SAMPLE_NAME));
resetButton.addEventListener('click', () => {
  controls.strength.value = 25; controls.minArea.value = 20; controls.bridge.value = 2;
  updateLabels();
  if (mode === 'image') analyze();
  else { blockStabilizer.reset(); resetGameLayer(); }
});
['dragenter','dragover'].forEach(name => dropZone.addEventListener(name, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(name => dropZone.addEventListener(name, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));

function openDrawer() {
  settingsDrawer.classList.add('open');
  drawerScrim.classList.add('open');
  settingsDrawer.setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  settingsDrawer.classList.remove('open');
  drawerScrim.classList.remove('open');
  settingsDrawer.setAttribute('aria-hidden', 'true');
}
settingsButton.addEventListener('click', openDrawer);
closeSettingsButton.addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', closeDrawer);

// --- First-run tutorial -------------------------------------------------
//
// Short, simple-language walkthrough for a young (~5-8yo) first-time
// user: where the blocks go, and what happens when you get it right.
// Shown automatically once (tracked in localStorage) and replayable from
// the settings drawer.
const tutorialOverlay = document.querySelector('#tutorialOverlay');
const tutorialSkipButton = document.querySelector('#tutorialSkipButton');
const tutorialNextButton = document.querySelector('#tutorialNextButton');
const showTutorialButton = document.querySelector('#showTutorialButton');
const tutorialStepEls = Array.from(document.querySelectorAll('.tutorial-step'));
const tutorialDotEls = Array.from(document.querySelectorAll('.tutorial-dot'));
let tutorialStepIndex = 0;

function showTutorialStep(i) {
  tutorialStepIndex = i;
  tutorialStepEls.forEach((el, idx) => { el.hidden = idx !== i; });
  tutorialDotEls.forEach((el, idx) => el.classList.toggle('is-active', idx === i));
  tutorialNextButton.textContent = i === tutorialStepEls.length - 1 ? "Let's go!" : 'Next';
}
function openTutorial() {
  showTutorialStep(0);
  tutorialOverlay.classList.remove('hidden');
  tutorialOverlay.setAttribute('aria-hidden', 'false');
}
function closeTutorial() {
  tutorialOverlay.classList.add('hidden');
  tutorialOverlay.setAttribute('aria-hidden', 'true');
  try { localStorage.setItem('tutorialSeen', '1'); } catch (e) { /* storage unavailable — it'll just show again next visit */ }
}
tutorialNextButton.addEventListener('click', () => {
  if (tutorialStepIndex >= tutorialStepEls.length - 1) closeTutorial();
  else showTutorialStep(tutorialStepIndex + 1);
});
tutorialSkipButton.addEventListener('click', closeTutorial);
showTutorialButton.addEventListener('click', () => { closeDrawer(); openTutorial(); });

let tutorialAlreadySeen = false;
try { tutorialAlreadySeen = localStorage.getItem('tutorialSeen') === '1'; } catch (e) { /* ignore */ }
if (!tutorialAlreadySeen) openTutorial();

modeImageButton.addEventListener('click', () => setMode('image'));
modeCameraButton.addEventListener('click', () => setMode('camera'));
opMultiplyButton.addEventListener('click', () => setOperation('multiply'));
opAddButton.addEventListener('click', () => setOperation('add'));
opSubtractButton.addEventListener('click', () => setOperation('subtract'));
startCameraButton.addEventListener('click', () => { initAudio(); startCamera(); });
stopCameraButton.addEventListener('click', () => stopCamera());
cameraSelect.addEventListener('change', () => {
  const id = cameraSelect.value;
  stopCamera();
  startCamera(id);
});
cardZoneEnabledInput.addEventListener('change', () => { cardStabilizer.reset(); resetGameLayer(); });
torchEnabledInput.addEventListener('change', () => {
  if (!cameraActive || !cameraStream) return;
  applyTorch(cameraStream, torchEnabledInput.checked);
});
debugModeInput.addEventListener('change', () => {
  if (!debugModeInput.checked) debugInfoEl.classList.add('hidden');
});
useMarkersInput.addEventListener('change', () => {
  if (mode === 'image') analyze();
  else { blockStabilizer.reset(); resetGameLayer(); }
});
cardContrastInput.addEventListener('input', () => {
  cardContrastOutput.value = cardContrastInput.value;
  cardStabilizer.reset();
  resetGameLayer();
});

// Public read-only hook, mirroring the ported prototype's
// window.AirWritingCamera.getLatestResult(). Camera start/stop stays owned
// by this system's own UI (single getUserMedia stream) rather than a
// second, separate API.
let latestAnswerCardsResult = null;
window.addEventListener('airwritingresult', event => { latestAnswerCardsResult = structuredClone(event.detail); });
window.AnswerCards = {
  getLatestResult: () => latestAnswerCardsResult ? structuredClone(latestAnswerCardsResult) : null
};

updateLabels();
loadUrl(SAMPLE_URL, SAMPLE_NAME, { silent: true });

// Digit templates now come from real SVG outlines (dist/digits/*.svg)
// instead of rendering a font by name, so there's no more "is the right
// font installed" question — but the 10 files still have to actually load
// (wrong path, one file missing, dist/digits/ not deployed, etc.), so
// surface that failure visibly instead of silently recognizing nothing.
if (window.CardDigitModel) {
  window.CardDigitModel.ready.catch(() => {
    const el = document.querySelector('#fontWarning');
    el.textContent = '⚠️ Failed to load the digit templates (dist/digits/*.svg). Digit-block recognition will not work.';
    el.classList.remove('hidden');
  });
}
