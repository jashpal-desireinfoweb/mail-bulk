const { EmailClient } = require('@azure/communication-email');
const nodemailer = require('nodemailer');

const AZURE_COMMUNICATION_CONNECTION_STRING = process.env.AZURE_COMMUNICATION_CONNECTION_STRING || '';
const AZURE_COMMUNICATION_FROM_EMAIL = process.env.AZURE_COMMUNICATION_FROM_EMAIL || 'donotreply@yourdomain.com';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Desire Mail';

// Initialize Azure Communication Services Email Client
const isAzureConfigured = 
  AZURE_COMMUNICATION_CONNECTION_STRING && 
  AZURE_COMMUNICATION_CONNECTION_STRING.trim() !== '' &&
  !AZURE_COMMUNICATION_CONNECTION_STRING.includes('your-resource');

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

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const isResendConfigured = RESEND_API_KEY && RESEND_API_KEY.trim() !== '' && !RESEND_API_KEY.includes('your-key');

async function sendViaResend(options) {
  const fromAddress = process.env.RESEND_FROM_EMAIL || (SMTP_USER ? `${SMTP_FROM_NAME} <${SMTP_USER}>` : 'onboarding@resend.dev');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY.trim()}`,
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Resend API error (${response.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data.id || 'resend-ok';
}

async function sendEmail(options) {
  if (isResendConfigured) {
    try {
      const messageId = await sendViaResend(options);
      console.log(`Email sent via Resend HTTPS API to ${options.to}: ${messageId}`);
      return { messageId, provider: 'resend' };
    } catch (resendError) {
      console.warn(
        `Resend API failed for ${options.to}: ${resendError.message}. Falling back to next provider.`,
      );
    }
  }

  if (isAzureConfigured) {
    try {
      const messageId = await sendViaAzure(options);
      console.log(`Email sent via Azure Communication Services to ${options.to}: ${messageId}`);
      return { messageId, provider: 'azure' };
    } catch (azureError) {
      console.warn(
        `Azure Communication Services failed for ${options.to}: ${azureError.message}. Falling back to SMTP.`,
      );
    }
  }

  try {
    const messageId = await sendViaSMTP(options);
    console.log(`Email sent via SMTP to ${options.to}: ${messageId}`);
    return { messageId, provider: 'smtp' };
  } catch (smtpError) {
    console.error(
      `SMTP failed for ${options.to}: ${smtpError.message}`,
    );
    throw new Error(
      `All email providers failed. SMTP Error: ${smtpError.message}`,
    );
  }
}

module.exports = { sendEmail };
