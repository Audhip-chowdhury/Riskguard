import app from './app';
import { config } from './config';

app.listen(config.port, () => {
  console.log(`RiskGuard listening on port ${config.port}`);
});
