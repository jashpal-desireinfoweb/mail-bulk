const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
  const vercelBackendUrl =
    process.env.VERCEL_BACKEND_URL ||
    'https://desire-mail-backend.vercel.app/api/cron/check-scheduler';
  const cronSecret =
    process.env.CRON_SECRET || 'desire-mail-cron-secret-2026-production';

  context.log(
    `[Azure Timer Scheduler] Triggering Vercel Campaign Scheduler at ${timeStamp}...`
  );

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
          context.log(
            `[Azure Timer Scheduler] Vercel response status: ${res.statusCode}`
          );
          try {
            const json = JSON.parse(body);
            context.log(
              `[Azure Timer Scheduler] Execution result:`,
              JSON.stringify(json)
            );
          } catch (e) {
            context.log(`[Azure Timer Scheduler] Response body:`, body);
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        context.log.error(
          `[Azure Timer Scheduler] Network error calling Vercel: ${err.message}`
        );
        resolve();
      });

      req.on('timeout', () => {
        context.log.error(
          `[Azure Timer Scheduler] Request timed out calling Vercel URL: ${vercelBackendUrl}`
        );
        req.destroy();
        resolve();
      });

      req.end();
    } catch (err) {
      context.log.error(
        `[Azure Timer Scheduler] Unexpected error: ${err.message}`
      );
      resolve();
    }
  });
};
