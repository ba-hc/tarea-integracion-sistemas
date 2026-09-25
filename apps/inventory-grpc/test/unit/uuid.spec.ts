import { describe, expect, it } from 'vitest';
import { isUuid } from '../../src/common/uuid.js';

describe('isUuid', () => {
  it.each([
    'd6e1fd98-cb07-458f-aa12-6fe220b37604',
    'D6E1FD98-CB07-458F-AA12-6FE220B37604',
    '00000000-0000-0000-0000-000000000000',
  ])('acepta %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    '',
    'nope',
    'd6e1fd98cb07458faa126fe220b37604',
    'd6e1fd98-cb07-458f-aa12-6fe220b3760',
    'd6e1fd98-cb07-458f-aa12-6fe220b37604 ',
    'g6e1fd98-cb07-458f-aa12-6fe220b37604',
    "d6e1fd98-cb07-458f-aa12-6fe220b37604'; --",
  ])('rechaza %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });

  it('rechaza valores que no son string', () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
