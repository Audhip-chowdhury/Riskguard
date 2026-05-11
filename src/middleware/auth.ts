import { Request, Response, NextFunction } from 'express';
import db from '../db';
import { User } from '../types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function auth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing X-API-Key header' },
    });
  }

  const user = db
    .prepare('SELECT id, username, email, api_key, role, is_active FROM users WHERE api_key = ? AND is_active = 1')
    .get(apiKey) as User | undefined;

  if (!user) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid API key' },
    });
  }

  req.user = user;
  next();
}
