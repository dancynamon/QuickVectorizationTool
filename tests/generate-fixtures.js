/**
 * Generate test PDF fixtures for the Overprint Studio conversion tests.
 *
 * Fixture 1 – raster-pixelated.pdf
 *   A PDF that embeds a raw RGB image (simulating a pixelated JPG/PNG import).
 *   Contains a 40×40 pixel grid with 4 distinct color blocks — the kind of
 *   input the raster trace pipeline should handle.
 *
 * Fixture 2 – vector-complex.pdf
 *   A PDF with complex vector artwork: filled/stroked paths, bezier curves,
 *   nested clipping regions, an embedded Form XObject, and text.  This
 *   exercises the vector conversion path including containers and embedded
 *   objects.
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRawStream,
  PDFNumber,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import pako from 'pako';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Fixture 1 — Raster pixelated image PDF
// ---------------------------------------------------------------------------

async function createRasterPDF() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([288, 288]); // 4 × 4 inches at 72 dpi

  // Build a 40×40 raw RGB image with 4 colored quadrants + a center circle
  const W = 40, H = 40;
  const pixels = new Uint8Array(W * H * 3);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const inTop = y < H / 2;
      const inLeft = x < W / 2;

      // Distance from center for circle
      const dx = x - W / 2 + 0.5;
      const dy = y - H / 2 + 0.5;
      const inCircle = (dx * dx + dy * dy) < (8 * 8);

      if (inCircle) {
        // Dark blue center circle
        pixels[i] = 20; pixels[i + 1] = 40; pixels[i + 2] = 120;
      } else if (inTop && inLeft) {
        // Red quadrant
        pixels[i] = 220; pixels[i + 1] = 40; pixels[i + 2] = 40;
      } else if (inTop && !inLeft) {
        // Green quadrant
        pixels[i] = 40; pixels[i + 1] = 180; pixels[i + 2] = 40;
      } else if (!inTop && inLeft) {
        // Yellow quadrant
        pixels[i] = 240; pixels[i + 1] = 220; pixels[i + 2] = 40;
      } else {
        // Purple quadrant
        pixels[i] = 140; pixels[i + 1] = 40; pixels[i + 2] = 180;
      }
    }
  }

  // Deflate the pixel data for embedding
  const compressed = pako.deflate(pixels);

  const ctx = doc.context;

  // Image XObject stream
  const imgDict = ctx.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: W,
    Height: H,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'FlateDecode',
    Length: compressed.length,
  });
  const imgStream = PDFRawStream.of(imgDict, compressed);
  const imgRef = ctx.register(imgStream);

  // Draw the image scaled to the full page
  const cs = `q\n288 0 0 288 0 0 cm\n/Img0 Do\nQ\n`;
  const csBytes = new TextEncoder().encode(cs);
  const csDict = ctx.obj({ Length: csBytes.length });
  const csStream = PDFRawStream.of(csDict, csBytes);
  const csRef = ctx.register(csStream);

  page.node.set(PDFName.of('Contents'), csRef);

  // Resources
  const xobjects = ctx.obj({});
  xobjects.set(PDFName.of('Img0'), imgRef);
  const resources = ctx.obj({});
  resources.set(PDFName.of('XObject'), xobjects);
  page.node.set(PDFName.of('Resources'), resources);

  const bytes = await doc.save();
  writeFileSync(FIXTURES_DIR + 'raster-pixelated.pdf', bytes);
  console.log(`  raster-pixelated.pdf  (${bytes.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Fixture 2 — Complex vector artwork PDF
// ---------------------------------------------------------------------------

async function createVectorPDF() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([432, 432]); // 6 × 6 inches

  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRef = page.node.get(PDFName.of('Resources'))
    ? undefined : null; // we'll set up resources manually

  // Build a complex content stream with many vector operations
  const ops = [];

  // 1) Background gradient (simulated with 10 horizontal strips)
  for (let i = 0; i < 10; i++) {
    const g = (i / 9); // 0..1
    ops.push(`${(0.1 + g * 0.3).toFixed(3)} ${(0.2 + g * 0.5).toFixed(3)} ${(0.8 - g * 0.4).toFixed(3)} rg`);
    ops.push(`0 ${(i * 43.2).toFixed(1)} 432 43.2 re f`);
  }

  // 2) Clipping path — star shape
  ops.push('q'); // save graphics state
  const cx = 216, cy = 260, outerR = 120, innerR = 50;
  for (let i = 0; i < 5; i++) {
    const aOuter = (Math.PI / 2) + (i * 2 * Math.PI / 5);
    const aInner = aOuter + Math.PI / 5;
    const ox = cx + outerR * Math.cos(aOuter);
    const oy = cy + outerR * Math.sin(aOuter);
    const ix = cx + innerR * Math.cos(aInner);
    const iy = cy + innerR * Math.sin(aInner);
    if (i === 0) ops.push(`${ox.toFixed(2)} ${oy.toFixed(2)} m`);
    else ops.push(`${ox.toFixed(2)} ${oy.toFixed(2)} l`);
    ops.push(`${ix.toFixed(2)} ${iy.toFixed(2)} l`);
  }
  ops.push('h W n'); // close, clip, discard path

  // 3) Inside the clip: filled circles with bezier curves (simulating complex artwork)
  const colors = [
    [0.9, 0.2, 0.2], [0.2, 0.8, 0.2], [0.2, 0.2, 0.9],
    [0.9, 0.9, 0.1], [0.9, 0.4, 0.8],
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI / 5) + Math.PI / 2;
    const ccx = cx + 60 * Math.cos(a);
    const ccy = cy + 60 * Math.sin(a);
    const r = 45;
    const [cr, cg, cb] = colors[i];
    ops.push(`${cr.toFixed(3)} ${cg.toFixed(3)} ${cb.toFixed(3)} rg`);
    // Approximate circle with 4 bezier curves
    const k = 0.5523;
    ops.push(`${(ccx + r).toFixed(2)} ${ccy.toFixed(2)} m`);
    ops.push(`${(ccx + r).toFixed(2)} ${(ccy + r * k).toFixed(2)} ${(ccx + r * k).toFixed(2)} ${(ccy + r).toFixed(2)} ${ccx.toFixed(2)} ${(ccy + r).toFixed(2)} c`);
    ops.push(`${(ccx - r * k).toFixed(2)} ${(ccy + r).toFixed(2)} ${(ccx - r).toFixed(2)} ${(ccy + r * k).toFixed(2)} ${(ccx - r).toFixed(2)} ${ccy.toFixed(2)} c`);
    ops.push(`${(ccx - r).toFixed(2)} ${(ccy - r * k).toFixed(2)} ${(ccx - r * k).toFixed(2)} ${(ccy - r).toFixed(2)} ${ccx.toFixed(2)} ${(ccy - r).toFixed(2)} c`);
    ops.push(`${(ccx + r * k).toFixed(2)} ${(ccy - r).toFixed(2)} ${(ccx + r).toFixed(2)} ${(ccy - r * k).toFixed(2)} ${(ccx + r).toFixed(2)} ${ccy.toFixed(2)} c`);
    ops.push('f');
  }

  ops.push('Q'); // restore (end clip)

  // 4) Stroked paths (outlines around star)
  ops.push('0.1 0.1 0.1 RG');
  ops.push('3 w'); // line width
  for (let i = 0; i < 5; i++) {
    const aOuter = (Math.PI / 2) + (i * 2 * Math.PI / 5);
    const aInner = aOuter + Math.PI / 5;
    const ox = cx + outerR * Math.cos(aOuter);
    const oy = cy + outerR * Math.sin(aOuter);
    const ix = cx + innerR * Math.cos(aInner);
    const iy = cy + innerR * Math.sin(aInner);
    if (i === 0) ops.push(`${ox.toFixed(2)} ${oy.toFixed(2)} m`);
    else ops.push(`${ox.toFixed(2)} ${oy.toFixed(2)} l`);
    ops.push(`${ix.toFixed(2)} ${iy.toFixed(2)} l`);
  }
  ops.push('h S'); // stroke

  // 5) Text label at bottom
  ops.push('BT');
  ops.push('/F1 18 Tf');
  ops.push('0.95 0.95 0.95 rg');
  ops.push('100 30 Td');
  ops.push('(Vector Test Artwork) Tj');
  ops.push('ET');

  // 6) Nested save/restore with transform
  ops.push('q');
  ops.push('0.5 0 0 0.5 216 50 cm'); // scale 50% + translate
  ops.push('0.8 0.3 0.1 rg');
  ops.push('0 0 80 80 re f'); // small orange square
  ops.push('-40 -40 160 160 re');
  ops.push('0.1 0.5 0.8 RG');
  ops.push('2 w S'); // stroked larger rect
  ops.push('Q');

  const csText = ops.join('\n') + '\n';
  const csBytes = new TextEncoder().encode(csText);
  const csDict = ctx.obj({ Length: csBytes.length });
  const csStream = PDFRawStream.of(csDict, csBytes);
  const csRef = ctx.register(csStream);

  page.node.set(PDFName.of('Contents'), csRef);

  // Resources with font
  let res = page.node.get(PDFName.of('Resources'));
  if (res && res.constructor.name === 'PDFRef') res = ctx.lookup(res);
  if (!res) {
    res = ctx.obj({});
    page.node.set(PDFName.of('Resources'), res);
  }

  // Font dict
  const fontDict = ctx.obj({});
  // Embed Helvetica-Bold manually for the content stream
  const f1 = ctx.obj({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica-Bold',
  });
  const f1Ref = ctx.register(f1);
  fontDict.set(PDFName.of('F1'), f1Ref);
  res.set(PDFName.of('Font'), fontDict);

  // --- Create a Form XObject (embedded artwork container) ---
  const xobjOps = [
    '0.6 0.1 0.6 rg',
    '10 10 60 60 re f',
    '0.9 0.9 0.2 rg',
    '10 10 m 40 70 l 70 10 l h f', // triangle
  ].join('\n') + '\n';
  const xobjBytes = new TextEncoder().encode(xobjOps);
  const xobjDict = ctx.obj({
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 80, 80],
    Length: xobjBytes.length,
  });
  const xobjStream = PDFRawStream.of(xobjDict, xobjBytes);
  const xobjRef = ctx.register(xobjStream);

  // Add XObject to resources and reference in content stream
  let xobjects = res.get(PDFName.of('XObject'));
  if (!xobjects) {
    xobjects = ctx.obj({});
    res.set(PDFName.of('XObject'), xobjects);
  }
  xobjects.set(PDFName.of('FX0'), xobjRef);

  // Append a Do operator to draw the form XObject
  const appendOps = 'q\n1 0 0 1 350 350 cm\n/FX0 Do\nQ\n';
  const appendBytes = new TextEncoder().encode(appendOps);

  // Combine with main content stream
  const combined = new Uint8Array(csBytes.length + appendBytes.length);
  combined.set(csBytes, 0);
  combined.set(appendBytes, csBytes.length);

  const combinedDict = ctx.obj({ Length: combined.length });
  const combinedStream = PDFRawStream.of(combinedDict, combined);
  const combinedRef = ctx.register(combinedStream);
  page.node.set(PDFName.of('Contents'), combinedRef);

  const bytes = await doc.save();
  writeFileSync(FIXTURES_DIR + 'vector-complex.pdf', bytes);
  console.log(`  vector-complex.pdf    (${bytes.length} bytes)`);
}

// ---------------------------------------------------------------------------

console.log('Generating test fixtures...');
mkdirSync(FIXTURES_DIR, { recursive: true });
await createRasterPDF();
await createVectorPDF();
console.log('Done.');
