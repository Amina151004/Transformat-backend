import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.resolve('uploads');
const CONVERTED_DIR = path.resolve('converted');

const DOCUMENT_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];
const IMAGE_FORMATS = ['png', 'jpg', 'jpeg'];
const ALLOWED_FORMATS = [...DOCUMENT_FORMATS, ...IMAGE_FORMATS];

// What each source extension can actually convert to.
// PDF -> DOCX/DOC/PPTX/PPT is intentionally excluded: LibreOffice's
// PDF import is Draw-based on the version we're running, and Draw has
// no export filter to Writer/Impress formats. Revisit if LibreOffice
// is upgraded to a version with native "PDF as Writer" import.
function getValidTargets(sourceExt) {
  const ext = sourceExt.toLowerCase().replace('.', '');

  if (['docx', 'doc', 'pptx', 'ppt'].includes(ext)) {
    return ['pdf', 'png', 'jpeg'];
  }
  if (ext === 'pdf') {
    return ['png', 'jpeg'];
  }
  if (IMAGE_FORMATS.includes(ext)) {
    return [...IMAGE_FORMATS.filter((f) => f !== ext), 'pdf'];
  }
  return [];
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/debug/mem', (req, res) => {
  const used = process.memoryUsage();
  res.json({
    rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
    freeSystemMemMB: Math.round(os.freemem() / 1024 / 1024),
    totalSystemMemMB: Math.round(os.totalmem() / 1024 / 1024),
  });
});

app.post('/convert', upload.single('file'), async (req, res) => {
  const inputFile = req.file;
  const targetFormat = req.body.to?.toLowerCase();

  if (!inputFile) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
  }
  if (!targetFormat || !ALLOWED_FORMATS.includes(targetFormat)) {
    return res.status(400).json({ error: `"to" must be one of: ${ALLOWED_FORMATS.join(', ')}` });
  }

  const inputPath = inputFile.path;
  const inputExt = path.extname(inputPath).replace('.', '').toLowerCase();
  const validTargets = getValidTargets(inputExt);

  if (!validTargets.includes(targetFormat)) {
    fs.unlink(inputPath, () => {});
    return res.status(400).json({
      error: `Cannot convert ${inputExt} to ${targetFormat}`,
      supportedTargets: validTargets,
    });
  }

  const isImageToImage = IMAGE_FORMATS.includes(inputExt) && IMAGE_FORMATS.includes(targetFormat);

  // --- Image -> Image: handled directly with sharp, no LibreOffice needed ---
  if (isImageToImage) {
    const outputFileName = `${path.basename(inputPath, path.extname(inputPath))}.${targetFormat}`;
    const outputPath = path.join(CONVERTED_DIR, outputFileName);
    const sharpFormat = targetFormat === 'jpg' ? 'jpeg' : targetFormat;

    try {
      await sharp(inputPath).toFormat(sharpFormat).toFile(outputPath);
      return res.download(outputPath, `converted.${targetFormat}`, () => {
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
    } catch (err) {
      console.error('sharp conversion failed:', err.message);
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Image conversion failed' });
    }
  }

  // --- Everything else (documents, doc->pdf, doc/image->pdf, pdf->image): LibreOffice ---
  const command = `libreoffice --headless --norestore -env:UserInstallation=file:///tmp/lo_profile --convert-to ${targetFormat} --outdir ${CONVERTED_DIR} ${inputPath}`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
    console.log('Command:', command);
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);

    if (error) {
      console.error('Conversion exec error:', error.message);
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Conversion failed' });
    }

    const outFmt = targetFormat === 'jpg' ? 'jpg' : targetFormat;
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const outputFileName = `${inputBaseName}.${outFmt}`;
    const outputPath = path.join(CONVERTED_DIR, outputFileName);

    if (!fs.existsSync(outputPath)) {
      console.error('Expected output at:', outputPath);
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Converted file not found' });
    }

    res.download(outputPath, `converted.${targetFormat}`, () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  });
});

app.listen(PORT, () => {
  console.log(`Converter backend running on http://localhost:${PORT}`);
});