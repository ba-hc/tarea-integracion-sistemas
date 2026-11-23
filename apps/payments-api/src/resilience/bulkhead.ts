export interface BulkheadSnapshot {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  readonly inFlight: number;
  readonly peakInFlight: number;
  readonly rejectedCalls: number;
}

/** Limita las llamadas simultáneas a la pasarela. Sin cola: si está lleno, rechaza al instante. */
export class Bulkhead {
  private inFlight = 0;
  private peakInFlight = 0;
  private rejectedCalls = 0;

  constructor(private readonly maxConcurrent: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.maxConcurrent) {
      this.rejectedCalls += 1;
      return false;
    }
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  snapshot(): Omit<BulkheadSnapshot, 'enabled'> {
    return {
      maxConcurrent: this.maxConcurrent,
      inFlight: this.inFlight,
      peakInFlight: this.peakInFlight,
      rejectedCalls: this.rejectedCalls,
    };
  }
}
