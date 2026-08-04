const { EmailClient } = require('@azure/communication-email');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const sgMail = require('@sendgrid/mail');
const brevo = require('@getbrevo/brevo');
const Mailjet = require('node-mailjet');
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');

const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || '';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Desire Mail';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const MAILJET_API_KEY = process.env.MAILJET_API_KEY || '';
const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET || '';
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY || '';

const AZURE_COMMUNICATION_CONNECTION_STRING = process.env.AZURE_COMMUNICATION_CONNECTION_STRING || '';
const AZURE_COMMUNICATION_FROM_EMAIL = process.env.AZURE_COMMUNICATION_FROM_EMAIL || 'donotreply@yourdomain.com';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Desire Mail';

const isBrevoConfigured = BREVO_API_KEY.trim() !== '';
const isResendConfigured = RESEND_API_KEY.trim() !== '';
const isSendGridConfigured = SENDGRID_API_KEY.trim() !== '';
const isMailjetConfigured = MAILJET_API_KEY.trim() !== '' && MAILJET_API_SECRET.trim() !== '';
const isMailerSendConfigured = MAILERSEND_API_KEY.trim() !== '';
const isAzureConfigured =
  AZURE_COMMUNICATION_CONNECTION_STRING &&
  AZURE_COMMUNICATION_CONNECTION_STRING.trim() !== '' &&
  !AZURE_COMMUNICATION_CONNECTION_STRING.includes('your-resource');

const brevoClient = isBrevoConfigured ? new brevo.BrevoClient({ apiKey: BREVO_API_KEY }) : null;
const resendClient = isResendConfigured ? new Resend(RESEND_API_KEY) : null;
if (isSendGridConfigured) sgMail.setApiKey(SENDGRID_API_KEY);
const mailjetClient = isMailjetConfigured ? Mailjet.apiConnect(MAILJET_API_KEY, MAILJET_API_SECRET) : null;
const mailerSendClient = isMailerSendConfigured ? new MailerSend({ apiKey: MAILERSEND_API_KEY }) : null;
const azureEmailClient = isAzureConfigured ? new EmailClient(AZURE_COMMUNICATION_CONNECTION_STRING) : null;

function createDynamicTransporter(hostOverride) {
  return nodemailer.createTransport({
    host: hostOverride || SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    requireTLS: SMTP_PORT === 587,
    family: 4,               // Force IPv4 lookup to prevent IPv6 socket blackholes
    pool: false,             // Fresh connection per email for STARTTLS stability
    connectionTimeout: 12000, // 12 seconds timeout for rapid failover
    greetingTimeout: 12000,   // 12 seconds greeting timeout
    socketTimeout: 30000,     // 30 seconds socket inactivity timeout
    tls: {
      rejectUnauthorized: false,
    },
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendViaBrevo(options) {
  if (!brevoClient) throw new Error('Brevo is not configured');
  const result = await brevoClient.transactionalEmails.sendTransacEmail({
    sender: { email: EMAIL_FROM_ADDRESS, name: EMAIL_FROM_NAME },
    to: [{ email: options.to }],
    subject: options.subject,
    htmlContent: options.html,
    textContent: options.text,
  });
  return result?.body?.messageId || result?.messageId || 'unknown';
}

async function sendViaResend(options) {
  if (!resendClient) throw new Error('Resend is not configured');
  const { data, error } = await resendClient.emails.send({
    from: `${EMAIL_FROM_NAME} <${EMAIL_FROM_ADDRESS}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  if (error) throw new Error(error.message || 'Resend send failed');
  return data?.id || 'unknown';
}

async function sendViaSendGrid(options) {
  if (!isSendGridConfigured) throw new Error('SendGrid is not configured');
  const [response] = await sgMail.send({
    from: { email: EMAIL_FROM_ADDRESS, name: EMAIL_FROM_NAME },
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  return response?.headers?.['x-message-id'] || 'unknown';
}

async function sendViaMailjet(options) {
  if (!mailjetClient) throw new Error('Mailjet is not configured');
  const result = await mailjetClient.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: { Email: EMAIL_FROM_ADDRESS, Name: EMAIL_FROM_NAME },
        To: [{ Email: options.to }],
        Subject: options.subject,
        HTMLPart: options.html,
        TextPart: options.text,
      },
    ],
  });
  const messageResult = result?.body?.Messages?.[0];
  if (messageResult?.Status !== 'success') {
    throw new Error(messageResult?.Errors?.[0]?.ErrorMessage || 'Mailjet send failed');
  }
  return messageResult?.To?.[0]?.MessageID || 'unknown';
}

async function sendViaMailerSend(options) {
  if (!mailerSendClient) throw new Error('MailerSend is not configured');
  const emailParams = new EmailParams()
    .setFrom(new Sender(EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME))
    .setTo([new Recipient(options.to)])
    .setSubject(options.subject)
    .setHtml(options.html)
    .setText(options.text);
  const response = await mailerSendClient.email.send(emailParams);
  return response?.headers?.['x-message-id'] || response?.body?.message_id || 'unknown';
}

async function sendViaAzure(options) {
  if (!azureEmailClient) {
    throw new Error('Azure Communication Services client is not initialized');
  }
  const emailMessage = {
    senderAddress: AZURE_COMMUNICATION_FROM_EMAIL,
    content: {
      subject: options.subject,
      plainText: options.text,
      html: options.html,
    },
    recipients: {
      to: [{ address: options.to }],
    },
  };

  const poller = await azureEmailClient.beginSend(emailMessage);
  const result = await poller.pollUntilDone();
  return result.messageId || result.id || 'unknown';
}

async function sendViaSMTP(options) {
  const fromAddress = SMTP_USER ? `${SMTP_FROM_NAME} <${SMTP_USER}>` : AZURE_COMMUNICATION_FROM_EMAIL;

  try {
    const primaryTransporter = createDynamicTransporter(SMTP_HOST);
    const info = await primaryTransporter.sendMail({
      from: fromAddress,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    return info.messageId || 'unknown';
  } catch (err) {
    // If primary host timed out and using Office 365, attempt failover host
    const isTimeout = err.message?.toLowerCase().includes('timeout') || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET';
    if (isTimeout && SMTP_HOST.includes('office365.com')) {
      console.warn(`[SMTP Failover] Primary host ${SMTP_HOST} timed out for ${options.to}. Retrying via fallback host smtp-mail.outlook.com...`);
      const fallbackTransporter = createDynamicTransporter('smtp-mail.outlook.com');
      const info = await fallbackTransporter.sendMail({
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });
      return info.messageId || 'unknown';
    }
    throw err;
  }
}

// Fallback chain, tried in order until one succeeds. Each provider's free tier
// covers a slice of daily volume; falling through on any error (including
// rate-limit/quota errors, which providers surface as thrown errors) means no
// manual send-count tracking is needed.
const PROVIDER_CHAIN = [
  { name: 'brevo', configured: isBrevoConfigured, send: sendViaBrevo, dailyLimit: 300 },
  { name: 'resend', configured: isResendConfigured, send: sendViaResend, dailyLimit: 100 },
  { name: 'sendgrid', configured: isSendGridConfigured, send: sendViaSendGrid, dailyLimit: 100 },
  { name: 'mailjet', configured: isMailjetConfigured, send: sendViaMailjet, dailyLimit: 200 },
  { name: 'mailersend', configured: isMailerSendConfigured, send: sendViaMailerSend, dailyLimit: 100 },
  { name: 'azure', configured: isAzureConfigured, send: sendViaAzure, dailyLimit: null },
];

// Exposed for the /api/providers/usage endpoint — daily limits are the
// documented free-tier caps for each provider, used to estimate remaining
// capacity against our own send counts (not each provider's live account
// balance, since not all providers expose that via API).
const PROVIDER_META = PROVIDER_CHAIN.map((p) => ({
  name: p.name,
  configured: p.configured,
  dailyLimit: p.dailyLimit,
})).concat([{ name: 'smtp', configured: true, dailyLimit: null }]);

async function sendEmail(options) {
  const errors = [];

  for (const provider of PROVIDER_CHAIN) {
    if (!provider.configured) continue;
    try {
      const messageId = await provider.send(options);
      console.log(`Email sent via ${provider.name} to ${options.to}: ${messageId}`);
      return { messageId, provider: provider.name };
    } catch (err) {
      console.warn(`${provider.name} failed for ${options.to}: ${err.message}. Trying next provider.`);
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  // Last-resort fallback: existing Office 365 SMTP transport
  try {
    const messageId = await sendViaSMTP(options);
    console.log(`Email sent via SMTP to ${options.to}: ${messageId}`);
    return { messageId, provider: 'smtp' };
  } catch (smtpError) {
    errors.push(`smtp: ${smtpError.message}`);
    console.error(`SMTP failed for ${options.to}: ${smtpError.message}`);
    throw new Error(`All email providers failed. Errors: ${errors.join(' | ')}`);
  }
}

module.exports = { sendEmail, PROVIDER_META };
