import { Router } from 'express';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

import { ALLOWED_FORMATS, IMAGE_FORMATS, CONVERTED_DIR } from '../config/constants.js';
import { convertLimiter } from '../middleware/rateLimiters.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { requireUser } from '../middleware/requireUser.js';
import { verifyMimeMatchesExtension } from '../services/fileSafety.js';
import { getValidTargets, imageToDocx, imageToPptx } from '../services/conversion.js';
import { supabase } from '../lib/clients.js';

const router = Router();

// convertLimiter runs before multer so an abusive burst gets rejected
// before any upload bytes are even accepted, not after paying the cost
// of receiving a large file.
router.post('/convert', convertLimiter, uploadSingleFile, requireUser, async (req, res) => {
  const inputFile = req.file;
  const targetFormat = req.body.to?.toLowerCase();

  if (!inputFile) {
    return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });
  }
  if (!targetFormat || !ALLOWED_FORMATS.includes(targetFormat)) {
    fs.unlink(inputFile.path, () => {});
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

  // --- MIME check: the extension says one thing, verify the actual
  // file bytes agree, before we burn a usage credit or hand this to
  // LibreOffice. ---
  try {
    const mimeOk = await verifyMimeMatchesExtension(inputPath, inputExt);
    if (!mimeOk) {
      fs.unlink(inputPath, () => {});
      return res.status(400).json({
        error: `File content does not match its extension (.${inputExt})`,
        code: 'MIME_MISMATCH',
      });
    }
  } catch (err) {
    console.error('MIME check failed:', err.message);
    fs.unlink(inputPath, () => {});
    return res.status(400).json({ error: 'Could not verify file type' });
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
      // sharp can write a partial/corrupt file before throwing, so
      // attempt cleanup here too rather than only on the success path.
      fs.unlink(outputPath, () => {});
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
      // Packer.toBuffer/writeFileSync can leave a partial .docx behind
      // if it fails midway, so clean that up too, not just the input.
      fs.unlink(outputPath, () => {});
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
      // pres.writeFile can leave a partial .pptx behind if it fails
      // midway, so clean that up too, not just the input.
      fs.unlink(outputPath, () => {});
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
        // The Python script can write a partial .docx before crashing,
        // so attempt cleanup here too rather than only on success.
        fs.unlink(outputPath, () => {});
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
  // Paths/format are quoted even though they're already sanitized
  // (server-generated filenames, whitelist-checked targetFormat) --
  // defense in depth against ever building a shell command from
  // unsanitized input in the future.
  const command = `libreoffice --headless --norestore -env:UserInstallation=file:///tmp/lo_profile --convert-to "${targetFormat}" --outdir "${CONVERTED_DIR}" "${inputPath}"`;

  exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
    console.log('Command:', command);
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);

    if (error) {
      console.error('Conversion exec error:', error.message);
      fs.unlink(inputPath, () => {});
      // LibreOffice can write a partial output file before failing
      // (e.g. hitting the timeout mid-conversion), so attempt cleanup
      // here too rather than only on the success path. The exact
      // output filename/extension isn't known this early in some
      // failure cases, but outFmt/outputPath below are computed from
      // inputs already validated earlier in the route, so it's safe
      // to compute them here as well for this cleanup attempt.
      const outFmtOnError = targetFormat === 'jpg' ? 'jpg' : targetFormat;
      const inputBaseNameOnError = path.basename(inputPath, path.extname(inputPath));
      const outputPathOnError = path.join(CONVERTED_DIR, `${inputBaseNameOnError}.${outFmtOnError}`);
      fs.unlink(outputPathOnError, () => {});
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

export default router;
