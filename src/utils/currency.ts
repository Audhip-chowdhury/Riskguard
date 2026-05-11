export function paisaToSim(paise: number): string {
  return (paise / 100).toFixed(2);
}

export function simToPaisa(sim: string): number {
  return Math.round(parseFloat(sim) * 100);
}
