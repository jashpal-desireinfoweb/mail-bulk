const df = require('durable-functions');

// Returns a random delay in ms within [EMAIL_INDIVIDUAL_DELAY_MIN_MS,
// EMAIL_INDIVIDUAL_DELAY_MAX_MS] (default 20-30s). Must live in an activity,
// not the orchestrator directly -- Math.random() inside an orchestrator
// generator function would break replay determinism.
async function getRandomDelayActivity() {
  const min = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MIN_MS || '20000', 10);
  const max = parseInt(process.env.EMAIL_INDIVIDUAL_DELAY_MAX_MS || '30000', 10);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

df.app.activity('getRandomDelayActivity', { handler: getRandomDelayActivity });

module.exports = { getRandomDelayActivity };
