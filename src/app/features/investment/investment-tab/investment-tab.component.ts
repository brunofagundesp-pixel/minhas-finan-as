import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { Budget } from '../../../core/models/budget.model';
import { normalizeTagName } from '../../../core/models/tag.model';
import { BudgetCalculatorService, BudgetProgress } from '../../../core/services/budget-calculator.service';
import { BudgetsService } from '../../../core/services/budgets.service';
import { FinanceApiService, FinancialEvent, MonthDefinition } from '../../../core/services/finance-api.service';

interface InvestmentMonthSummary {
  key: string;
  label: string;
  year: number;
  monthNumber: number;
  income: number;
  investment: number;
  emergencyReserveInvestment: number;
  fixedCosts: number;
  savingsRate: number | null;
  remainingBalance: number;
}

@Component({
  selector: 'app-investment-tab',
  templateUrl: './investment-tab.component.html',
  styleUrls: ['./investment-tab.component.scss']
})
export class InvestmentTabComponent implements OnInit, OnDestroy {
  isLoading = true;
  errorMessage = '';
  monthSummaries: InvestmentMonthSummary[] = [];
  investmentGoalProgresses: BudgetProgress[] = [];
  readonly savingsTargetPercent = 20;
  readonly emergencyTargetMonths = 6;

  private readonly today = new Date();
  private readonly currentYear = this.today.getFullYear();
  private readonly subscription = new Subscription();
  private readonly monthNames = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];
  private readonly emergencyGoalName = normalizeTagName('reserva de emergência');
  private readonly defaultEmergencyGoalTagKeys = [
    normalizeTagName('reserva de emergência'),
    normalizeTagName('reserva de emergencia')
  ];
  private emergencyReserveGoalTagKeys = new Set<string>();
  private allMonthSummaries: InvestmentMonthSummary[] = [];
  selectedYear = this.currentYear;
  availableYears: number[] = [];

  constructor(
    private readonly financeApi: FinanceApiService,
    private readonly budgetsService: BudgetsService,
    private readonly calculator: BudgetCalculatorService
  ) {}

  ngOnInit(): void {
    this.subscription.add(
      combineLatest([
        this.financeApi.getMonths(),
        this.budgetsService.budgets$,
        this.financeApi.getCards(),
        this.financeApi.getCardLaunches()
      ]).subscribe({
        next: ([months, budgets, cards, cardLaunches]) => {
          const investmentBudgets = (budgets ?? []).filter((budget) => budget.scope === 'investment');
          this.emergencyReserveGoalTagKeys = this.resolveEmergencyReserveGoalTagKeys(investmentBudgets as Budget[]);
          this.allMonthSummaries = this.buildMonthSummaries(months ?? []);
          this.availableYears = this.buildAvailableYears(this.allMonthSummaries);
          if (!this.availableYears.includes(this.selectedYear) && this.selectedYear !== this.currentYear) {
            this.selectedYear = this.currentYear;
          }
          this.monthSummaries = this.getSummariesForYear(this.selectedYear);
          this.investmentGoalProgresses = this.calculator.computeAll(investmentBudgets as Budget[], {
            months: months ?? [],
            cardLaunches: cardLaunches ?? [],
            cards: cards ?? [],
            now: this.today
          });
          this.isLoading = false;
        },
        error: () => {
          this.errorMessage = 'Não foi possível carregar os dados de investimentos.';
          this.isLoading = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  get currentMonthSummary(): InvestmentMonthSummary {
    const currentYear = this.today.getFullYear();
    const currentMonth = this.today.getMonth() + 1;
    return this.allMonthSummaries.find(
      (summary) => summary.year === currentYear && summary.monthNumber === currentMonth
    ) ?? this.buildCurrentMonthFallback(currentYear, currentMonth);
  }

  get averageSavingsRate(): number | null {
    const validRates = this.monthSummaries
      .map((summary) => summary.savingsRate)
      .filter((rate): rate is number => rate !== null);

    if (validRates.length === 0) {
      return null;
    }

    const total = validRates.reduce((sum, rate) => sum + rate, 0);
    return total / validRates.length;
  }

  get totalInvested(): number {
    return this.allMonthSummaries.reduce((sum, summary) => sum + summary.investment, 0);
  }

  get emergencyReserveAmount(): number {
    return this.allMonthSummaries.reduce((sum, summary) => sum + summary.emergencyReserveInvestment, 0);
  }

  get fixedMonthlyCostEstimate(): number {
    const withCosts = this.allMonthSummaries.filter((summary) => summary.fixedCosts > 0);
    if (!withCosts.length) {
      return 0;
    }

    const total = withCosts.reduce((sum, summary) => sum + summary.fixedCosts, 0);
    return total / withCosts.length;
  }

  get emergencyTargetAmount(): number {
    return this.fixedMonthlyCostEstimate * this.emergencyTargetMonths;
  }

  get emergencyCoverageMonths(): number {
    if (this.fixedMonthlyCostEstimate <= 0) {
      return 0;
    }

    return this.emergencyReserveAmount / this.fixedMonthlyCostEstimate;
  }

  get emergencyProgress(): number {
    if (this.emergencyTargetAmount <= 0) {
      return 0;
    }

    return Math.min(1, this.emergencyReserveAmount / this.emergencyTargetAmount);
  }

  get emergencyShortfall(): number {
    return Math.max(0, this.emergencyTargetAmount - this.emergencyReserveAmount);
  }

  get suggestedEmergencyContribution(): number {
    if (this.emergencyShortfall <= 0) {
      return 0;
    }

    return this.emergencyShortfall / 12;
  }

  get emergencySuggestionMessage(): string {
    if (this.fixedMonthlyCostEstimate <= 0) {
      return 'Ainda não há dados suficientes de gastos fixos para sugerir uma meta confiável.';
    }

    const coverage = this.emergencyCoverageMonths;
    if (coverage >= this.emergencyTargetMonths) {
      return `Reserva saudável: você já cobre cerca de ${coverage.toFixed(1).replace('.', ',')} meses de custo fixo.`;
    }
    if (coverage >= 3) {
      return `Boa evolução: você cobre ${coverage.toFixed(1).replace('.', ',')} meses. Foque em chegar a ${this.emergencyTargetMonths} meses.`;
    }
    return `Alerta de previsibilidade: hoje a reserva cobre ${coverage.toFixed(1).replace('.', ',')} meses. Priorize aportes até atingir ${this.emergencyTargetMonths} meses.`;
  }

  get emergencySuggestionTone(): 'good' | 'warning' | 'risk' | 'neutral' {
    if (this.fixedMonthlyCostEstimate <= 0) {
      return 'neutral';
    }
    if (this.emergencyCoverageMonths >= this.emergencyTargetMonths) {
      return 'good';
    }
    if (this.emergencyCoverageMonths >= 3) {
      return 'warning';
    }
    return 'risk';
  }

  get historyLabel(): string {
    return `Histórico de ${this.selectedYear}`;
  }

  get canGoPreviousYear(): boolean {
    return this.availableYears.includes(this.selectedYear - 1);
  }

  get canGoNextYear(): boolean {
    return this.availableYears.includes(this.selectedYear + 1);
  }

  get currentMonthInvestment(): number {
    return this.currentMonthSummary.investment;
  }

  get currentMonthIncome(): number {
    return this.currentMonthSummary.income;
  }

  get currentMonthSavingsGap(): number | null {
    if (this.currentMonthIncome <= 0) {
      return null;
    }

    const targetAmount = this.currentMonthIncome * (this.savingsTargetPercent / 100);
    return targetAmount - this.currentMonthInvestment;
  }

  get currentMonthSavingsRate(): number | null {
    return this.currentMonthSummary.savingsRate;
  }

  formatCurrency(value: number): string {
    return this.safeNumber(value).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      maximumFractionDigits: 2
    });
  }

  formatPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
      return '—';
    }

    return `${value.toFixed(1).replace('.', ',')}%`;
  }

  savingsTargetLabel(rate: number | null): string {
    if (rate === null) {
      return 'Sem receita registrada ainda';
    }

    if (rate >= 20) {
      return 'Acima da referência inicial de 20%';
    }

    if (rate >= 10) {
      return 'Na faixa mínima saudável';
    }

    return 'Abaixo da referência sugerida';
  }

  rentabilitySourceHint(): string {
    return 'Rentabilidade real depende de cotações do ativo e do saldo atual de mercado.';
  }

  trackByMonth(_index: number, item: InvestmentMonthSummary): string {
    return item.key;
  }

  trackByGoal(_index: number, item: BudgetProgress): string {
    return item.budget.id;
  }

  getGoalProgressWidth(progress: BudgetProgress): string {
    return `${(Math.min(1, Math.max(0, progress.percent)) * 100).toFixed(1)}%`;
  }

  getEmergencyProgressWidth(): string {
    return `${(this.emergencyProgress * 100).toFixed(1)}%`;
  }

  setSelectedYear(year: number): void {
    if (this.selectedYear === year) {
      return;
    }

    this.selectedYear = year;
    this.monthSummaries = this.getSummariesForYear(year);
  }

  goToPreviousYear(): void {
    if (!this.canGoPreviousYear) {
      return;
    }

    this.setSelectedYear(this.selectedYear - 1);
  }

  goToNextYear(): void {
    if (!this.canGoNextYear) {
      return;
    }

    this.setSelectedYear(this.selectedYear + 1);
  }

  private buildMonthSummaries(months: MonthDefinition[]): InvestmentMonthSummary[] {
    const investmentEventById = new Map<string, FinancialEvent>();
    for (const month of months) {
      for (const event of month.events ?? []) {
        if (event.type === 'investment' && event.id && event.suppressed !== true) {
          investmentEventById.set(event.id, event);
        }
      }
    }

    return [...months]
      .sort((a, b) => b.year - a.year || b.monthNumber - a.monthNumber)
      .map((month) => {
        const income = this.sumIncomeExcludingWithdrawals(month.events);
        const investment = this.sumNetInvestments(month.events, investmentEventById);
        const emergencyReserveInvestment = this.sumEmergencyReserveNetInvestments(month.events, investmentEventById);
        const fixedCosts = this.computeFixedCosts(month);
        const remainingBalance = income - investment - this.sumEvents(month.events, 'expense') - this.sumEvents(month.events, 'daily');

        return {
          key: month.key,
          label: `${month.title} ${month.year}`,
          year: month.year,
          monthNumber: month.monthNumber,
          income,
          investment,
          emergencyReserveInvestment,
          fixedCosts,
          savingsRate: income > 0 ? (investment / income) * 100 : null,
          remainingBalance
        };
      });
  }

  private buildAvailableYears(monthSummaries: InvestmentMonthSummary[]): number[] {
    const years = new Set<number>(monthSummaries.map((summary) => summary.year));
    years.add(this.currentYear);
    return [...years].sort((a, b) => b - a);
  }

  private getSummariesForYear(year: number): InvestmentMonthSummary[] {
    return this.allMonthSummaries
      .filter((summary) => summary.year === year)
      .sort((a, b) => b.monthNumber - a.monthNumber);
  }

  private buildCurrentMonthFallback(year: number, monthNumber: number): InvestmentMonthSummary {
    const label = `${this.monthNames[monthNumber - 1]} ${year}`;

    return {
      key: `${year}-${String(monthNumber).padStart(2, '0')}`,
      label,
      year,
      monthNumber,
      income: 0,
      investment: 0,
      emergencyReserveInvestment: 0,
      fixedCosts: 0,
      savingsRate: null,
      remainingBalance: 0
    };
  }

  private sumEmergencyReserveInvestments(events: FinancialEvent[]): number {
    return (events ?? [])
      .filter((event) => event.type === 'investment' && this.isEmergencyReserveEvent(event))
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);
  }

  private sumEmergencyReserveNetInvestments(events: FinancialEvent[], investmentEventById: Map<string, FinancialEvent>): number {
    const gross = this.sumEmergencyReserveInvestments(events);
    const withdrawals = (events ?? [])
      .filter((event) => this.isInvestmentWithdrawal(event))
      .reduce((sum, event) => {
        const sourceEvent = event.investmentSourceEventId ? investmentEventById.get(event.investmentSourceEventId) : undefined;
        if (!sourceEvent || !this.isEmergencyReserveEvent(sourceEvent)) {
          return sum;
        }

        return sum + this.safeNumber(event.amount);
      }, 0);

    return Number((gross - withdrawals).toFixed(2));
  }

  private isEmergencyReserveEvent(event: FinancialEvent): boolean {
    const tags = event.tags ?? [];
    if (!tags.length || !this.emergencyReserveGoalTagKeys.size) {
      return false;
    }

    return tags.some((tag) => this.emergencyReserveGoalTagKeys.has(normalizeTagName(tag)));
  }

  private resolveEmergencyReserveGoalTagKeys(budgets: Budget[]): Set<string> {
    const keys = new Set<string>(this.defaultEmergencyGoalTagKeys);

    for (const budget of budgets) {
      if (budget.active === false) {
        continue;
      }

      const goalName = normalizeTagName(budget.targetName || budget.targetId);
      if (goalName !== this.emergencyGoalName) {
        continue;
      }

      if (budget.targetName) {
        keys.add(normalizeTagName(budget.targetName));
      }
      if (budget.targetId) {
        keys.add(normalizeTagName(budget.targetId));
      }
    }

    return keys;
  }

  private computeFixedCosts(month: MonthDefinition): number {
    const hasDailyEvents = (month.events ?? []).some((event) => event.type === 'daily');
    const dailyFromEvents = (month.events ?? [])
      .filter((event) => event.type === 'daily')
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);

    const fixedRecurringExpenses = (month.events ?? [])
      .filter((event) => event.type === 'expense' && event.recurrenceKind === 'fixed')
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);

    const legacyDaily = !hasDailyEvents ? this.safeNumber(month.dailyFixedCost) : 0;
    return dailyFromEvents + fixedRecurringExpenses + legacyDaily;
  }

  private sumEvents(events: FinancialEvent[], type: FinancialEvent['type']): number {
    return events
      .filter((event) => event.type === type && event.suppressed !== true)
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);
  }

  private sumIncomeExcludingWithdrawals(events: FinancialEvent[]): number {
    return (events ?? [])
      .filter((event) => event.type === 'income' && !this.isInvestmentWithdrawal(event) && event.suppressed !== true)
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);
  }

  private sumNetInvestments(events: FinancialEvent[], _investmentEventById: Map<string, FinancialEvent>): number {
    const gross = (events ?? [])
      .filter((event) => event.type === 'investment' && event.suppressed !== true)
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);

    const withdrawals = (events ?? [])
      .filter((event) => this.isInvestmentWithdrawal(event))
      .reduce((sum, event) => sum + this.safeNumber(event.amount), 0);

    return Number((gross - withdrawals).toFixed(2));
  }

  private isInvestmentWithdrawal(event: FinancialEvent): boolean {
    return event.type === 'income' && !!event.investmentSourceEventId && event.suppressed !== true;
  }

  private safeNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }
}
