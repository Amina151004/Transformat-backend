import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.resolve('uploads');
const CONVERTED_DIR = path.resolve('converted');

const ALLOWED_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];

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

// Temporary debug endpoint — remove once conversion is fixed.
app.get('/debug/mem', (req, res) => {
  const used = process.memoryUsage();
  res.json({
    rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
    freeSystemMemMB: Math.round(os.freemem() / 1024 / 1024),
    totalSystemMemMB: Math.round(os.totalmem() / 1024 / 1024),
  });
});

app.post('/convert', upload.single('file'), (req, res) => {
  const inputFile = req.file;
  const targetFormat = req.body.to;

  if (!inputFile) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
  }
  if (!targetFormat || !ALLOWED_FORMATS.includes(targetFormat)) {
    return res.status(400).json({ error: `"to" must be one of: ${ALLOWED_FORMATS.join(', ')}` });
  }

  const inputPath = inputFile.path;

  const command = `libreoffice --headless --norestore -env:UserInstallation=file:///tmp/lo_profile --convert-to ${targetFormat} --outdir ${CONVERTED_DIR} ${inputPath}`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
    console.log('Command:', command);
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);

    if (error) {
      console.error('Conversion exec error:', error.message);
      return res.status(500).json({ error: 'Conversion failed' });
    }

    const inputExt = path.extname(inputPath);
    const inputBaseName = path.basename(inputPath, inputExt);
    const outputFileName = `${inputBaseName}.${targetFormat}`;
    const outputPath = path.join(CONVERTED_DIR, outputFileName);

    if (!fs.existsSync(outputPath)) {
      console.error('Expected output at:', outputPath);
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