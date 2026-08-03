const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

const ContactStatus = {
  valid: 'valid',
  invalid: 'invalid',
  duplicate: 'duplicate',
  unsubscribed: 'unsubscribed',
};

module.exports = { prisma, ContactStatus };
