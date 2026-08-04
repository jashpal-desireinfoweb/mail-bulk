const df = require('durable-functions');

const BATCH_SIZE = 25;

function* emailOrchestrator(context) {
  const input = context.df.getInput() || {};
  const { uploadId, templateId, scheduledAt } = input;

  // Durable timer: fires exactly once at scheduledAt, survives host restarts —
  // this replaces the 10s setInterval polling loop in the Express app.
  if (scheduledAt) {
    yield context.df.createTimer(new Date(scheduledAt));
  }

  const batchDelayMs = parseInt(process.env.EMAIL_BATCH_DELAY_MS || '1000', 10);
  let totalSent = 0;
  let totalFailed = 0;

  while (true) {
    const contacts = yield context.df.callActivity('getPendingContactsActivity', {
      uploadId,
      batchSize: BATCH_SIZE,
    });

    if (!contacts || contacts.length === 0) break;

    const tasks = contacts.map((contact) =>
      context.df.callActivity('sendEmailActivity', { uploadId, templateId, contact })
    );
    const results = yield context.df.Task.all(tasks);

    for (const result of results) {
      if (result && result.sent) totalSent++;
      else totalFailed++;
    }

    if (!context.df.isReplaying) {
      context.log(`[emailOrchestrator] Upload ${uploadId}: batch complete, sent=${totalSent} failed=${totalFailed}`);
    }

    if (contacts.length < BATCH_SIZE) break;

    if (batchDelayMs > 0) {
      yield context.df.createTimer(new Date(Date.now() + batchDelayMs));
    }
  }

  return { uploadId, totalSent, totalFailed, status: 'completed' };
}

df.app.orchestration('emailOrchestrator', emailOrchestrator);

module.exports = { emailOrchestrator };
