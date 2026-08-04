const { app } = require('@azure/functions');
const df = require('durable-functions');

require('./emailOrchestrator');
require('./getPendingContactsActivity');
require('./sendEmailActivity');

async function starterHandler(request, context) {
  const client = df.getClient(context);

  let body = {};
  try {
    body = (await request.json()) || {};
  } catch (_e) {
    body = {};
  }

  const { uploadId, templateId, scheduledAt } = body;
  if (!uploadId || !templateId) {
    return { status: 400, jsonBody: { error: 'uploadId and templateId are required' } };
  }

  const instanceId = `campaign-${uploadId}-${Date.now()}`;
  await client.startNew('emailOrchestrator', { instanceId, input: { uploadId, templateId, scheduledAt } });

  context.log(`Started orchestration '${instanceId}' for Upload '${uploadId}'.`);

  return client.createCheckStatusResponse(request, instanceId);
}

app.http('startEmailOrchestration', {
  route: 'start-email-orchestration',
  methods: ['POST'],
  authLevel: 'function',
  extraInputs: [df.input.durableClient()],
  handler: starterHandler,
});

module.exports = { starterHandler };
