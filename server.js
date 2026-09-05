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
import ws from 'ws';
import Stripe from 'stripe';
import { fileTypeFromFile } from 'file-type';
import rateLimit from 'express-rate-limit';


const app = express();
const PORT = process.env.PORT || 3000;

// Render sits behind a proxy (like most PaaS), so Express needs this to
// read the real client IP from X-Forwarded-For instead of seeing every
// request as coming from the proxy itself -- required for
// express-rate-limit to key by IP correctly.
app.set('trust proxy', 1);

const UPLOAD_DIR = path.resolve('uploads');
const CONVERTED_DIR = path.resolve('converted');

const DOCUMENT_FORMATS = ['pdf', 'docx', 'doc', 'pptx', 'ppt'];
const IMAGE_FORMATS = ['png', 'jpg', 'jpeg'];
const ALLOWED_FORMATS = [...DOCUMENT_FORMATS, ...IMAGE_FORMATS];

// Render's free plan gives the whole process 512MB of RAM. LibreOffice
// and sharp can use several times an input file's size in memory during
// conversion, so this cap is deliberately conservative -- it's not about
// storage (nothing is persisted; see UPLOAD_DIR/CONVERTED_DIR cleanup
// below), it's about not OOM-killing the dyno on a single request.
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Maps our accepted extensions to the real MIME type file-type should
// detect from the file's actual bytes -- never trust the extension or
// the client-supplied Content-Type, both are trivially spoofable.
// Legacy .doc/.ppt are OLE compound files (not modern zip-based Office
// formats), and file-type reports those as 'application/x-cfb' rather
// than anything doc/ppt-specific, so we accept that generic signature
// for them -- it still rules out someone renaming an .exe or .pdf to
// .doc, just not a renamed .doc to .ppt (both are OLE-based).
const EXPECTED_MIME_BY_EXT = {
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
const SAFE_EXT_REGEX = /^[a-zA-Z0-9]+$/;

function sanitizeExtension(originalName) {
  const rawExt = path.extname(originalName || '').replace('.', '').toLowerCase();
  return SAFE_EXT_REGEX.test(rawExt) ? rawExt : '';
}

// General baseline across the whole API -- catches abuse of the
// lighter-weight routes (checkout, account deletion, etc). Generous
// since it's just a backstop, not the primary defense.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// /convert specifically spins up LibreOffice or a Python subprocess --
// by far the most expensive thing this server does, and on Render's
// free 512MB instance a burst of these could OOM the whole process.
// This is deliberately stricter than increment_usage_if_allowed's
// monthly quota: that guards against long-term overuse, this guards
// against short bursts hammering the machine within seconds/minutes,
// which the monthly counter alone wouldn't catch in time. Keyed by IP
// since it runs before requireUser resolves a user id.
const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many conversion requests. Please wait a bit and try again.', code: 'RATE_LIMITED' },
});

// --- Supabase (service role client — bypasses RLS, used only server-side) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Verifies the Supabase access token the Flutter app sends and attaches
// the user id to the request. Runs before /convert does anything else.
async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.slice(7);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = data.user.id;
  next();
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

// Reads the file's actual magic bytes and checks them against what its
// extension claims to be. Returns true if they match (or if the
// extension has no signature to check, which shouldn't happen given
// ALLOWED_FORMATS, but fails closed just in case). This protects
// against someone renaming an arbitrary file (e.g. an executable) to
// look like an accepted extension before uploading it.
async function verifyMimeMatchesExtension(filePath, ext) {
  const expected = EXPECTED_MIME_BY_EXT[ext];
  if (!expected) return false;

  const detected = await fileTypeFromFile(filePath);
  if (!detected) return false; // couldn't sniff a signature at all -- reject

  return expected.includes(detected.mime);
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

// Health checks (e.g. from Render itself, or uptime monitors) can be
// frequent -- skip the general limiter for it so monitoring never gets
// throttled.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use(generalLimiter);

app.get('/debug/mem', (req, res) => {
  const used = process.memoryUsage();
  res.json({
    rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
    freeSystemMemMB: Math.round(os.freemem() / 1024 / 1024),
    totalSystemMemMB: Math.round(os.totalmem() / 1024 / 1024),
  });
});

// convertLimiter runs before multer so an abusive burst gets rejected
// before any upload bytes are even accepted, not after paying the cost
// of receiving a large file.
app.post('/convert', convertLimiter, (req, res, next) => {
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
}, requireUser, async (req, res) => {
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
app.get('/checkout-success', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;">' +
    '<h2>Payment successful 🎉</h2><p>You can return to the app now.</p></body></html>'
  );
});

app.get('/checkout-cancel', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;">' +
    '<h2>Checkout canceled</h2><p>You can return to the app.</p></body></html>'
  );
});

// GET /reset-password
// This is what the "forgot password" email link points to -- NOT a
// custom URL scheme directly, because most email clients strip or
// refuse to render non-http(s) links, so Supabase's redirectTo needs
// to be a normal https URL.
//
// Supabase appends the recovery token to the URL fragment (the part
// after #), e.g. .../reset-password#access_token=...&type=recovery.
// Fragments are never sent to the server -- only the browser sees
// them -- so this page has to be a tiny bit of client-side JS that
// reads window.location.hash and forwards it into the app's own
// custom scheme, which is what actually reopens Transformat.
//
// You'll need to:
//   1. Register a custom URL scheme for the app (e.g. transformat://)
//      in AndroidManifest.xml and Info.plist.
//   2. Add a deep link listener in Flutter (e.g. via the app_links
//      package) that catches transformat://reset-password#... and
//      hands the fragment to Supabase to complete the recovery.
//   3. Add this exact page's URL to Supabase's Auth -> URL
//      Configuration -> Redirect URLs allowlist, and pass it as
//      `redirectTo` in AuthService.sendPasswordResetEmail().
app.get('/reset-password', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Resetting your password</title>
</head>
<body style="font-family:sans-serif;text-align:center;padding-top:60px;">
  <h2>Opening Transformat...</h2>
  <p>If nothing happens, make sure the Transformat app is installed.</p>
  <p><a id="fallback-link" href="#">Tap here to open the app</a></p>
  <script>
    // The recovery token lives in the fragment (#...), which never
    // reaches the server -- only this in-browser script can read it.
    var hash = window.location.hash; // includes the leading '#'
    var deepLink = 'transformat://reset-password' + hash;

    document.getElementById('fallback-link').href = deepLink;

    // Attempt an automatic redirect; the visible link above is the
    // fallback for browsers that block auto-redirects to custom schemes.
    window.location.href = deepLink;
  </script>
</body>
</html>`);
});

// Creates a Stripe Checkout session for the logged-in user and returns its URL.
app.post('/create-checkout-session', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;

    let customerId = profile.stripe_customer_id;

    // First-time upgrader: create a Stripe customer and remember it.
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { supabase_user_id: req.userId },
      });
      customerId = customer.id;

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', req.userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://transformat-backend.onrender.com/checkout-success',
      cancel_url: 'https://transformat-backend.onrender.com/checkout-cancel',
      metadata: { supabase_user_id: req.userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session creation failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// POST /cancel-subscription
// Sets the user's active subscription to cancel at the end of the
// current billing period, rather than cancelling immediately -- they
// keep Pro access through what they already paid for. The webhook
// handler below already listens for 'customer.subscription.updated'
// and 'customer.subscription.deleted' and calls
// syncSubscriptionToProfile, so profiles.plan flips to 'free' on its
// own once the period actually ends. No extra sync logic is needed here.
app.post('/cancel-subscription', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: 'active',
      limit: 1,
    });

    const subscription = subscriptions.data[0];
    if (!subscription) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Subscription cancellation failed:', err.message);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
});

// POST /billing-portal
// Returns a URL to Stripe's hosted Billing Portal, where the user can
// update their card, view invoices, etc. This is the actual fix for a
// failed payment -- pairs with the payment_failed flag on profiles:
// the app shows a warning when it's true, and this is where the
// "Update payment method" button sends them.
app.post('/billing-portal', express.json(), requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) throw profileError;
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: 'https://transformat-backend.onrender.com/checkout-success',
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Billing portal session creation failed:', err.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// DELETE /account
// Permanently deletes the caller's account. Best-effort cancels any
// active Stripe subscription first so they don't keep getting billed
// after their account is gone -- if that step fails, we log it and
// still proceed with deletion rather than trap the user who asked to
// leave, but you may want to alert yourself (e.g. via error logging)
// so you can refund/cancel manually if this ever fires.
app.delete('/account', requireUser, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .single();

    if (profileError) {
      console.error('Could not load profile before deletion:', profileError.message);
    }

    // Deleting a Stripe customer also cancels any subscriptions attached
    // to them, so this one call handles cleanup without needing to list
    // and cancel subscriptions individually.
    if (profile?.stripe_customer_id) {
      try {
        await stripe.customers.del(profile.stripe_customer_id);
      } catch (stripeErr) {
        console.error(
          `Stripe cleanup failed for user ${req.userId}, customer ${profile.stripe_customer_id}:`,
          stripeErr.message
        );
        // Continue anyway -- see comment above the route.
      }
    }

    // Deletes the auth.users row. If profiles/usage have a foreign key
    // to auth.users with ON DELETE CASCADE, their rows go with it.
    // Worth confirming that in Supabase -- if it's not set up, delete
    // from those tables explicitly here before this call.
    const { error: deleteError } = await supabase.auth.admin.deleteUser(req.userId);

    if (deleteError) {
      console.error('Account deletion failed:', deleteError.message);
      return res.status(500).json({ error: 'Could not delete account' });
    }

    return res.status(204).send();
  } catch (err) {
    console.error('Account deletion error:', err.message);
    return res.status(500).json({ error: 'Could not delete account' });
  }
});

// Keeps profiles.plan and profiles.pro_expires_at in sync with Stripe's
// view of the subscription, whatever triggered the event.
async function syncSubscriptionToProfile(subscription) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', subscription.customer)
    .single();

  if (!profile) return;

  const isActive = ['active', 'trialing'].includes(subscription.status);
  const expiresAt = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  await supabase
    .from('profiles')
    .update({
      plan: isActive ? 'pro' : 'free',
      pro_expires_at: isActive ? expiresAt : null,
    })
    .eq('id', profile.id);
}

// Flips profiles.payment_failed to true/false based on invoice events,
// so the app can show (or clear) a "update your payment method"
// warning. Looked up by customer id, same pattern as
// syncSubscriptionToProfile.
async function setPaymentFailed(customerId, failed) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!profile) return;

  await supabase
    .from('profiles')
    .update({ payment_failed: failed })
    .eq('id', profile.id);
}

// Stripe calls this when a payment or subscription event happens.
// express.raw is required here (not express.json) — Stripe's signature
// check needs the exact raw request body, not a parsed/re-serialized one.
// Placed after app.use(generalLimiter) in file order, but Stripe retries
// failed webhooks on its own schedule -- if you see missed events in
// Stripe's dashboard under load, exclude this route from the limiter too.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency check: Stripe retries webhooks on any non-200 response
  // (and sometimes just due to network flakiness on their end), so the
  // same event.id can arrive more than once. Recording it here means a
  // retry is recognized and skipped instead of reapplied.
  const { error: dedupeError } = await supabase
    .from('stripe_webhook_events')
    .insert({ event_id: event.id });

  if (dedupeError) {
    // Unique violation (code 23505) means we've already processed this
    // exact event -- that's expected on a retry, not a real error.
    // Anything else is a genuine DB problem and should surface as one.
    if (dedupeError.code === '23505') {
      return res.json({ received: true, duplicate: true });
    }
    console.error('Could not record webhook event, processing anyway:', dedupeError.message);
    // Fall through rather than block on a logging failure -- worst
    // case here is a duplicate is processed, not that a real payment
    // event gets dropped.
  }

  // Wrapped in try/catch so a transient failure (e.g. Supabase being
  // briefly unreachable) surfaces as a 500. Stripe interprets that as
  // "retry me later" and will keep trying for up to three days --
  // silently swallowing an error here would leave profiles.plan stale
  // with no way to recover short of a manual fix.
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        await syncSubscriptionToProfile(subscription);
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      await syncSubscriptionToProfile(event.data.object);
    }

    if (event.type === 'invoice.payment_failed') {
      // Stripe's own retry schedule (Smart Retries) will keep trying
      // the card automatically, and a subsequent
      // customer.subscription.updated event will flip profiles.plan
      // to 'free' once the subscription actually lapses to
      // past_due/unpaid. payment_failed is set immediately though, so
      // the app can warn the user well before that happens -- waiting
      // for the plan to actually lapse would be too late to help them
      // avoid it.
      const invoice = event.data.object;
      console.warn(
        `Payment failed for customer ${invoice.customer}, invoice ${invoice.id}`
      );
      await setPaymentFailed(invoice.customer, true);
    }

    if (event.type === 'invoice.payment_succeeded') {
      // Clears the warning once a payment actually goes through --
      // covers both "fixed their card and Stripe's retry succeeded"
      // and the normal case of every renewal that just works.
      const invoice = event.data.object;
      await setPaymentFailed(invoice.customer, false);
    }

    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook handler failed for event ${event.id} (${event.type}):`, err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Converter backend running on http://localhost:${PORT}`);
});