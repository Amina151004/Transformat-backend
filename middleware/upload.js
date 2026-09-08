import multer from 'multer';
import path from 'path';
import { UPLOAD_DIR, MAX_FILE_SIZE_BYTES, SAFE_EXT_REGEX } from '../config/constants.js';

function sanitizeExtension(originalName) {
  const rawExt = path.extname(originalName || '').replace('.', '').toLowerCase();
  return SAFE_EXT_REGEX.test(rawExt) ? rawExt : '';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust file.originalname directly -- it's fully attacker
    // controlled and this filename later gets interpolated into shell
    // commands (LibreOffice/pdf2docx via exec()). Only the sanitized
    // extension survives; the base name is always our own
    // Date.now()-random string, never anything from the client.
    const ext = sanitizeExtension(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext ? '.' + ext : ''}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// Wraps upload.single('file') so a Multer error (most importantly, the
// file-size limit) turns into a clean JSON response instead of an
// unhandled error reaching Express's default HTML error page.
export function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File too large. Max size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
        code: 'FILE_TOO_LARGE',
      });
    }
    if (err) {
      console.error('Upload error:', err.message);
      return res.status(400).json({ error: 'Upload failed' });
    }
    next();
  });
}
