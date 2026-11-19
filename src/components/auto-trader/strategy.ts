export type TradeSignal = 'CALL' | 'PUT' | 'WAIT';

export const calculateEma = (values: number[], period: number): number | null => {
    if (period < 1 || values.length < period) return null;
    const multiplier = 2 / (period + 1);
    return values.slice(1).reduce((value, price) => value + (price - value) * multiplier, values[0]);
};

export const calculateRsi = (values: number[], period = 14): number | null => {
    if (period < 1 || values.length <= period) return null;
    let gains = 0;
    let losses = 0;
    for (let i = values.length - period; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    if (losses === 0) return 100;
    if (gains === 0) return 0;
    const relativeStrength = gains / losses;
    return 100 - 100 / (1 + relativeStrength);
};

export const getCrossoverSignal = (
    previousSpread: number | null,
    currentSpread: number,
    rsi: number
): TradeSignal => {
    const crossedUp = previousSpread !== null && previousSpread <= 0 && currentSpread > 0;
    const crossedDown = previousSpread !== null && previousSpread >= 0 && currentSpread < 0;
    if (crossedUp && rsi >= 55) return 'CALL';
    if (crossedDown && rsi <= 45) return 'PUT';
    return 'WAIT';
};
