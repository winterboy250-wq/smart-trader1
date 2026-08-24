import React, { useEffect, useRef, useState } from "react";

const DEFAULT_CONFIG = {
  accountId: "",
  symbol: "1HZ100V",
  currency: "USD",
  stake: 1,
  duration: 5,
  durationUnit: "t",

  // IMPORTANT:
  // Replace these with a strategy returned by Deriv's
  // auto-list-strategies endpoint.
  strategyId: "",

  maxRounds: 5,
  maxLoss: 10,
  maxProfit: 20,
};

export default function TradingBot() {
  const ws = useRef(null);

  const [config, setConfig] = useState(DEFAULT_CONFIG);

  const [status, setStatus] = useState("Disconnected");
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);

  const [balance, setBalance] = useState(null);
  const [currency, setCurrency] = useState("USD");

  const [trades, setTrades] = useState([]);
  const [profit, setProfit] = useState(0);

  const [error, setError] = useState("");

  function update(field, value) {
    setConfig((old) => ({
      ...old,
      [field]: value,
    }));
  }

  async function connect() {
    setError("");
    setStatus("Authenticating...");

    try {
      if (!config.accountId) {
        throw new Error("Enter your Deriv account ID.");
      }

      const response = await fetch("/.netlify/functions/deriv-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountId: config.accountId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Authentication failed.");
      }

      const socket = new WebSocket(data.wsUrl);

      ws.current = socket;

      socket.onopen = () => {
        setStatus("Connected");

        socket.send(
          JSON.stringify({
            balance: 1,
            subscribe: 1,
            req_id: 100,
          })
        );
      };

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        console.log("Deriv:", data);

        if (data.error) {
          setError(data.error.message || "Deriv API error");
          return;
        }

        if (data.msg_type === "balance") {
          setBalance(data.balance.balance);
          setCurrency(data.balance.currency);
        }

        if (data.msg_type === "buy") {
          addTrade({
            type: "BUY",
            contractId: data.buy.contract_id,
            amount: data.buy.buy_price,
            time: new Date().toLocaleTimeString(),
          });
        }

        if (data.msg_type === "proposal_open_contract") {
          const contract = data.proposal_open_contract;

          if (
            contract.is_sold ||
            contract.status === "won" ||
            contract.status === "lost"
          ) {
            const result =
              Number(contract.profit || 0);

            setProfit((old) => old + result);

            addTrade({
              type: contract.status?.toUpperCase(),
              contractId: contract.contract_id,
              profit: result,
              time: new Date().toLocaleTimeString(),
            });
          }
        }

        if (data.msg_type === "auto_start") {
          const id =
            data.auto_start?.run_id ||
            data.run_id;

          if (id) {
            setRunId(id);
            setRunning(true);
            setStatus("Bot running");
          }
        }

        if (data.msg_type === "auto_get") {
          console.log("Bot update:", data);
        }
      };

      socket.onerror = () => {
        setStatus("Connection error");
        setError("Unable to connect to Deriv.");
      };

      socket.onclose = () => {
        setStatus("Disconnected");
        setRunning(false);
      };
    } catch (err) {
      setError(err.message);
      setStatus("Disconnected");
    }
  }

  function startBot() {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      setError("Connect to Deriv first.");
      return;
    }

    if (!config.strategyId) {
      setError(
        "Add a valid Deriv strategy ID before starting the bot."
      );
      return;
    }

    const stake = Number(config.stake);

    if (stake <= 0) {
      setError("Stake must be greater than zero.");
      return;
    }

    // Safety guard.
    if (stake > 10) {
      setError(
        "Starter version limits the stake to 10. Change this only after testing."
      );
      return;
    }

    ws.current.send(
      JSON.stringify({
        auto_start: 1,

        contract_template: {
          underlying_symbol: config.symbol,
          currency: config.currency,
          amount: stake,
          basis: "stake",

          duration: Number(config.duration),
          duration_unit: config.durationUnit,

          // Select the contract type supported by
          // your chosen Deriv strategy.
          contract_type: "CALL",
        },

        strategy_id: config.strategyId,

        strategy_parameters: {
          max_rounds: Number(config.maxRounds),
          max_loss: Number(config.maxLoss),
          max_profit: Number(config.maxProfit),
        },

        subscribe: 1,

        req_id: 200,
      })
    );

    setStatus("Starting bot...");
  }

  function pauseBot() {
    if (!ws.current || !runId) return;

    ws.current.send(
      JSON.stringify({
        auto_pause: 1,
        run_id: runId,
        req_id: 300,
      })
    );

    setRunning(false);
    setStatus("Bot paused");
  }

  function resumeBot() {
    if (!ws.current || !runId) return;

    ws.current.send(
      JSON.stringify({
        auto_resume: 1,
        run_id: runId,
        req_id: 301,
      })
    );

    setRunning(true);
    setStatus("Bot running");
  }

  function stopBot() {
    if (!ws.current || !runId) return;

    ws.current.send(
      JSON.stringify({
        auto_stop: 1,
        run_id: runId,
        req_id: 302,
      })
    );

    setRunning(false);
    setStatus("Bot stopped");
  }

  function addTrade(trade) {
    setTrades((old) => [trade, ...old].slice(0, 30));
  }

  useEffect(() => {
    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  return (
    <div className="trading-bot">

      <div className="bot-header">
        <div>
          <h2>Automated Trading Bot</h2>
          <p>Deriv automated strategy control</p>
        </div>

        <div className={`bot-status ${running ? "online" : ""}`}>
          ● {status}
        </div>
      </div>

      <div className="bot-grid">

        <section className="bot-card">

          <h3>Account</h3>

          <label>Deriv Account ID</label>
          <input
            value={config.accountId}
            onChange={(e) =>
              update("accountId", e.target.value)
            }
            placeholder="e.g. DOTXXXXXXXX"
          />

          <label>Strategy ID</label>
          <input
            value={config.strategyId}
            onChange={(e) =>
              update("strategyId", e.target.value)
            }
            placeholder="Deriv strategy ID"
          />

          <label>Market</label>
          <input
            value={config.symbol}
            onChange={(e) =>
              update("symbol", e.target.value)
            }
          />

          <label>Currency</label>
          <input
            value={config.currency}
            onChange={(e) =>
              update("currency", e.target.value)
            }
          />

          <button
            className="connect"
            onClick={connect}
          >
            Connect Deriv
          </button>

        </section>

        <section className="bot-card">

          <h3>Bot Settings</h3>

          <label>Stake</label>
          <input
            type="number"
            min="0.35"
            max="10"
            step="0.01"
            value={config.stake}
            onChange={(e) =>
              update("stake", e.target.value)
            }
          />

          <label>Duration</label>
          <input
            type="number"
            min="1"
            value={config.duration}
            onChange={(e) =>
              update("duration", e.target.value)
            }
          />

          <label>Duration Unit</label>
          <select
            value={config.durationUnit}
            onChange={(e) =>
              update("durationUnit", e.target.value)
            }
          >
            <option value="t">Ticks</option>
            <option value="s">Seconds</option>
            <option value="m">Minutes</option>
          </select>

          <label>Maximum Rounds</label>
          <input
            type="number"
            min="1"
            value={config.maxRounds}
            onChange={(e) =>
              update("maxRounds", e.target.value)
            }
          />

          <label>Maximum Loss</label>
          <input
            type="number"
            min="0"
            value={config.maxLoss}
            onChange={(e) =>
              update("maxLoss", e.target.value)
            }
          />

          <label>Profit Target</label>
          <input
            type="number"
            min="0"
            value={config.maxProfit}
            onChange={(e) =>
              update("maxProfit", e.target.value)
            }
          />

        </section>

        <section className="bot-card bot-control">

          <h3>Bot Control</h3>

          <div className="balance">
            <span>Balance</span>
            <strong>
              {balance === null
                ? "--"
                : `${balance} ${currency}`}
            </strong>
          </div>

          <div className="profit">
            <span>Session P/L</span>
            <strong>{profit.toFixed(2)}</strong>
          </div>

          {!running && !runId && (
            <button
              className="start"
              onClick={startBot}
            >
              ▶ Start Bot
            </button>
          )}

          {running && (
            <button
              className="pause"
              onClick={pauseBot}
            >
              ⏸ Pause Bot
            </button>
          )}

          {!running && runId && (
            <button
              className="resume"
              onClick={resumeBot}
            >
              ▶ Resume Bot
            </button>
          )}

          {runId && (
            <button
              className="stop"
              onClick={stopBot}
            >
              ■ Stop Bot
            </button>
          )}

          {error && (
            <div className="bot-error">
              {error}
            </div>
          )}

        </section>

      </div>

      <section className="bot-card">

        <h3>Recent Bot Activity</h3>

        {trades.length === 0 ? (
          <p>No trades yet.</p>
        ) : (
          <div className="trade-list">

            {trades.map((trade, index) => (
              <div
                className="trade-row"
                key={`${trade.contractId}-${index}`}
              >
                <span>{trade.type}</span>

                <span>
                  {trade.contractId || "--"}
                </span>

                <span>
                  {trade.profit !== undefined
                    ? trade.profit.toFixed(2)
                    : "--"}
                </span>

                <span>{trade.time}</span>
              </div>
            ))}

          </div>
        )}

      </section>

    </div>
  );
}
