import { InvalidRequestTargetError } from './errors.js';

export interface ParsedRequestTarget {
  readonly path: string;
  readonly query: string;
}

const ENCODED_SEPARATOR = /%(?:2f|5c|2e)/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function parseRequestTarget(rawUrl: string | undefined): ParsedRequestTarget {
  if (!rawUrl || !rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('#')) {
    throw new InvalidRequestTargetError();
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
    throw new InvalidRequestTargetError();
  }

  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') throw new InvalidRequestTargetError();
  }

  return { path, query };
}
