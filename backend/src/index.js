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

// --- Rate Limit Settings for Email Sending (Human-like Random Delays) ---
const EMAIL_BATCH_SIZE = parseInt(process.env.EMAIL_BATCH_SIZE || '1', 10);
const EMAIL_BATCH_DELAY_MS = parseInt(process.env.EMAIL_BATCH_DELAY_MS || '0', 10);

function getRandomIndividualDelayMs() {
  const min = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MIN_MS || '120000', 10);
  const max = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MAX_MS || '150000', 10);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const app = express();


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

// POST /uploads/:id/send-batch
apiRouter.post('/uploads/:id/send-batch', batchLimiter, catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId, contactIds } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ message: 'contactIds must be a non-empty array' });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, uploadId: id, deliveryStatus: 'pending' },
  });
  if (contacts.length === 0) {
    return res.status(200).json({ sent: 0, failed: 0 });
  }

  // Update campaign upload status to 'processing' and assign template
  await prisma.upload.update({
    where: { id },
    data: { status: 'processing', templateId },
  });

  // Launch campaign processing asynchronously in background to prevent HTTP gateway timeout
  runCampaignInBackground(id, templateId).catch((err) => {
    console.error(`[Background Scheduler] Error processing campaign ${id}:`, err);
  });

  return res.status(200).json({ sent: 0, failed: 0, status: 'processing', message: 'Campaign started in background' });
}));

// POST /uploads/:id/finalize
apiRouter.post('/uploads/:id/finalize', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const status = await checkUploadCompletion(id);
  return res.status(200).json({ status });
}));

// GET /uploads/:id/contacts
apiRouter.get('/uploads/:id/contacts', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '50', 10);
  const skip = (page - 1) * limit;

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where: { uploadId: id },
      skip,
      take: limit,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.contact.count({ where: { uploadId: id } }),
  ]);

  return res.status(200).json({
    contacts, total, page, limit,
    totalPages: Math.ceil(total / limit),
  });
}));

// GET /uploads/:id
apiRouter.get('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
    include: { template: true },
  });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  return res.status(200).json(upload);
}));

// PUT /uploads/:id
apiRouter.put('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { fileName, originalName } = req.body;
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  const updated = await prisma.upload.update({
    where: { id },
    data: {
      fileName: fileName || upload.fileName,
      originalName: originalName || upload.originalName,
    },
  });
  return res.status(200).json(updated);
}));

// DELETE /uploads/:id
apiRouter.delete('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  await prisma.upload.delete({ where: { id } });
  return res.status(200).json({ message: 'Upload deleted successfully' });
}));

// GET /contacts/logs
apiRouter.get('/contacts/logs', catchAsync(async (req, res) => {
  await authenticate(req);

  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '10', 10);
  const skip = (page - 1) * limit;
  const { search, status, startDate, endDate } = req.query;

  const where = {
    deliveryStatus: { not: 'idle' },
  };

  if (status && status !== 'all') {
    where.deliveryStatus = status;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (startDate || endDate) {
    where.sentAt = {};
    if (startDate) {
      where.sentAt.gte = new Date(`${startDate}T00:00:00.000Z`);
    }
    if (endDate) {
      where.sentAt.lte = new Date(`${endDate}T23:59:59.999Z`);
    }
  }

  const [logs, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      include: {
        upload: {
          include: {
            template: true,
          },
        },
      },
      skip,
      take: limit,
      orderBy: [
        { sentAt: 'desc' },
        { createdAt: 'desc' },
      ],
    }),
    prisma.contact.count({ where }),
  ]);

  return res.status(200).json({
    logs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}));

// PUT /contacts/:id
apiRouter.put('/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, email } = req.body;

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return res.status(404).json({ message: 'Contact not found' });

  const oldEmail = contact.email;
  const newEmail = email !== undefined ? email.trim().toLowerCase() : contact.email;
  const newName = name !== undefined ? name.trim() : contact.name;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let newStatus = 'valid';
  let newError = null;

  if (!newEmail) {
    newStatus = 'invalid'; newError = 'Email is empty';
  } else if (!emailRegex.test(newEmail)) {
    newStatus = 'invalid'; newError = 'Invalid email format';
  } else {
    const unsubSet = await getUnsubscribedSet();
    if (unsubSet.has(newEmail)) {
      newStatus = 'unsubscribed'; newError = 'Email is unsubscribed';
    } else {
      const duplicate = await prisma.contact.findFirst({
        where: { uploadId: contact.uploadId, email: newEmail, id: { not: id } },
      });
      if (duplicate) {
        newStatus = 'duplicate'; newError = 'Duplicate email in file';
      }
    }
  }

  const updatedContact = await prisma.contact.update({
    where: { id },
    data: { name: newName, email: newEmail, status: newStatus, error: newError },
  });

  if (oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
    await revalidateDuplicatesForEmails(contact.uploadId, [oldEmail, newEmail]);
  }

  // Recount upload stats using ONE aggregate query
  const uploadId = contact.uploadId;
  const counts = await recountUploadStats(uploadId);
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });

  const updateData = {
    totalRows: counts.totalRows,
    validEmails: counts.validEmails,
    invalidEmails: counts.invalidEmails,
    duplicateEmails: counts.duplicateEmails,
    unsubscribedEmails: counts.unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    updateData.totalCount = counts.validEmails;
    updateData.sentCount = counts.sentCount;
    updateData.failedCount = counts.failedCount;
    updateData.pendingCount = counts.pendingCount;
    updateData.skippedCount = counts.skippedCount;
  }

  await prisma.upload.update({ where: { id: uploadId }, data: updateData });

  return res.status(200).json(updatedContact);
}));

// DELETE /contacts/:id
apiRouter.delete('/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return res.status(404).json({ message: 'Contact not found' });

  await prisma.contact.delete({ where: { id } });
  await revalidateDuplicatesForEmails(contact.uploadId, [contact.email]);

  // Recount upload stats using ONE aggregate query
  const uploadId = contact.uploadId;
  const counts = await recountUploadStats(uploadId);
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });

  const updateData = {
    totalRows: counts.totalRows,
    validEmails: counts.validEmails,
    invalidEmails: counts.invalidEmails,
    duplicateEmails: counts.duplicateEmails,
    unsubscribedEmails: counts.unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    updateData.totalCount = counts.validEmails;
    updateData.sentCount = counts.sentCount;
    updateData.failedCount = counts.failedCount;
    updateData.pendingCount = counts.pendingCount;
    updateData.skippedCount = counts.skippedCount;
  }

  await prisma.upload.update({ where: { id: uploadId }, data: updateData });

  return res.status(200).json({ message: 'Contact deleted successfully' });
}));

// GET /templates
apiRouter.get('/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const templates = await prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
  return res.status(200).json(templates);
}));

// POST /templates
apiRouter.post('/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  if (!name || !subject || !htmlBody || !plainTextBody) {
    return res.status(400).json({ message: 'name, subject, htmlBody, and plainTextBody are required' });
  }
  const template = await prisma.template.create({ data: { name, subject, htmlBody, plainTextBody } });
  return res.status(201).json(template);
}));

// POST /templates/:id/test
apiRouter.post('/templates/:id/test', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { testEmail } = req.body;
  if (!testEmail) return res.status(400).json({ message: 'testEmail is required' });

  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const rendered = renderTemplate(
    { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
    { name: 'Test User', email: testEmail, unsubscribeLink: '#' }
  );
  await sendEmail({ to: testEmail, subject: `[TEST] ${rendered.subject}`, html: rendered.html, text: rendered.text });
  return res.status(200).json({ message: 'Test email sent successfully' });
}));

// GET /templates/:id
apiRouter.get('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });
  return res.status(200).json(template);
}));

// PUT /templates/:id
apiRouter.put('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  // Invalidate compiled cache so next render uses new content
  invalidateTemplate(id);

  const updated = await prisma.template.update({
    where: { id },
    data: {
      name: name || template.name,
      subject: subject || template.subject,
      htmlBody: htmlBody || template.htmlBody,
      plainTextBody: plainTextBody || template.plainTextBody,
    },
  });
  return res.status(200).json(updated);
}));

// DELETE /templates/:id
apiRouter.delete('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });
  invalidateTemplate(id);
  await prisma.template.delete({ where: { id } });
  return res.status(200).json({ message: 'Template deleted successfully' });
}));

// GET /unsubscribe/:token
apiRouter.get('/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const existing = await prisma.unsubscribed.findUnique({ where: { token } });
  if (existing) {
    return res.status(200).json({ alreadyUnsubscribed: true, email: maskEmail(existing.email) });
  }
  return res.status(200).json({ alreadyUnsubscribed: false, email: null });
}));

// POST /unsubscribe/:token
apiRouter.post('/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const expectedToken = crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase() + 'desire-unsubscribe-salt')
    .digest('hex')
    .substring(0, 32);

  if (expectedToken !== token) return res.status(404).json({ message: 'Invalid unsubscribe link' });

  const existing = await prisma.unsubscribed.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return res.status(200).json({ message: 'You are already unsubscribed', email: maskEmail(email) });
  }

  await prisma.unsubscribed.create({ data: { email: email.toLowerCase(), token } });
  invalidateUnsubscribedCache();

  return res.status(200).json({
    message: 'You have been successfully unsubscribed',
    email: maskEmail(email),
  });
}));

// --- Mount router for dual path support (/api and /) ---
app.use('/api', apiRouter);
app.use('/', apiRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[Express Error] ${err.stack || err.message}`);
  const status = err.message === 'Unauthorized' ? 401 : 400;
  return res.status(status).json({ message: err.message });
});

// --- Campaign background sending worker ---
async function runCampaignInBackground(uploadId, templateId) {
  try {
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    if (!template) {
      console.error(`[Scheduler] Template ${templateId} not found for upload ${uploadId}`);
      await prisma.upload.update({
        where: { id: uploadId },
        data: { status: 'failed' }
      });
      return;
    }

    // Recount stats to be completely accurate before starting
    const counts = await recountUploadStats(uploadId);
    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        totalCount: counts.validEmails,
        pendingCount: counts.pendingCount,
        skippedCount: counts.skippedCount,
        sentCount: counts.sentCount,
        failedCount: counts.failedCount,
      }
    });

    const contacts = await prisma.contact.findMany({
      where: { uploadId, deliveryStatus: 'pending' },
    });

    console.log(`[Scheduler] Starting background processing for campaign ${uploadId} with ${contacts.length} pending contacts.`);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    for (let i = 0; i < contacts.length; i++) {
      // Re-fetch the upload state to check if the campaign status has been cancelled or updated
      const currentUpload = await prisma.upload.findUnique({ where: { id: uploadId } });
      if (!currentUpload || currentUpload.status !== 'processing') {
        console.log(`[Scheduler] Campaign ${uploadId} is no longer processing (status: ${currentUpload?.status}). Aborting execution loop.`);
        break;
      }

      const contact = contacts[i];

      // Double-check contact status to prevent duplicate sending/concurrency issues
      const freshContact = await prisma.contact.findUnique({ where: { id: contact.id } });
      if (!freshContact || freshContact.deliveryStatus !== 'pending') {
        console.log(`[Scheduler] Skipping contact ${contact.email} as it is no longer pending (status: ${freshContact?.deliveryStatus}).`);
        continue;
      }

      const token = crypto
        .createHash('sha256')
        .update(contact.email + 'desire-unsubscribe-salt')
        .digest('hex')
        .substring(0, 32);
      const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

      const variables = { name: contact.name, email: contact.email, unsubscribeLink };
      const rendered = renderTemplate(
        { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
        variables
      );

      let attempts = 0;
      const maxAttempts = 3;
      let lastError = null;
      let sentSuccessfully = false;

      while (attempts < maxAttempts) {
        try {
          await sendEmail({ to: contact.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
          await prisma.contact.update({
            where: { id: contact.id },
            data: { deliveryStatus: 'sent', deliveryError: null, sentAt: new Date() },
          });
          sentSuccessfully = true;
          break;
        } catch (err) {
          attempts++;
          lastError = err;
          console.warn(`[Scheduler] Attempt ${attempts} failed for ${contact.email}: ${err.message}`);
          if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
        }
      }

      if (!sentSuccessfully) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: {
            deliveryStatus: 'failed',
            deliveryError: lastError?.message || 'All retry attempts failed',
            sentAt: new Date(),
          },
        });
      }

      // Update upload metrics atomically
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          sentCount: sentSuccessfully ? { increment: 1 } : undefined,
          failedCount: !sentSuccessfully ? { increment: 1 } : undefined,
          pendingCount: { decrement: 1 },
        },
      });

      // Pause to simulate human sending activity and avoid Outlook bot detection
      if (i < contacts.length - 1) {
        const randomDelayMs = getRandomIndividualDelayMs();
        const isEndOfBatch = EMAIL_BATCH_SIZE > 0 && (i + 1) % EMAIL_BATCH_SIZE === 0;
        if (isEndOfBatch && EMAIL_BATCH_DELAY_MS > 0) {
          console.log(`[Scheduler] Batch of ${EMAIL_BATCH_SIZE} completed. Waiting ${EMAIL_BATCH_DELAY_MS}ms batch delay + ${(randomDelayMs / 1000).toFixed(1)}s random delay...`);
          await new Promise((r) => setTimeout(r, randomDelayMs));
          await new Promise((r) => setTimeout(r, EMAIL_BATCH_DELAY_MS));
        } else {
          console.log(`[Scheduler] Waiting human-like randomized delay of ${(randomDelayMs / 1000).toFixed(1)} seconds before next email...`);
          await new Promise((r) => setTimeout(r, randomDelayMs));
        }
      }
    }

    // Finalize campaign status
    await checkUploadCompletion(uploadId);
    console.log(`[Scheduler] Finished background processing for campaign ${uploadId}.`);
  } catch (error) {
    console.error(`[Scheduler] Critical error in background execution for campaign ${uploadId}:`, error);
    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: 'failed' }
    });
  }
}

// Recovery logic for campaigns stuck in processing on startup
async function recoverStuckCampaigns() {
  try {
    const stuckCampaigns = await prisma.upload.findMany({
      where: { status: 'processing' },
    });

    for (const campaign of stuckCampaigns) {
      if (!campaign.templateId) {
        console.warn(`[Scheduler] Stuck campaign ${campaign.id} has no template ID. Marking as failed.`);
        await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed' } });
        continue;
      }

      const pendingCount = await prisma.contact.count({
        where: { uploadId: campaign.id, deliveryStatus: 'pending' },
      });

      if (pendingCount > 0) {
        console.log(`[Scheduler] Resuming stuck campaign: ${campaign.id} (${campaign.originalName}) with ${pendingCount} pending emails.`);
        runCampaignInBackground(campaign.id, campaign.templateId).catch(err => {
          console.error(`[Scheduler] Error resuming campaign ${campaign.id}:`, err);
        });
      } else {
        console.log(`[Scheduler] Finalizing stuck campaign: ${campaign.id} (${campaign.originalName}) as no pending emails remain.`);
        await checkUploadCompletion(campaign.id);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error during stuck campaign recovery:', err);
  }
}

// Incremental scheduler runner for serverless/cron environments
async function runSchedulerIncrementally() {
  const startTime = Date.now();
  const TIME_LIMIT_MS = 6000; // 6 seconds budget to stay safe within Vercel's limits

  let startedCampaignsCount = 0;
  let emailsSentCount = 0;
  let emailsFailedCount = 0;

  try {
    // 1. Recover / transition scheduled campaigns that are due
    const now = new Date();
    const scheduledCampaigns = await prisma.upload.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: {
          lte: now,
        },
      },
    });

    for (const campaign of scheduledCampaigns) {
      if (!campaign.templateId) {
        console.warn(`[Scheduler] Scheduled campaign ${campaign.id} has no template ID. Marking as failed.`);
        await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed', scheduledAt: null } });
        continue;
      }

      console.log(`[Scheduler] Starting scheduled campaign: ${campaign.id} (${campaign.originalName})`);

      const contacts = await prisma.contact.findMany({ where: { uploadId: campaign.id, status: 'valid' } });
      if (contacts.length === 0) {
        console.warn(`[Scheduler] Scheduled campaign ${campaign.id} has no valid contacts. Finalizing.`);
        await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed', scheduledAt: null } });
        continue;
      }

      const unsubscribedSet = await getUnsubscribedSet();
      const unsubscribedArray = [...unsubscribedSet];

      const [skippedResult, pendingResult] = await Promise.all([
        prisma.contact.updateMany({
          where: { uploadId: campaign.id, status: 'valid', email: { in: unsubscribedArray } },
          data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
        }),
        prisma.contact.updateMany({
          where: { uploadId: campaign.id, status: 'valid', email: { notIn: unsubscribedArray } },
          data: { deliveryStatus: 'pending' },
        }),
      ]);

      await prisma.upload.update({
        where: { id: campaign.id },
        data: {
          status: 'processing',
          totalCount: contacts.length,
          pendingCount: pendingResult.count,
          skippedCount: skippedResult.count,
          sentCount: 0,
          failedCount: 0,
        },
      });

      startedCampaignsCount++;
    }

    // 2. Process campaigns currently in 'processing' status
    const processingCampaigns = await prisma.upload.findMany({
      where: { status: 'processing' },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    for (const campaign of processingCampaigns) {
      // Check budget
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        break;
      }

      const template = await prisma.template.findUnique({ where: { id: campaign.templateId } });
      if (!template) {
        console.error(`[Scheduler] Template ${campaign.templateId} not found for campaign ${campaign.id}`);
        await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed' } });
        continue;
      }

      // Grab up to 5 pending contacts to keep the slice quick
      const contacts = await prisma.contact.findMany({
        where: { uploadId: campaign.id, deliveryStatus: 'pending' },
        take: 5,
      });

      if (contacts.length === 0) {
        await checkUploadCompletion(campaign.id);
        continue;
      }

      for (const contact of contacts) {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          break;
        }

        const freshContact = await prisma.contact.findUnique({ where: { id: contact.id } });
        if (!freshContact || freshContact.deliveryStatus !== 'pending') {
          continue;
        }

        const token = crypto
          .createHash('sha256')
          .update(contact.email + 'desire-unsubscribe-salt')
          .digest('hex')
          .substring(0, 32);
        const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

        const variables = { name: contact.name, email: contact.email, unsubscribeLink };
        const rendered = renderTemplate(
          { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
          variables
        );

        let sentSuccessfully = false;
        let lastError = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          try {
            await sendEmail({ to: contact.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
            await prisma.contact.update({
              where: { id: contact.id },
              data: { deliveryStatus: 'sent', deliveryError: null, sentAt: new Date() },
            });
            sentSuccessfully = true;
            emailsSentCount++;
            break;
          } catch (err) {
            attempts++;
            lastError = err;
            console.warn(`[Cron Scheduler] Attempt ${attempts} failed for ${contact.email}: ${err.message}`);
            if (attempts < maxAttempts) {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }

        if (!sentSuccessfully) {
          await prisma.contact.update({
            where: { id: contact.id },
            data: {
              deliveryStatus: 'failed',
              deliveryError: lastError?.message || 'All retry attempts failed',
              sentAt: new Date(),
            },
          });
          emailsFailedCount++;
        }

        // Update metrics
        await prisma.upload.update({
          where: { id: campaign.id },
          data: {
            sentCount: sentSuccessfully ? { increment: 1 } : undefined,
            failedCount: !sentSuccessfully ? { increment: 1 } : undefined,
            pendingCount: { decrement: 1 },
          },
        });

        // Small delay if we have time budget in serverless mode
        const delay = 500;
        if (Date.now() - startTime < TIME_LIMIT_MS) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      await checkUploadCompletion(campaign.id);
    }
  } catch (err) {
    console.error('[Scheduler] Error in incremental scheduler run:', err);
    throw err;
  }

  return {
    startedCampaigns: startedCampaignsCount,
    emailsSent: emailsSentCount,
    emailsFailed: emailsFailedCount,
    elapsedMs: Date.now() - startTime,
  };
}

// Background scheduler checker
function initCampaignScheduler() {
  console.log('[Scheduler] Background campaign scheduler initialized.');

  // Run startup recovery
  recoverStuckCampaigns().catch(err => {
    console.error('[Scheduler] Error in startup campaign recovery:', err);
  });

  setInterval(async () => {
    try {
      const now = new Date();
      const scheduledCampaigns = await prisma.upload.findMany({
        where: {
          status: 'scheduled',
          scheduledAt: {
            lte: now,
          },
        },
      });

      for (const campaign of scheduledCampaigns) {
        if (!campaign.templateId) {
          console.warn(`[Scheduler] Scheduled campaign ${campaign.id} has no template ID. Marking as failed.`);
          await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed', scheduledAt: null } });
          continue;
        }

        console.log(`[Scheduler] Starting scheduled campaign: ${campaign.id} (${campaign.originalName})`);

        // Prepare contacts (unsubscribes and pending status check)
        const contacts = await prisma.contact.findMany({ where: { uploadId: campaign.id, status: 'valid' } });
        if (contacts.length === 0) {
          console.warn(`[Scheduler] Scheduled campaign ${campaign.id} has no valid contacts. Finalizing.`);
          await prisma.upload.update({ where: { id: campaign.id }, data: { status: 'failed', scheduledAt: null } });
          continue;
        }

        const unsubscribedSet = await getUnsubscribedSet();
        const unsubscribedArray = [...unsubscribedSet];

        const [skippedResult, pendingResult] = await Promise.all([
          prisma.contact.updateMany({
            where: { uploadId: campaign.id, status: 'valid', email: { in: unsubscribedArray } },
            data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
          }),
          prisma.contact.updateMany({
            where: { uploadId: campaign.id, status: 'valid', email: { notIn: unsubscribedArray } },
            data: { deliveryStatus: 'pending' },
          }),
        ]);

        await prisma.upload.update({
          where: { id: campaign.id },
          data: {
            status: 'processing',
            totalCount: contacts.length,
            pendingCount: pendingResult.count,
            skippedCount: skippedResult.count,
            sentCount: 0,
            failedCount: 0,
          },
        });

        // Trigger execution asynchronously
        runCampaignInBackground(campaign.id, campaign.templateId).catch(err => {
          console.error(`[Scheduler] Error running scheduled campaign ${campaign.id}:`, err);
        });
      }
    } catch (err) {
      console.error('[Scheduler] Error in check interval:', err);
    }
  }, 30000); // Check every 30 seconds
}

const PORT = process.env.PORT || 7071;
app.listen(PORT, () => {
  console.log(`[Express Started] Backend listening on port ${PORT}`);
  initCampaignScheduler();
});

module.exports = app;
