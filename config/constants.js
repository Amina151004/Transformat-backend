import path from 'path';

// ---------------------------------------------------------------------
// Filesystem paths
// ---------------------------------------------------------------------
export const UPLOAD_DIR = path.resolve('uploads');
export const CONVERTED_DIR = path.resolve('converted');

// ---------------------------------------------------------------------
// Supported conversion formats
// ---------------------------------------------------------------------
export const DOCUMENT_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];
export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg'];
export const ALLOWED_FORMATS = [...DOCUMENT_FORMATS, ...IMAGE_FORMATS];

// Maps our accepted extensions to the real MIME type file-type should
// detect from the file's actual bytes -- never trust the extension or
// the client-supplied Content-Type, both are trivially spoofable.
// Legacy .doc/.ppt are OLE compound files (not modern zip-based Office
// formats), and file-type reports those as 'application/x-cfb' rather
// than anything doc/ppt-specific, so we accept that generic signature
// for them -- it still rules out someone renaming an .exe or .pdf to
// .doc, just not a renamed .doc to .ppt (both are OLE-based).
export const EXPECTED_MIME_BY_EXT = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  doc: ['application/x-cfb'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ppt: ['application/x-cfb'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
};

// Only allow simple alphanumeric extensions. Anything else -- path
// traversal attempts, shell metacharacters, null bytes, unicode
// tricks, multiple dots -- is stripped rather than trusted, since
// this string becomes part of a filename that later gets
// interpolated into a shell command via exec() (LibreOffice,
// pdf2docx). Never build a shell command from raw user input.
export const SAFE_EXT_REGEX = /^[a-zA-Z0-9]+$/;

// ---------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------

// Render's free plan gives the whole process 512MB of RAM. LibreOffice
// and sharp can use several times an input file's size in memory during
// conversion, so this cap is deliberately conservative -- it's not about
// storage (nothing is persisted; see the cleanup sweep in
// services/cleanup.js), it's about not OOM-killing the dyno on a
// single request.
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Safety net on top of the explicit fs.unlink() calls throughout
// /convert. Those cover every failure path we can actually catch, but
// some things slip past any try/catch entirely -- a Multer upload
// rejected for exceeding MAX_FILE_SIZE_BYTES can leave a partial file
// on disk with no req.file reference to clean it up by, and a server
// crash or client disconnect mid-request leaves whatever existed at
// that instant. See services/cleanup.js for the sweep that uses these.
export const STALE_FILE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run every 5 minutes
