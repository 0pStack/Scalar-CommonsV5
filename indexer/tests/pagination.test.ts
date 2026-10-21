import { describe, it, expect } from 'vitest';

import { parsePage, parseOptionalInteger, DEFAULT_LIMIT, MAX_LIMIT, InvalidQueryError } from '../src/pagination.ts';

/**
 * Every list endpoint is a window onto an unbounded chain. The paging rules are
 * the only thing standing between a client typo (`?limit=99999999`) and the API
 * trying to serialise the whole index into one response, so they are pinned here.
 */

const page = (qs: string) => parsePage(new URLSearchParams(qs));

describe('parsePage', () => {
  it('defaults to the first page when nothing is asked for', () => {
    expect(page('')).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('honours an explicit limit and offset', () => {
    expect(page('limit=5&offset=10')).toEqual({ limit: 5, offset: 10 });
  });

  it('caps the limit rather than trusting the client', () => {
    expect(page(`limit=${MAX_LIMIT + 1}`)).toEqual({ limit: MAX_LIMIT, offset: 0 });
    expect(page('limit=100000')).toEqual({ limit: MAX_LIMIT, offset: 0 });
  });

  it('rejects a limit below one instead of silently returning nothing', () => {
    expect(() => page('limit=0')).toThrow(InvalidQueryError);
    expect(() => page('limit=-1')).toThrow(InvalidQueryError);
  });

  it('rejects non-integer paging values', () => {
    expect(() => page('limit=abc')).toThrow(InvalidQueryError);
    expect(() => page('offset=1.5')).toThrow(InvalidQueryError);
    expect(() => page('offset=-3')).toThrow(InvalidQueryError);
  });

  it('accepts a zero offset explicitly', () => {
    expect(page('offset=0')).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('rejects an offset too large to represent exactly', () => {
    // 2^63 reached SQLite as a double it cannot bind and came back as a 500.
    expect(() => page('offset=9223372036854775808')).toThrow(InvalidQueryError);
    // Below 2^63 it binds, but past 2^53 it has already been silently rounded.
    expect(() => page(`offset=${Number.MAX_SAFE_INTEGER + 1}`)).toThrow(InvalidQueryError);
    expect(page(`offset=${Number.MAX_SAFE_INTEGER}`)).toEqual({ limit: DEFAULT_LIMIT, offset: Number.MAX_SAFE_INTEGER });
  });

  it('still clamps a huge limit rather than refusing it', () => {
    expect(page('limit=9223372036854775808')).toEqual({ limit: MAX_LIMIT, offset: 0 });
  });
});

describe('parseOptionalInteger', () => {
  const blockNumber = (qs: string) => parseOptionalInteger(new URLSearchParams(qs), 'blockNumber');

  it('is absent when the filter is not given', () => {
    expect(blockNumber('')).toBeUndefined();
  });

  it('rejects a filter too large to represent exactly', () => {
    expect(() => blockNumber('blockNumber=9223372036854775808')).toThrow(InvalidQueryError);
    expect(() => blockNumber(`blockNumber=${Number.MAX_SAFE_INTEGER + 1}`)).toThrow(InvalidQueryError);
    expect(blockNumber(`blockNumber=${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
