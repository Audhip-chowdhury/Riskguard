// STUB: Replace when ComplyHub is built.

export async function checkKyc(_borrowerId: string) {
  return { status: 'passed' as const, verified_at: new Date().toISOString() };
}

export async function screenAml(_transactionId: string, _amount: string) {
  return { flagged: false };
}

export async function logAuditEvent(_event: object) {
  return { status: 'ok' };
}
