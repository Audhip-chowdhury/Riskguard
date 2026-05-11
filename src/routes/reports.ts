import { Router, Request, Response } from 'express';
import { auth } from '../middleware/auth';
import { AppError } from '../middleware/error-handler';
import {
  getPortfolioDashboard,
  getAgingReport,
  getVintageReport,
  getConcentrationReport,
  computeEcl,
} from '../services/reporting.service';

const router = Router();

const ALLOWED_ROLES = ['admin', 'senior_underwriter'];

function requireReportingRole(req: Request) {
  const user = req.user!;
  if (!ALLOWED_ROLES.includes(user.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Reporting endpoints require admin or senior_underwriter role');
  }
}

// GET /api/v1/reports/portfolio
router.get('/portfolio', auth, (req: Request, res: Response) => {
  requireReportingRole(req);

  const asOfDate = (req.query.as_of_date as string) || new Date().toISOString().slice(0, 10);
  const compareWith = req.query.compare_with as string | undefined;

  const data = getPortfolioDashboard(asOfDate, compareWith);
  res.json({ success: true, data });
});

// GET /api/v1/reports/aging
router.get('/aging', auth, (req: Request, res: Response) => {
  requireReportingRole(req);

  const asOfDate = (req.query.as_of_date as string) || new Date().toISOString().slice(0, 10);

  const data = getAgingReport(asOfDate);
  res.json({ success: true, data });
});

// GET /api/v1/reports/vintage
router.get('/vintage', auth, (req: Request, res: Response) => {
  requireReportingRole(req);

  const periodMonths = parseInt(req.query.period_months as string, 10) || 12;
  if (isNaN(periodMonths) || periodMonths < 1 || periodMonths > 120) {
    throw new AppError(400, 'VALIDATION_ERROR', 'period_months must be between 1 and 120');
  }

  const data = getVintageReport(periodMonths);
  res.json({ success: true, data });
});

// GET /api/v1/reports/concentration
router.get('/concentration', auth, (req: Request, res: Response) => {
  requireReportingRole(req);

  const cut = req.query.cut as string;
  if (!cut) {
    throw new AppError(400, 'VALIDATION_ERROR', 'cut query parameter is required');
  }

  const data = getConcentrationReport(cut);
  res.json({ success: true, data });
});

// GET /api/v1/reports/ecl
router.get('/ecl', auth, (req: Request, res: Response) => {
  requireReportingRole(req);

  const asOfDate = (req.query.as_of_date as string) || new Date().toISOString().slice(0, 10);

  const data = computeEcl(asOfDate);
  res.json({ success: true, data });
});

export default router;
