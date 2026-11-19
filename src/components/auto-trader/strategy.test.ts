import { calculateEma, calculateRsi, getCrossoverSignal } from './strategy';

describe('Auto Trader strategy calculations', () => {
    test('returns null until enough EMA values are available', () => {
        expect(calculateEma([1, 2], 3)).toBeNull();
    });

    test('calculates a finite EMA for a complete price series', () => {
        expect(calculateEma([10, 11, 12, 13], 3)).toBeCloseTo(12.25);
    });

    test('returns 100 RSI when all observed changes are gains', () => {
        expect(calculateRsi(Array.from({ length: 15 }, (_, index) => index + 1))).toBe(100);
    });

    test('signals CALL only on an upward crossover with bullish RSI confirmation', () => {
        expect(getCrossoverSignal(-0.1, 0.2, 60)).toBe('CALL');
        expect(getCrossoverSignal(-0.1, 0.2, 50)).toBe('WAIT');
    });

    test('signals PUT only on a downward crossover with bearish RSI confirmation', () => {
        expect(getCrossoverSignal(0.1, -0.2, 40)).toBe('PUT');
        expect(getCrossoverSignal(0.1, -0.2, 50)).toBe('WAIT');
    });

    test('does not generate an entry without a crossover', () => {
        expect(getCrossoverSignal(0.2, 0.3, 65)).toBe('WAIT');
    });
});
