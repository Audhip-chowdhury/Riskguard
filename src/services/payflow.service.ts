import { request } from 'undici';
import { config } from '../config';

const PAYFLOW_BASE = config.payflowBaseUrl;
const PAYFLOW_KEY = config.payflowApiKey;

export async function transferFromPayFlow(params: {
  fromWalletId: string;
  toWalletId: string;
  amount: string;
  description: string;
  idempotencyKey: string;
}) {
  const res = await request(`${PAYFLOW_BASE}/api/v1/transfers`, {
    method: 'POST',
    headers: {
      'X-API-Key': PAYFLOW_KEY,
      'Idempotency-Key': params.idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender_wallet_id: params.fromWalletId,
      receiver_wallet_id: params.toWalletId,
      amount: params.amount,
      description: params.description,
    }),
  });
  const body = await res.body.json();
  if (res.statusCode >= 400) throw new Error(`PayFlow error: ${JSON.stringify(body)}`);
  return body;
}

export async function getWalletBalance(walletId: string) {
  const res = await request(`${PAYFLOW_BASE}/api/v1/wallets/${walletId}`, {
    method: 'GET',
    headers: { 'X-API-Key': PAYFLOW_KEY },
  });
  return res.body.json();
}
