import type { CircuitBreakerConfig } from '../config.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Resultado de una llamada para el circuito. `ignored` libera la sonda sin
 * contar como éxito ni falla (por ejemplo, una respuesta 4xx de la pasarela que
 * no dice nada sobre su salud).
 */
export type CallOutcome = 'success' | 'failure' | 'ignored';

export interface CircuitSnapshot {
  readonly enabled: boolean;
  readonly state: CircuitState;
  readonly windowCalls: number;
  readonly windowFailures: number;
  readonly failureRatePercent: number;
  readonly openedCount: number;
  readonly rejectedCalls: number;
  readonly successCalls: number;
  readonly failedCalls: number;
}

/**
 * Circuit Breaker por conteo (ventana de las últimas N llamadas).
 *
 * CLOSED: deja pasar todo y abre cuando la ventana tiene al menos
 * `minimumCalls` y la tasa de fallas alcanza el umbral.
 * OPEN: rechaza sin llamar durante `openMs`.
 * HALF_OPEN: deja pasar hasta `halfOpenMaxCalls` sondas; una falla reabre y
 * el éxito de todas cierra.
 *
 * Cada cambio de estado incrementa `generation`; el resultado de una llamada
 * admitida en otra generación no altera el estado actual.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private window: boolean[] = [];
  private openedAt = 0;
  private generation = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;
  private openedCount = 0;
  private rejectedCalls = 0;
  private successCalls = 0;
  private failedCalls = 0;

  constructor(
    private readonly options: Omit<CircuitBreakerConfig, 'enabled'>,
    private readonly onTransition: (from: CircuitState, to: CircuitState) => void = () => undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Devuelve un token para `record`, o `undefined` si el circuito rechaza la llamada. */
  tryAcquire(): number | undefined {
    this.refresh();
    if (this.state === 'OPEN') {
      this.rejectedCalls += 1;
      return undefined;
    }
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenInFlight >= this.options.halfOpenMaxCalls) {
        this.rejectedCalls += 1;
        return undefined;
      }
      this.halfOpenInFlight += 1;
    }
    return this.generation;
  }

  record(token: number, outcome: CallOutcome): void {
    if (outcome === 'success') this.successCalls += 1;
    if (outcome === 'failure') this.failedCalls += 1;
    if (token !== this.generation) return;

    if (this.state === 'HALF_OPEN') {
      this.halfOpenInFlight -= 1;
      if (outcome === 'failure') {
        this.transition('OPEN');
      } else if (outcome === 'success') {
        this.halfOpenSuccesses += 1;
        if (this.halfOpenSuccesses >= this.options.halfOpenMaxCalls) this.transition('CLOSED');
      }
      return;
    }

    if (this.state !== 'CLOSED' || outcome === 'ignored') return;
    this.window.push(outcome === 'failure');
    if (this.window.length > this.options.windowSize) this.window.shift();
    if (this.window.length >= this.options.minimumCalls
      && this.failureRate() >= this.options.failureRateThreshold) {
      this.transition('OPEN');
    }
  }

  snapshot(): Omit<CircuitSnapshot, 'enabled'> {
    this.refresh();
    return {
      state: this.state,
      windowCalls: this.window.length,
      windowFailures: this.window.filter(Boolean).length,
      failureRatePercent: Math.round(this.failureRate() * 10) / 10,
      openedCount: this.openedCount,
      rejectedCalls: this.rejectedCalls,
      successCalls: this.successCalls,
      failedCalls: this.failedCalls,
    };
  }

  private failureRate(): number {
    if (this.window.length === 0) return 0;
    return (this.window.filter(Boolean).length / this.window.length) * 100;
  }

  private refresh(): void {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= this.options.openMs) this.transition('HALF_OPEN');
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.generation += 1;
    this.window = [];
    this.halfOpenInFlight = 0;
    this.halfOpenSuccesses = 0;
    if (to === 'OPEN') {
      this.openedAt = this.now();
      this.openedCount += 1;
    }
    this.onTransition(from, to);
  }
}
