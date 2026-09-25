import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/app-config.js';
import { HEALTH_SERVICE_NAMES, HealthService } from '../../src/health/health.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

describe('HealthService', () => {
  const queryRaw = vi.fn();
  const setStatus = vi.fn();
  let service: HealthService;

  const lastStatusFor = (name: string) => setStatus.mock.calls.filter(([n]) => n === name).at(-1)?.[1];

  beforeEach(() => {
    queryRaw.mockReset();
    setStatus.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new HealthService(
      { setStatus } as never,
      { $queryRaw: queryRaw } as unknown as PrismaService,
      { healthCheckIntervalMs: 60_000 } as AppConfig,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parte en NOT_SERVING', () => {
    expect(service.getStatus()).toBe('NOT_SERVING');
  });

  it('SERVING para "" y para el servicio cuando la base responde', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(service.probe()).resolves.toBe('SERVING');

    for (const name of HEALTH_SERVICE_NAMES) {
      expect(lastStatusFor(name)).toBe('SERVING');
    }
    expect(HEALTH_SERVICE_NAMES).toContain('repuestossur.inventory.v1.InventoryService');
  });

  it('NOT_SERVING cuando la base falla, y vuelve a SERVING al recuperarse', async () => {
    queryRaw.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Can't reach database server")).mockResolvedValueOnce([]);

    expect(await service.probe()).toBe('SERVING');
    expect(await service.probe()).toBe('NOT_SERVING');
    expect(await service.probe()).toBe('SERVING');
  });

  it('NOT_SERVING si la base no contesta a tiempo', async () => {
    vi.useFakeTimers();
    queryRaw.mockReturnValue(new Promise(() => undefined));

    const probe = service.probe();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(probe).resolves.toBe('NOT_SERVING');
  });

  it('registra sólo los cambios de estado, no cada sondeo', async () => {
    queryRaw.mockResolvedValue([]);
    const log = vi.mocked(Logger.prototype.log);

    await service.probe();
    await service.probe();
    await service.probe();

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('al apagarse queda en NOT_SERVING aunque la base siga respondiendo', async () => {
    queryRaw.mockResolvedValue([]);
    await service.probe();

    service.markShuttingDown();

    expect(await service.probe()).toBe('NOT_SERVING');
    expect(lastStatusFor('')).toBe('NOT_SERVING');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('onApplicationBootstrap sondea de inmediato y luego cada intervalo', async () => {
    vi.useFakeTimers();
    queryRaw.mockResolvedValue([]);

    await service.onApplicationBootstrap();
    expect(queryRaw).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
