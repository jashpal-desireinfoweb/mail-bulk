const df = require('durable-functions');
const crypto = require('crypto');
const { prisma } = require('../prisma');
const { sendEmail } = require('../email');
const { renderTemplate } = require('../templates-service');
const { checkUploadCompletion } = require('../upload-helpers');

async function sendEmailActivity(input, context) {
  const { uploadId, templateId, contact } = input;

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) {
    throw new Error(`Template ${templateId} not found`);
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const token = crypto
    .createHash('sha256')
    .update(contact.email + 'desire-unsubscribe-salt')
    .digest('hex')
    .substring(0, 32);
  const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

  const rendered = renderTemplate(
    { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
    { name: contact.name, email: contact.email, unsubscribeLink }
  );

  let sent = false;
  let lastError = null;
  let deliveryProvider = null;

  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      const result = await sendEmail({ to: contact.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
      sent = true;
      deliveryProvider = result.provider;
      context.log(`Sent to ${contact.email} via ${result.provider} (attempt ${attempt + 1})`);
    } catch (err) {
      lastError = err;
      context.log(`Attempt ${attempt + 1}/3 failed for ${contact.email}: ${err.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      deliveryStatus: sent ? 'sent' : 'failed',
      deliveryError: sent ? null : (lastError?.message || 'Failed to deliver email'),
      deliveryProvider,
      sentAt: new Date(),
    },
  });

  await prisma.upload.update({
    where: { id: uploadId },
    data: {
      sentCount: sent ? { increment: 1 } : undefined,
      failedCount: !sent ? { increment: 1 } : undefined,
      pendingCount: { decrement: 1 },
    },
  });

  await checkUploadCompletion(uploadId);

  return { sent, contactId: contact.id };
}

df.app.activity('sendEmailActivity', { handler: sendEmailActivity });

module.exports = { sendEmailActivity };
