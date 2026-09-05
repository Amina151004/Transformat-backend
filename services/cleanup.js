import fs from 'fs';
import path from 'path';
import { UPLOAD_DIR, CONVERTED_DIR, STALE_FILE_MAX_AGE_MS } from '../config/constants.js';

// Safety net on top of the explicit fs.unlink() calls throughout
// /convert. Those cover every failure path we can actually catch, but
// some things slip past any try/catch entirely -- a Multer upload
// rejected for exceeding the file-size limit can leave a partial file
// on disk with no req.file reference to clean it up by, and a server
// crash or client disconnect mid-request leaves whatever existed at
// that instant. This sweep periodically deletes anything older than
// STALE_FILE_MAX_AGE_MS from both directories, regardless of how it
// got there or why it wasn't cleaned up already.
export async function cleanupStaleFiles() {
  for (const dir of [UPLOAD_DIR, CONVERTED_DIR]) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      console.error(`Cleanup sweep: could not read ${dir}:`, err.message);
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      try {
        const stats = await fs.promises.stat(filePath);
        const age = Date.now() - stats.mtimeMs;
        if (age > STALE_FILE_MAX_AGE_MS) {
          await fs.promises.unlink(filePath);
          console.warn(`Cleanup sweep: removed stale file ${filePath} (age ${Math.round(age / 1000)}s)`);
        }
      } catch (err) {
        // ENOENT is expected if the file was already deleted by the
        // normal cleanup path between readdir and this stat/unlink --
        // that's a race, not a real error. Anything else gets logged.
        if (err.code !== 'ENOENT') {
          console.error(`Cleanup sweep: failed on ${filePath}:`, err.message);
        }
      }
    }
  }
}
