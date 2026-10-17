import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('adds and subtracts exactly without changing its operands', () => {
    const original = brl('0.10');
    expect(original.add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(original.toString()).toBe('0.10');
    expect(brl('9007199254740993.00').subtract(brl('0.01')).toString()).toBe('9007199254740992.99');
    expect(brl('0.01').negate().add(brl('0.01')).isZero()).toBe(true);
    expect(brl('0.10').subtract(brl('0.20')).isNegative()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });
  test.each(['', 'NaN', 'Infinity', '1e2', '1', '1.0', '1.001', '1.005', ' 1.00', '1.00 ', '+1.00', '01.00', '1,00'])('rejects invalid input %j without rounding', amount => {
    expect(() => brl(amount)).toThrow();
  });
  test('rejects numeric input at runtime', () => {
    expect(() => brl(1 as unknown as string)).toThrow();
  });
  test('bounds precision and checks arithmetic overflow', () => {
    expect(brl('999999999999999999.99').toString()).toBe('999999999999999999.99');
    expect(() => brl('1000000000000000000.00')).toThrow();
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow();
  });
  test('all binary operations reject a different currency', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    for (const operation of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
      expect(() => brl('1.00')[operation](usd)).toThrow('Currencies must match');
    }
    expect(() => Money.zero('brl')).toThrow();
  });
});
