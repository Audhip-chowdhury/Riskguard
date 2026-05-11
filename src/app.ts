import 'express-async-errors';
import express from 'express';
import dotenv from 'dotenv';
import { runMigrations } from './migrate';
import { requestLogger } from './middleware/request-logger';
import { errorHandler } from './middleware/error-handler';
import borrowersRouter from './routes/borrowers';
import loansRouter from './routes/loans';
import disbursementsRouter from './routes/disbursements';
import collectionsRouter from './routes/collections';
import reportsRouter from './routes/reports';

dotenv.config();
runMigrations();

const app = express();
app.use(express.json());
app.use(requestLogger);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'riskguard' }));

app.use('/api/v1/borrowers', borrowersRouter);
app.use('/api/v1/loans', loansRouter);
app.use('/api/v1/disbursements', disbursementsRouter);
app.use('/api/v1/collections', collectionsRouter);
app.use('/api/v1/reports', reportsRouter);

app.use(errorHandler);

export default app;
