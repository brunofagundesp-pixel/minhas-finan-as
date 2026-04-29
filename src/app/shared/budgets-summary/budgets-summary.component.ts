import { Component, Input, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { Budget } from '../../core/models/budget.model';
import { TagCatalogItem, normalizeTagName } from '../../core/models/tag.model';
import { BudgetCalculatorService, BudgetProgress } from '../../core/services/budget-calculator.service';
import { BudgetsService } from '../../core/services/budgets.service';
import {
  CardLaunch,
  CreditCard,
  FinanceApiService,
  MonthDefinition
} from '../../core/services/finance-api.service';
import { TagsService } from '../../core/services/tags.service';

/**
 * Compact, read-only display of active budgets with progress bars.
 * Reusable in the dashboard, the cards tab and anywhere else we want
 * the user to see how close they are to their spending caps.
 *
 * Inputs let consumers narrow the displayed set:
 *  - `scopeFilter`: only show budgets of a given scope (e.g. 'card' inside cards-tab).
 *  - `targetIdFilter`: only show budgets matching the given target id.
 *  - `emptyStateMessage`: text rendered when no budget matches.
 *  - `referenceDate`: when set, the component is "controlled" by the parent
 *    (no internal nav is rendered) and follows that month.
 */
@Component({
  selector: 'app-budgets-summary',
  templateUrl: './budgets-summary.component.html',
  styleUrls: ['./budgets-summary.component.scss']
})
export class BudgetsSummaryComponent implements OnInit, OnChanges, OnDestroy {
  @Input() scopeFilter?: Budget['scope'];
  @Input() targetIdFilter?: string;
  @Input() emptyStateMessage = 'Nenhuma meta ativa. Cadastre em Configurações.';
  @Input() title = 'Metas';
  @Input() compact = false;
  /** Quando definido, o mês de referência é controlado pelo pai e a navegação interna não é exibida. */
  @Input() referenceDate?: Date;

  progresses: BudgetProgress[] = [];
  tags: TagCatalogItem[] = [];
  isLoading = true;

  /** Mês de referência exibido. Inicializa em hoje, no primeiro dia do mês. */
  referenceDateInternal: Date = this.firstDayOfMonth(new Date());
  private readonly today = new Date();

  /** True quando o mês é controlado pelo pai (Input referenceDate definido). */
  get isControlled(): boolean {
    return !!this.referenceDate;
  }

  get currentReferenceDate(): Date {
    return this.referenceDate ?? this.referenceDateInternal;
  }

  private budgets: Budget[] = [];
  private months: MonthDefinition[] = [];
  private cards: CreditCard[] = [];
  private cardLaunches: CardLaunch[] = [];

  private readonly monthNames = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];

  private subscription = new Subscription();

  constructor(
    private readonly budgetsService: BudgetsService,
    private readonly tagsService: TagsService,
    private readonly calculator: BudgetCalculatorService,
    private readonly api: FinanceApiService
  ) {}

  ngOnInit(): void {
    this.subscription.add(
      combineLatest([
        this.budgetsService.budgets$,
        this.tagsService.tags$,
        this.api.getMonths(),
        this.api.getCards(),
        this.api.getCardLaunches()
      ]).subscribe({
        next: ([budgets, tags, months, cards, launches]) => {
          this.tags = tags;
          this.budgets = budgets;
          this.months = months;
          this.cards = cards;
          this.cardLaunches = launches;
          this.recompute();
          this.isLoading = false;
        },
        error: () => {
          this.isLoading = false;
        }
      })
    );
  }

  private recompute(): void {
    const filtered = this.budgets.filter((b) => {
      if (b.active === false) {
        return false;
      }
      if (this.scopeFilter && b.scope !== this.scopeFilter) {
        return false;
      }
      if (this.targetIdFilter !== undefined && String(b.targetId) !== String(this.targetIdFilter)) {
        return false;
      }
      return true;
    });

    this.progresses = this.calculator.computeAll(filtered, {
      months: this.months,
      cards: this.cards,
      cardLaunches: this.cardLaunches,
      now: this.referenceForCalculator()
    });
  }

  /**
   * Quando o mês de referência é o atual, usa `today` real para que `daysElapsed`
   * e a projeção fiquem corretos. Para meses passados/futuros, usa o último dia
   * do mês (passados → 100% decorrido) ou o primeiro (futuros → começo).
   */
  private referenceForCalculator(): Date {
    const ref = this.currentReferenceDate;
    const sameYear = ref.getFullYear() === this.today.getFullYear();
    const sameMonth = ref.getMonth() === this.today.getMonth();
    if (sameYear && sameMonth) {
      return this.today;
    }
    const isPast = ref.getTime() < this.firstDayOfMonth(this.today).getTime();
    if (isPast) {
      return new Date(ref.getFullYear(), ref.getMonth() + 1, 0); // último dia
    }
    return new Date(ref.getFullYear(), ref.getMonth(), 1); // primeiro dia
  }

  goToPreviousMonth(): void {
    if (this.isControlled) return;
    this.referenceDateInternal = new Date(
      this.referenceDateInternal.getFullYear(),
      this.referenceDateInternal.getMonth() - 1,
      1
    );
    this.recompute();
  }

  goToNextMonth(): void {
    if (this.isControlled) return;
    this.referenceDateInternal = new Date(
      this.referenceDateInternal.getFullYear(),
      this.referenceDateInternal.getMonth() + 1,
      1
    );
    this.recompute();
  }

  goToCurrentMonth(): void {
    if (this.isControlled) return;
    this.referenceDateInternal = this.firstDayOfMonth(new Date());
    this.recompute();
  }

  isCurrentMonth(): boolean {
    return (
      this.currentReferenceDate.getFullYear() === this.today.getFullYear() &&
      this.currentReferenceDate.getMonth() === this.today.getMonth()
    );
  }

  get referenceMonthLabel(): string {
    const ref = this.currentReferenceDate;
    return `${this.monthNames[ref.getMonth()]} ${ref.getFullYear()}`;
  }

  private firstDayOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['referenceDate'] && !changes['referenceDate'].firstChange) {
      this.recompute();
    }
  }

  trackByBudgetId(_index: number, item: BudgetProgress): string {
    return item.budget.id;
  }

  formatCurrency(value: number): string {
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
  }

  formatPercent(value: number): string {
    return `${Math.max(0, value * 100).toFixed(0)}%`;
  }

  getProgressColor(progress: BudgetProgress): string {
    switch (progress.status) {
      case 'over':
        return 'var(--danger, #e3516e)';
      case 'warning':
        return '#d97706';
      default:
        return 'var(--accent, #2d6cdf)';
    }
  }

  getProgressBarWidth(progress: BudgetProgress): string {
    return `${Math.min(1, progress.percent) * 100}%`;
  }

  getProjectionMarker(progress: BudgetProgress): string | null {
    if (progress.budget.amount <= 0) {
      return null;
    }
    const projectedPercent = progress.projectedSpent / progress.budget.amount;
    return `${Math.min(1, Math.max(0, projectedPercent)) * 100}%`;
  }

  getTagColor(tagName: string): string {
    const tag = this.tags.find((t) => normalizeTagName(t.name) === normalizeTagName(tagName));
    return tag?.color ?? 'var(--accent, #2d6cdf)';
  }

  scopeLabel(scope: Budget['scope']): string {
    if (scope === 'tag') return 'Tag';
    if (scope === 'card') return 'Cartão';
    return 'Geral';
  }

  /**
   * Indica que a meta usa periodo "Ciclo de fatura". O total exibido reflete o que sera
   * cobrado naquela fatura (parcelas / compras pos-fechamento entram em ciclos seguintes),
   * em vez do mes calendario das compras.
   */
  isInvoiceCycle(progress: BudgetProgress): boolean {
    return progress.budget.period === 'invoice-cycle';
  }

  /** Tooltip explicando como o valor consumido foi calculado. */
  getProgressTooltip(progress: BudgetProgress): string {
    const consumed = `${this.formatCurrency(progress.spent)} de ${this.formatCurrency(progress.budget.amount)}`;
    if (this.isInvoiceCycle(progress)) {
      return `${consumed} comprometido nesta fatura (${progress.periodLabel}). Inclui compras e parcelas que serão cobradas neste ciclo, mesmo que tenham sido feitas em meses anteriores.`;
    }
    return `${consumed} gasto em ${progress.periodLabel} (mês calendário das compras).`;
  }
}
