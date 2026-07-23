#!/usr/bin/env node

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MATTE = [241, 240, 241];
const PREVIEW_BACKGROUNDS = {
  dark: [42, 40, 40],
  mid: [128, 128, 128],
};

const STROKE_WIDTH_ALPHA_THRESHOLD = 16;

const TARGET_GROUPS = [
  {
    name: 'wordmark-423x145-unified',
    family: 'wordmark',
    canonicalTarget: 'desktop-wordmark-1x',
    targets: [
      {
        name: 'desktop-wordmark-1x',
        path: 'apps/desktop/src/renderer/assets/login/wordmark.png',
      },
      {
        name: 'mobile-wordmark-2x',
        path: 'apps/mobile/assets/login/login-wordmark@2x.png',
      },
    ],
  },
  {
    name: 'wordmark-846x290',
    family: 'wordmark',
    canonicalTarget: 'desktop-wordmark-2x',
    targets: [
      {
        name: 'desktop-wordmark-2x',
        path: 'apps/desktop/src/renderer/assets/login/wordmark@2x.png',
      },
    ],
  },
  {
    name: 'wordmark-635x218',
    family: 'wordmark',
    canonicalTarget: 'mobile-wordmark-3x',
    targets: [
      {
        name: 'mobile-wordmark-3x',
        path: 'apps/mobile/assets/login/login-wordmark@3x.png',
      },
    ],
  },
  {
    name: 'slogan-455x131-unified',
    family: 'slogan',
    canonicalTarget: 'desktop-slogan-1x',
    targets: [
      {
        name: 'desktop-slogan-1x',
        path: 'apps/desktop/src/renderer/assets/login/slogan.png',
      },
      {
        name: 'mobile-slogan-2x',
        path: 'apps/mobile/assets/login/login-slogan@2x.png',
      },
    ],
  },
  {
    name: 'slogan-909x261',
    family: 'slogan',
    canonicalTarget: 'desktop-slogan-2x',
    targets: [
      {
        name: 'desktop-slogan-2x',
        path: 'apps/desktop/src/renderer/assets/login/slogan@2x.png',
      },
    ],
  },
  {
    name: 'slogan-682x196',
    family: 'slogan',
    canonicalTarget: 'mobile-slogan-3x',
    targets: [
      {
        name: 'mobile-slogan-3x',
        path: 'apps/mobile/assets/login/login-slogan@3x.png',
      },
    ],
  },
];

const HERO_CHECKS = [
  'apps/desktop/src/renderer/assets/login/hero.png',
  'apps/desktop/src/renderer/assets/login/hero@2x.png',
  'apps/mobile/assets/login/login-hero@2x.png',
  'apps/mobile/assets/login/login-hero@3x.png',
  'apps/mobile/assets/login/login-hero-pad-portrait.png',
  'apps/mobile/assets/login/login-hero-pad-portrait@2x.png',
  'apps/mobile/assets/login/login-hero-pad-landscape.png',
  'apps/mobile/assets/login/login-hero-pad-landscape@2x.png',
];

const INKS = {
  slogan: [[42, 40, 40]],
  wordmark: [
    [4, 3, 3],
    [247, 1, 33],
  ],
};

const EVIDENCE_DIR =
  'docs/login-redesign/acceptance/evidence/slogan-defringe';

function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const report = {
    matte: rgbHex(MATTE),
    inks: Object.fromEntries(
      Object.entries(INKS).map(([family, colors]) => [
        family,
        colors.map(rgbHex),
      ]),
    ),
    targets: [],
    byteIdenticalGroups: [],
    heroChecks: [],
  };

  for (const group of TARGET_GROUPS) {
    const canonicalTarget = group.targets.find(
      (target) => target.name === group.canonicalTarget,
    );
    if (!canonicalTarget) {
      throw new Error(`Missing canonical target ${group.canonicalTarget}`);
    }

    const canonicalBefore = decodePng(readFileSync(canonicalTarget.path));
    const { image: canonicalAfter } = defringe(canonicalBefore, group);
    const encodedCanonical = encodePng(canonicalAfter);
    const canonicalSha256 = sha256Hex(encodedCanonical);

    for (const target of group.targets) {
      const before = decodePng(readFileSync(target.path));
      assertSameDimensions(before, canonicalAfter, target, group);
      const stats = collectStats(before, canonicalAfter, {
        family: group.family,
        canonicalGroup: group.name,
        canonicalSourcePath: canonicalTarget.path,
      });
      writeFileSync(target.path, encodedCanonical);

      const previewPath = join(EVIDENCE_DIR, `${target.name}-preview.png`);
      writeFileSync(previewPath, encodePng(makePreview(before, canonicalAfter)));

      report.targets.push({
        name: target.name,
        path: target.path,
        preview: previewPath,
        outputSha256: canonicalSha256,
        ...stats,
      });
    }

    report.byteIdenticalGroups.push({
      name: group.name,
      canonicalSourcePath: canonicalTarget.path,
      outputSha256: canonicalSha256,
      outputSha256Prefix16: canonicalSha256.slice(0, 16),
      targets: group.targets.map((target) => target.path),
    });
  }

  for (const path of HERO_CHECKS) {
    const image = decodePng(readFileSync(path));
    report.heroChecks.push({
      path,
      ...summarizeImage(image),
      matteLikeNonTransparentPixels: countMatteLikePixels(image),
      exactTransparentMattePixels: countExactMattePixels(image, 0),
      exactVisibleMattePixels: countExactMattePixels(image, 'visible'),
    });
  }

  const reportPath = join(EVIDENCE_DIR, 'defringe-report.json');
  writeFileSync(`${reportPath}`, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
}

function defringe(image, target) {
  const out = Buffer.from(image.data);
  const width = image.width;
  const height = image.height;
  const inkPalette = INKS[target.family];

  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3];
    if (alpha === 0) {
      if (out[i] !== 0 || out[i + 1] !== 0 || out[i + 2] !== 0) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
      }
      continue;
    }
    if (alpha < 255) {
      continue;
    }

    const pixel = [out[i], out[i + 1], out[i + 2]];
    const fit = chooseInk(pixel, inkPalette);
    const nextAlpha = Math.max(1, Math.min(255, Math.round(fit.alpha * 255)));

    if (nextAlpha >= 255) {
      continue;
    }

    out[i] = fit.ink[0];
    out[i + 1] = fit.ink[1];
    out[i + 2] = fit.ink[2];
    out[i + 3] = nextAlpha;
  }

  return { image: { width, height, data: out } };
}

function collectStats(beforeImage, afterImage, options) {
  const inkPalette = INKS[options.family];
  const before = summarizeImage(beforeImage);
  const after = summarizeImage(afterImage);
  const inferredAlphaBefore = alphaSummary(beforeImage, inkPalette);
  const inferredAlphaAfter = alphaSummary(afterImage, inkPalette);
  const beforeStrokeMask = makeInferredAlphaMask(
    beforeImage,
    inkPalette,
    STROKE_WIDTH_ALPHA_THRESHOLD,
  );
  const afterStrokeMask = makeInferredAlphaMask(
    afterImage,
    inkPalette,
    STROKE_WIDTH_ALPHA_THRESHOLD,
  );
  const beforeNonZeroMask = makeAlphaMask(beforeImage.data, 1);
  const afterNonZeroMask = makeAlphaMask(afterImage.data, 1);

  let changedPixels = 0;
  let transparentRgbCleared = 0;
  let unblendedPixels = 0;
  let fullAlphaRgbMaxDelta = 0;
  let maxReconstructionError = 0;
  let nonZeroMaskDeltaPixels = 0;

  for (let i = 0, p = 0; i < beforeImage.data.length; i += 4, p += 1) {
    const beforePixel = [
      beforeImage.data[i],
      beforeImage.data[i + 1],
      beforeImage.data[i + 2],
      beforeImage.data[i + 3],
    ];
    const afterPixel = [
      afterImage.data[i],
      afterImage.data[i + 1],
      afterImage.data[i + 2],
      afterImage.data[i + 3],
    ];

    if (beforeNonZeroMask[p] !== afterNonZeroMask[p]) {
      nonZeroMaskDeltaPixels += 1;
    }
    if (beforePixel.some((value, index) => value !== afterPixel[index])) {
      changedPixels += 1;
    }
    if (
      beforePixel[3] === 0 &&
      beforePixel.slice(0, 3).some((value) => value !== 0) &&
      afterPixel[3] === 0 &&
      afterPixel.slice(0, 3).every((value) => value === 0)
    ) {
      transparentRgbCleared += 1;
    }
    if (beforePixel[3] === 255 && afterPixel[3] > 0 && afterPixel[3] < 255) {
      unblendedPixels += 1;
    }
    if (beforePixel[3] === 255 && afterPixel[3] === 255) {
      fullAlphaRgbMaxDelta = Math.max(
        fullAlphaRgbMaxDelta,
        Math.abs(beforePixel[0] - afterPixel[0]),
        Math.abs(beforePixel[1] - afterPixel[1]),
        Math.abs(beforePixel[2] - afterPixel[2]),
      );
    }
    if (beforePixel[3] > 0) {
      const fit = chooseInk(beforePixel.slice(0, 3), inkPalette);
      maxReconstructionError = Math.max(maxReconstructionError, fit.error);
    }
  }

  return {
    canonicalGroup: options.canonicalGroup,
    canonicalSourcePath: options.canonicalSourcePath,
    dimensions: `${beforeImage.width}x${beforeImage.height}`,
    changedPixels,
    transparentRgbCleared,
    unblendedPixels,
    nonZeroAlphaPixelsBefore: before.nonZeroAlphaPixels,
    nonZeroAlphaPixelsAfter: after.nonZeroAlphaPixels,
    nonZeroMaskDeltaPixels,
    rawAlphaSumBefore: before.alphaSum,
    rawAlphaSumAfter: after.alphaSum,
    rawAlphaDeltaPct: pctDelta(after.alphaSum, before.alphaSum),
    inferredAlphaSumBefore: inferredAlphaBefore.alphaSum,
    inferredAlphaSumAfter: inferredAlphaAfter.alphaSum,
    inferredAlphaDeltaPct: pctDelta(
      inferredAlphaAfter.alphaSum,
      inferredAlphaBefore.alphaSum,
    ),
    semiTransparentBefore: before.semiTransparent,
    semiTransparentAfter: after.semiTransparent,
    alphaSmoothnessBefore: alphaSmoothness(beforeImage),
    alphaSmoothnessAfter: alphaSmoothness(afterImage),
    matteLikeNonTransparentBefore: countMatteLikePixels(beforeImage),
    matteLikeNonTransparentAfter: countMatteLikePixels(afterImage),
    fullAlphaRgbMaxDelta,
    maxReconstructionError: round3(maxReconstructionError),
    strokeWidthAlphaMode: 'inferred',
    strokeWidthAlphaThreshold: STROKE_WIDTH_ALPHA_THRESHOLD,
    crossSections: sampleCrossSections(
      beforeStrokeMask,
      afterStrokeMask,
      beforeImage.width,
      beforeImage.height,
    ),
  };
}

function chooseInk(pixel, palette) {
  let best = null;
  for (const ink of palette) {
    const fit = fitAlpha(pixel, ink);
    if (!best || fit.error < best.error) {
      best = fit;
    }
  }
  return best;
}

function fitAlpha(pixel, ink) {
  const alphas = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const denom = MATTE[channel] - ink[channel];
    if (Math.abs(denom) >= 20) {
      alphas.push((MATTE[channel] - pixel[channel]) / denom);
    }
  }
  const alpha = Math.max(0, Math.min(1, median(alphas)));
  let errorSq = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const reconstructed =
      MATTE[channel] * (1 - alpha) + ink[channel] * alpha;
    errorSq += (pixel[channel] - reconstructed) ** 2;
  }
  return {
    ink,
    alpha,
    error: Math.sqrt(errorSq),
  };
}

function alphaSummary(image, palette) {
  let alphaSum = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    if (alpha === 0) {
      continue;
    }
    if (alpha < 255) {
      alphaSum += alpha;
      continue;
    }
    const fit = chooseInk(
      [image.data[i], image.data[i + 1], image.data[i + 2]],
      palette,
    );
    alphaSum += Math.max(1, Math.min(255, Math.round(fit.alpha * 255)));
  }
  return { alphaSum };
}

function summarizeImage(image) {
  let alphaSum = 0;
  let transparent = 0;
  let semiTransparent = 0;
  let opaque = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    alphaSum += alpha;
    if (alpha === 0) {
      transparent += 1;
    } else if (alpha === 255) {
      opaque += 1;
    } else {
      semiTransparent += 1;
    }
  }
  return {
    dimensions: `${image.width}x${image.height}`,
    alphaSum,
    transparent,
    semiTransparent,
    opaque,
    nonZeroAlphaPixels: opaque + semiTransparent,
  };
}

function countMatteLikePixels(image) {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) {
      continue;
    }
    const distance = colorDistance([
      image.data[i],
      image.data[i + 1],
      image.data[i + 2],
    ], MATTE);
    if (distance < 80) {
      count += 1;
    }
  }
  return count;
}

function countExactMattePixels(image, alphaMode) {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    const alphaMatches =
      alphaMode === 'visible' ? alpha > 0 : alpha === alphaMode;
    if (
      alphaMatches &&
      image.data[i] === MATTE[0] &&
      image.data[i + 1] === MATTE[1] &&
      image.data[i + 2] === MATTE[2]
    ) {
      count += 1;
    }
  }
  return count;
}

function makeAlphaMask(data, threshold) {
  const mask = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    mask[p] = data[i + 3] >= threshold ? 1 : 0;
  }
  return mask;
}

function makeInferredAlphaMask(image, palette, threshold) {
  const mask = new Uint8Array(image.data.length / 4);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
    mask[p] = inferredAlphaAt(image.data, i, palette) >= threshold ? 1 : 0;
  }
  return mask;
}

function inferredAlphaAt(data, offset, palette) {
  const alpha = data[offset + 3];
  if (alpha === 0) {
    return 0;
  }
  if (alpha < 255) {
    return alpha;
  }
  const fit = chooseInk(
    [data[offset], data[offset + 1], data[offset + 2]],
    palette,
  );
  return Math.max(1, Math.min(255, Math.round(fit.alpha * 255)));
}

function alphaSmoothness(image) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    if (alpha > 0 && alpha < 255) {
      counts[alpha] += 1;
    }
  }

  const values = [];
  let semiTransparentPixels = 0;
  for (let alpha = 1; alpha < 255; alpha += 1) {
    const count = counts[alpha];
    if (count > 0) {
      values.push(alpha);
      semiTransparentPixels += count;
    }
  }

  let maxUniqueAlphaGap = 0;
  for (let index = 1; index < values.length; index += 1) {
    maxUniqueAlphaGap = Math.max(
      maxUniqueAlphaGap,
      values[index] - values[index - 1],
    );
  }

  const topAlphaBuckets = values
    .map((alpha) => ({ alpha, pixels: counts[alpha] }))
    .sort((a, b) => b.pixels - a.pixels || a.alpha - b.alpha)
    .slice(0, 8);

  return {
    semiTransparentPixels,
    distinctSemiAlphaValues: values.length,
    minSemiAlpha: values[0] ?? null,
    maxSemiAlpha: values[values.length - 1] ?? null,
    maxUniqueAlphaGap,
    topAlphaBuckets,
  };
}

function sampleCrossSections(beforeMask, afterMask, width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let hasInk = false;
    for (let x = 0; x < width; x += 1) {
      if (beforeMask[y * width + x]) {
        hasInk = true;
        break;
      }
    }
    if (hasInk) {
      rows.push(y);
    }
  }
  if (rows.length === 0) {
    return [];
  }
  const sampleRows = [
    rows[0],
    rows[Math.floor(rows.length * 0.25)],
    rows[Math.floor(rows.length * 0.5)],
    rows[Math.floor(rows.length * 0.75)],
    rows[rows.length - 1],
  ];
  return [...new Set(sampleRows)].map((y) => {
    const before = rowSegments(beforeMask, width, y);
    const after = rowSegments(afterMask, width, y);
    return {
      y,
      beforeWidths: before.map((segment) => segment.width),
      afterWidths: after.map((segment) => segment.width),
      equal: JSON.stringify(before) === JSON.stringify(after),
    };
  });
}

function rowSegments(mask, width, y) {
  const segments = [];
  let start = -1;
  for (let x = 0; x < width; x += 1) {
    const on = mask[y * width + x] === 1;
    if (on && start < 0) {
      start = x;
    }
    if ((!on || x === width - 1) && start >= 0) {
      const end = on && x === width - 1 ? x : x - 1;
      segments.push({ x: start, width: end - start + 1 });
      start = -1;
    }
  }
  return segments;
}

function makePreview(before, after) {
  const gap = 16;
  const panels = [
    compositeOnBackground(before, PREVIEW_BACKGROUNDS.dark),
    compositeOnBackground(after, PREVIEW_BACKGROUNDS.dark),
    compositeOnBackground(before, PREVIEW_BACKGROUNDS.mid),
    compositeOnBackground(after, PREVIEW_BACKGROUNDS.mid),
  ];
  const width = before.width * panels.length + gap * (panels.length + 1);
  const height = before.height + gap * 2;
  const data = Buffer.alloc(width * height * 4);
  data.fill(255);

  for (let index = 0; index < panels.length; index += 1) {
    const panel = panels[index];
    const x0 = gap + index * (before.width + gap);
    blit(panel, data, width, x0, gap);
  }
  return { width, height, data };
}

function compositeOnBackground(image, bg) {
  const data = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3] / 255;
    data[i] = Math.round(image.data[i] * alpha + bg[0] * (1 - alpha));
    data[i + 1] = Math.round(image.data[i + 1] * alpha + bg[1] * (1 - alpha));
    data[i + 2] = Math.round(image.data[i + 2] * alpha + bg[2] * (1 - alpha));
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

function blit(source, dest, destWidth, x0, y0) {
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const destStart = ((y0 + y) * destWidth + x0) * 4;
    source.data.copy(dest, destStart, sourceStart, sourceStart + source.width * 4);
  }
}

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Not a PNG file');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (
        bitDepth !== 8 ||
        colorType !== 6 ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error(
          `Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`,
        );
      }
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || idatParts.length === 0) {
    throw new Error('PNG is missing IHDR or IDAT chunks');
  }

  const inflated = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const data = Buffer.alloc(width * height * 4);
  let inOffset = 0;
  let outOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inOffset];
    inOffset += 1;
    const row = Buffer.from(inflated.subarray(inOffset, inOffset + stride));
    inOffset += stride;
    unfilterRow(row, previous, filter, 4);
    row.copy(data, outOffset);
    previous = row;
    outOffset += stride;
  }

  return { width, height, data };
}

function unfilterRow(row, previous, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    if (filter === 1) {
      row[i] = (row[i] + left) & 0xff;
    } else if (filter === 2) {
      row[i] = (row[i] + up) & 0xff;
    } else if (filter === 3) {
      row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter type ${filter}`);
    }
  }
}

function encodePng(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  const stride = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    const rawOffset = y * (stride + 1);
    raw[rawOffset] = 0;
    image.data.copy(raw, rawOffset + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdrData(image.width, image.height)),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function ihdrData(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  if (pb <= pc) {
    return up;
  }
  return upLeft;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function median(values) {
  if (values.length === 0) {
    return 1;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function colorDistance(a, b) {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2,
  );
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function assertSameDimensions(before, after, target, group) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      [
        `Cannot apply ${group.name} canonical PNG to ${target.name}:`,
        `target=${before.width}x${before.height}`,
        `canonical=${after.width}x${after.height}`,
      ].join(' '),
    );
  }
}

function pctDelta(next, prev) {
  if (prev === 0) {
    return next === 0 ? 0 : 100;
  }
  return round3(((next - prev) / prev) * 100);
}

function rgbHex(rgb) {
  return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function printSummary(report) {
  for (const target of report.targets) {
    console.log(
      [
        target.name,
        target.dimensions,
        `unblended=${target.unblendedPixels}`,
        `matteLike ${target.matteLikeNonTransparentBefore}->${target.matteLikeNonTransparentAfter}`,
        `inferredAlphaDelta=${target.inferredAlphaDeltaPct}%`,
        `rawAlphaDelta=${target.rawAlphaDeltaPct}%`,
      ].join(' | '),
    );
  }
  console.log(`report=${join(EVIDENCE_DIR, 'defringe-report.json')}`);
}

main();
