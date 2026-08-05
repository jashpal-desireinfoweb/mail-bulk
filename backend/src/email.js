const { EmailClient } = require('@azure/communication-email');
const { Resend } = require('resend');
const sgMail = require('@sendgrid/mail');
const brevo = require('@getbrevo/brevo');
const Mailjet = require('node-mailjet');
const { MailerSend, EmailParams, Sender, Recipient } = require('mailersend');
const { ClientSecretCredential } = require('@azure/identity');

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

const MS_GRAPH_TENANT_ID = process.env.MS_GRAPH_TENANT_ID || '';
const MS_GRAPH_CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID || '';
const MS_GRAPH_CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET || '';
const MS_GRAPH_SENDER_EMAIL = process.env.MS_GRAPH_SENDER_EMAIL || '';

const isBrevoConfigured = BREVO_API_KEY.trim() !== '';
const isResendConfigured = RESEND_API_KEY.trim() !== '';
const isSendGridConfigured = SENDGRID_API_KEY.trim() !== '';
const isMailjetConfigured = MAILJET_API_KEY.trim() !== '' && MAILJET_API_SECRET.trim() !== '';
const isMailerSendConfigured = MAILERSEND_API_KEY.trim() !== '';
const isGraphConfigured =
  MS_GRAPH_TENANT_ID.trim() !== '' && MS_GRAPH_CLIENT_ID.trim() !== '' &&
  MS_GRAPH_CLIENT_SECRET.trim() !== '' && MS_GRAPH_SENDER_EMAIL.trim() !== '';
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
const graphCredential = isGraphConfigured
  ? new ClientSecretCredential(MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET)
  : null;

// Cache the app-only Graph token between sends (tokens are valid ~1hr) instead
// of requesting a new one per email.
let cachedGraphToken = null;
async function getGraphToken() {
  if (cachedGraphToken && cachedGraphToken.expiresOnTimestamp > Date.now() + 60000) {
    return cachedGraphToken.token;
  }
  const tokenResponse = await graphCredential.getToken('https://graph.microsoft.com/.default');
  cachedGraphToken = tokenResponse;
  return tokenResponse.token;
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

// Uses Microsoft Graph's application-permission sendMail endpoint (OAuth
// client-credentials auth) instead of SMTP basic auth -- this sidesteps the
// SMTP AUTH / Security Defaults / per-user MFA restrictions entirely, since
// it's a first-party authenticated API call rather than an external SMTP
// relay, which also avoids the same-tenant anti-spoofing quarantine issue
// that blocked plain SMTP sends between desireinfoweb.in and .com earlier.
async function sendViaGraph(options) {
  if (!isGraphConfigured) throw new Error('Microsoft Graph is not configured');
  const token = await getGraphToken();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_GRAPH_SENDER_EMAIL)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: options.subject,
          body: { contentType: 'HTML', content: options.html },
          toRecipients: [{ emailAddress: { address: options.to } }],
        },
        saveToSentItems: true,
      }),
    }
  );

  if (res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph sendMail failed (${res.status}): ${body || res.statusText}`);
  }
  // sendMail returns 202 Accepted with no body/message id
  return 'accepted';
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
})).concat([{ name: 'graph', configured: isGraphConfigured, dailyLimit: null }]);

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

  // Last-resort fallback: Microsoft Graph API (app-only auth), replacing the
  // previous raw-SMTP fallback.
  try {
    const messageId = await sendViaGraph(options);
    console.log(`Email sent via Microsoft Graph to ${options.to}: ${messageId}`);
    return { messageId, provider: 'graph' };
  } catch (graphError) {
    errors.push(`graph: ${graphError.message}`);
    console.error(`Microsoft Graph failed for ${options.to}: ${graphError.message}`);
    throw new Error(`All email providers failed. Errors: ${errors.join(' | ')}`);
  }
}

module.exports = { sendEmail, PROVIDER_META };
