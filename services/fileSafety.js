import { fileTypeFromFile } from 'file-type';
import { EXPECTED_MIME_BY_EXT } from '../config/constants.js';

// Reads the file's actual magic bytes and checks them against what its
// extension claims to be. Returns true if they match (or if the
// extension has no signature to check, which shouldn't happen given
// ALLOWED_FORMATS, but fails closed just in case). This protects
// against someone renaming an arbitrary file (e.g. an executable) to
// look like an accepted extension before uploading it.
export async function verifyMimeMatchesExtension(filePath, ext) {
  const expected = EXPECTED_MIME_BY_EXT[ext];
  if (!expected) return false;

  const detected = await fileTypeFromFile(filePath);
  if (!detected) return false; // couldn't sniff a signature at all -- reject

  return expected.includes(detected.mime);
}
