import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';
import { Document, Packer, Paragraph, ImageRun } from 'docx';
import pptxgen from 'pptxgenjs';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.resolve('uploads');
const CONVERTED_DIR = path.resolve('converted');

const DOCUMENT_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];
const IMAGE_FORMATS = ['png', 'jpg', 'jpeg'];
const ALLOWED_FORMATS = [...DOCUMENT_FORMATS, ...IMAGE_FORMATS];

// --- Supabase (service role client — bypasses RLS, used only server-side) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

// Verifies the Supabase access token the Flutter app sends and attaches
// the user id to the request. Runs before /convert does anything else.
function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), SUPABASE_JWT_SECRET, {
      audience: 'authenticated',
    });
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// What each source extension can actually convert to.
//
// docx/pptx <-> each other and pdf -> pptx are intentionally excluded:
// there's no reliable free path that reconstructs editable text/shapes
// across those format families. LibreOffice's PDF/PPTX import for this
// direction is Draw-based with no export filter to Writer/Impress, and
// no equivalent free library exists (unlike pdf2docx for PDF->Writer).
// Revisit if a paid API (CloudConvert/Adobe) is ever wired in.
function getValidTargets(sourceExt) {
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// ---------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------

// Embed an image as a full page in a new Word document.
async function imageToDocx(inputPath, outputPath) {
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
async function imageToPptx(inputPath, outputPath) {
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

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

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

app.post('/convert', upload.single('file'), requireUser, async (req, res) => {
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

  // --- Usage check: verifies the plan/limit and atomically increments
  // the counter before doing any conversion work. ---
  const { data: allowed, error: usageError } = await supabase.rpc(
    'increment_usage_if_allowed',
    { p_user_id: req.userId }
  );

  if (usageError) {
    console.error('Usage check failed:', usageError.message);
    fs.unlink(inputPath, () => {});
    return res.status(500).json({ error: 'Usage check failed' });
  }
  if (!allowed) {
    fs.unlink(inputPath, () => {});
    return res.status(403).json({ error: 'Monthly conversion limit reached', code: 'LIMIT_REACHED' });
  }

  const isImageToImage = IMAGE_FORMATS.includes(inputExt) && IMAGE_FORMATS.includes(targetFormat);
  const isImageToDocx = IMAGE_FORMATS.includes(inputExt) && ['docx', 'doc'].includes(targetFormat);
  const isImageToPptx = IMAGE_FORMATS.includes(inputExt) && ['pptx', 'ppt'].includes(targetFormat);
  const isPdfToWord = inputExt === 'pdf' && ['docx', 'doc'].includes(targetFormat);

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

  // --- Image -> DOCX: embed image full-page in a new Word doc ---
  if (isImageToDocx) {
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(CONVERTED_DIR, `${inputBaseName}.docx`);
    try {
      await imageToDocx(inputPath, outputPath);
      return res.download(outputPath, 'converted.docx', () => {
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
    } catch (err) {
      console.error('image->docx conversion failed:', err.message);
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Image to DOCX conversion failed' });
    }
  }

  // --- Image -> PPTX: embed image full-slide in a new PowerPoint file ---
  if (isImageToPptx) {
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(CONVERTED_DIR, `${inputBaseName}.pptx`);
    try {
      await imageToPptx(inputPath, outputPath);
      return res.download(outputPath, 'converted.pptx', () => {
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
    } catch (err) {
      console.error('image->pptx conversion failed:', err.message);
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: 'Image to PPTX conversion failed' });
    }
  }

  // --- PDF -> DOCX/DOC: handled by the pdf2docx Python sidecar script ---
  if (isPdfToWord) {
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const outputFileName = `${inputBaseName}.docx`; // pdf2docx only writes .docx
    const outputPath = path.join(CONVERTED_DIR, outputFileName);

    const pyCommand = `/opt/pdf2docx-venv/bin/python3 convert_pdf.py "${inputPath}" "${outputPath}"`;

    exec(pyCommand, { timeout: 120000 }, (error, stdout, stderr) => {
      console.log('PDF->DOCX command:', pyCommand);
      console.log('stdout:', stdout);
      console.log('stderr:', stderr);

      if (error) {
        console.error('pdf2docx conversion failed:', error.message);
        fs.unlink(inputPath, () => {});
        return res.status(500).json({ error: 'PDF to DOCX conversion failed' });
      }

      if (!fs.existsSync(outputPath)) {
        console.error('Expected output at:', outputPath);
        fs.unlink(inputPath, () => {});
        return res.status(500).json({ error: 'Converted file not found' });
      }

      // targetFormat may be "doc" -- we still hand back a .docx file either way,
      // since pdf2docx doesn't produce legacy .doc
      res.download(outputPath, 'converted.docx', () => {
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
    });
    return; // stop here, don't fall through to the LibreOffice block
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