import { CreditCard } from '../services/finance-api.service';

export interface InvoiceMonth {
  year: number;
  /** 1..12 */
  month: number;
}

/**
 * Calcula a fatura (ano + mês de vencimento) à qual uma data de lançamento pertence,
 * dado o cartão. Replica a lógica usada em `CardsTabComponent`.
 */
export function getInvoiceMonthForDate(dateInput: string, card: CreditCard): InvoiceMonth | null {
  const transactionDate = new Date(`${dateInput}T00:00:00`);
  if (Number.isNaN(transactionDate.getTime())) {
    return null;
  }

  const dueDateSameMonth = new Date(transactionDate.getFullYear(), transactionDate.getMonth(), card.dueDay);
  const closeDateSameMonth = new Date(dueDateSameMonth);
  closeDateSameMonth.setDate(closeDateSameMonth.getDate() - card.closeDaysBefore);

  const invoiceDueDate = transactionDate <= closeDateSameMonth
    ? dueDateSameMonth
    : new Date(transactionDate.getFullYear(), transactionDate.getMonth() + 1, card.dueDay);

  return {
    year: invoiceDueDate.getFullYear(),
    month: invoiceDueDate.getMonth() + 1
  };
}

/** Data de fechamento (último dia em que lançamentos entram nesta fatura). */
export function getClosingDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
  const anchorDay = new Date(invoiceMonth.year, invoiceMonth.month, 0).getDate();
  const closingDate = new Date(invoiceMonth.year, invoiceMonth.month - 1, Math.min(card.dueDay, anchorDay));
  closingDate.setDate(closingDate.getDate() - card.closeDaysBefore);
  return closingDate;
}

/** Primeiro dia do ciclo da fatura (dia seguinte ao fechamento da fatura anterior). */
export function getCycleStartDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
  const previousInvoice: InvoiceMonth = {
    year: invoiceMonth.month === 1 ? invoiceMonth.year - 1 : invoiceMonth.year,
    month: invoiceMonth.month === 1 ? 12 : invoiceMonth.month - 1
  };
  const previousClose = getClosingDateForInvoiceMonth(previousInvoice, card);
  previousClose.setDate(previousClose.getDate() + 1);
  return previousClose;
}
