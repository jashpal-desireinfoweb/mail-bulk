const df = require('durable-functions');
const { prisma } = require('../prisma');

async function getPendingContactsActivity(input) {
  const { uploadId, batchSize } = input;

  // Flip 'scheduled' -> 'processing' once the durable timer fires and we start
  // pulling contacts. Without this, Upload.status never becomes eligible for
  // checkUploadCompletion (which only finalizes from 'processing'), so a
  // scheduled campaign would stay stuck at 'scheduled' forever even after
  // fully sending. Idempotent: no-op once already 'processing'.
  await prisma.upload.updateMany({
    where: { id: uploadId, status: 'scheduled' },
    data: { status: 'processing', scheduledAt: null },
  });

  return prisma.contact.findMany({
    where: { uploadId, deliveryStatus: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: batchSize || 25,
  });
}

df.app.activity('getPendingContactsActivity', { handler: getPendingContactsActivity });

module.exports = { getPendingContactsActivity };
