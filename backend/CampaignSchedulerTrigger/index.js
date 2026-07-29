const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
  const vercelBackendUrl =
    process.env.VERCEL_BACKEND_URL ||
    'https://desire-mail-backend.vercel.app/api/cron/check-scheduler';
  const cronSecret = process.env.CRON_SECRET;

  const log = (...args) => context.log('[Azure Timer Scheduler]', ...args);
  const logError = (...args) =>
    context.log('[Azure Timer Scheduler][Error]', ...args);

  if (!cronSecret) {
    logError('CRON_SECRET is not configured in Function App settings.');
    return;
  }

  log(`Triggering Vercel Campaign Scheduler at ${timeStamp}...`);

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(vercelBackendUrl);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          'User-Agent': 'Azure-Timer-Scheduler/1.0',
        },
        timeout: 25000,
      };

      const req = protocol.request(reqOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          log(`Vercel response status: ${res.statusCode}`);
          try {
            const json = JSON.parse(body);
            log('Execution result:', JSON.stringify(json));
          } catch (e) {
            log('Response body:', body);
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            logError(
              `Upstream returned non-2xx status ${res.statusCode}. Check Vercel logs and Function App env vars.`
            );
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        logError(`Network error calling Vercel: ${err.message}`);
        resolve();
      });

      req.on('timeout', () => {
        logError(`Request timed out calling Vercel URL: ${vercelBackendUrl}`);
        req.destroy();
        resolve();
      });

      req.end();
    } catch (err) {
      logError(`Unexpected error: ${err.message}`);
      resolve();
    }
  });
};
