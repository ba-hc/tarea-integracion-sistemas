import { ConsoleLogger } from '@nestjs/common';
import { LOG_LEVELS, type AppConfig } from '../config/app-config.js';

/**
 * Logger de todo el servicio. En formato json cada evento es una sola línea
 * JSON y los objetos que se pasan después del mensaje se agregan como campos
 * propios (method, code, traceId...), lo que permite filtrar y correlacionar.
 */
export function createLogger(config: Pick<AppConfig, 'logFormat' | 'logLevel'>): ConsoleLogger {
  const json = config.logFormat === 'json';
  const threshold = LOG_LEVELS.indexOf(config.logLevel);
  return new ConsoleLogger({
    json,
    colors: !json,
    logLevels: LOG_LEVELS.filter((_, index) => index <= threshold),
    structuredParams: true,
    flattenParams: true,
  });
}

const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/**
 * Elimina credenciales de URLs (postgresql://user:pass@host -> postgresql://***@host).
 * Se aplica a mensajes y stacks de errores inesperados antes de registrarlos.
 */
export function redactSecrets(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, '$1***@');
}
