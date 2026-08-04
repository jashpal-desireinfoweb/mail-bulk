const df = require('durable-functions');
const { prisma } = require('../prisma');

async function getPendingContactsActivity(input) {
  const { uploadId, batchSize } = input;
  return prisma.contact.findMany({
    where: { uploadId, deliveryStatus: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: batchSize || 25,
  });
}

df.app.activity('getPendingContactsActivity', { handler: getPendingContactsActivity });

module.exports = { getPendingContactsActivity };
