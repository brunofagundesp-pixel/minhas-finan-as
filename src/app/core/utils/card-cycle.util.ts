import { CreditCard } from '../services/finance-api.service';

export interface InvoiceMonth {
  year: number;
  /** 1..12 */
  month: number;
}

function getSafeDayForMonth(year: number, monthNumber: number, day: number): number {
  const maxDay = new Date(year, monthNumber, 0).getDate();
  return Math.min(Math.max(1, day), maxDay);
}

function getCloseDay(card: CreditCard): number {
  return card.closeDay ?? (card.dueDay - card.closeDaysBefore);
}

function getOldDueMonthOffset(card: CreditCard): number {
  if (card.dueMonthOffset != null) return card.dueMonthOffset;
  const closeDay = getCloseDay(card);
  return closeDay > card.dueDay ? 1 : 0;
}

function getDueMonthOffset(card: CreditCard): number {
  return getOldDueMonthOffset(card) + 1;
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { year: y, month: m };
}

export function getInvoiceMonthForDate(dateInput: string, card: CreditCard): InvoiceMonth | null {
  const transactionDate = new Date(`${dateInput}T00:00:00`);
  if (Number.isNaN(transactionDate.getTime())) return null;

  const closeDay = getCloseDay(card);
  const purchaseDay = transactionDate.getDate();
  const purchaseMonth = transactionDate.getMonth() + 1;
  const purchaseYear = transactionDate.getFullYear();

  let refMonth: number;
  let refYear: number;

  if (purchaseDay > closeDay) {
    // Compra após o fechamento → pertence ao ciclo que iniciou NESTE mês
    refMonth = purchaseMonth;
    refYear = purchaseYear;
  } else {
    // Compra antes/dia do fechamento → pertence ao ciclo que iniciou no mês anterior
    const shifted = shiftMonth(purchaseYear, purchaseMonth, -1);
    refMonth = shifted.month;
    refYear = shifted.year;
  }

  return { year: refYear, month: refMonth };
}

export function getClosingDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
  const closeDay = getCloseDay(card);
  // O fechamento ocorre no mês seguinte ao mês da fatura
  // Ex.: fatura de junho → fechamento em julho (dia closeDay)
  const closeMonth = shiftMonth(invoiceMonth.year, invoiceMonth.month, 1);
  const safeDay = getSafeDayForMonth(closeMonth.year, closeMonth.month, closeDay);
  return new Date(closeMonth.year, closeMonth.month - 1, safeDay);
}

export function getCycleStartDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
  const prev = shiftMonth(invoiceMonth.year, invoiceMonth.month, -1);
  const previousClose = getClosingDateForInvoiceMonth(prev, card);
  previousClose.setDate(previousClose.getDate() + 1);
  return previousClose;
}

export function getDueDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
  const offset = getDueMonthOffset(card);
  const due = shiftMonth(invoiceMonth.year, invoiceMonth.month, offset);
  const dueDay = getSafeDayForMonth(due.year, due.month, card.dueDay);
  return new Date(due.year, due.month - 1, dueDay);
}
