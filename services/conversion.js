import fs from 'fs';
import sharp from 'sharp';
import { Document, Packer, Paragraph, ImageRun } from 'docx';
import pptxgen from 'pptxgenjs';
import { IMAGE_FORMATS } from '../config/constants.js';

// What each source extension can actually convert to.
//
// docx/pptx <-> each other and pdf -> pptx are intentionally excluded:
// there's no reliable free path that reconstructs editable text/shapes
// across those format families. LibreOffice's PDF/PPTX import for this
// direction is Draw-based with no export filter to Writer/Impress, and
// no equivalent free library exists (unlike pdf2docx for PDF->Writer).
// Revisit if a paid API (CloudConvert/Adobe) is ever wired in.
export function getValidTargets(sourceExt) {
  const ext = sourceExt.toLowerCase().replace('.', '');

  if (['docx', 'doc'].includes(ext)) {
    return ['pdf', 'png', 'jpeg'];
  }
  if (['pptx', 'ppt'].includes(ext)) {
    return ['pdf', 'png', 'jpeg'];
  }
  if (ext === 'pdf') {
    return ['png', 'jpeg', 'docx', 'doc']; // pptx intentionally excluded
  }
  if (IMAGE_FORMATS.includes(ext)) {
    return [...IMAGE_FORMATS.filter((f) => f !== ext), 'pdf', 'docx', 'pptx'];
  }
  return [];
}

// Embed an image as a full page in a new Word document.
export async function imageToDocx(inputPath, outputPath) {
  const imageBuffer = fs.readFileSync(inputPath);
  const metadata = await sharp(inputPath).metadata();

  // Fit inside a standard page area, keeping aspect ratio
  const maxWidth = 550;
  const maxHeight = 720;
  const ratio = Math.min(maxWidth / metadata.width, maxHeight / metadata.height, 1);
  const width = Math.round(metadata.width * ratio);
  const height = Math.round(metadata.height * ratio);

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new ImageRun({ data: imageBuffer, transformation: { width, height } })],
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// Embed an image as a full slide in a new PowerPoint file.
export async function imageToPptx(inputPath, outputPath) {
  const metadata = await sharp(inputPath).metadata();
  const pres = new pptxgen();
  const slide = pres.addSlide();

  const slideW = pres.width;  // inches, default 10
  const slideH = pres.height; // default 7.5

  const imgRatio = metadata.width / metadata.height;
  let w = slideW;
  let h = w / imgRatio;
  if (h > slideH) {
    h = slideH;
    w = h * imgRatio;
  }
  const x = (slideW - w) / 2;
  const y = (slideH - h) / 2;

  slide.addImage({ path: inputPath, x, y, w, h });
  await pres.writeFile({ fileName: outputPath });
}
