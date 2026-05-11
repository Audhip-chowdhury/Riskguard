import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { AppError } from '../middleware/error-handler';
import { getCollectionsQueue, assignAgent } from '../services/collections.service';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const assignAgentSchema = z.object({
  agent_user_id: z.string().uuid(),
  notes: z.string().optional(),
});

// ─── GET /api/v1/collections/queue ───────────────────────────────────────────

router.get('/queue', auth, (req: Request, res: Response) => {
  const user = req.user!;

  const allowedRoles = ['collections_agent', 'senior_underwriter', 'admin'];
  if (!allowedRoles.includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Insufficient role to view collections queue');
  }

  const { data, meta } = getCollectionsQueue(req.query as Record<string, unknown>, user);
  return res.json({ success: true, data, meta });
});

// ─── POST /api/v1/collections/:id/assign-agent ───────────────────────────────

router.post('/:id/assign-agent', auth, (req: Request, res: Response) => {
  const user = req.user!;

  if (user.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only admin can assign collections agents');
  }

  const { agent_user_id, notes } = assignAgentSchema.parse(req.body);
  const result = assignAgent(req.params.id, agent_user_id, user.id, notes);

  return res.status(201).json({ success: true, data: result });
});

export default router;
