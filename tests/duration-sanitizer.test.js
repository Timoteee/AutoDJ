const { sanitizeDuration, isBadDuration, formatDuration, validateTrack, MAX_REASONABLE_SEC } = require('../lib/duration-sanitizer');

describe('sanitizeDuration', () => {
  // Spec table from V7 requirements
  test.each([
    ['1000:30', null],
    ['abc', null],
    [0, null],
    [5, null],
    [350000, 350],
    ['3:45', 225],
    [234, 234],
    [null, null],
    [undefined, null],
  ])('sanitizeDuration(%p) => %p', (input, expected) => {
    expect(sanitizeDuration(input)).toBe(expected);
  });

  test('36001 treated as ms => 36 (numbers > MAX_REASONABLE_SEC are divided by 1000)', () => {
    expect(sanitizeDuration(36001)).toBe(36);
  });

  test('"1:30:15" HH:MM:SS format returns 5415', () => {
    // HH:MM:SS formats produce long durations - the limit is 10h (36000) per spec
    expect(sanitizeDuration('1:30:15')).toBe(5415);
  });

  test('empty string returns null', () => {
    expect(sanitizeDuration('')).toBeNull();
  });

  test('string with whitespace is trimmed', () => {
    expect(sanitizeDuration('  234  ')).toBe(234);
  });

  test('decimal seconds are rounded', () => {
    expect(sanitizeDuration(234.7)).toBe(235);
  });

  test('very large number > 1e12 returns null (too large to be ms)', () => {
    expect(sanitizeDuration(9999999999999)).toBeNull();
  });

  test('string with only spaces returns null', () => {
    expect(sanitizeDuration('   ')).toBeNull();
  });

  test('negative number returns null', () => {
    expect(sanitizeDuration(-5)).toBeNull();
  });

  test('"0:30" MM:SS format (30 seconds)', () => {
    expect(sanitizeDuration('0:30')).toBe(30);
  });

  test('"10:00" MM:SS format (10 minutes = 600s) - at boundary', () => {
    expect(sanitizeDuration('10:00')).toBe(600);
  });

  test('"11:00" MM:SS format (11 minutes = 660s) - valid', () => {
      expect(sanitizeDuration('11:00')).toBe(660);
    });
});

describe('isBadDuration', () => {
  test('null returns true', () => {
    expect(isBadDuration(null)).toBe(true);
  });

  test('undefined returns true', () => {
    expect(isBadDuration(undefined)).toBe(true);
  });

  test('NaN returns true', () => {
    expect(isBadDuration(NaN)).toBe(true);
  });

  test('valid number returns false', () => {
    expect(isBadDuration(234)).toBe(false);
  });

  test('0 returns false (0 is a valid numeric duration)', () => {
    expect(isBadDuration(0)).toBe(false);
  });

  test('Infinity returns true', () => {
    expect(isBadDuration(Infinity)).toBe(true);
  });

  test('negative numbers return false (they are finite numbers)', () => {
    expect(isBadDuration(-5)).toBe(false);
  });
});

describe('formatDuration', () => {
  test('234 seconds => "3:54"', () => {
    expect(formatDuration(234)).toBe('3:54');
  });

  test('null => "---"', () => {
    expect(formatDuration(null)).toBe('---');
  });

  test('undefined => "---"', () => {
    expect(formatDuration(undefined)).toBe('---');
  });

  test('NaN => "---"', () => {
    expect(formatDuration(NaN)).toBe('---');
  });

  test('0 => "0:00"', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  test('90 => "1:30"', () => {
    expect(formatDuration(90)).toBe('1:30');
  });

  test('60 => "1:00"', () => {
    expect(formatDuration(60)).toBe('1:00');
  });

  test('3600 => "60:00" (1 hour in seconds)', () => {
    expect(formatDuration(3600)).toBe('60:00');
  });

  test('decimal seconds are floored', () => {
    expect(formatDuration(90.7)).toBe('1:30');
  });
});

describe('validateTrack', () => {
  test('track with duration 1000 (ms) => sanitized to 1s, which is < 10s => null, _badDuration: true', () => {
    const result = validateTrack({ duration: 1000 });
    expect(result.duration).toBeNull();
    expect(result._badDuration).toBe(true);
  });

  test('track with valid duration 234', () => {
    const result = validateTrack({ duration: 234, title: 'test' });
    expect(result.duration).toBe(234);
    expect(result._badDuration).toBe(false);
  });

  test('null track returns null', () => {
    expect(validateTrack(null)).toBeNull();
  });

  test('undefined track returns undefined', () => {
    expect(validateTrack(undefined)).toBeUndefined();
  });

  test('track without duration field gets null duration', () => {
    const result = validateTrack({ title: 'no duration' });
    expect(result.duration).toBeNull();
    expect(result._badDuration).toBe(true);
  });

  test('track with duration 350000 (ms) => sanitized to 350s', () => {
    const result = validateTrack({ duration: 350000, title: 'long track' });
    expect(result.duration).toBe(350);
    expect(result._badDuration).toBe(false);
  });

  test('original track properties are preserved', () => {
    const result = validateTrack({ duration: 234, title: 'test', artist: 'someone', videoId: 'abc123' });
    expect(result.title).toBe('test');
    expect(result.artist).toBe('someone');
    expect(result.videoId).toBe('abc123');
  });
});

describe('MAX_REASONABLE_SEC', () => {
  test('is exported and is a number', () => {
    expect(typeof MAX_REASONABLE_SEC).toBe('number');
    expect(MAX_REASONABLE_SEC).toBe(600);
  });
});