export const formatMoney = (n: number, opts: { compact?: boolean; sign?: boolean } = {}): string => {
  if (!Number.isFinite(n)) return "$0.00";
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1000) {
    const v =
      abs >= 1_000_000 ? (abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1) + "M" : (abs / 1000).toFixed(abs >= 10_000 ? 0 : 1) + "k";
    return `${n < 0 ? "-" : opts.sign ? "+" : ""}$${v}`;
  }
  const str = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(abs);
  return `${n < 0 ? "-" : opts.sign && n > 0 ? "+" : ""}${str}`;
};

export const formatInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
