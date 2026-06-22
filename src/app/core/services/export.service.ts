import { Injectable } from '@angular/core';

import {
  CardLaunch,
  CreditCard,
  EventType,
  FinancialEvent,
  MonthDefinition
} from './finance-api.service';
import { getInvoiceMonthForDate, getDueDateForInvoiceMonth } from '../utils/card-cycle.util';

export interface ExportRow {
  date: string;          // ISO yyyy-mm-dd
  category: string;      // Lançamento | Diário | Cartão
  type: string;          // Receita | Despesa | Investimento | Diário | Despesa cartão
  description: string;
  account: string;       // ex.: Inter, Cartão XYZ
  amount: number;        // sempre absoluto, sinal vai em `signedAmount`
  signedAmount: number;  // negativo p/ saídas, positivo p/ receitas
  tags: string;
  notes: string;
}

export interface ExportContext {
  year: number;
  month: number;          // 1..12
  monthLabel: string;     // ex.: "maio 2026"
  rows: ExportRow[];
  totals: {
    income: number;
    expense: number;
    investment: number;
    daily: number;
    card: number;
    net: number;
  };
  openingBalance: number;
  /**
   * Faturas de cartão que vencem dentro do mês exportado, consolidadas por
   * dia de vencimento. Usado pelo "Resumo diário" para exibir o gasto na
   * data correta (igual ao dashboard).
   */
  cardInvoiceForecasts: Array<{ day: number; amount: number; cardName: string }>;
}

export interface DailyMatrixRow {
  day: number;
  income: number;
  expense: number;
  investment: number;
  daily: number;
  closingBalance: number;
}

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly monthNames = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];

  /**
   * Monta as linhas do mês selecionado a partir das definições de mês +
   * lançamentos de cartão. Despesas de cartão são incluídas pela `date`
   * (data da compra), não pela fatura — assim "exportar maio" traz tudo
   * que foi gasto no mês de maio.
   */
  buildMonthExport(
    year: number,
    month: number,
    months: MonthDefinition[],
    cardLaunches: CardLaunch[],
    cards: CreditCard[]
  ): ExportContext {
    const rows: ExportRow[] = [];

    // Match defensivo: aceita year/monthNumber como number ou string, e cai
    // pra `key` no formato "yyyy-mm" como fallback.
    const targetKey = `${year}-${String(month).padStart(2, '0')}`;
    const candidateMonths = months.filter(
      (m) =>
        (Number(m.year) === year && Number(m.monthNumber) === month) ||
        m.key === targetKey
    );
    // Pode haver mais de um doc com a mesma chave (placeholder vazio + real).
    // Pega o que tem mais events; em empate, o que foi criado por último.
    const monthDef = candidateMonths.sort((a, b) => {
      const eventsDiff = (b.events?.length ?? 0) - (a.events?.length ?? 0);
      if (eventsDiff !== 0) return eventsDiff;
      return String(b.id ?? '').localeCompare(String(a.id ?? ''));
    })[0];

    if (monthDef) {
      for (const ev of monthDef.events ?? []) {
        if (ev.suppressed) continue;
        // Diários são tratados pela projeção abaixo (carry de séries fixas
        // + skips/overrides), evitando duplicidade.
        if (ev.type === 'daily') continue;
        rows.push(this.fromEvent(ev, year, month));
      }
    }

    // Lançamentos fixos mensais (income/expense/investment) só ficam materializados
    // no mês original; meses futuros recebem via propagação sob demanda no app.
    // Aqui projetamos virtualmente pra garantir que apareçam no export.
    const fixedRows = this.projectFixedMonthlyRows(year, month, months, monthDef);
    rows.push(...fixedRows);

    // Diários recorrentes: replica a lógica do dashboard que carrega séries
    // através dos meses (`seriesAmounts`). Sem isso, diários fixos criados
    // em meses anteriores não apareceriam no mês exportado.
    const dailyRows = this.projectDailySeriesRows(year, month, months);
    rows.push(...dailyRows);

    const cardById = new Map<string, CreditCard>();
    for (const c of cards) {
      if (c.id !== undefined && c.id !== null) {
        cardById.set(String(c.id), c);
      }
    }

    for (const launch of cardLaunches) {
      if (!launch.date || !launch.date.startsWith(targetKey)) continue;
      const card = cardById.get(String(launch.cardId));
      rows.push(this.fromCardLaunch(launch, card));
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));

    const totals = this.computeTotals(rows);
    const cardInvoiceForecasts = this.buildCardInvoiceForecastsForMonth(year, month, cardLaunches, cards);

    return {
      year,
      month,
      monthLabel: `${this.monthNames[month - 1]} ${year}`,
      rows,
      totals,
      openingBalance: Number(monthDef?.openingBalance ?? 0) || 0,
      cardInvoiceForecasts,
    };
  }

  /**
   * Para cada cartão, calcula a data de vencimento da fatura cujo ciclo cobre
   * cada `cardLaunch`, e agrega o valor por (dia, cartão) — somente quando o
   * vencimento cai dentro do mês exportado. Replica a lógica do dashboard.
   */
  private buildCardInvoiceForecastsForMonth(
    year: number,
    month: number,
    cardLaunches: CardLaunch[],
    cards: CreditCard[]
  ): Array<{ day: number; amount: number; cardName: string }> {
    const aggregate = new Map<string, { day: number; amount: number; cardName: string }>();

    for (const launch of cardLaunches) {
      const card = cards.find((c) => String(c.id) === String(launch.cardId));
      if (!card || !launch.date) continue;

      const due = this.computeDueDateForLaunch(launch.date, card);
      if (!due) continue;
      if (due.getFullYear() !== year || due.getMonth() + 1 !== month) continue;

      const day = due.getDate();
      const key = `${day}|${card.id ?? card.name}`;
      const existing = aggregate.get(key);
      const amount = Number(launch.amount) || 0;
      if (existing) {
        existing.amount = Number((existing.amount + amount).toFixed(2));
      } else {
        aggregate.set(key, { day, amount: Number(amount.toFixed(2)), cardName: card.name });
      }
    }

    return Array.from(aggregate.values()).sort((a, b) => a.day - b.day);
  }

  private computeDueDateForLaunch(dateInput: string, card: CreditCard): Date | null {
    const invoiceMonth = getInvoiceMonthForDate(dateInput, card);
    if (!invoiceMonth) return null;
    return getDueDateForInvoiceMonth(invoiceMonth, card);
  }

  /**
   * Projeta lançamentos `income | expense | investment` com `recurrenceKind: 'fixed'`
   * e `repeatMode: 'monthly'` para o mês alvo. Pega o template mais recente em
   * meses anteriores (ou no próprio) e emite apenas se o mês alvo ainda não
   * possui um evento com aquele `seriesId` (evita duplicar quando já foi
   * materializado pelo app).
   */
  private projectFixedMonthlyRows(
    year: number,
    month: number,
    months: MonthDefinition[],
    targetMonth: MonthDefinition | undefined
  ): ExportRow[] {
    const existingSeriesIds = new Set<string>();
    if (targetMonth) {
      for (const ev of targetMonth.events ?? []) {
        if (ev.seriesId) existingSeriesIds.add(ev.seriesId);
      }
    }

    // Última versão de cada série fixa mensal vista até o mês alvo (inclusive).
    const templateBySeriesId = new Map<string, FinancialEvent>();
    const sorted = [...months].sort(
      (a, b) => (Number(a.year) - Number(b.year)) || (Number(a.monthNumber) - Number(b.monthNumber))
    );

    for (const m of sorted) {
      const my = Number(m.year);
      const mm = Number(m.monthNumber);
      if (my > year || (my === year && mm > month)) break;
      for (const ev of m.events ?? []) {
        if (!ev.seriesId) continue;
        if (ev.recurrenceKind !== 'fixed' || ev.repeatMode !== 'monthly') continue;
        if (ev.type === 'daily') continue; // tratado em projectDailySeriesRows
        templateBySeriesId.set(ev.seriesId, ev);
      }
    }

    const rows: ExportRow[] = [];
    const daysInMonth = new Date(year, month, 0).getDate();

    for (const template of templateBySeriesId.values()) {
      if (existingSeriesIds.has(template.seriesId!)) continue;
      const day = Math.min(Math.max(1, Number(template.day) || 1), daysInMonth);
      rows.push(this.fromEvent({ ...template, day }, year, month));
    }

    return rows;
  }

  /**
   * Reproduz, em modo "fast-forward", a evolução das séries de diário fixo
   * até o mês alvo, e emite uma linha por dia com o total de diário do dia
   * (única série + carry) e descrição com os labels ativos.
   */
  private projectDailySeriesRows(
    year: number,
    month: number,
    months: MonthDefinition[]
  ): ExportRow[] {
    const sorted = [...months].sort(
      (a, b) => (Number(a.year) - Number(b.year)) || (Number(a.monthNumber) - Number(b.monthNumber))
    );

    const seriesAmounts = new Map<string, number>();
    const seriesLabels = new Map<string, string>();
    let target: MonthDefinition | undefined;

    for (const m of sorted) {
      const isTarget = Number(m.year) === year && Number(m.monthNumber) === month;
      if (Number(m.year) > year || (Number(m.year) === year && Number(m.monthNumber) > month)) {
        break;
      }

      if (isTarget) {
        target = m;
        break;
      }

      // Replica updates do mês anterior antes de chegar no alvo. Como não
      // sabemos a ordem dos events ao longo do mês, processamos por dia.
      const byDay = this.groupEventsByDay(m.events ?? []);
      const daysInMonth = new Date(Number(m.year), Number(m.monthNumber), 0).getDate();
      for (let d = 1; d <= daysInMonth; d += 1) {
        const events = byDay.get(d) ?? [];
        for (const ev of events) {
          if (ev.type !== 'daily' || !ev.seriesId) continue;
          if ((ev.recurrenceKind ?? 'single') === 'single') continue;
          if (ev.dailyOccurrenceAction === 'skip' || ev.dailyOccurrenceAction === 'override') continue;
          seriesAmounts.set(ev.seriesId, ev.amount);
          if (ev.label) seriesLabels.set(ev.seriesId, ev.label);
        }
      }
    }

    if (!target) return [];

    const rows: ExportRow[] = [];
    const byDay = this.groupEventsByDay(target.events ?? []);
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthStr = String(month).padStart(2, '0');

    for (let d = 1; d <= daysInMonth; d += 1) {
      const events = byDay.get(d) ?? [];
      let singleSum = 0;
      const singleLabels: string[] = [];
      const skips = new Set<string>();
      const overrides = new Map<string, number>();

      for (const ev of events) {
        if (ev.type !== 'daily' || ev.suppressed) continue;
        const kind = ev.recurrenceKind ?? 'single';
        if (kind === 'single' || !ev.seriesId) {
          singleSum += ev.amount;
          if (ev.label) singleLabels.push(ev.label);
        } else if (ev.dailyOccurrenceAction === 'skip') {
          skips.add(ev.seriesId);
        } else if (ev.dailyOccurrenceAction === 'override') {
          overrides.set(ev.seriesId, ev.amount);
        } else {
          seriesAmounts.set(ev.seriesId, ev.amount);
          if (ev.label) seriesLabels.set(ev.seriesId, ev.label);
        }
      }

      let dayTotal = singleSum;
      const labelParts: string[] = [...singleLabels];
      for (const [sid, amt] of seriesAmounts.entries()) {
        if (skips.has(sid)) continue;
        const value = overrides.has(sid) ? overrides.get(sid)! : amt;
        if (!value) continue;
        dayTotal += value;
        const lbl = seriesLabels.get(sid) ?? 'Diário';
        labelParts.push(lbl);
      }

      if (dayTotal <= 0) continue;

      const date = `${year}-${monthStr}-${String(d).padStart(2, '0')}`;
      rows.push({
        date,
        category: 'Diário',
        type: 'Diário',
        description: labelParts.length ? labelParts.join(' + ') : 'Diário do dia',
        account: '',
        amount: dayTotal,
        signedAmount: -dayTotal,
        tags: '',
        notes: '',
      });
    }

    return rows;
  }

  private groupEventsByDay(events: FinancialEvent[]): Map<number, FinancialEvent[]> {
    const map = new Map<number, FinancialEvent[]>();
    for (const ev of events) {
      const day = Number(ev.day);
      if (!day) continue;
      const arr = map.get(day) ?? [];
      arr.push(ev);
      map.set(day, arr);
    }
    return map;
  }

  // -------------------------------------------------------- Matriz diária

  /**
   * Agrega as `rows` por dia em colunas (entrada / saída / investidos / diário)
   * com saldo corrente. Replica exatamente o formato do dashboard:
   * faturas de cartão entram como "saída" no dia do vencimento (consolidadas
   * por cartão), em vez de aparecerem por compra.
   */
  buildDailyMatrix(ctx: ExportContext): DailyMatrixRow[] {
    const daysInMonth = new Date(ctx.year, ctx.month, 0).getDate();
    const byDay = new Map<number, DailyMatrixRow>();
    for (let d = 1; d <= daysInMonth; d += 1) {
      byDay.set(d, { day: d, income: 0, expense: 0, investment: 0, daily: 0, closingBalance: 0 });
    }

    for (const r of ctx.rows) {
      // Cartão é tratado via fatura no dia do vencimento (abaixo).
      if (r.category === 'Cartão') continue;

      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date);
      if (!m) continue;
      const day = Number(m[3]);
      const slot = byDay.get(day);
      if (!slot) continue;

      if (r.type === 'Receita') slot.income += r.amount;
      else if (r.type === 'Despesa') slot.expense += r.amount;
      else if (r.type === 'Investimento') slot.investment += r.amount;
      else if (r.type === 'Diário') slot.daily += r.amount;
    }

    // Faturas de cartão consolidadas no dia do vencimento (igual dashboard).
    for (const fc of ctx.cardInvoiceForecasts) {
      const slot = byDay.get(fc.day);
      if (!slot) continue;
      slot.expense += fc.amount;
    }

    let running = ctx.openingBalance;
    const out: DailyMatrixRow[] = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const slot = byDay.get(d)!;
      running += slot.income - slot.expense - slot.investment - slot.daily;
      slot.closingBalance = Number(running.toFixed(2));
      out.push(slot);
    }
    return out;
  }

  /** Exporta a matriz diária (uma linha por dia, colunas de totais) em CSV. */
  downloadDailyCsv(ctx: ExportContext): void {
    const matrix = this.buildDailyMatrix(ctx);
    const header = ['Dia', 'Entrada', 'Saída', 'Investidos', 'Diário', 'Saldo'];
    const lines: string[] = [header.map(this.csvCell).join(';')];

    let totalIncome = 0, totalExpense = 0, totalInvestment = 0, totalDaily = 0;
    for (const r of matrix) {
      totalIncome += r.income;
      totalExpense += r.expense;
      totalInvestment += r.investment;
      totalDaily += r.daily;
      lines.push([
        this.csvCell(String(r.day)),
        this.csvCell(this.formatNumber(r.income)),
        this.csvCell(this.formatNumber(r.expense)),
        this.csvCell(this.formatNumber(r.investment)),
        this.csvCell(this.formatNumber(r.daily)),
        this.csvCell(this.formatNumber(r.closingBalance)),
      ].join(';'));
    }

    const finalBalance = ctx.openingBalance + totalIncome - totalExpense - totalInvestment - totalDaily;
    lines.push('');
    lines.push([
      this.csvCell('Totais'),
      this.csvCell(this.formatNumber(totalIncome)),
      this.csvCell(this.formatNumber(totalExpense)),
      this.csvCell(this.formatNumber(totalInvestment)),
      this.csvCell(this.formatNumber(totalDaily)),
      this.csvCell(this.formatNumber(finalBalance)),
    ].join(';'));
    lines.push([this.csvCell('Saldo inicial'), '', '', '', '', this.csvCell(this.formatNumber(ctx.openingBalance))].join(';'));
    lines.push([this.csvCell('Saldo final'), '', '', '', '', this.csvCell(this.formatNumber(finalBalance))].join(';'));

    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    this.triggerDownload(blob, `lancamentos-diario-${ctx.year}-${String(ctx.month).padStart(2, '0')}.csv`);
  }

  /** Abre janela imprimível com a matriz diária (similar ao layout do dashboard). */
  openDailyPrintablePdf(ctx: ExportContext): void {
    const win = window.open('', '_blank', 'noopener,noreferrer,width=900,height=1000');
    if (!win) {
      alert('Não foi possível abrir a janela de impressão. Verifique se o navegador está bloqueando pop-ups.');
      return;
    }
    win.document.open();
    win.document.write(this.buildDailyPrintableHtml(ctx));
    win.document.close();

    const triggerPrint = () => { try { win.focus(); win.print(); } catch { /* noop */ } };
    if (win.document.readyState === 'complete') {
      setTimeout(triggerPrint, 200);
    } else {
      win.addEventListener('load', () => setTimeout(triggerPrint, 200));
    }
  }

  /** Gera CSV detalhado (uma linha por lançamento). */
  downloadCsv(ctx: ExportContext): void {
    const header = [
      'Data', 'Categoria', 'Tipo', 'Descrição', 'Conta/Cartão',
      'Valor (R$)', 'Valor com sinal (R$)', 'Tags', 'Notas'
    ];
    const lines: string[] = [header.map(this.csvCell).join(';')];

    for (const r of ctx.rows) {
      lines.push([
        this.csvCell(r.date),
        this.csvCell(r.category),
        this.csvCell(r.type),
        this.csvCell(r.description),
        this.csvCell(r.account),
        this.csvCell(this.formatNumber(r.amount)),
        this.csvCell(this.formatNumber(r.signedAmount)),
        this.csvCell(r.tags),
        this.csvCell(r.notes),
      ].join(';'));
    }

    // Linha em branco + totais
    lines.push('');
    const t = ctx.totals;
    lines.push([this.csvCell('Receitas'), '', '', '', '', this.csvCell(this.formatNumber(t.income))].join(';'));
    lines.push([this.csvCell('Despesas'), '', '', '', '', this.csvCell(this.formatNumber(t.expense))].join(';'));
    lines.push([this.csvCell('Investimentos'), '', '', '', '', this.csvCell(this.formatNumber(t.investment))].join(';'));
    lines.push([this.csvCell('Diários'), '', '', '', '', this.csvCell(this.formatNumber(t.daily))].join(';'));
    lines.push([this.csvCell('Despesas de cartão'), '', '', '', '', this.csvCell(this.formatNumber(t.card))].join(';'));
    lines.push([this.csvCell('Saldo líquido'), '', '', '', '', this.csvCell(this.formatNumber(t.net))].join(';'));

    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    this.triggerDownload(blob, `lancamentos-${ctx.year}-${String(ctx.month).padStart(2, '0')}.csv`);
  }

  /**
   * Abre uma janela com layout estruturado e dispara `print()` automaticamente.
   * O usuário escolhe "Salvar como PDF" no diálogo de impressão do navegador.
   */
  openPrintablePdf(ctx: ExportContext): void {
    const win = window.open('', '_blank', 'noopener,noreferrer,width=900,height=1000');
    if (!win) {
      alert('Não foi possível abrir a janela de impressão. Verifique se o navegador está bloqueando pop-ups.');
      return;
    }

    win.document.open();
    win.document.write(this.buildPrintableHtml(ctx));
    win.document.close();

    const triggerPrint = () => {
      try {
        win.focus();
        win.print();
      } catch {
        /* noop */
      }
    };

    if (win.document.readyState === 'complete') {
      setTimeout(triggerPrint, 200);
    } else {
      win.addEventListener('load', () => setTimeout(triggerPrint, 200));
    }
  }

  // ----------------------------------------------------------- internals

  private fromEvent(ev: FinancialEvent, year: number, month: number): ExportRow {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(ev.day).padStart(2, '0')}`;
    const tags = (ev.tags ?? []).filter((t) => !!t).join(', ');
    const isExpense = ev.type === 'expense' || ev.type === 'daily' || ev.type === 'investment';
    const signed = isExpense ? -Math.abs(ev.amount) : Math.abs(ev.amount);
    return {
      date,
      category: ev.type === 'daily' ? 'Diário' : 'Lançamento',
      type: this.eventTypeLabel(ev.type),
      description: ev.label || '—',
      account: '',
      amount: Math.abs(ev.amount),
      signedAmount: signed,
      tags,
      notes: '',
    };
  }

  private fromCardLaunch(launch: CardLaunch, card?: CreditCard): ExportRow {
    const cardName = card?.name ?? launch.account ?? 'Cartão';
    const installmentSuffix = launch.installmentTotal && launch.installmentTotal > 1
      ? ` (${launch.installmentNumber ?? 1}/${launch.installmentTotal})`
      : '';
    return {
      date: launch.date,
      category: 'Cartão',
      type: 'Despesa cartão',
      description: (launch.description || '—') + installmentSuffix,
      account: cardName,
      amount: Math.abs(launch.amount),
      signedAmount: -Math.abs(launch.amount),
      tags: launch.tags || '',
      notes: launch.notes || '',
    };
  }

  private eventTypeLabel(type: EventType): string {
    switch (type) {
      case 'income': return 'Receita';
      case 'expense': return 'Despesa';
      case 'investment': return 'Investimento';
      case 'daily': return 'Diário';
    }
  }

  private computeTotals(rows: ExportRow[]) {
    let income = 0, expense = 0, investment = 0, daily = 0, card = 0;
    for (const r of rows) {
      if (r.category === 'Cartão') {
        card += r.amount;
      } else if (r.type === 'Receita') {
        income += r.amount;
      } else if (r.type === 'Despesa') {
        expense += r.amount;
      } else if (r.type === 'Investimento') {
        investment += r.amount;
      } else if (r.type === 'Diário') {
        daily += r.amount;
      }
    }
    const net = income - expense - investment - daily - card;
    return { income, expense, investment, daily, card, net };
  }

  private csvCell = (value: string | number | null | undefined): string => {
    const str = value === null || value === undefined ? '' : String(value);
    if (/[";\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  private formatNumber(value: number): string {
    // pt-BR: vírgula decimal, sem agrupador (mais limpo p/ Excel)
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toFixed(2).replace('.', ',');
  }

  private formatCurrency(value: number): string {
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
  }

  private formatDate(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildPrintableHtml(ctx: ExportContext): string {
    const rowsHtml = ctx.rows.length === 0
      ? `<tr><td colspan="6" class="empty">Sem lançamentos neste mês.</td></tr>`
      : ctx.rows.map((r) => `
          <tr class="row-${r.category.toLowerCase().replace('ã', 'a')}">
            <td>${this.escapeHtml(this.formatDate(r.date))}</td>
            <td>${this.escapeHtml(r.category)}</td>
            <td>${this.escapeHtml(r.description)}${r.account ? ` <span class="muted">· ${this.escapeHtml(r.account)}</span>` : ''}</td>
            <td>${this.escapeHtml(r.tags)}</td>
            <td class="amount ${r.signedAmount < 0 ? 'neg' : 'pos'}">${this.escapeHtml(this.formatCurrency(r.signedAmount))}</td>
            <td>${this.escapeHtml(r.notes)}</td>
          </tr>
        `).join('');

    const t = ctx.totals;
    const generated = new Date().toLocaleString('pt-BR');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Lançamentos · ${this.escapeHtml(ctx.monthLabel)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 24px; font-size: 12px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .meta { color: #6b7280; font-size: 11px; margin-bottom: 18px; }
    .summary { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 18px; }
    .summary div { background: #f3f4f6; border-radius: 6px; padding: 8px 10px; }
    .summary .label { font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px; }
    .summary .value { font-size: 13px; font-weight: 600; margin-top: 2px; }
    .summary .net.pos { color: #047857; }
    .summary .net.neg { color: #b91c1c; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    th { background: #f9fafb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #374151; }
    td.amount { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
    td.amount.neg { color: #b91c1c; }
    td.amount.pos { color: #047857; }
    td.empty { text-align: center; color: #9ca3af; padding: 20px; }
    .muted { color: #9ca3af; font-size: 11px; }
    .footer { margin-top: 16px; font-size: 10px; color: #9ca3af; }
    @media print {
      body { margin: 12mm; }
      .no-print { display: none; }
      tr { page-break-inside: avoid; }
    }
    .actions { margin-bottom: 18px; }
    .actions button {
      background: #2d6cdf; color: #fff; border: 0; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="actions no-print">
    <button onclick="window.print()">Imprimir / Salvar como PDF</button>
  </div>
  <h1>Lançamentos · ${this.escapeHtml(ctx.monthLabel)}</h1>
  <div class="meta">Gerado em ${this.escapeHtml(generated)} · ${ctx.rows.length} lançamento(s)</div>

  <div class="summary">
    <div><div class="label">Receitas</div><div class="value">${this.escapeHtml(this.formatCurrency(t.income))}</div></div>
    <div><div class="label">Despesas</div><div class="value">${this.escapeHtml(this.formatCurrency(t.expense))}</div></div>
    <div><div class="label">Investimentos</div><div class="value">${this.escapeHtml(this.formatCurrency(t.investment))}</div></div>
    <div><div class="label">Diários</div><div class="value">${this.escapeHtml(this.formatCurrency(t.daily))}</div></div>
    <div><div class="label">Cartão</div><div class="value">${this.escapeHtml(this.formatCurrency(t.card))}</div></div>
    <div><div class="label">Saldo líquido</div><div class="value net ${t.net >= 0 ? 'pos' : 'neg'}">${this.escapeHtml(this.formatCurrency(t.net))}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Data</th>
        <th>Categoria</th>
        <th>Descrição</th>
        <th>Tags</th>
        <th style="text-align:right">Valor</th>
        <th>Notas</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="footer">Previsa · exportação de lançamentos</div>
</body>
</html>`;
  }

  private buildDailyPrintableHtml(ctx: ExportContext): string {
    const matrix = this.buildDailyMatrix(ctx);
    let totalIncome = 0, totalExpense = 0, totalInvestment = 0, totalDaily = 0;
    for (const r of matrix) {
      totalIncome += r.income;
      totalExpense += r.expense;
      totalInvestment += r.investment;
      totalDaily += r.daily;
    }
    const finalBalance = ctx.openingBalance + totalIncome - totalExpense - totalInvestment - totalDaily;
    const generated = new Date().toLocaleString('pt-BR');

    const rowsHtml = matrix.map((r) => {
      const cellOrDash = (v: number) => v === 0
        ? '<span class="muted">—</span>'
        : this.escapeHtml(this.formatCurrency(v));
      const balanceClass = r.closingBalance < 0 ? 'neg' : 'pos';
      return `
        <tr>
          <td class="day">${r.day}</td>
          <td class="num pos">${cellOrDash(r.income)}</td>
          <td class="num neg">${cellOrDash(r.expense)}</td>
          <td class="num">${cellOrDash(r.investment)}</td>
          <td class="num">${cellOrDash(r.daily)}</td>
          <td class="num balance ${balanceClass}">${this.escapeHtml(this.formatCurrency(r.closingBalance))}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>${this.escapeHtml(ctx.monthLabel.toUpperCase())}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 24px; font-size: 12px; }
    h1 { font-size: 18px; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 1px; text-align: center; }
    .meta { color: #6b7280; font-size: 11px; margin-bottom: 16px; text-align: center; }
    .opening { font-size: 11px; margin-bottom: 12px; color: #374151; }
    .opening strong { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 5px 8px; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #374151; text-align: right; }
    th.day, td.day { text-align: left; width: 36px; font-weight: 600; color: #374151; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.num.pos { color: #047857; }
    td.num.neg { color: #b91c1c; }
    td.balance { font-weight: 600; }
    .muted { color: #d1d5db; }
    tfoot td { font-weight: 700; background: #f3f4f6; }
    .summary { margin-top: 16px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .summary div { background: #f9fafb; border-radius: 6px; padding: 8px 10px; }
    .summary .label { font-size: 10px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.5px; }
    .summary .value { font-size: 13px; font-weight: 600; margin-top: 2px; }
    .summary .net.pos { color: #047857; }
    .summary .net.neg { color: #b91c1c; }
    .actions { margin-bottom: 14px; }
    .actions button {
      background: #2d6cdf; color: #fff; border: 0; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 12px;
    }
    @media print {
      body { margin: 12mm; }
      .no-print { display: none; }
      tr { page-break-inside: avoid; }
    }
    .footer { margin-top: 16px; font-size: 10px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="actions no-print">
    <button onclick="window.print()">Imprimir / Salvar como PDF</button>
  </div>
  <h1>${this.escapeHtml(ctx.monthLabel)}</h1>
  <div class="meta">Resumo diário · gerado em ${this.escapeHtml(generated)}</div>
  <div class="opening">Saldo inicial: <strong>${this.escapeHtml(this.formatCurrency(ctx.openingBalance))}</strong></div>

  <table>
    <thead>
      <tr>
        <th class="day">Dia</th>
        <th>Entrada</th>
        <th>Saída</th>
        <th>Investidos</th>
        <th>Diário</th>
        <th>Saldo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td class="day">Σ</td>
        <td class="num pos">${this.escapeHtml(this.formatCurrency(totalIncome))}</td>
        <td class="num neg">${this.escapeHtml(this.formatCurrency(totalExpense))}</td>
        <td class="num">${this.escapeHtml(this.formatCurrency(totalInvestment))}</td>
        <td class="num">${this.escapeHtml(this.formatCurrency(totalDaily))}</td>
        <td class="num balance ${finalBalance >= 0 ? 'pos' : 'neg'}">${this.escapeHtml(this.formatCurrency(finalBalance))}</td>
      </tr>
    </tfoot>
  </table>

  <div class="summary">
    <div><div class="label">Saldo inicial</div><div class="value">${this.escapeHtml(this.formatCurrency(ctx.openingBalance))}</div></div>
    <div><div class="label">Receitas</div><div class="value">${this.escapeHtml(this.formatCurrency(totalIncome))}</div></div>
    <div><div class="label">Saídas totais</div><div class="value">${this.escapeHtml(this.formatCurrency(totalExpense + totalInvestment + totalDaily))}</div></div>
    <div><div class="label">Saldo final</div><div class="value net ${finalBalance >= 0 ? 'pos' : 'neg'}">${this.escapeHtml(this.formatCurrency(finalBalance))}</div></div>
  </div>

  <div class="footer">Previsa · resumo diário</div>
</body>
</html>`;
  }
}
