import { Injectable } from '@angular/core';

import {
  CardLaunch,
  FinancialEvent,
  MonthDefinition
} from './finance-api.service';

/**
 * Cenário de simulação. Tudo opcional além do `startYear/startMonth` —
 * o motor aplica defaults seguros (multiplicador 1, sem cortes).
 *
 * Convenções:
 * - `incomeMultiplier`: aplica sobre TODA receita projetada (events com type === 'income').
 *   `1` = renda inalterada, `0` = perdeu o emprego, `0.5` = metade, etc.
 * - `severance`: entrada única no primeiro mês da projeção (rescisão, FGTS, etc.).
 * - `unemploymentInsurance`: parcelas mensais somadas como receita extra a partir do
 *   primeiro mês, durante N meses.
 * - `expenseCutAmount`: valor em R$ por mês que o usuário consegue cortar das
 *   despesas variáveis. É descontado proporcionalmente de despesas, investimentos
 *   e custo diário fixo (cap em 0 — não pode ficar negativo). Compromissos de
 *   cartão NÃO são cortados (parcelas já compradas continuam caindo — é
 *   justamente o ponto do simulador).
 * - `emergencyFund`: saldo inicial considerado disponível para queimar (reserva).
 */
export interface SimulatorScenario {
  startYear: number;
  startMonth: number; // 1-12
  /** Quantos meses projetar à frente (inclui o mês inicial). */
  horizonMonths: number;

  incomeMultiplier: number;
  /**
   * Quando definido, substitui completamente a receita projetada (ignora
   * `incomeMultiplier` e os lançamentos de receita do mês). Útil quando o
   * usuário declara explicitamente "vou receber X por mês".
   */
  monthlyIncomeOverride?: number | null;
  severance: number;
  unemploymentInsurance: {
    monthlyAmount: number;
    months: number;
  };
  expenseCutAmount: number;
  emergencyFund: number;
}

export interface MonthProjection {
  year: number;
  month: number; // 1-12
  label: string; // ex: 'mai/2026'

  /** Receita do mês já com `incomeMultiplier` aplicado (NÃO inclui seguro-desemprego). */
  income: number;
  /** Parcela do seguro-desemprego recebida neste mês (somada ao netFlow, mas separada de `income`). */
  unemploymentInflow: number;
  /** Rescisão / entrada única recebida neste mês (só ocorre no mês 0; não entra em `income`). */
  severanceInflow: number;
  /** Despesas variáveis (events) já com corte aplicado. */
  variableExpenses: number;
  /** Investimentos (tratados como saída, com corte aplicado). */
  investments: number;
  /** Custo diário fixo do mês (já com corte aplicado). */
  dailyFixedCost: number;
  /** Soma de lançamentos de cartão cuja data cai neste mês calendário. */
  cardCommitments: number;
  /** Receitas - todas saídas. */
  netFlow: number;
  /** Saldo acumulado ao final deste mês, partindo de `emergencyFund + severance` no mês 0. */
  cumulativeBalance: number;
  /** True quando `cumulativeBalance < 0`. */
  isUnderwater: boolean;
}

export interface SimulationResult {
  scenario: SimulatorScenario;
  months: MonthProjection[];
  /**
   * Quantos meses (com fração) você consegue se manter antes do saldo virar negativo.
   * `null` quando o saldo nunca fica negativo dentro do horizonte projetado.
   * `0` quando já começa negativo.
   */
  runwayMonths: number | null;
  /** Mês em que o saldo cruza zero (year/month/label). `null` se não cruzar no horizonte. */
  brokenAt: { year: number; month: number; label: string } | null;
  /** Saldo no último mês projetado. */
  finalBalance: number;
}

/**
 * Defaults razoáveis para um cenário "tudo igual" (baseline).
 */
export function defaultScenario(today: Date = new Date()): SimulatorScenario {
  return {
    startYear: today.getFullYear(),
    startMonth: today.getMonth() + 1,
    horizonMonths: 12,
    incomeMultiplier: 1,
    severance: 0,
    unemploymentInsurance: { monthlyAmount: 0, months: 0 },
    expenseCutAmount: 0,
    emergencyFund: 0,
    monthlyIncomeOverride: null,
  };
}

const MONTH_LABELS = [
  'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
  'jul', 'ago', 'set', 'out', 'nov', 'dez'
];

@Injectable({ providedIn: 'root' })
export class SimulatorProjectionService {
  /**
   * Roda a simulação consolidando meses cadastrados (`MonthDefinition`) e
   * lançamentos de cartão. Não toca Firestore — função pura sobre os arrays
   * recebidos.
   */
  simulate(
    months: MonthDefinition[],
    cardLaunches: CardLaunch[],
    scenario: SimulatorScenario
  ): SimulationResult {
    const monthsByKey = this.indexMonthsByKey(months);
    const launchesByKey = this.indexLaunchesByKey(cardLaunches);

    const horizon = Math.max(1, Math.floor(scenario.horizonMonths));
    const cutAmount = Math.max(0, scenario.expenseCutAmount);
    const incomeFactor = Math.max(0, scenario.incomeMultiplier);

    const projections: MonthProjection[] = [];
    let balance = scenario.emergencyFund + scenario.severance;
    let brokenAt: SimulationResult['brokenAt'] = null;
    let runwayMonths: number | null = null;

    for (let i = 0; i < horizon; i += 1) {
      const { year, month } = addMonths(scenario.startYear, scenario.startMonth, i);
      const key = monthKey(year, month);
      const monthDef = monthsByKey.get(key);

      const rawIncome = sumEventsByType(monthDef?.events, 'income');
      const rawExpenses = sumEventsByType(monthDef?.events, 'expense');
      const rawInvestments = sumEventsByType(monthDef?.events, 'investment');
      const rawDailyFixed = (monthDef?.dailyFixedCost ?? 0) * daysInMonth(year, month);

      const unemploymentBonus =
        i < scenario.unemploymentInsurance.months
          ? scenario.unemploymentInsurance.monthlyAmount
          : 0;

      // Distribui o corte proporcionalmente entre despesas + investimentos +
      // custo diário fixo. Cap em zero (não vira receita extra).
      const cuttablePool = rawExpenses + rawInvestments + rawDailyFixed;
      const effectiveCut = Math.min(cutAmount, cuttablePool);
      const cutFactor = cuttablePool > 0 ? 1 - effectiveCut / cuttablePool : 1;

      const income =
        scenario.monthlyIncomeOverride != null
          ? Math.max(0, scenario.monthlyIncomeOverride)
          : rawIncome * incomeFactor;
      const variableExpenses = rawExpenses * cutFactor;
      const investments = rawInvestments * cutFactor;
      const dailyFixedCost = rawDailyFixed * cutFactor;
      const cardCommitments = launchesByKey.get(key) ?? 0;

      const totalOut = variableExpenses + investments + dailyFixedCost + cardCommitments;
      const netFlow = income + unemploymentBonus - totalOut;
      const balanceBefore = balance;
      balance = balanceBefore + netFlow;

      // detecta runway: primeiro mês onde saldo final cruza < 0
      if (runwayMonths === null && balance < 0) {
        if (balanceBefore <= 0) {
          // já começou no vermelho
          runwayMonths = i === 0 ? 0 : i;
        } else if (netFlow < 0) {
          // queima parcial dentro do mês
          runwayMonths = i + balanceBefore / -netFlow;
        } else {
          runwayMonths = i;
        }
        brokenAt = { year, month, label: monthLabel(year, month) };
      }

      projections.push({
        year,
        month,
        label: monthLabel(year, month),
        income,
        unemploymentInflow: unemploymentBonus,
        severanceInflow: i === 0 ? scenario.severance : 0,
        variableExpenses,
        investments,
        dailyFixedCost,
        cardCommitments,
        netFlow,
        cumulativeBalance: balance,
        isUnderwater: balance < 0
      });
    }

    return {
      scenario,
      months: projections,
      runwayMonths,
      brokenAt,
      finalBalance: balance
    };
  }

  private indexMonthsByKey(months: MonthDefinition[]): Map<string, MonthDefinition> {
    const map = new Map<string, MonthDefinition>();
    for (const m of months) {
      map.set(monthKey(m.year, m.monthNumber), m);
    }
    return map;
  }

  private indexLaunchesByKey(launches: CardLaunch[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const l of launches) {
      if (!l.date) continue;
      const d = parseIsoDate(l.date);
      if (!d) continue;
      const key = monthKey(d.getFullYear(), d.getMonth() + 1);
      map.set(key, (map.get(key) ?? 0) + (Number(l.amount) || 0));
    }
    return map;
  }
}

// --- helpers puros ---

function sumEventsByType(events: FinancialEvent[] | undefined, type: 'income' | 'expense' | 'investment'): number {
  if (!events) return 0;
  let total = 0;
  for (const e of events) {
    if (e.suppressed) continue;
    if (e.type !== type) continue;
    total += Number(e.amount) || 0;
  }
  return total;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = (year * 12) + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function monthLabel(year: number, month: number): string {
  return `${MONTH_LABELS[month - 1]}/${year}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function parseIsoDate(value: string): Date | null {
  // Aceita 'YYYY-MM-DD' ou ISO completo.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}
