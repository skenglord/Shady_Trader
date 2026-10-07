import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

interface PerformanceChartProps {
  history: { time: number | string; balance: number }[];
  showBacktestUI: boolean;
}

export default function PerformanceChart({ history, showBacktestUI }: PerformanceChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={history}>
        <defs>
          <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0.3} />
            <stop offset="95%" stopColor={showBacktestUI ? "#f59e0b" : "#6366f1"} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
        <XAxis dataKey="time" hide />
        <YAxis domain={['auto', 'auto']} hide />
        <Tooltip content={({ active, payload }) => {
          if (active && payload && payload.length) {
            return (
              <div className="bg-[#1e1e1e] border border-white/10 p-2 rounded shadow-xl text-[10px] font-mono">
                <p className="text-gray-400">{new Date(payload[0].payload.time).toLocaleString()}</p>
                <p className={showBacktestUI ? "text-amber-400" : "text-indigo-400"}>
                  Balance: ${(payload[0].value as number).toFixed(2)}
                </p>
              </div>
            );
          }
          return null;
        }} />
        <Area type="monotone" dataKey="balance" stroke={showBacktestUI ? "#f59e0b" : "#6366f1"}
          fillOpacity={1} fill="url(#colorBalance)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
