import pino from 'pino';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  payflowBaseUrl: process.env.PAYFLOW_BASE_URL || 'http://localhost:3000',
  payflowApiKey: process.env.PAYFLOW_API_KEY || '',
  lendingWalletId: process.env.LENDING_WALLET_ID || '',
};

export const logger = pino({ level: config.logLevel });
