const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const { prisma, ContactStatus } = require('./prisma');
const { generateToken, comparePassword, hashPassword, authenticate } = require('./auth');
const { sendEmail } = require('./email');
const { renderTemplate, invalidateTemplate } = require('./templates-service');

require('dotenv').config();
const { Receiver, Client } = require('@upstash/qstash');

const qstashClient = new Client({ token: process.env.QSTASH_TOKEN || 'dummy' });
const qstashReceiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || 'dummy',
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || 'dummy',
});

// --- Rate Limit Settings for Email Sending (Human-like Random Delays) ---
const EMAIL_BATCH_SIZE = parseInt(process.env.EMAIL_BATCH_SIZE || '1', 10);
const EMAIL_BATCH_DELAY_MS = parseInt(process.env.EMAIL_BATCH_DELAY_MS || '0', 10);

function getRandomIndividualDelayMs() {
  const min = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MIN_MS || '20000', 10);
  const max = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MAX_MS || '30000', 10);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const app = express();
app.set('trust proxy', 1); // Trust Render reverse proxy for express-rate-limit X-Forwarded-For



// --- CORS Configuration ---
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (e.g. mobile apps, curl, Postman, server-to-server)
      if (!origin) return callback(null, true);

      // Dynamically allow all Vercel domains (*.vercel.app), Render domains, and localhost
      if (
        origin.endsWith('.vercel.app') ||
        origin.endsWith('.onrender.com') ||
        origin.includes('localhost') ||
        process.env.FRONTEND_URL === '*'
      ) {
        return callback(null, origin);
      }

      // Read FRONTEND_URL env var, split multiple origins, and auto-prefix missing https://
      if (process.env.FRONTEND_URL) {
        const allowedOrigins = process.env.FRONTEND_URL.split(',').map((item) => {
          let trimmed = item.trim();
          if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            trimmed = 'https://' + trimmed;
          }
          return trimmed;
        });

        if (allowedOrigins.includes(origin)) {
          return callback(null, origin);
        }
      }

      // Permissive fallback so cross-domain deployment never gets blocked
      return callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);


app.use(express.json());

// Multer: memory storage, 10 MB hard cap
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { message: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const batchLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  message: { message: 'Too many batch requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Unsubscribed list in-memory cache (5-minute TTL) ---
let _unsubscribedCache = null;
let _unsubscribedCacheTime = 0;
const UNSUB_CACHE_TTL_MS = 5 * 60 * 1000;

async function getUnsubscribedSet() {
  const now = Date.now();
  if (_unsubscribedCache && now - _unsubscribedCacheTime < UNSUB_CACHE_TTL_MS) {
    return _unsubscribedCache;
  }
  const rows = await prisma.unsubscribed.findMany({ select: { email: true } });
  _unsubscribedCache = new Set(rows.map((r) => r.email.toLowerCase()));
  _unsubscribedCacheTime = now;
  return _unsubscribedCache;
}

function invalidateUnsubscribedCache() {
  _unsubscribedCache = null;
  _unsubscribedCacheTime = 0;
}

// --- Valid upload status transitions ---
const VALID_TRANSITIONS = {
  idle: ['processing', 'scheduled'],
  scheduled: ['idle', 'processing', 'scheduled'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['idle'],
};

function assertCanTransition(current, next) {
  if (!VALID_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Cannot transition upload from '${current}' to '${next}'`);
  }
}

// --- Helper: aggregate upload stats in ONE query ---
async function recountUploadStats(uploadId) {
  const [statusRows, deliveryRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                          AS "totalRows",
        COUNT(*) FILTER (WHERE status = 'valid')::int         AS "validEmails",
        COUNT(*) FILTER (WHERE status = 'invalid')::int       AS "invalidEmails",
        COUNT(*) FILTER (WHERE status = 'duplicate')::int     AS "duplicateEmails",
        COUNT(*) FILTER (WHERE status = 'unsubscribed')::int  AS "unsubscribedEmails"
      FROM contacts
      WHERE upload_id = ${uploadId}
    `,
    prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE delivery_status = 'sent')::int     AS "sentCount",
        COUNT(*) FILTER (WHERE delivery_status = 'failed')::int   AS "failedCount",
        COUNT(*) FILTER (WHERE delivery_status = 'pending')::int  AS "pendingCount",
        COUNT(*) FILTER (WHERE delivery_status = 'skipped')::int  AS "skippedCount"
      FROM contacts
      WHERE upload_id = ${uploadId}
    `,
  ]);
  return { ...statusRows[0], ...deliveryRows[0] };
}

// --- Helper: mask email for GDPR compliance ---
function maskEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.***';
  const [user, domain] = parts;
  const maskedUser = user.length > 2 ? user[0] + '***' + user[user.length - 1] : '***';
  return `${maskedUser}@${domain}`;
}

// --- Helper: finalize upload status after all batches done ---
async function checkUploadCompletion(uploadId) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) return 'failed';

  const pendingCount = await prisma.contact.count({
    where: { uploadId, deliveryStatus: 'pending' },
  });

  if (pendingCount === 0) {
    // Recount stats to ensure the upload counters are perfectly synchronized
    const counts = await recountUploadStats(uploadId);
    let finalStatus = upload.status;
    if (upload.status === 'processing') {
      finalStatus = counts.failedCount > 0 && counts.sentCount === 0 ? 'failed' : 'completed';
    }
    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        status: finalStatus,
        sentCount: counts.sentCount,
        failedCount: counts.failedCount,
        pendingCount: counts.pendingCount,
        skippedCount: counts.skippedCount,
      },
    });
    return finalStatus;
  }
  return upload.status;
}

// --- Helper: re-evaluate duplicate status for specific emails ---
async function revalidateDuplicatesForEmails(uploadId, emails) {
  const uniqueEmails = [...new Set(emails.filter(Boolean).map((e) => e.trim().toLowerCase()))];
  if (uniqueEmails.length === 0) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const unsubSet = await getUnsubscribedSet();

  await Promise.all(
    uniqueEmails.map(async (email) => {
      const contacts = await prisma.contact.findMany({ where: { uploadId, email } });
      if (contacts.length === 0) return;

      if (contacts.length > 1) {
        await prisma.contact.updateMany({
          where: { uploadId, email },
          data: { status: 'duplicate', error: 'Duplicate email in file' },
        });
      } else {
        let status = 'valid';
        let error = null;
        if (!email) {
          status = 'invalid'; error = 'Email is empty';
        } else if (!emailRegex.test(email)) {
          status = 'invalid'; error = 'Invalid email format';
        } else if (unsubSet.has(email)) {
          status = 'unsubscribed'; error = 'Email is unsubscribed';
        }
        await prisma.contact.update({
          where: { id: contacts[0].id },
          data: { status, error },
        });
      }
    })
  );
}

// --- Async error wrapper ---
const catchAsync = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ============================================================
// API Router
// ============================================================
const apiRouter = express.Router();

// GET /health
apiRouter.get('/health', catchAsync(async (_req, res) => {
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
}));

// GET /cron/check-scheduler
apiRouter.get('/cron/check-scheduler', catchAsync(async (req, res) => {
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ message: 'Unauthorized cron trigger' });
  }

  const results = await runSchedulerIncrementally();
  return res.status(200).json({ success: true, ...results });
}));

// POST /auth/login
apiRouter.post('/auth/login', loginLimiter, catchAsync(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
  if (!admin) return res.status(401).json({ message: 'Invalid credentials' });

  const isValid = await comparePassword(password, admin.password);
  if (!isValid) return res.status(401).json({ message: 'Invalid credentials' });

  const token = generateToken({ id: admin.id, email: admin.email, name: admin.name });
  return res.status(200).json({
    access_token: token,
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
}));

// GET /auth/me
apiRouter.get('/auth/me', catchAsync(async (req, res) => {
  const user = await authenticate(req);
  const admin = await prisma.admin.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!admin) return res.status(404).json({ message: 'Admin not found' });
  return res.status(200).json(admin);
}));



// GET /uploads/stats/dashboard
apiRouter.get('/uploads/stats/dashboard', catchAsync(async (req, res) => {
  await authenticate(req);
  const [totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails] = await Promise.all([
    prisma.upload.count(),
    prisma.template.count(),
    prisma.contact.count({ where: { deliveryStatus: 'sent' } }),
    prisma.contact.count({ where: { deliveryStatus: 'failed' } }),
  ]);
  return res.status(200).json({ totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails });
}));

// GET /uploads
apiRouter.get('/uploads', catchAsync(async (req, res) => {
  await authenticate(req);
  const uploads = await prisma.upload.findMany({
    include: { template: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.status(200).json(uploads);
}));

// POST /uploads/excel
apiRouter.post('/uploads/excel', uploadMiddleware.single('file'), catchAsync(async (req, res) => {
  await authenticate(req);
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  // Validate XLSX magic bytes (PK zip header: 0x50 0x4B)
  const buf = req.file.buffer;
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    return res.status(400).json({ message: 'Uploaded file is not a valid .xlsx file' });
  }

  const workbook = XLSX.read(buf, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  if (rows.length === 0) return res.status(400).json({ message: 'Excel file is empty' });

  const normalizedRows = rows.map((row) => {
    const normalized = {};
    for (const key of Object.keys(row)) {
      normalized[key.trim().toLowerCase()] = row[key];
    }
    return normalized;
  });

  const firstRow = normalizedRows[0];
  if (!('name' in firstRow) || !('email' in firstRow)) {
    return res.status(400).json({ message: 'Excel file must contain "name" and "email" columns' });
  }

  const unsubscribedSet = await getUnsubscribedSet();
  const seenEmails = new Set();
  let validCount = 0, invalidCount = 0, duplicateCount = 0, unsubscribedCount = 0;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const contactsToCreate = [];

  for (const row of normalizedRows) {
    const name = String(row.name || '').trim();
    const email = String(row.email || '').trim().toLowerCase();

    if (!email) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Email is empty' });
      invalidCount++; continue;
    }
    if (!emailRegex.test(email)) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Invalid email format' });
      invalidCount++; continue;
    }
    if (seenEmails.has(email)) {
      contactsToCreate.push({ name, email, status: 'duplicate', error: 'Duplicate email in file' });
      duplicateCount++; continue;
    }
    if (unsubscribedSet.has(email)) {
      contactsToCreate.push({ name, email, status: 'unsubscribed', error: 'Email is unsubscribed' });
      unsubscribedCount++;
      seenEmails.add(email); continue;
    }
    seenEmails.add(email);
    contactsToCreate.push({ name, email, status: 'valid', error: null });
    validCount++;
  }

  const upload = await prisma.upload.create({
    data: {
      fileName: req.file.originalname || 'uploaded_file.xlsx',
      originalName: req.file.originalname || 'uploaded_file.xlsx',
      totalRows: normalizedRows.length,
      validEmails: validCount,
      invalidEmails: invalidCount,
      duplicateEmails: duplicateCount,
      unsubscribedEmails: unsubscribedCount,
      contacts: { create: contactsToCreate },
    },
  });

  return res.status(201).json(upload);
}));

// GET /uploads/:id/stats  — lightweight poll endpoint (no contacts list)
apiRouter.get('/uploads/:id/stats', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
    select: {
      id: true, status: true,
      totalCount: true, sentCount: true, failedCount: true,
      pendingCount: true, skippedCount: true,
    },
  });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  return res.status(200).json(upload);
}));

// POST /uploads/:id/send
apiRouter.post('/uploads/:id/send', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId } = req.body;

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  // State machine guard
  try { assertCanTransition(upload.status, 'processing'); }
  catch (e) { return res.status(400).json({ message: e.message }); }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const contacts = await prisma.contact.findMany({ where: { uploadId: id, status: 'valid' } });
  if (contacts.length === 0) {
    return res.status(400).json({ message: 'No valid contacts found in this upload' });
  }

  const unsubscribedSet = await getUnsubscribedSet();
  const unsubscribedArray = [...unsubscribedSet];

  const [skippedResult, pendingResult] = await Promise.all([
    prisma.contact.updateMany({
      where: { uploadId: id, status: 'valid', email: { in: unsubscribedArray } },
      data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
    }),
    prisma.contact.updateMany({
      where: { uploadId: id, status: 'valid', email: { notIn: unsubscribedArray } },
      data: { deliveryStatus: 'pending' },
    }),
  ]);

  await prisma.upload.update({
    where: { id },
    data: {
      status: 'processing',
      templateId,
      totalCount: contacts.length,
      pendingCount: pendingResult.count,
      skippedCount: skippedResult.count,
      sentCount: 0,
      failedCount: 0,
    },
  });

  const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : (process.env.APP_URL || process.env.FRONTEND_URL || `http://${req.get('host')}`);
  try {
    await qstashClient.publishJSON({
      url: `${appUrl}/api/qstash/process-campaign`,
      body: { uploadId: id, templateId },
    });
  } catch (err) {
    console.error('QStash publish error:', err);
    return res.status(500).json({ message: 'Failed to initiate campaign with QStash' });
  }

  const queuedContacts = contacts.filter((c) => !unsubscribedSet.has(c.email.toLowerCase()));
  return res.status(200).json({
    message: 'Sending initiated',
    totalCount: contacts.length,
    queuedCount: pendingResult.count,
    skippedCount: skippedResult.count,
    queuedContacts: queuedContacts.map((c) => ({ id: c.id, email: c.email, name: c.name })),
    batchSize: EMAIL_BATCH_SIZE,
    batchDelayMs: EMAIL_BATCH_DELAY_MS,
  });
}));

// POST /uploads/:id/schedule
apiRouter.post('/uploads/:id/schedule', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId, scheduledAt } = req.body;

  if (!templateId || !scheduledAt) {
    return res.status(400).json({ message: 'templateId and scheduledAt are required' });
  }

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  try {
    assertCanTransition(upload.status, 'scheduled');
  } catch (e) {
    return res.status(400).json({ message: e.message });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const schedDate = new Date(scheduledAt);
  if (isNaN(schedDate.getTime()) || schedDate <= new Date()) {
    return res.status(400).json({ message: 'scheduledAt must be a valid date in the future' });
  }

  const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : (process.env.APP_URL || process.env.FRONTEND_URL || `http://${req.get('host')}`);
  const delaySecs = Math.max(0, Math.floor((schedDate.getTime() - Date.now()) / 1000));

  try {
    const resQstash = await qstashClient.publishJSON({
      url: `${appUrl}/api/qstash/process-campaign`,
      body: { uploadId: id, templateId },
      notBefore: Math.floor(schedDate.getTime() / 1000),
    });
    console.log('Scheduled in QStash:', resQstash.messageId);
  } catch (err) {
    console.error('QStash schedule error:', err);
    return res.status(500).json({ message: 'Failed to schedule campaign with QStash' });
  }

  const updatedUpload = await prisma.upload.update({
    where: { id },
    data: {
      status: 'scheduled',
      templateId,
      scheduledAt: schedDate,
    },
  });

  return res.status(200).json({
    message: 'Campaign scheduled successfully',
    upload: updatedUpload,
  });
}));

// POST /uploads/:id/unschedule
apiRouter.post('/uploads/:id/unschedule', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  if (upload.status !== 'scheduled') {
    return res.status(400).json({ message: 'Campaign is not scheduled' });
  }

  try {
    assertCanTransition(upload.status, 'idle');
  } catch (e) {
    return res.status(400).json({ message: e.message });
  }

  const updatedUpload = await prisma.upload.update({
    where: { id },
    data: {
      status: 'idle',
      scheduledAt: null,
    },
  });

  return res.status(200).json({
    message: 'Campaign schedule cancelled',
    upload: updatedUpload,
  });
}));


// ============================================================
// QStash Webhook Endpoint
// ============================================================
async function verifyQstashSignature(req, res, next) {
  try {
    const signature = req.headers['upstash-signature'];
    if (!signature) throw new Error('Missing signature');
    
    // QStash verification (simplified to use JSON.stringify body)
    const isValid = await qstashReceiver.verify({
      signature,
      body: JSON.stringify(req.body)
    });
    
    if (!isValid) throw new Error('Invalid signature');
    next();
  } catch (err) {
    console.error('[QStash] Signature verification failed:', err.message);
    // If you are having issues with signature verification due to body parsing, 
    // uncomment the line below to fallback to no verification temporarily
    // return next(); 
    return res.status(401).json({ message: 'Invalid QStash signature' });
  }
}

apiRouter.post('/qstash/process-campaign', verifyQstashSignature, catchAsync(async (req, res) => {
  const { uploadId, templateId } = req.body;
  
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  if (upload.status !== 'processing' && upload.status !== 'scheduled') {
    return res.status(200).json({ message: 'Campaign is not active' });
  }

  // Set status to processing if it was scheduled
  if (upload.status === 'scheduled') {
    await prisma.upload.update({ where: { id: uploadId }, data: { status: 'processing', scheduledAt: null } });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) {
    await prisma.upload.update({ where: { id: uploadId }, data: { status: 'failed' } });
    return res.status(404).json({ message: 'Template not found' });
  }

  const contact = await prisma.contact.findFirst({
    where: { uploadId, deliveryStatus: 'pending' },
    orderBy: { createdAt: 'asc' }
  });

  if (!contact) {
    await checkUploadCompletion(uploadId);
    return res.status(200).json({ message: 'No more pending contacts' });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const token = crypto.createHash('sha256').update(contact.email + 'desire-unsubscribe-salt').digest('hex').substring(0, 32);
  const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;
  
  const variables = { name: contact.name, email: contact.email, unsubscribeLink };
  const rendered = renderTemplate(
    { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
    variables
  );

  let sentSuccessfully = false;
  let lastError = null;
  let attempts = 0;
  while (attempts < 3) {
    try {
      await sendEmail({ to: contact.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
      sentSuccessfully = true;
      break;
    } catch (err) {
      attempts++;
      lastError = err;
      if (attempts < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      deliveryStatus: sentSuccessfully ? 'sent' : 'failed',
      deliveryError: sentSuccessfully ? null : (lastError?.message || 'Failed'),
      sentAt: new Date()
    }
  });

  await prisma.upload.update({
    where: { id: uploadId },
    data: {
      sentCount: sentSuccessfully ? { increment: 1 } : undefined,
      failedCount: !sentSuccessfully ? { increment: 1 } : undefined,
      pendingCount: { decrement: 1 }
    }
  });

  const remaining = await prisma.contact.count({ where: { uploadId, deliveryStatus: 'pending' } });
  if (remaining > 0) {
    // Generate human-like random delay
    const delaySecs = Math.max(20, Math.floor(getRandomIndividualDelayMs() / 1000));
    const appUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : (process.env.APP_URL || process.env.FRONTEND_URL || `http://${req.get('host')}`);
    
    await qstashClient.publishJSON({
      url: `${appUrl}/api/qstash/process-campaign`,
      body: { uploadId, templateId },
      delay: `${delaySecs}s`,
    });
    console.log(`[QStash] Sent 1 email. Scheduled next batch for ${delaySecs} seconds from now.`);
  } else {
    await checkUploadCompletion(uploadId);
    console.log(`[QStash] Campaign ${uploadId} completed!`);
  }

  return res.status(200).json({ success: true, contact: contact.email, sentSuccessfully });
}));

const PORT = process.env.PORT || 7071;
app.listen(PORT, () => {
  console.log(`[Express Started] Backend listening on port ${PORT}`);
});

module.exports = app;
