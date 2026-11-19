import React, { useEffect, useRef, useState } from 'react';
import './auto-trader.scss';

type Account = { account_id: string; account_type?: string; currency: string; balance?: string | number; status?: string };
type Trade = { id: number; direction: string; stake: number; profit?: number; status: string; time: string };

const DEFAULTS = { symbol: '1HZ100V', stake: 1, duration: 5, maxTrades: 10, maxDailyLoss: 5, maxConsecutiveLosses: 3, cooldownSeconds: 30 };
const ema = (values: number[], period: number) => {
    if (values.length < period) return null;
    const multiplier = 2 / (period + 1);
    return values.slice(1).reduce((value, price) => value + (price - value) * multiplier, values[0]);
};
const rsi = (values: number[], period = 14) => {
    if (values.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = values.length - period; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        if (change > 0) gains += change; else losses -= change;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
};

export default function AutoTrader() {
    const socket = useRef<WebSocket | null>(null);
    const prices = useRef<number[]>([]);
    const pending = useRef(false);
    const runningRef = useRef(false);
    const contractId = useRef<number | null>(null);
    const previousSpread = useRef<number | null>(null);
    const stopRequested = useRef(false);
    const lastTradeAt = useRef(0);
    const reqCounter = useRef(100);
    const configRef = useRef(DEFAULTS);
    const statsRef = useRef({ trades: 0, loss: 0, consecutiveLosses: 0, profit: 0 });
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [accountId, setAccountId] = useState('');
    const [connected, setConnected] = useState(false);
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState('Connect your Deriv account');
    const [error, setError] = useState('');
    const [config, setConfig] = useState(DEFAULTS);
    const [balance, setBalance] = useState<number | null>(null);
    const [currency, setCurrency] = useState('USD');
    const [lastPrice, setLastPrice] = useState<number | null>(null);
    const [signal, setSignal] = useState('WAIT');
    const [indicators, setIndicators] = useState({ emaFast: 0, emaSlow: 0, rsi: 0 });
    const [profit, setProfit] = useState(0);
    const [tradeCount, setTradeCount] = useState(0);
    const [trades, setTrades] = useState<Trade[]>([]);
    const [confirmed, setConfirmed] = useState(false);

    useEffect(() => { configRef.current = config; }, [config]);
    useEffect(() => { runningRef.current = running; }, [running]);

    useEffect(() => {
        fetch('/api/deriv/session', { credentials: 'same-origin' })
            .then(async response => {
                const data = await response.json();
                if (!response.ok || !data.authenticated) throw new Error(data.error || 'Connect Deriv first.');
                setAccounts(data.accounts || []);
                const first = (data.accounts || [])[0];
                if (first) { setAccountId(first.account_id); setCurrency(first.currency || 'USD');
                    const initialBalance = Number(first.balance); setBalance(Number.isFinite(initialBalance) ? initialBalance : null); }
                setStatus('Deriv account authorised');
            })
            .catch(() => setStatus('Connect Deriv from the main dashboard first'));
        return () => { runningRef.current = false; socket.current?.close(); };
    }, []);

    const send = (payload: Record<string, unknown>) => {
        if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('Deriv connection is not open.');
        socket.current.send(JSON.stringify({ ...payload, req_id: reqCounter.current++ }));
    };

    const stopBot = (reason = 'Bot stopped by user') => {
        runningRef.current = false;
        setRunning(false);
        pending.current = false;
        setStatus(reason);
        stopRequested.current = Boolean(contractId.current);
        try {
            if (contractId.current && socket.current?.readyState === WebSocket.OPEN) {
                send({ proposal_open_contract: 1, contract_id: contractId.current, subscribe: 1 });
            }
            if (socket.current?.readyState === WebSocket.OPEN) send({ forget_all: 'ticks' });
        } catch { /* the connection may already be closed */ }
    };

    const connect = async () => {
        setError('');
        if (!accountId) { setError('Choose an authorised Deriv account.'); return; }
        setStatus('Requesting secure trading connection…');
        try {
            const response = await fetch('/api/deriv/session', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'otp', accountId }),
            });
            const data = await response.json();
            if (!response.ok || !data.websocketUrl) throw new Error(data.error || 'Could not create an authenticated connection.');
            socket.current?.close();
            prices.current = []; previousSpread.current = null;
            const ws = new WebSocket(data.websocketUrl);
            socket.current = ws;
            ws.onopen = () => {
                setConnected(true); setStatus('Connected — waiting for live prices');
                send({ balance: 1, subscribe: 1 });
                send({ ticks_history: configRef.current.symbol, count: 100, end: 'latest', style: 'ticks' });
                send({ ticks: configRef.current.symbol, subscribe: 1 });
            };
            ws.onmessage = event => {
                const message = JSON.parse(event.data);
                if (message.error) {
                    setError(message.error.message || 'Deriv API error');
                    pending.current = false;
                    return;
                }
                if (message.msg_type === 'balance') {
                    setBalance(Number(message.balance.balance));
                    setCurrency(message.balance.currency || 'USD');
                }
                if (message.msg_type === 'history' && message.history?.prices) {
                    prices.current = message.history.prices.map(Number).filter(Number.isFinite).slice(-80);
                    setStatus('Market history loaded — listening for live ticks');
                }
                if (message.msg_type === 'tick') {
                    const quote = Number(message.tick.quote);
                    if (!Number.isFinite(quote)) return;
                    prices.current = [...prices.current, quote].slice(-80);
                    setLastPrice(quote);
                    const fast = ema(prices.current, 9), slow = ema(prices.current, 21), momentum = rsi(prices.current, 14);
                    if (fast === null || slow === null || momentum === null) { setStatus('Collecting market data…'); return; }
                    setIndicators({ emaFast: fast, emaSlow: slow, rsi: momentum });
                    const spread = fast - slow;
                    const crossedUp = previousSpread.current !== null && previousSpread.current <= 0 && spread > 0;
                    const crossedDown = previousSpread.current !== null && previousSpread.current >= 0 && spread < 0;
                    previousSpread.current = spread;
                    const direction = crossedUp && momentum >= 55 ? 'CALL' : crossedDown && momentum <= 45 ? 'PUT' : 'WAIT';
                    setSignal(direction);
                    if (runningRef.current && direction !== 'WAIT' && !pending.current && !contractId.current) {
                        const current = configRef.current;
                        const stats = statsRef.current;
                        const now = Date.now();
                        if (stats.trades >= current.maxTrades) { stopBot('Maximum trades reached'); return; }
                        if (stats.loss >= current.maxDailyLoss) { stopBot('Daily loss limit reached'); return; }
                        if (stats.consecutiveLosses >= current.maxConsecutiveLosses) { stopBot('Consecutive loss limit reached'); return; }
                        if (now - lastTradeAt.current < current.cooldownSeconds * 1000) return;
                        pending.current = true;
                        lastTradeAt.current = now;
                        setStatus('Signal confirmed — requesting price');
                        try {
                            send({ proposal: 1, amount: current.stake, basis: 'stake', contract_type: direction,
                                currency, duration: current.duration, duration_unit: 't', underlying_symbol: current.symbol });
                        } catch (e) { pending.current = false; setError((e as Error).message); }
                    }
                }
                if (message.msg_type === 'proposal' && message.proposal && pending.current && runningRef.current) {
                    send({ buy: message.proposal.id, price: Number(message.proposal.ask_price) });
                    setStatus('Proposal received — placing demo trade');
                }
                if (message.msg_type === 'buy' && message.buy) {
                    contractId.current = Number(message.buy.contract_id);
                    statsRef.current.trades += 1;
                    setTradeCount(statsRef.current.trades);
                    setTrades(old => [{ id: Number(message.buy.contract_id), direction: signal, stake: Number(message.buy.buy_price), status: 'OPEN', time: new Date().toLocaleTimeString() }, ...old].slice(0, 25));
                    send({ proposal_open_contract: 1, contract_id: Number(message.buy.contract_id), subscribe: 1 });
                    pending.current = false;
                    setStatus('Trade open — monitoring profit/loss');
                }
                if (message.msg_type === 'proposal_open_contract' && message.proposal_open_contract) {
                    const contract = message.proposal_open_contract;
                    if (stopRequested.current && contract.is_valid_to_sell && !contract.is_sold) {
                        send({ sell: Number(contract.contract_id), price: 0 });
                        stopRequested.current = false;
                    }
                    if (contract.is_sold || contract.is_expired || contract.status === 'won' || contract.status === 'lost') {
                        const result = Number(contract.profit || 0);
                        statsRef.current.profit += result;
                        if (result < 0) { statsRef.current.loss += Math.abs(result); statsRef.current.consecutiveLosses += 1; }
                        else statsRef.current.consecutiveLosses = 0;
                        setProfit(statsRef.current.profit);
                        setTrades(old => old.map(trade => trade.id === Number(contract.contract_id) ? { ...trade, profit: result, status: result >= 0 ? 'WON' : 'LOST' } : trade));
                        contractId.current = null;
                        stopRequested.current = false;
                        setStatus(result >= 0 ? 'Trade settled — profit' : 'Trade settled — loss');
                    }
                }
            };
            ws.onerror = () => { setConnected(false); stopBot('Connection error'); setError('Deriv WebSocket connection failed.'); };
            ws.onclose = () => { setConnected(false); stopBot('Disconnected from Deriv'); };
        } catch (e) { setStatus('Connection failed'); setError((e as Error).message); }
    };

    const startBot = () => {
        const account = accounts.find(item => item.account_id === accountId);
        const isDemo = account?.account_type?.toLowerCase() === 'demo' || /^(VRT|VRTC)/.test(accountId);
        if (!connected) { setError('Connect to Deriv before starting.'); return; }
        if (!isDemo) { setError('Automated execution is currently restricted to demo accounts while this feature is being tested.'); return; }
        if (!confirmed) { setError('Confirm that you understand this bot can place demo trades automatically.'); return; }
        if (config.stake <= 0 || config.stake > 10 || config.maxDailyLoss <= 0 || config.duration < 1) {
            setError('Use a stake above zero and no more than 10, a positive daily loss limit, and a valid duration.'); return;
        }
        statsRef.current = { trades: 0, loss: 0, consecutiveLosses: 0, profit: 0 };
        setProfit(0); setTradeCount(0); setError('');
        runningRef.current = true; setRunning(true); setStatus('Bot active — analysing live ticks');
    };

    const disconnect = () => { stopBot('Disconnected by user'); socket.current?.close(); socket.current = null; setConnected(false); };

    return (
        <main className="auto-trader">
            <header className="auto-trader__hero">
                <div><span className="auto-trader__eyebrow">SMART TRADER • AUTOMATION LAB</span><h1>Strategy Auto Trader</h1>
                    <p>Live market analysis, rule-based entries and risk-managed demo execution.</p></div>
                <span className={connected ? 'auto-trader__pill is-live' : 'auto-trader__pill'}>{connected ? '● CONNECTED' : '● OFFLINE'}</span>
            </header>
            <section className="auto-trader__notice"><strong>Demo safety mode</strong><span>Automatic execution is restricted to demo accounts during testing. No bot can guarantee profits.</span></section>
            {error && <div className="auto-trader__error" role="alert">{error}</div>}
            <div className="auto-trader__stats">
                <article><span>Account balance</span><strong>{balance === null ? '—' : balance.toFixed(2) + ' ' + currency}</strong></article>
                <article><span>Session P/L</span><strong className={profit >= 0 ? 'positive' : 'negative'}>{profit.toFixed(2)} {currency}</strong></article>
                <article><span>Trades opened</span><strong>{tradeCount} / {config.maxTrades}</strong></article>
                <article><span>Market price</span><strong>{lastPrice === null ? '—' : lastPrice}</strong></article>
            </div>
            <div className="auto-trader__columns">
                <section className="auto-trader__panel">
                    <h2>Connection & market</h2>
                    <label>Deriv account<select value={accountId} onChange={e => setAccountId(e.target.value)}>
                        <option value="">Select account</option>{accounts.map(account => <option key={account.account_id} value={account.account_id}>{account.account_id} · {account.account_type || 'Account'} · {account.currency}</option>)}
                    </select></label>
                    <label>Market symbol<input value={config.symbol} onChange={e => setConfig({ ...config, symbol: e.target.value.toUpperCase() })} disabled={connected} /></label>
                    <div className="auto-trader__actions"><button onClick={connect} disabled={connected}>{connected ? 'Connected' : 'Connect account'}</button><button className="secondary" onClick={disconnect} disabled={!connected}>Disconnect</button></div>
                    <p className="auto-trader__status">{status}</p>
                </section>
                <section className="auto-trader__panel">
                    <h2>Strategy settings</h2>
                    <div className="auto-trader__form-grid">
                        <label>Stake ({currency})<input type="number" min="0.35" max="10" step="0.01" value={config.stake} onChange={e => setConfig({ ...config, stake: Number(e.target.value) })} /></label>
                        <label>Duration (ticks)<input type="number" min="1" max="20" value={config.duration} onChange={e => setConfig({ ...config, duration: Number(e.target.value) })} /></label>
                        <label>Maximum trades<input type="number" min="1" max="100" value={config.maxTrades} onChange={e => setConfig({ ...config, maxTrades: Number(e.target.value) })} /></label>
                        <label>Daily loss limit ({currency})<input type="number" min="0.5" value={config.maxDailyLoss} onChange={e => setConfig({ ...config, maxDailyLoss: Number(e.target.value) })} /></label>
                        <label>Max consecutive losses<input type="number" min="1" max="10" value={config.maxConsecutiveLosses} onChange={e => setConfig({ ...config, maxConsecutiveLosses: Number(e.target.value) })} /></label>
                        <label>Cooldown (seconds)<input type="number" min="5" max="3600" value={config.cooldownSeconds} onChange={e => setConfig({ ...config, cooldownSeconds: Number(e.target.value) })} /></label>
                    </div>
                    <p className="auto-trader__hint">Strategy: EMA 9 / EMA 21 crossover with RSI 14 confirmation. CALL when trend and RSI are bullish; PUT when bearish; otherwise WAIT.</p>
                </section>
            </div>
            <section className="auto-trader__panel auto-trader__analysis">
                <div><h2>Live strategy analysis</h2><span className={'auto-trader__signal signal-' + signal.toLowerCase()}>{signal}</span></div>
                <div className="auto-trader__indicators"><article><span>EMA 9</span><strong>{indicators.emaFast ? indicators.emaFast.toFixed(5) : '—'}</strong></article><article><span>EMA 21</span><strong>{indicators.emaSlow ? indicators.emaSlow.toFixed(5) : '—'}</strong></article><article><span>RSI 14</span><strong>{indicators.rsi ? indicators.rsi.toFixed(1) : '—'}</strong></article></div>
                <p className="auto-trader__hint">The strategy waits for enough live ticks before generating a signal. It allows one open trade at a time.</p>
                <label className="auto-trader__confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I understand that this bot can place automatic demo trades using the settings above.</label>
                <div className="auto-trader__actions"><button className="start" onClick={startBot} disabled={running || !connected}>▶ Start demo bot</button><button className="stop" onClick={() => stopBot('All bot activity stopped')} disabled={!running}>■ STOP ALL BOTS</button></div>
            </section>
            <section className="auto-trader__panel">
                <h2>Trade history</h2>
                <div className="auto-trader__table-wrap"><table><thead><tr><th>Contract</th><th>Signal</th><th>Stake</th><th>Result</th><th>Time</th></tr></thead><tbody>
                    {trades.length ? trades.map(trade => <tr key={trade.id}><td>{trade.id}</td><td>{trade.direction}</td><td>{trade.stake.toFixed(2)}</td><td>{trade.status === 'OPEN' ? 'OPEN' : (trade.profit || 0).toFixed(2) + ' ' + currency}</td><td>{trade.time}</td></tr>) : <tr><td colSpan={5}>No trades yet. Connect a demo account to begin testing.</td></tr>}
                </tbody></table></div>
            </section>
        </main>
    );
}
