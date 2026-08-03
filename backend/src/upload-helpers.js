const { prisma } = require('./prisma');

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

// --- Helper: finalize upload status once all contacts have a terminal delivery status ---
async function checkUploadCompletion(uploadId) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) return 'failed';

  const pendingCount = await prisma.contact.count({
    where: { uploadId, deliveryStatus: 'pending' },
  });

  if (pendingCount === 0) {
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

module.exports = { recountUploadStats, checkUploadCompletion };
