// Compares measured numbers with the budgets in bench/budgets.json.
export type Numbers = Record<string, number>;

export interface Row {
  name: string;
  measured: number;
  budget: number;
  over: boolean;
}

// One row per budget; a budget with no measured number counts as over, so a renamed metric cannot pass silently.
export function compare(measured: Numbers, budgets: Numbers): Row[] {
  return Object.entries(budgets).map(([name, budget]) => {
    const value = measured[name];
    return { name, measured: value ?? NaN, budget, over: value === undefined || value > budget };
  });
}

export function table(rows: Row[]): string {
  const lines = rows.map((r) => `| ${r.name} | ${r.measured} | ${r.budget} | ${r.over ? "OVER" : "ok"} |`);
  return ["| metric | measured | budget | result |", "|---|---|---|---|", ...lines].join("\n");
}
