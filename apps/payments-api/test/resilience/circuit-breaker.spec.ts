import { describe, expect, it } from 'vitest';
import { CircuitBreaker, type CircuitState } from '../../src/resilience/circuit-breaker.js';

function breaker(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let now = 0;
  const transitions: Array<[CircuitState, CircuitState]> = [];
  const instance = new CircuitBreaker(
    { windowSize: 10, minimumCalls: 5, failureRateThreshold: 50, openMs: 1_000, halfOpenMaxCalls: 1, ...overrides },
    (from, to) => transitions.push([from, to]),
    () => now,
  );
  return { instance, transitions, advance: (ms: number) => { now += ms; } };
}

function call(instance: CircuitBreaker, outcome: 'success' | 'failure' | 'ignored') {
  const token = instance.tryAcquire();
  expect(token).toBeDefined();
  instance.record(token!, outcome);
}

describe('CircuitBreaker', () => {
  it('stays closed until the window has the minimum number of calls', () => {
    const { instance } = breaker();
    for (let index = 0; index < 4; index += 1) call(instance, 'failure');
    expect(instance.snapshot().state).toBe('CLOSED');
    call(instance, 'failure');
    expect(instance.snapshot().state).toBe('OPEN');
  });

  it('opens when the failure rate reaches the threshold', () => {
    const { instance, transitions } = breaker();
    for (const outcome of ['success', 'failure', 'success', 'failure', 'success', 'failure'] as const) call(instance, outcome);
    expect(instance.snapshot().state).toBe('OPEN');
    expect(transitions).toEqual([['CLOSED', 'OPEN']]);
  });

  it('only counts the last windowSize calls', () => {
    const { instance } = breaker({ windowSize: 4, minimumCalls: 4 });
    for (const outcome of ['failure', 'success', 'success', 'success', 'success'] as const) call(instance, outcome);
    expect(instance.snapshot()).toMatchObject({ state: 'CLOSED', windowCalls: 4, windowFailures: 0 });
  });

  it('ignores outcomes that say nothing about the dependency health', () => {
    const { instance } = breaker();
    for (let index = 0; index < 10; index += 1) call(instance, 'ignored');
    expect(instance.snapshot()).toMatchObject({ state: 'CLOSED', windowCalls: 0 });
  });

  it('rejects immediately while open and counts the rejections', () => {
    const { instance } = breaker({ minimumCalls: 1 });
    call(instance, 'failure');
    expect(instance.tryAcquire()).toBeUndefined();
    expect(instance.tryAcquire()).toBeUndefined();
    expect(instance.snapshot()).toMatchObject({ state: 'OPEN', rejectedCalls: 2, openedCount: 1 });
  });

  it('lets a single probe through after openMs and closes when it succeeds', () => {
    const { instance, advance, transitions } = breaker({ minimumCalls: 1 });
    call(instance, 'failure');
    advance(1_000);
    const probe = instance.tryAcquire();
    expect(probe).toBeDefined();
    expect(instance.snapshot().state).toBe('HALF_OPEN');
    expect(instance.tryAcquire()).toBeUndefined();
    instance.record(probe!, 'success');
    expect(instance.snapshot().state).toBe('CLOSED');
    expect(transitions.map(([, to]) => to)).toEqual(['OPEN', 'HALF_OPEN', 'CLOSED']);
  });

  it('reopens when the half-open probe fails', () => {
    const { instance, advance } = breaker({ minimumCalls: 1 });
    call(instance, 'failure');
    advance(1_000);
    call(instance, 'failure');
    expect(instance.snapshot()).toMatchObject({ state: 'OPEN', openedCount: 2 });
  });

  it('releases the half-open slot when the probe result is ignored', () => {
    const { instance, advance } = breaker({ minimumCalls: 1 });
    call(instance, 'failure');
    advance(1_000);
    call(instance, 'ignored');
    expect(instance.snapshot().state).toBe('HALF_OPEN');
    expect(instance.tryAcquire()).toBeDefined();
  });

  it('does not let a result from a previous state change the current one', () => {
    const { instance, advance } = breaker({ minimumCalls: 1 });
    const slow = instance.tryAcquire()!;
    call(instance, 'failure');
    advance(1_000);
    const probe = instance.tryAcquire()!;
    instance.record(slow, 'failure');
    expect(instance.snapshot().state).toBe('HALF_OPEN');
    instance.record(probe, 'success');
    expect(instance.snapshot().state).toBe('CLOSED');
  });
});
