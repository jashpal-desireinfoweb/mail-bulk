const df = require('durable-functions');

// How many pending contacts to pull from the DB per query -- this is just a
// query page size, not a send-concurrency setting. Sends themselves are
// always fully sequential (see below), one at a time with a random delay
// between each, regardless of this value.
const FETCH_PAGE_SIZE = parseInt(process.env.EMAIL_BATCH_SIZE || '25', 10);

function* emailOrchestrator(context) {
  const input = context.df.getInput() || {};
  const { uploadId, templateId, scheduledAt } = input;

  // Durable timer: fires exactly once at scheduledAt, survives host restarts —
  // this replaces the 10s setInterval polling loop in the Express app.
  if (scheduledAt) {
    yield context.df.createTimer(new Date(scheduledAt));
  }

  let totalSent = 0;
  let totalFailed = 0;

  while (true) {
    const contacts = yield context.df.callActivity('getPendingContactsActivity', {
      uploadId,
      batchSize: FETCH_PAGE_SIZE,
    });

    if (!contacts || contacts.length === 0) break;

    // Sequential, one email at a time, with a random human-like delay
    // between each send -- deliberately not parallel (Task.all), since
    // firing many sends simultaneously is exactly the burst pattern that
    // trips provider rate limits (e.g. Office 365's "concurrent connections
    // exceeded") and looks bot-like to receiving mail servers.
    for (let i = 0; i < contacts.length; i++) {
      const result = yield context.df.callActivity('sendEmailActivity', {
        uploadId,
        templateId,
        contact: contacts[i],
      });
      if (result && result.sent) totalSent++;
      else totalFailed++;

      const isLastOverall = i === contacts.length - 1 && contacts.length < FETCH_PAGE_SIZE;
      if (!isLastOverall) {
        const delayMs = yield context.df.callActivity('getRandomDelayActivity');
        yield context.df.createTimer(new Date(Date.now() + delayMs));
      }
    }

    if (!context.df.isReplaying) {
      context.log(`[emailOrchestrator] Upload ${uploadId}: page complete, sent=${totalSent} failed=${totalFailed}`);
    }

    if (contacts.length < FETCH_PAGE_SIZE) break;
  }

  return { uploadId, totalSent, totalFailed, status: 'completed' };
}

df.app.orchestration('emailOrchestrator', emailOrchestrator);

module.exports = { emailOrchestrator };
