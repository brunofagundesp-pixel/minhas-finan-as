import { Injectable } from '@angular/core';

import { Budget } from '../models/budget.model';
import { normalizeTagName } from '../models/tag.model';
import {
  CardLaunch,
  CreditCard,
  FinancialEvent,
  MonthDefinition
} from './finance-api.service';
import {
  InvoiceMonth,
  getClosingDateForInvoiceMonth,
  getCycleStartDateForInvoiceMonth,
  getInvoiceMonthForDate
} from '../utils/card-cycle.util';

export type BudgetStatus = 'ok' | 'warning' | 'over';

export interface BudgetPeriodRef {
  /** Calendar period (used for `monthly` budgets). */
  monthly?: { year: number; month: number };
  /** Invoice cycle (used for `invoice-cycle` budgets, requires the card). */
  invoiceCycle?: { invoiceMonth: InvoiceMonth };
}

export interface BudgetProgress {
  budget: Budget;
  /** Soma já gasta dentro do período. */
  spent: number;
  /** Teto - gasto (pode ser negativo). */
  remaining: number;
  /** spent / amount em fração (>1 = estourou). 0 se amount<=0. */
  percent: number;
  status: BudgetStatus;

  /** Dias decorridos do período (mínimo 1, para evitar divisão por zero). */
  daysElapsed: number;
  /** Dias totais do período. */
  daysTotal: number;
  /** Projeção linear de gasto ao final do período (≈ spent / daysElapsed * daysTotal). */
  projectedSpent: number;
  /** Status com base na projeção (extra alerta antecipado). */
  projectedStatus: BudgetStatus;

  /** Período resolvido (para a UI exibir). */
  periodLabel: string;
}

const WARNING_THRESHOLD = 0.7;

/**
 * Tag-key implícita para lançamentos do tipo "daily". Qualquer evento com
 * `type === 'daily'` é automaticamente considerado como pertencente à tag
 * "diário", de modo que orçamentos por tag chamados "diário" agreguem todos
 * os lançamentos diários — mesmo quando o usuário não marca a tag à mão.
 */
const DAILY_IMPLICIT_TAG_KEY = normalizeTagName('diário');

/**
 * Cálculo (puro) do progresso das metas. Não toca em Firestore.
 * Os dados de transações vêm pré-carregados pelos serviços que orquestram a UI.
 */
@Injectable({ providedIn: 'root' })
export class BudgetCalculatorService {
  computeProgress(
    budget: Budget,
    context: {
      months: ReadonlyArray<MonthDefinition>;
      cardLaunches: ReadonlyArray<CardLaunch>;
      cards: ReadonlyArray<CreditCard>;
      /** Default: hoje. Sobrescrito em testes. */
      now?: Date;
    }
  ): BudgetProgress {
    const now = context.now ?? new Date();
    const period = this.resolvePeriod(budget, now, context.cards);

    // Verifica se o periodo corrente esta dentro da janela de vigencia da meta.
    // Metas legadas (sem startYear/Month) sao tratadas como "vale desde sempre".
    const inWindow = this.isPeriodInBudgetWindow(budget, period);

    const effectiveAmount = inWindow ? this.resolveAmountForPeriod(budget, period) : 0;
    const safeAmount = effectiveAmount > 0 ? effectiveAmount : 0;
    const spent = inWindow ? this.computeSpent(budget, period, { ...context, now }) : 0;
    const remaining = safeAmount - spent;
    const percent = safeAmount > 0 ? spent / safeAmount : 0;

    const status = this.deriveStatus(percent);

    const daysTotal = Math.max(1, this.daysBetween(period.startDate, period.endDate) + 1);
    const daysElapsedRaw = this.daysBetween(period.startDate, now) + 1;
    const daysElapsed = Math.min(daysTotal, Math.max(1, daysElapsedRaw));

    // Para períodos que ainda não começaram (now <= início) ou já encerrados
    // (now >= fim), a "projeção pelo ritmo atual" não tem sentido — usamos o
    // gasto efetivo. A comparação com `<=` cobre o caso em que a UI passa o
    // primeiro dia do mês futuro como `now`.
    const periodNotStarted = now.getTime() <= period.startDate.getTime();
    const periodEnded = now.getTime() >= period.endDate.getTime();
    const projectedSpent = periodNotStarted || periodEnded
      ? spent
      : (spent / daysElapsed) * daysTotal;
    const projectedPercent = safeAmount > 0 ? projectedSpent / safeAmount : 0;
    const projectedStatus = this.deriveStatus(projectedPercent);

    return {
      budget: { ...budget, amount: safeAmount },
      spent,
      remaining,
      percent,
      status,
      daysElapsed,
      daysTotal,
      projectedSpent,
      projectedStatus,
      periodLabel: period.label
    };
  }

  /** Versão batch: utilitário comum para listar progresso de várias metas. */
  computeAll(
    budgets: ReadonlyArray<Budget>,
    context: Parameters<BudgetCalculatorService['computeProgress']>[1]
  ): BudgetProgress[] {
    return budgets
      .filter((b) => b.active !== false)
      .filter((b) => this.isPeriodInBudgetWindow(b, this.resolvePeriod(b, context.now ?? new Date(), context.cards)))
      .map((budget) => this.computeProgress(budget, context));
  }

  private isPeriodInBudgetWindow(
    budget: Budget,
    period: { year?: number; month?: number; invoiceMonth?: InvoiceMonth }
  ): boolean {
    const refYear = period.year ?? period.invoiceMonth?.year;
    const refMonth = period.month ?? period.invoiceMonth?.month;
    if (refYear === undefined || refMonth === undefined) {
      return true;
    }
    const refIndex = refYear * 12 + (refMonth - 1);

    if (budget.startYear !== undefined && budget.startMonth !== undefined) {
      const startIndex = budget.startYear * 12 + (budget.startMonth - 1);
      if (refIndex < startIndex) {
        return false;
      }
    }

    if (budget.endYear !== undefined && budget.endMonth !== undefined) {
      const endIndex = budget.endYear * 12 + (budget.endMonth - 1);
      if (refIndex > endIndex) {
        return false;
      }
    }

    if (budget.excludedMonths && budget.excludedMonths.length > 0) {
      const key = `${refYear}-${String(refMonth).padStart(2, '0')}`;
      if (budget.excludedMonths.includes(key)) {
        return false;
      }
    }

    return true;
  }

  private resolveAmountForPeriod(
    budget: Budget,
    period: { year?: number; month?: number; invoiceMonth?: InvoiceMonth }
  ): number {
    const refYear = period.year ?? period.invoiceMonth?.year;
    const refMonth = period.month ?? period.invoiceMonth?.month;
    if (refYear !== undefined && refMonth !== undefined && budget.monthlyAmounts) {
      const key = `${refYear}-${String(refMonth).padStart(2, '0')}`;
      const override = budget.monthlyAmounts[key];
      if (Number.isFinite(override) && (override as number) > 0) {
        return override as number;
      }
    }
    return budget.amount;
  }

  // -------------------------------------------------------------------------
  // Resolução do período
  // -------------------------------------------------------------------------

  private resolvePeriod(
    budget: Budget,
    now: Date,
    cards: ReadonlyArray<CreditCard>
  ): { startDate: Date; endDate: Date; label: string; year?: number; month?: number; invoiceMonth?: InvoiceMonth } {
    if (budget.period === 'invoice-cycle' && budget.scope === 'card') {
      const card = cards.find((c) => String(c.id) === String(budget.targetId));
      if (card) {
        const invoiceMonth = getInvoiceMonthForDate(this.toIsoDate(now), card);
        if (invoiceMonth) {
          const startDate = getCycleStartDateForInvoiceMonth(invoiceMonth, card);
          const endDate = getClosingDateForInvoiceMonth(invoiceMonth, card);
          return {
            startDate,
            endDate,
            invoiceMonth,
            label: `Fatura de ${this.monthLabel(invoiceMonth.month)}/${invoiceMonth.year}`
          };
        }
      }
    }

    // Fallback: monthly (calendário).
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0); // último dia do mês
    return {
      startDate,
      endDate,
      year,
      month,
      label: `${this.monthLabel(month)}/${year}`
    };
  }

  // -------------------------------------------------------------------------
  // Cálculo do gasto
  // -------------------------------------------------------------------------

  private computeSpent(
    budget: Budget,
    period: { startDate: Date; endDate: Date; year?: number; month?: number; invoiceMonth?: InvoiceMonth },
    context: {
      months: ReadonlyArray<MonthDefinition>;
      cardLaunches: ReadonlyArray<CardLaunch>;
      cards: ReadonlyArray<CreditCard>;
      now?: Date;
    }
  ): number {
    if (budget.scope === 'tag') {
      return this.computeTagSpent(budget, period, context);
    }
    if (budget.scope === 'card') {
      return this.computeCardSpent(budget, period, context);
    }
    if (budget.scope === 'investment') {
      return this.computeInvestmentSpent(budget, period, context);
    }
    return this.computeGlobalSpent(period, context);
  }

  private computeTagSpent(
    budget: Budget,
    period: { startDate: Date; endDate: Date; year?: number; month?: number },
    context: {
      months: ReadonlyArray<MonthDefinition>;
      cardLaunches: ReadonlyArray<CardLaunch>;
      cards: ReadonlyArray<CreditCard>;
      now?: Date;
    }
  ): number {
    const tagKey = normalizeTagName(budget.targetId || budget.targetName);
    if (!tagKey) {
      return 0;
    }

    // Para a meta da tag "diário" (que agrega lançamentos do tipo daily), só
    // contamos os dias já decorridos quando o período é o mês corrente — assim
    // a barra começa em 0 e cresce com o passar dos dias, em vez de já estourar
    // 100% logo no dia 1 com a soma do mês inteiro.
    const isDailyBudget = tagKey === DAILY_IMPLICIT_TAG_KEY;
    const now = context.now ?? new Date();
    const dailyDayCap = this.resolveDailyDayCap(period, now);

    let total = 0;

    // Eventos do mês civil correspondente.
    // Atenção: pode haver múltiplos docs para o mesmo (year, monthNumber)
    // — por ex., um doc com key "2026-06" e outro com key "jun-2026".
    // Precisamos agregar todos para não perder eventos.
    if (period.year !== undefined && period.month !== undefined) {
      const monthDefs = context.months.filter(
        (m) => m.year === period.year && m.monthNumber === period.month
      );
      const seenEventIds = new Set<string>();
      for (const monthDef of monthDefs) {
        for (const ev of monthDef.events ?? []) {
          // Deduplica por id quando o mesmo evento aparece em mais de um doc.
          if (ev.id && seenEventIds.has(ev.id)) {
            continue;
          }
          if (!this.isExpenseEvent(ev)) {
            continue;
          }
          if (!this.eventMatchesTag(ev, tagKey)) {
            continue;
          }
          if (isDailyBudget && ev.type === 'daily' && dailyDayCap !== null && ev.day > dailyDayCap) {
            continue;
          }
          if (ev.id) {
            seenEventIds.add(ev.id);
          }
          total += this.absAmount(ev.amount);
        }
      }
    }

    // Lançamentos de cartão agrupados pelo mês calendário da data da compra/parcela.
    // (No período "Mensal" usamos a data civil; período "Ciclo de fatura" é tratado em computeCardSpent.)
    if (period.year !== undefined && period.month !== undefined) {
      const monthRef = `${period.year}-${String(period.month).padStart(2, '0')}`;
      for (const launch of context.cardLaunches) {
        if (!this.launchMatchesTag(launch, tagKey)) {
          continue;
        }
        if (typeof launch.date !== 'string' || !launch.date.startsWith(monthRef)) {
          continue;
        }
        total += this.absAmount(launch.amount);
      }
    }

    return total;
  }

  private computeCardSpent(
    budget: Budget,
    period: { startDate: Date; endDate: Date; year?: number; month?: number; invoiceMonth?: InvoiceMonth },
    context: { cardLaunches: ReadonlyArray<CardLaunch>; cards: ReadonlyArray<CreditCard> }
  ): number {
    const cardId = String(budget.targetId);
    const card = context.cards.find((c) => String(c.id) === cardId);
    if (!card) {
      return 0;
    }

    let total = 0;
    for (const launch of context.cardLaunches) {
      if (String(launch.cardId) !== cardId) {
        continue;
      }
      if (period.invoiceMonth) {
        // Período = Ciclo de fatura: agrupa pelo ciclo de fechamento do cartão.
        const inv = getInvoiceMonthForDate(launch.date, card);
        if (inv && inv.year === period.invoiceMonth.year && inv.month === period.invoiceMonth.month) {
          total += this.absAmount(launch.amount);
        }
      } else if (period.year !== undefined && period.month !== undefined) {
        // Período = Mensal: agrupa pelo mês calendário da data da compra/parcela.
        if (typeof launch.date === 'string') {
          const monthRef = `${period.year}-${String(period.month).padStart(2, '0')}`;
          if (launch.date.startsWith(monthRef)) {
            total += this.absAmount(launch.amount);
          }
        }
      }
    }
    return total;
  }

  private computeInvestmentSpent(
    budget: Budget,
    period: { startDate: Date; endDate: Date; year?: number; month?: number },
    context: { months: ReadonlyArray<MonthDefinition> }
  ): number {
    if (period.year === undefined || period.month === undefined) {
      return 0;
    }

    const tagKey = normalizeTagName(budget.targetId || budget.targetName);
    if (!tagKey) {
      return 0;
    }

    const monthDefs = context.months.filter((m) => m.year === period.year && m.monthNumber === period.month);
    if (!monthDefs.length) {
      return 0;
    }

    const investmentEventById = new Map<string, FinancialEvent>();
    for (const month of context.months) {
      for (const ev of month.events ?? []) {
        if (ev.type === 'investment' && ev.id && ev.suppressed !== true) {
          investmentEventById.set(ev.id, ev);
        }
      }
    }

    let total = 0;
    for (const monthDef of monthDefs) {
      for (const ev of monthDef.events ?? []) {
        if (ev.type === 'investment') {
          if (ev.suppressed === true || !this.eventMatchesTag(ev, tagKey)) {
            continue;
          }
          total += this.absAmount(ev.amount);
          continue;
        }

        if (!this.isInvestmentWithdrawalEvent(ev)) {
          continue;
        }

        const sourceEvent = ev.investmentSourceEventId ? investmentEventById.get(ev.investmentSourceEventId) : undefined;
        if (!sourceEvent || !this.eventMatchesTag(sourceEvent, tagKey)) {
          continue;
        }

        total -= this.absAmount(ev.amount);
      }
    }

    return total;
  }

  private computeGlobalSpent(
    period: { startDate: Date; endDate: Date; year?: number; month?: number },
    context: { months: ReadonlyArray<MonthDefinition>; cardLaunches: ReadonlyArray<CardLaunch>; cards: ReadonlyArray<CreditCard> }
  ): number {
    if (period.year === undefined || period.month === undefined) {
      return 0;
    }
    let total = 0;
    const monthDef = context.months.find((m) => m.year === period.year && m.monthNumber === period.month);
    if (monthDef) {
      for (const ev of monthDef.events ?? []) {
        if (this.isExpenseEvent(ev)) {
          total += this.absAmount(ev.amount);
        }
      }
    }
    for (const launch of context.cardLaunches) {
      const card = context.cards.find((c) => String(c.id) === String(launch.cardId));
      if (!card) {
        continue;
      }
      const inv = getInvoiceMonthForDate(launch.date, card);
      if (inv && inv.year === period.year && inv.month === period.month) {
        total += this.absAmount(launch.amount);
      }
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isExpenseEvent(ev: FinancialEvent): boolean {
    return (ev.type === 'expense' || ev.type === 'daily') && ev.suppressed !== true;
  }

  private isInvestmentWithdrawalEvent(ev: FinancialEvent): boolean {
    return ev.type === 'income' && !!ev.investmentSourceEventId && ev.suppressed !== true;
  }

  /**
   * Para a meta da tag "diário" (que soma eventos do tipo `daily`), retornamos
   * o último dia que já passou dentro do período. Assim eventos diários de dias
   * futuros não entram no `spent`. Retorna `null` quando não há limite a aplicar
   * (período passado por completo, ou inteiramente no futuro).
   */
  private resolveDailyDayCap(
    period: { startDate: Date; endDate: Date; year?: number; month?: number },
    now: Date
  ): number | null {
    if (period.year === undefined || period.month === undefined) {
      return null;
    }
    // Usamos sempre a data real do sistema (não o `now` que pode ter sido
    // sintetizado pela UI ao navegar para outro mês na tela de metas). Caso
    // contrário, ao abrir junho a UI passaria now = "01/jun" e o cap virava
    // dia 1, somando lançamentos diários do dia 1 mesmo sendo um mês futuro.
    const today = new Date();
    const periodIndex = period.year * 12 + (period.month - 1);
    const todayIndex = today.getFullYear() * 12 + today.getMonth();
    if (todayIndex < periodIndex) {
      // período inteiramente no futuro: não conta nada.
      return 0;
    }
    if (todayIndex > periodIndex) {
      // período já encerrado: conta tudo.
      return null;
    }
    return today.getDate();
  }

  private eventMatchesTag(ev: FinancialEvent, tagKey: string): boolean {
    // Lançamentos do tipo "daily" são tratados implicitamente como se
    // tivessem a tag "diário", para que o orçamento dessa tag agregue todos
    // os diários sem o usuário precisar marcar a tag manualmente.
    if (ev.type === 'daily' && tagKey === DAILY_IMPLICIT_TAG_KEY) {
      return true;
    }
    const tags = ev.tags ?? [];
    return tags.some((t) => normalizeTagName(t) === tagKey);
  }

  private launchMatchesTag(launch: CardLaunch, tagKey: string): boolean {
    if (!launch.tags) {
      return false;
    }
    return launch.tags
      .split(',')
      .map((t) => normalizeTagName(t))
      .some((t) => t === tagKey);
  }

  private absAmount(value: number): number {
    return Math.abs(Number.isFinite(value) ? value : 0);
  }

  private daysBetween(start: Date, end: Date): number {
    const dayMs = 86_400_000;
    const a = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const b = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
    return Math.floor((b - a) / dayMs);
  }

  private deriveStatus(percent: number): BudgetStatus {
    if (percent > 1) {
      return 'over';
    }
    if (percent >= WARNING_THRESHOLD) {
      return 'warning';
    }
    return 'ok';
  }

  private toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private monthLabel(month: number): string {
    const names = [
      'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
      'jul', 'ago', 'set', 'out', 'nov', 'dez'
    ];
    return names[Math.max(0, Math.min(11, month - 1))];
  }
}
