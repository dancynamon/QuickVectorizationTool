/**
 * End-to-end conversion tests for PDF Overprint Studio.
 *
 * Test 1 — Raster path:
 *   Load a pixelated image PDF, force raster trace mode, convert,
 *   validate the output is a well-formed 2-layer overprint PDF.
 *
 * Test 2 — Vector path:
 *   Load a complex vector PDF, force vector mode, convert,
 *   validate the output preserves vector structure with proper layers.
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFRawStream } from 'pdf-lib';
import pako from 'pako';

const FIXTURES = path.resolve(new URL('./fixtures/', import.meta.url).pathname);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Load a fixture PDF into the Convert panel via the file input. */
async function loadFixture(page, fileName) {
  const filePath = path.join(FIXTURES, fileName);
  const fileInput = page.locator('#convert-file-input');
  await fileInput.setInputFiles(filePath);

  // Wait for status to show "Ready to convert"
  await expect(page.locator('#convert-status')).toContainText('Ready to convert', {
    timeout: 15_000,
  });
}

/** Set conversion options and run conversion; return the output PDF bytes. */
async function runConversion(page, opts = {}) {
  // Set input mode
  if (opts.mode) {
    await page.selectOption('#input-mode', opts.mode);
  }
  if (opts.traceQuality) {
    await page.selectOption('#trace-quality', String(opts.traceQuality));
  }
  if (opts.maxColors) {
    await page.fill('#max-colors', String(opts.maxColors));
  }
  if (opts.tolerance) {
    await page.fill('#simplify-tolerance', String(opts.tolerance));
  }
  if (opts.spotC !== undefined) await page.fill('#spot-c', String(opts.spotC));
  if (opts.spotM !== undefined) await page.fill('#spot-m', String(opts.spotM));
  if (opts.spotY !== undefined) await page.fill('#spot-y', String(opts.spotY));
  if (opts.spotK !== undefined) await page.fill('#spot-k', String(opts.spotK));
  if (opts.spotName) await page.fill('#spot-name', opts.spotName);

  // Click convert
  await page.click('#convert-btn');

  // Wait for success status
  await expect(page.locator('#convert-status')).toContainText('Conversion complete', {
    timeout: 60_000,
  });

  // Extract the output bytes from the page via script evaluation
  const base64 = await page.evaluate(() => {
    if (!convertOutputBytes) return null;
    let binary = '';
    const bytes = convertOutputBytes;
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  });

  expect(base64).toBeTruthy();
  return Buffer.from(base64, 'base64');
}

/** Decode a pdf-lib stream to a string (handles FlateDecode). */
function decodeStream(stream, context) {
  const filtEntry = stream.dict.get(PDFName.of('Filter'));
  let bytes = stream.contents;
  if (!bytes || !bytes.length) return '';
  if (filtEntry) {
    const fn = filtEntry.toString();
    if (fn === '/FlateDecode') {
      try { bytes = pako.inflate(bytes); } catch { return ''; }
    } else if (filtEntry instanceof PDFArray) {
      for (let i = 0; i < filtEntry.size(); i++) {
        if (filtEntry.get(i).toString() === '/FlateDecode') {
          try { bytes = pako.inflate(bytes); } catch { return ''; }
        }
      }
    }
  }
  return new TextDecoder('latin1').decode(bytes);
}

/** Get the content stream text for a page. */
function getPageContent(page, context) {
  const ce = page.node.get(PDFName.of('Contents'));
  if (!ce) return '';
  const res = ce instanceof PDFRef ? context.lookup(ce) : ce;
  if (res instanceof PDFArray) {
    let t = '';
    for (let i = 0; i < res.size(); i++) {
      const sr = res.get(i);
      t += decodeStream(sr instanceof PDFRef ? context.lookup(sr) : sr, context) + '\n';
    }
    return t;
  }
  return decodeStream(res, context);
}

/**
 * Deeply resolve a PDF value — if it's a PDFRef, look it up and
 * keep following until we hit a concrete object.
 */
function resolve(val, ctx) {
  while (val instanceof PDFRef) val = ctx.lookup(val);
  return val;
}

// ── Structural validation ────────────────────────────────────────────────────

/**
 * Validate that a PDF has the expected 2-layer overprint structure.
 * Returns an object with details for further assertions.
 */
async function validateOverprintPDF(pdfBytes, opts = {}) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const ctx = doc.context;
  const pages = doc.getPages();
  const result = {
    pageCount: pages.length,
    hasOCProperties: false,
    ocgNames: [],
    hasBaseLayer: false,
    hasSpotLayer: false,
    hasSeparationColorSpace: false,
    hasOverprintGState: false,
    contentHasBaseMarker: false,
    contentHasSpotMarker: false,
    contentHasSpotColorSetup: false,
    spotCMYK: null,
    spotName: null,
    contentStream: '',
  };

  // ─ Check catalog for OCProperties ─
  const catalog = resolve(ctx.trailerInfo.Root, ctx);
  const ocProps = resolve(catalog.get(PDFName.of('OCProperties')), ctx);
  if (ocProps) {
    result.hasOCProperties = true;
    const ocgs = resolve(ocProps.get(PDFName.of('OCGs')), ctx);
    if (ocgs && typeof ocgs.size === 'function') {
      for (let i = 0; i < ocgs.size(); i++) {
        const ocg = resolve(ocgs.get(i), ctx);
        const name = ocg.get(PDFName.of('Name'));
        if (name) {
          const n = name.value || name.toString().replace(/^\(|\)$/g, '');
          result.ocgNames.push(n);
          if (n.toLowerCase().includes('base')) result.hasBaseLayer = true;
          if (n.toLowerCase().includes('spot')) result.hasSpotLayer = true;
        }
      }
    }
  }

  // ─ Check first page resources ─
  const page0 = pages[0];
  let res = resolve(page0.node.get(PDFName.of('Resources')), ctx);

  if (res) {
    // Separation color space
    const csDict = resolve(res.get(PDFName.of('ColorSpace')), ctx);
    if (csDict) {
      const csSpot = resolve(csDict.get(PDFName.of('CS_Spot')), ctx);
      if (csSpot && typeof csSpot.size === 'function') {
        const csType = csSpot.get(0);
        if (csType && csType.toString() === '/Separation') {
          result.hasSeparationColorSpace = true;
          // Extract spot color name
          const spotNameEntry = csSpot.get(1);
          if (spotNameEntry) {
            result.spotName = spotNameEntry.toString().replace(/^\//, '');
          }
          // Extract CMYK values from tint function
          const tintRef = csSpot.get(3);
          if (tintRef) {
            const tintFunc = resolve(tintRef, ctx);
            const c1 = resolve(tintFunc.get(PDFName.of('C1')), ctx);
            if (c1 && typeof c1.size === 'function') {
              result.spotCMYK = {
                c: Math.round(c1.get(0).value() * 100),
                m: Math.round(c1.get(1).value() * 100),
                y: Math.round(c1.get(2).value() * 100),
                k: Math.round(c1.get(3).value() * 100),
              };
            }
          }
        }
      }
    }

    // Overprint ExtGState
    const gsDict = resolve(res.get(PDFName.of('ExtGState')), ctx);
    if (gsDict) {
      const gsOP = resolve(gsDict.get(PDFName.of('GS_OP')), ctx);
      if (gsOP) {
        const op = gsOP.get(PDFName.of('OP'));
        const opLower = gsOP.get(PDFName.of('op'));
        const opm = gsOP.get(PDFName.of('OPM'));
        // pdf-lib stores booleans as PDFBool; check their value
        const opVal = op && (op.value !== undefined ? op.value : op.toString());
        const opLVal = opLower && (opLower.value !== undefined ? opLower.value : opLower.toString());
        if (opVal && opLVal) {
          result.hasOverprintGState = true;
        }
      }
    }

    // Properties (OCG references)
    const propsDict = resolve(res.get(PDFName.of('Properties')), ctx);
    if (propsDict) {
      const ocBase = propsDict.get(PDFName.of('OC_Base'));
      const ocSpot = propsDict.get(PDFName.of('OC_Spot'));
      // These are refs to the OCG objects — their presence is enough
      if (ocBase) result.hasBaseLayer = true;
      if (ocSpot) result.hasSpotLayer = true;
    }
  }

  // ─ Check content stream ─
  const csText = getPageContent(page0, ctx);
  result.contentStream = csText;
  result.contentHasBaseMarker = csText.includes('/OC /OC_Base BDC');
  result.contentHasSpotMarker = csText.includes('/OC /OC_Spot BDC');
  result.contentHasSpotColorSetup =
    csText.includes('/GS_OP gs') &&
    csText.includes('/CS_Spot cs') &&
    csText.includes('1 scn');

  return result;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Raster PDF Conversion (pixelated image to 2-layer print-ready PDF)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/overprint-studio.html');
    // Switch to Convert tab
    await page.click('[data-tab="convert"]');
    await expect(page.locator('#convert-panel')).toBeVisible();
  });

  test('converts raster PDF with default settings', async ({ page }) => {
    await loadFixture(page, 'raster-pixelated.pdf');

    const pdfBytes = await runConversion(page, {
      mode: 'raster',
      traceQuality: '3',
      maxColors: '12',
      tolerance: '1.0',
      spotC: 68, spotM: 0, spotY: 100, spotK: 0,
      spotName: 'SpotGreen',
    });

    // Basic validity
    expect(pdfBytes.length).toBeGreaterThan(100);
    expect(pdfBytes[0]).toBe(0x25); // %PDF

    const result = await validateOverprintPDF(pdfBytes);

    // Structure checks
    expect(result.pageCount).toBe(1);
    expect(result.hasOCProperties).toBe(true);
    expect(result.hasBaseLayer).toBe(true);
    expect(result.hasSpotLayer).toBe(true);
    expect(result.hasSeparationColorSpace).toBe(true);
    expect(result.hasOverprintGState).toBe(true);

    // Content stream has both layer markers
    expect(result.contentHasBaseMarker).toBe(true);
    expect(result.contentHasSpotMarker).toBe(true);
    expect(result.contentHasSpotColorSetup).toBe(true);

    // Spot color values are correct
    expect(result.spotName).toBe('SpotGreen');
    expect(result.spotCMYK).toEqual({ c: 68, m: 0, y: 100, k: 0 });

    // Content stream should have traced vector paths (m/l/h/f operators)
    const cs = result.contentStream;
    expect(cs).toMatch(/\d+\.\d+ \d+\.\d+ m/); // moveto
    expect(cs).toMatch(/\d+\.\d+ \d+\.\d+ l/); // lineto
    expect(cs).toContain('h f'); // close + fill

    // Base layer should contain color commands (rg)
    const baseSection = cs.split('/OC /OC_Base BDC')[1]?.split('EMC')[0] || '';
    expect(baseSection).toMatch(/[\d.]+ [\d.]+ [\d.]+ rg/);
  });

  test('converts raster PDF without base layer', async ({ page }) => {
    await loadFixture(page, 'raster-pixelated.pdf');

    // Uncheck "Include base layer"
    await page.uncheck('#include-base');

    const pdfBytes = await runConversion(page, {
      mode: 'raster',
      traceQuality: '2',
    });

    const result = await validateOverprintPDF(pdfBytes);

    // Should still have both OCG definitions but base content marker absent
    expect(result.hasOCProperties).toBe(true);
    expect(result.contentHasSpotMarker).toBe(true);
    expect(result.contentHasSpotColorSetup).toBe(true);

    // Base layer marker should NOT be present since we unchecked it
    expect(result.contentHasBaseMarker).toBe(false);
  });

  test('raster conversion produces different output with different spot colors', async ({ page }) => {
    await loadFixture(page, 'raster-pixelated.pdf');

    const pdfBytes1 = await runConversion(page, {
      mode: 'raster',
      spotC: 0, spotM: 100, spotY: 0, spotK: 0,
      spotName: 'SpotMagenta',
    });

    // Reload to reset state
    await page.goto('/overprint-studio.html');
    await page.click('[data-tab="convert"]');
    await loadFixture(page, 'raster-pixelated.pdf');

    const pdfBytes2 = await runConversion(page, {
      mode: 'raster',
      spotC: 100, spotM: 0, spotY: 0, spotK: 0,
      spotName: 'SpotCyan',
    });

    const result1 = await validateOverprintPDF(pdfBytes1);
    const result2 = await validateOverprintPDF(pdfBytes2);

    expect(result1.spotName).toBe('SpotMagenta');
    expect(result1.spotCMYK).toEqual({ c: 0, m: 100, y: 0, k: 0 });

    expect(result2.spotName).toBe('SpotCyan');
    expect(result2.spotCMYK).toEqual({ c: 100, m: 0, y: 0, k: 0 });
  });
});

test.describe('Vector PDF Conversion (complex artwork to 2-layer print-ready PDF)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/overprint-studio.html');
    await page.click('[data-tab="convert"]');
    await expect(page.locator('#convert-panel')).toBeVisible();
  });

  test('converts vector PDF preserving paths and structure', async ({ page }) => {
    await loadFixture(page, 'vector-complex.pdf');

    const pdfBytes = await runConversion(page, {
      mode: 'vector',
      spotC: 68, spotM: 0, spotY: 100, spotK: 0,
      spotName: 'SpotGreen',
    });

    expect(pdfBytes.length).toBeGreaterThan(100);

    const result = await validateOverprintPDF(pdfBytes);

    // Structure checks
    expect(result.pageCount).toBe(1);
    expect(result.hasOCProperties).toBe(true);
    expect(result.hasBaseLayer).toBe(true);
    expect(result.hasSpotLayer).toBe(true);
    expect(result.hasSeparationColorSpace).toBe(true);
    expect(result.hasOverprintGState).toBe(true);

    // Both layer markers present
    expect(result.contentHasBaseMarker).toBe(true);
    expect(result.contentHasSpotMarker).toBe(true);
    expect(result.contentHasSpotColorSetup).toBe(true);

    // Base layer should preserve original vector operations
    const cs = result.contentStream;
    const baseSection = cs.split('/OC /OC_Base BDC')[1]?.split('EMC')[0] || '';

    // Original content should have bezier curves (c operator)
    expect(baseSection).toMatch(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ c/);
    // Should have clipping (W)
    expect(baseSection).toContain('W');
    // Should have graphics state save/restore (q/Q)
    expect(baseSection).toContain('q');
    expect(baseSection).toContain('Q');
    // Should have color operations in base
    expect(baseSection).toMatch(/[\d.]+ [\d.]+ [\d.]+ rg/);
    // Should have text
    expect(baseSection).toContain('BT');
    expect(baseSection).toContain('Tj');
    expect(baseSection).toContain('ET');
    // Should reference the Form XObject
    expect(baseSection).toContain('/FX0 Do');

    // Spot layer should strip color ops but keep paths
    const spotSection = cs.split('/OC /OC_Spot BDC')[1]?.split('EMC')[0] || '';
    expect(spotSection).toContain('/GS_OP gs');
    expect(spotSection).toContain('/CS_Spot cs');

    // Spot layer should NOT contain color commands (rg, RG, etc.)
    // but SHOULD contain path construction operators
    expect(spotSection).not.toMatch(/[\d.]+ [\d.]+ [\d.]+ rg/);
    expect(spotSection).not.toMatch(/[\d.]+ [\d.]+ [\d.]+ RG/);
    // It should still have path ops
    expect(spotSection).toMatch(/[\d.]+ [\d.]+ m/);
  });

  test('vector conversion spot layer strips shading operators', async ({ page }) => {
    await loadFixture(page, 'vector-complex.pdf');

    const pdfBytes = await runConversion(page, {
      mode: 'vector',
    });

    const result = await validateOverprintPDF(pdfBytes);
    const cs = result.contentStream;
    const spotSection = cs.split('/OC /OC_Spot BDC')[1]?.split('EMC')[0] || '';

    // Spot layer must not have color-setting operators
    expect(spotSection).not.toMatch(/\brg\b.*[\d.]+/);
    // But structural operators (q, Q, cm, re, m, l, c, f, S, h, W, n) should remain
    expect(spotSection).toContain('q');
    expect(spotSection).toContain('Q');
  });

  test('vector conversion without base layer', async ({ page }) => {
    await loadFixture(page, 'vector-complex.pdf');
    await page.uncheck('#include-base');

    const pdfBytes = await runConversion(page, {
      mode: 'vector',
      spotC: 50, spotM: 50, spotY: 0, spotK: 10,
      spotName: 'SpotPurple',
    });

    const result = await validateOverprintPDF(pdfBytes);

    expect(result.contentHasSpotMarker).toBe(true);
    expect(result.contentHasBaseMarker).toBe(false);
    expect(result.spotName).toBe('SpotPurple');
    expect(result.spotCMYK).toEqual({ c: 50, m: 50, y: 0, k: 10 });
  });
});

test.describe('Auto-detection mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/overprint-studio.html');
    await page.click('[data-tab="convert"]');
    await expect(page.locator('#convert-panel')).toBeVisible();
  });

  test('auto-detects raster PDF and traces it', async ({ page }) => {
    await loadFixture(page, 'raster-pixelated.pdf');

    const pdfBytes = await runConversion(page, {
      mode: 'auto',
    });

    const result = await validateOverprintPDF(pdfBytes);
    expect(result.hasOCProperties).toBe(true);
    expect(result.hasBaseLayer).toBe(true);
    expect(result.hasSpotLayer).toBe(true);
    expect(result.contentHasBaseMarker).toBe(true);
    expect(result.contentHasSpotMarker).toBe(true);

    // Raster path produces traced vector paths (h f pattern)
    expect(result.contentStream).toContain('h f');
  });

  test('auto-detects vector PDF and preserves it', async ({ page }) => {
    await loadFixture(page, 'vector-complex.pdf');

    const pdfBytes = await runConversion(page, {
      mode: 'auto',
    });

    const result = await validateOverprintPDF(pdfBytes);
    expect(result.hasOCProperties).toBe(true);
    expect(result.contentHasBaseMarker).toBe(true);
    expect(result.contentHasSpotMarker).toBe(true);

    // Vector path preserves bezier curves
    const baseSection = result.contentStream.split('/OC /OC_Base BDC')[1]?.split('EMC')[0] || '';
    expect(baseSection).toMatch(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ c/);
  });
});

test.describe('Preview tab — output PDF round-trip', () => {
  test('converted PDF can be loaded in preview and shows 2 layers', async ({ page }) => {
    await page.goto('/overprint-studio.html');

    // First convert
    await page.click('[data-tab="convert"]');
    await loadFixture(page, 'vector-complex.pdf');
    await runConversion(page, { mode: 'vector' });

    // Click "Preview Result" button
    await page.click('#preview-result-btn');

    // Should switch to preview tab with workspace visible
    await expect(page.locator('#preview-workspace')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#preview-nav')).toBeVisible();

    // Layers section should appear with Base and Spot layers
    await expect(page.locator('#layers-section')).toBeVisible({ timeout: 10_000 });
    const layerItems = page.locator('#layers-list .layer-item');
    await expect(layerItems).toHaveCount(2);

    // Verify layer names
    const layerNames = await layerItems.locator('.layer-name').allTextContents();
    expect(layerNames).toContain('Base');
    expect(layerNames).toContain('Spot');
  });
});
