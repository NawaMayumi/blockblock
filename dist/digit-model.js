/* Digit-card recognition model: matches a camera-captured glyph against 10
   real vector outlines (dist/digits/digit-0.svg .. digit-9.svg) supplied
   directly, rather than rendering a font by name via the Canvas Text API.
   This removes the dependency on the viewing device actually having the
   right font installed — earlier versions rendered `ctx.font = "Futura"`,
   which silently falls back to a different, wrong-shaped typeface on any
   device that doesn't have Futura (confirmed missing on the target
   iPhone). The SVGs are loaded once at page load and rasterized into the
   same 28x28 template format used for the live camera glyph, so template
   creation and live decoding go through identical normalization logic.
   No image data leaves the browser. */
(function () {
  // Dilates a 28x28 binary grid by `radius` (a pixel turns "on" if any
  // pixel within `radius` is on). Used to make matching tolerant of a few
  // pixels of shift/blur/thickness change, instead of requiring an exact
  // pixel-for-pixel overlap — real camera footage (blur, compression,
  // slight rotation) shifts and fattens strokes just enough that raw
  // pixel-overlap matching was too brittle in practice.
  function dilateGlyph(pixels, radius) {
    const size = 28;
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let on = false;
        for (let dy = -radius; dy <= radius && !on; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= size) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= size) continue;
            if (pixels[ny * size + nx]) { on = true; break; }
          }
        }
        out[y * size + x] = on ? 1 : 0;
      }
    }
    return out;
  }

  // A soft F1-style distance: how much of the input's ink falls near the
  // template's ink (precision, checked against the *dilated* template) and
  // how much of the template's ink falls near the input's ink (recall,
  // checked against the *dilated* input). A few pixels of misalignment no
  // longer counts as a full mismatch the way raw pixel-overlap did.
  function tolerantDistance(inputPixels, inputDilated, templatePixels, templateDilated) {
    let inputOn = 0, inputCovered = 0, templateOn = 0, templateCovered = 0;
    for (let i = 0; i < inputPixels.length; i++) {
      if (inputPixels[i]) { inputOn++; if (templateDilated[i]) inputCovered++; }
      if (templatePixels[i]) { templateOn++; if (inputDilated[i]) templateCovered++; }
    }
    const precision = inputOn ? inputCovered / inputOn : (templateOn ? 0 : 1);
    const recall = templateOn ? templateCovered / templateOn : (inputOn ? 0 : 1);
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return 1 - f1;
  }

  // Keep only the largest connected white component so the small gray
  // orientation tab and glare specks (separate, smaller blobs) can't
  // stretch or shift the digit's bounding box.
  function normalizeCardGlyphPixels(source, width, height) {
    const seen = new Uint8Array(source.length);
    let best = [];
    for (let seed = 0; seed < source.length; seed++) {
      if (!source[seed] || seen[seed]) continue;
      const queue = [seed], component = [];
      seen[seed] = 1;
      let head = 0;
      while (head < queue.length) {
        const p = queue[head++], x = p % width, y = (p / width) | 0;
        component.push(p);
        for (const n of [p - 1, p + 1, p - width, p + width]) {
          if (n >= 0 && n < source.length && !seen[n] && source[n] &&
            Math.abs(n % width - x) + Math.abs(((n / width) | 0) - y) === 1) {
            seen[n] = 1;
            queue.push(n);
          }
        }
      }
      if (component.length > best.length) best = component;
    }
    const clean = new Uint8Array(source.length);
    for (const p of best) clean[p] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (const p of best) {
      const x = p % width, y = (p / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const out = new Float32Array(784);
    if (maxX < minX) return out;
    const glyphW = maxX - minX + 1, glyphH = maxY - minY + 1;
    const scale = 22 / Math.max(glyphW, glyphH);
    const ox = (28 - glyphW * scale) / 2, oy = (28 - glyphH * scale) / 2;
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
      const sx = Math.floor((x - ox) / scale + minX);
      const sy = Math.floor((y - oy) / scale + minY);
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY && clean[sy * width + sx]) out[y * 28 + x] = 1;
    }
    return out;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('failed to load ' + url));
      img.src = url;
    });
  }

  // Renders one loaded digit SVG (a white glyph path, no background) onto
  // a black 96x96 canvas at a given height/baseline-offset/rotation, then
  // binarizes and normalizes it exactly like a live camera crop would be.
  function renderDigitFromImage(img, targetHeight, offsetY, rotationDeg) {
    const side = 96;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, side, side);
    ctx.save();
    ctx.translate(side / 2, side / 2 + offsetY);
    if (rotationDeg) ctx.rotate(rotationDeg * Math.PI / 180);
    const scale = targetHeight / img.height;
    ctx.drawImage(img, -img.width * scale / 2, -img.height * scale / 2, img.width * scale, img.height * scale);
    ctx.restore();
    const data = ctx.getImageData(0, 0, side, side).data;
    const raw = new Uint8Array(side * side);
    for (let i = 0; i < raw.length; i++) raw[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 > 160 ? 1 : 0;
    return normalizeCardGlyphPixels(raw, side, side);
  }

  let cardTemplates = [];
  let ready = false;
  let failed = false;

  // Small height/baseline/rotation variants absorb print and camera
  // rasterisation (plus a few degrees of imprecise placement) without
  // needing multiple source images per digit. Each template's dilated
  // form is precomputed once here so matching later doesn't redo it per
  // candidate per frame.
  const readyPromise = (async () => {
    try {
      const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const images = await Promise.all(digits.map(d => loadImage(`./digits/digit-${d}.svg`)));
      const templates = [];
      digits.forEach((digit, idx) => {
        const img = images[idx];
        [68, 72, 76].forEach(targetHeight => {
          [-1, 0, 1].forEach(offsetY => {
            [0, -6, 6].forEach(rotationDeg => {
              const pixels = renderDigitFromImage(img, targetHeight, offsetY, rotationDeg);
              templates.push({ digit, pixels, dilated: dilateGlyph(pixels, 1) });
            });
          });
        });
      });
      cardTemplates = templates;
      ready = true;
    } catch (e) {
      failed = true;
      throw e;
    }
  })();

  function predictCardPixels(pixels) {
    if (!ready || !cardTemplates.length) return [];
    const inputDilated = dilateGlyph(pixels, 1);
    const scored = cardTemplates.map(t => ({
      value: t.digit,
      distance: tolerantDistance(pixels, inputDilated, t.pixels, t.dilated)
    }));
    const best = {};
    for (const s of scored) if (!(s.value in best) || s.distance < best[s.value]) best[s.value] = s.distance;
    const entries = Object.entries(best).map(([value, distance]) => ({ value: Number(value), distance }));
    const weights = entries.map(x => Math.exp(-x.distance * 25));
    const sum = weights.reduce((a, b) => a + b, 0);
    return entries.map((x, i) => ({ value: x.value, confidence: weights[i] / sum })).sort((a, b) => b.confidence - a.confidence);
  }

  window.CardDigitModel = {
    normalizeCardGlyphPixels,
    predictCardPixels,
    get isReady() { return ready; },
    get failed() { return failed; },
    ready: readyPromise
  };
})();
