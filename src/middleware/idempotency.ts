import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import db from '../db';

interface IdempotencyRecord {
  key_hash: string;
  request_payload_hash: string;
  response_status: number;
  response_body: string;
}

export function idempotency(req: Request, res: Response, next: NextFunction) {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (!idempotencyKey) return next();

  const apiKey = (req.headers['x-api-key'] as string) || '';
  const keyHash = crypto
    .createHash('sha256')
    .update(`${idempotencyKey}:${req.path}:${apiKey}`)
    .digest('hex');

  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body))
    .digest('hex');

  const existing = db
    .prepare('SELECT * FROM idempotency_store WHERE key_hash = ? AND expires_at > datetime(\'now\')')
    .get(keyHash) as IdempotencyRecord | undefined;

  if (existing) {
    if (existing.request_payload_hash !== payloadHash) {
      return res.status(409).json({
        success: false,
        error: { code: 'CONFLICT', message: 'Idempotency key reused with different payload' },
      });
    }
    return res.status(existing.response_status).json(JSON.parse(existing.response_body));
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      db.prepare(`
        INSERT INTO idempotency_store (key_hash, endpoint, api_key_id, request_payload_hash, response_status, response_body, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(keyHash, req.path, apiKey, payloadHash, res.statusCode, JSON.stringify(body), expiresAt);
    } catch {
      // Race condition: already inserted, ignore
    }
    return originalJson(body);
  };

  next();
}
