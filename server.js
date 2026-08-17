import express from 'express';
import multer from 'multer';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// Where uploaded files land, and where LibreOffice will drop the converted output.
const UPLOAD_DIR = path.resolve('uploads');
const CONVERTED_DIR = path.resolve('converted');

// Only allow converting TO these formats — keeps the API from running
// arbitrary LibreOffice commands.
const ALLOWED_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];

// multer needs to know where to save incoming files.
const upload = multer({ dest: UPLOAD_DIR });

// A simple "is this thing alive" route.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// The main endpoint. Expects:
//   - a file, sent as multipart form field "file"
//   - a target format, sent as form field "to" (e.g. "pdf")
app.post('/convert', upload.single('file'), (req, res) => {
  const inputFile = req.file;
  const targetFormat = req.body.to;

  // --- Basic validation before we run anything ---
  if (!inputFile) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
  }
  if (!targetFormat || !ALLOWED_FORMATS.includes(targetFormat)) {
    return res.status(400).json({ error: `"to" must be one of: ${ALLOWED_FORMATS.join(', ')}` });
  }

  const inputPath = inputFile.path;

  // LibreOffice headless command:
  // --headless        -> no GUI window
  // --convert-to X     -> target format
  // --outdir Y          -> where to write the result
  const command = `libreoffice --headless --convert-to ${targetFormat} --outdir ${CONVERTED_DIR} ${inputPath}`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('Conversion failed:', stderr);
      return res.status(500).json({ error: 'Conversion failed' });
    }

    // LibreOffice keeps the original filename and just swaps the extension.
    const outputFileName = path.basename(inputPath) + `.${targetFormat}`;
    const outputPath = path.join(CONVERTED_DIR, outputFileName);

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Converted file not found' });
    }

    // Send the converted file back, then clean up both temp files.
    res.download(outputPath, `converted.${targetFormat}`, () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
  });
});

app.listen(PORT, () => {
  console.log(`Converter backend running on http://localhost:${PORT}`);
});