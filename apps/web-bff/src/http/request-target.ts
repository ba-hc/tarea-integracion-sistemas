import { ValidationError } from './errors.js';

export interface ParsedTarget {
  readonly path: string;
  readonly query: string;
}

const ENCODED_SEPARATOR = /%(?:2f|5c|2e)/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function parseTarget(rawUrl: string | undefined): ParsedTarget {
  if (!rawUrl || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('#')) {
    throw new ValidationError();
  }

  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);

  if (
    !path.startsWith('/')
    || path.includes('\\')
    || path.includes('//')
    || path.length > 1 && path.endsWith('/')
    || ENCODED_SEPARATOR.test(path)
    || CONTROL_CHARACTER.test(path)
  ) {
    throw new ValidationError();
  }

  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') throw new ValidationError();
  }

  return { path, query };
}
