import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { Budget, BudgetInput, BudgetPeriod, BudgetScope } from '../../../core/models/budget.model';
import { TagCatalogItem, normalizeTagName } from '../../../core/models/tag.model';
import { BudgetsService } from '../../../core/services/budgets.service';
import { BudgetCalculatorService, BudgetProgress } from '../../../core/services/budget-calculator.service';
import {
  CardLaunch,
  CreditCard,
  FinanceApiService,
  MonthDefinition
} from '../../../core/services/finance-api.service';
import { TagsService } from '../../../core/services/tags.service';

interface BudgetFormState {
  scope: BudgetScope;
  targetId: string;
  amount: number | null;
  period: BudgetPeriod;
  rollover: boolean;
  active: boolean;
  notes: string;
  /**
   * Vigencia da meta:
   * - `single`: aplica somente ao mes inicial.
   * - `range`: aplica de startMonth/Year ate endMonth/Year (inclusive).
   * - `forever`: aplica de startMonth/Year em diante, sem prazo.
   */
  vigencia: 'single' | 'range' | 'forever';
  startYear: number;
  startMonth: number;
  endYear: number;
  endMonth: number;
  /**
   * Quando true, ao salvar substitui valores ja definidos em `monthlyAmounts`
   * dentro da janela. Quando false, preserva overrides existentes (so escreve
   * onde nao havia valor).
   */
  overwriteExisting: boolean;
}

@Component({
  selector: 'app-goals-tab',
  templateUrl: './goals-tab.component.html',
  styleUrls: ['./goals-tab.component.scss']
})
export class GoalsTabComponent implements OnInit, OnDestroy {
  budgets: Budget[] = [];
  progresses: BudgetProgress[] = [];
  tags: TagCatalogItem[] = [];
  cards: CreditCard[] = [];
  private months: MonthDefinition[] = [];
  private cardLaunches: CardLaunch[] = [];

  /** Mês de referência exibido. Inicializa em hoje, no primeiro dia do mês. */
  referenceDate: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private readonly today = new Date();
  private readonly monthNames = [
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
    'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
  ];

  isLoading = true;
  saving = false;
  errorMessage: string | null = null;

  isFormOpen = false;
  editingBudgetId: string | null = null;
  form: BudgetFormState = this.emptyForm();
  readonly monthOptions: ReadonlyArray<{ value: number; label: string }> = [
    { value: 1, label: 'janeiro' },
    { value: 2, label: 'fevereiro' },
    { value: 3, label: 'março' },
    { value: 4, label: 'abril' },
    { value: 5, label: 'maio' },
    { value: 6, label: 'junho' },
    { value: 7, label: 'julho' },
    { value: 8, label: 'agosto' },
    { value: 9, label: 'setembro' },
    { value: 10, label: 'outubro' },
    { value: 11, label: 'novembro' },
    { value: 12, label: 'dezembro' }
  ];
  yearOptions: number[] = [];

  pendingDeleteId: string | null = null;

  isCreatingTag = false;
  newTagName = '';
  newTagError: string | null = null;
  creatingTag = false;

  amountInput = '';

  private subscription = new Subscription();

  constructor(
    private readonly budgetsService: BudgetsService,
    private readonly calculator: BudgetCalculatorService,
    private readonly tagsService: TagsService,
    private readonly api: FinanceApiService
  ) {}

  ngOnInit(): void {
    const currentYear = new Date().getFullYear();
    this.yearOptions = [];
    for (let y = currentYear - 1; y <= currentYear + 5; y += 1) {
      this.yearOptions.push(y);
    }

    this.subscription.add(
      combineLatest([
        this.budgetsService.budgets$,
        this.tagsService.tags$,
        this.api.getMonths(),
        this.api.getCards(),
        this.api.getCardLaunches()
      ]).subscribe({
        next: ([budgets, tags, months, cards, launches]) => {
          this.budgets = budgets;
          this.tags = tags;
          this.months = months;
          this.cards = cards;
          this.cardLaunches = launches;
          this.recomputeProgress();
          this.isLoading = false;
        },
        error: () => {
          this.errorMessage = 'Erro ao carregar metas. Tente novamente.';
          this.isLoading = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  // ------------------------------------------------------------- UI helpers

  trackByBudgetId(_index: number, item: BudgetProgress): string {
    return item.budget.id;
  }

  formatCurrency(value: number): string {
    const safe = Number.isFinite(value) ? value : 0;
    return safe.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
  }

  formatPercent(value: number): string {
    const pct = Math.max(0, Number.isFinite(value) ? value : 0) * 100;
    return `${pct.toFixed(0)}%`;
  }

  scopeLabel(scope: BudgetScope): string {
    switch (scope) {
      case 'tag':
        return 'Tag';
      case 'card':
        return 'Cartão';
      case 'investment':
        return 'Investimento';
      case 'global':
        return 'Geral';
    }
  }

  periodLabel(period: BudgetPeriod): string {
    return period === 'invoice-cycle' ? 'Ciclo de fatura' : 'Mensal';
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
    const pct = Math.min(1, progress.percent) * 100;
    return `${pct.toFixed(1)}%`;
  }

  getRemainingToSpend(progress: BudgetProgress): number {
    return Math.max(0, progress.budget.amount - progress.spent);
  }

  getProjectionMarker(progress: BudgetProgress): string | null {
    if (progress.budget.amount <= 0) {
      return null;
    }
    const projectedPercent = progress.projectedSpent / progress.budget.amount;
    const clamped = Math.min(1.2, Math.max(0, projectedPercent));
    return `${(Math.min(1, clamped) * 100).toFixed(1)}%`;
  }

  getTagColor(tagName: string): string {
    const tag = this.tags.find((t) => normalizeTagName(t.name) === normalizeTagName(tagName));
    return tag?.color ?? 'var(--accent, #2d6cdf)';
  }

  getCardName(cardId: string): string {
    return this.cards.find((c) => String(c.id) === String(cardId))?.name ?? 'Cartão removido';
  }

  // ------------------------------------------------------------- Form

  openCreateForm(): void {
    this.editingBudgetId = null;
    this.form = this.emptyForm();
    this.errorMessage = null;
    this.amountInput = '';
    this.isFormOpen = true;
  }

  openEditForm(budget: Budget): void {
    this.editingBudgetId = budget.id;
    const now = new Date();
    const startYear = budget.startYear ?? now.getFullYear();
    const startMonth = budget.startMonth ?? now.getMonth() + 1;
    const hasEnd = budget.endYear !== undefined && budget.endMonth !== undefined;
    const endYear = budget.endYear ?? startYear;
    const endMonth = budget.endMonth ?? startMonth;
    const isSingle = hasEnd && endYear === startYear && endMonth === startMonth;
    const vigencia: BudgetFormState['vigencia'] = !hasEnd ? 'forever' : (isSingle ? 'single' : 'range');

    this.form = {
      scope: budget.scope,
      targetId: budget.targetId,
      amount: budget.amount,
      period: budget.period,
      rollover: budget.rollover,
      active: budget.active !== false,
      notes: budget.notes ?? '',
      vigencia,
      startYear,
      startMonth,
      endYear: hasEnd ? endYear : startYear,
      endMonth: hasEnd ? endMonth : startMonth,
      overwriteExisting: false
    };
    this.errorMessage = null;
    this.amountInput = budget.amount > 0 ? this.formatCurrencyInput(budget.amount) : '';
    this.isFormOpen = true;
  }

  closeForm(): void {
    this.isFormOpen = false;
    this.editingBudgetId = null;
    this.errorMessage = null;
    this.amountInput = '';
    this.pendingEditPayload = null;
    this.cancelNewTag();
  }

  onAmountInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.amountInput = masked.display;
    this.form.amount = masked.amount;
  }

  private maskCurrencyFromDigits(rawValue: string): { display: string; amount: number | null } {
    const digits = (rawValue ?? '').replace(/\D/g, '');
    if (!digits) {
      return { display: '', amount: null };
    }
    const amount = Number((Number(digits) / 100).toFixed(2));
    return { display: this.formatCurrencyInput(amount), amount };
  }

  private formatCurrencyInput(value: number): string {
    return value.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  onScopeChange(scope: BudgetScope): void {
    this.form.scope = scope;
    this.form.targetId = '';

    if (scope === 'investment') {
      // Metas de investimento nao usam ciclo de fatura nem rollover de teto.
      this.form.period = 'monthly';
      this.form.rollover = false;
      this.form.vigencia = 'forever';
    }

    if (scope !== 'card' && this.form.period === 'invoice-cycle') {
      this.form.period = 'monthly';
    }
    if (scope !== 'tag') {
      this.cancelNewTag();
    }
  }

  startCreatingTag(): void {
    this.isCreatingTag = true;
    this.newTagName = '';
    this.newTagError = null;
  }

  cancelNewTag(): void {
    this.isCreatingTag = false;
    this.newTagName = '';
    this.newTagError = null;
    this.creatingTag = false;
  }

  async confirmNewTag(): Promise<void> {
    const label = this.newTagName.trim().replace(/\s+/g, ' ');
    if (!label) {
      this.newTagError = 'Informe um nome para a tag.';
      return;
    }

    const normalized = normalizeTagName(label);
    const existing = this.tags.find((t) => normalizeTagName(t.name) === normalized);
    if (existing) {
      // Tag ja existe — apenas seleciona.
      this.form.targetId = existing.name;
      this.cancelNewTag();
      return;
    }

    this.creatingTag = true;
    this.newTagError = null;
    try {
      const created = await this.tagsService.upsert({ name: label, color: '' });
      const finalName = created?.name ?? label;
      // O tags$ vai atualizar a lista; ja deixamos selecionado pelo nome.
      this.form.targetId = finalName;
      this.cancelNewTag();
    } catch (error) {
      console.error('[GoalsTab] Erro ao criar tag:', error);
      this.newTagError = 'Não foi possível criar a tag. Tente novamente.';
      this.creatingTag = false;
    }
  }

  async saveBudget(): Promise<void> {
    const validation = this.validateForm();
    if (validation) {
      this.errorMessage = validation;
      return;
    }

    const targetName = this.resolveTargetName(this.form.scope, this.form.targetId);
    const amount = Number(this.form.amount ?? 0);

    const startYear = this.form.startYear;
    const startMonth = this.form.startMonth;
    const isInvestmentScope = this.form.scope === 'investment';
    const effectivePeriod: BudgetPeriod = isInvestmentScope ? 'monthly' : this.form.period;
    const effectiveRollover = isInvestmentScope ? false : !!this.form.rollover;
    let endYear: number | null;
    let endMonth: number | null;
    if (isInvestmentScope || this.form.vigencia === 'forever') {
      endYear = null;
      endMonth = null;
    } else if (this.form.vigencia === 'single') {
      endYear = startYear;
      endMonth = startMonth;
    } else {
      endYear = this.form.endYear;
      endMonth = this.form.endMonth;
    }

    const existing = this.editingBudgetId
      ? this.budgets.find((b) => b.id === this.editingBudgetId)
      : undefined;
    const monthlyAmounts = this.buildMonthlyAmounts(
      amount,
      startYear,
      startMonth,
      endYear,
      endMonth,
      existing?.monthlyAmounts,
      this.form.overwriteExisting
    );

    const payload: Record<string, unknown> = {
      scope: this.form.scope,
      targetId: this.form.scope === 'global' ? '' : this.form.targetId,
      targetName,
      amount,
      period: effectivePeriod,
      rollover: effectiveRollover,
      active: this.form.active !== false,
      notes: this.form.notes?.trim() ? this.form.notes.trim() : undefined,
      startYear,
      startMonth,
      endYear,
      endMonth,
      monthlyAmounts: Object.keys(monthlyAmounts).length > 0 ? monthlyAmounts : null
    };

    // Quando estamos editando uma meta com janela maior que 1 mes, perguntamos
    // o escopo da edicao (analogo a exclusao). Para criacao ou metas single,
    // salvamos direto.
    if (existing && this.editingBudgetHasRange(existing)) {
      this.pendingEditPayload = { payload, existing, amount };
      return;
    }

    await this.persistBudgetPayload(payload);
  }

  /**
   * Persiste o payload de meta (create ou update simples) — usado tanto no
   * fluxo direto quanto pela escolha "Todos" no scope picker de edicao.
   */
  private async persistBudgetPayload(payload: Record<string, unknown>): Promise<void> {
    this.saving = true;
    this.errorMessage = null;

    try {
      if (this.editingBudgetId) {
        await this.budgetsService.update(this.editingBudgetId, payload as unknown as BudgetInput);
      } else {
        await this.budgetsService.create(payload as unknown as BudgetInput);
      }
      this.closeForm();
    } catch (error) {
      console.error('[GoalsTab] Erro ao salvar meta:', error);
      this.errorMessage = 'Não foi possível salvar a meta. Tente novamente.';
    } finally {
      this.saving = false;
    }
  }

  // -------- Edit scope picker ---------

  /** Estado do scope picker de edicao. */
  pendingEditPayload: {
    payload: Record<string, unknown>;
    existing: Budget;
    amount: number;
  } | null = null;

  cancelEditScope(): void {
    this.pendingEditPayload = null;
  }

  get pendingEditMonthLabel(): string {
    return this.referenceMonthLabel;
  }

  /** Replica `pendingDeleteHasRange` mas para um Budget arbitrario. */
  private editingBudgetHasRange(b: Budget): boolean {
    if (b.startYear === undefined || b.startMonth === undefined) {
      return true;
    }
    if (b.endYear === undefined || b.endMonth === undefined) {
      return true;
    }
    const startIdx = b.startYear * 12 + (b.startMonth - 1);
    const endIdx = b.endYear * 12 + (b.endMonth - 1);
    return endIdx > startIdx;
  }

  async confirmEditScope(scope: 'single' | 'forward' | 'all'): Promise<void> {
    const ctx = this.pendingEditPayload;
    const editingId = this.editingBudgetId;
    if (!ctx || !editingId) {
      this.pendingEditPayload = null;
      return;
    }
    this.pendingEditPayload = null;

    const refYear = this.referenceDate.getFullYear();
    const refMonth = this.referenceDate.getMonth() + 1;
    const refKey = `${refYear}-${String(refMonth).padStart(2, '0')}`;

    this.saving = true;
    this.errorMessage = null;

    try {
      if (scope === 'all') {
        await this.budgetsService.update(editingId, ctx.payload as unknown as BudgetInput);
      } else if (scope === 'single') {
        // Aplica o novo valor SOMENTE no mes de referencia, como override.
        // Demais alteracoes do formulario sao descartadas — paralelo ao
        // "apenas este mes" da exclusao.
        const monthlyAmounts = {
          ...(ctx.existing.monthlyAmounts ?? {}),
          [refKey]: ctx.amount
        };
        await this.budgetsService.update(editingId, {
          monthlyAmounts
        } as unknown as BudgetInput);
      } else {
        // forward: split — encerra a meta atual no mes anterior ao de
        // referencia e cria uma nova com os dados do form a partir do mes
        // de referencia.
        const prevMonth = refMonth === 1 ? 12 : refMonth - 1;
        const prevYear = refMonth === 1 ? refYear - 1 : refYear;

        const existingStartIdx =
          (ctx.existing.startYear ?? prevYear) * 12 +
          ((ctx.existing.startMonth ?? prevMonth) - 1);
        const closeIdx = prevYear * 12 + (prevMonth - 1);

        if (closeIdx < existingStartIdx) {
          // Janela original comecava em refMonth ou depois — apaga e recria.
          await this.budgetsService.remove(editingId);
        } else {
          await this.budgetsService.update(editingId, {
            endYear: prevYear,
            endMonth: prevMonth
          } as unknown as BudgetInput);
        }

        // Nova meta a partir do mes de referencia. Preserva endYear/endMonth
        // do form (pode ser forever ou range).
        const newPayload: Record<string, unknown> = {
          ...ctx.payload,
          startYear: refYear,
          startMonth: refMonth
        };

        // Se o form definiu fim antes do mes de referencia, o "novo trecho"
        // ficaria vazio — nesse caso so encerramos sem criar nada.
        const formEndYear = ctx.payload['endYear'] as number | null | undefined;
        const formEndMonth = ctx.payload['endMonth'] as number | null | undefined;
        const newEndIdx =
          formEndYear && formEndMonth
            ? formEndYear * 12 + (formEndMonth - 1)
            : Number.POSITIVE_INFINITY;
        const newStartIdx = refYear * 12 + (refMonth - 1);

        if (newEndIdx >= newStartIdx) {
          await this.budgetsService.create(newPayload as unknown as BudgetInput);
        }
      }

      this.closeForm();
    } catch (error) {
      console.error('[GoalsTab] Erro ao salvar meta:', error);
      this.errorMessage = 'Não foi possível salvar a meta. Tente novamente.';
    } finally {
      this.saving = false;
    }
  }

  private buildMonthlyAmounts(
    amount: number,
    startYear: number,
    startMonth: number,
    endYear: number | null,
    endMonth: number | null,
    existing: Record<string, number> | undefined,
    overwriteExisting: boolean
  ): Record<string, number> {
    const result: Record<string, number> = { ...(existing ?? {}) };

    // Quando "forever", nao geramos overrides — o `amount` base ja cobre todos
    // os meses futuros. Apenas preservamos overrides historicos do usuario.
    if (endYear === null || endMonth === null) {
      return result;
    }

    const startIndex = startYear * 12 + (startMonth - 1);
    const endIndex = endYear * 12 + (endMonth - 1);
    if (endIndex < startIndex) {
      return result;
    }

    for (let idx = startIndex; idx <= endIndex; idx += 1) {
      const year = Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (!overwriteExisting && result[key] !== undefined) {
        continue;
      }
      result[key] = amount;
    }

    return result;
  }

  hasOverridesInWindow(): boolean {
    if (!this.editingBudgetId) {
      return false;
    }
    const existing = this.budgets.find((b) => b.id === this.editingBudgetId);
    if (!existing?.monthlyAmounts) {
      return false;
    }

    const startIndex = this.form.startYear * 12 + (this.form.startMonth - 1);
    let endIndex: number;
    if (this.form.vigencia === 'forever') {
      // Considera ate o ultimo override existente para nao esconder o checkbox.
      const keys = Object.keys(existing.monthlyAmounts);
      if (keys.length === 0) return false;
      endIndex = keys
        .map((k) => {
          const [y, m] = k.split('-').map(Number);
          return y * 12 + (m - 1);
        })
        .reduce((a, b) => Math.max(a, b), startIndex);
    } else if (this.form.vigencia === 'single') {
      endIndex = startIndex;
    } else {
      endIndex = this.form.endYear * 12 + (this.form.endMonth - 1);
    }

    for (const key of Object.keys(existing.monthlyAmounts)) {
      const [y, m] = key.split('-').map(Number);
      const idx = y * 12 + (m - 1);
      if (idx >= startIndex && idx <= endIndex) {
        return true;
      }
    }
    return false;
  }


  // ------------------------------------------------------------- Delete

  /** Meta sob a qual o modal de exclusão está aberto. */
  pendingDeleteBudget: Budget | null = null;

  requestDelete(budgetId: string): void {
    this.pendingDeleteId = budgetId;
    this.pendingDeleteBudget = this.budgets.find((b) => b.id === budgetId) ?? null;
  }

  cancelDelete(): void {
    this.pendingDeleteId = null;
    this.pendingDeleteBudget = null;
  }

  /**
   * Indica se a meta tem janela maior que 1 mês — só nesse caso oferecemos
   * as opções "apenas este mês" / "deste mês em diante". Para metas
   * `vigencia: single` (1 mês só), só faz sentido excluir tudo.
   */
  get pendingDeleteHasRange(): boolean {
    const b = this.pendingDeleteBudget;
    if (!b) {
      return false;
    }
    // Sem janela definida = "vale desde sempre" → tem range.
    if (b.startYear === undefined || b.startMonth === undefined) {
      return true;
    }
    // Sem fim = forever → tem range.
    if (b.endYear === undefined || b.endMonth === undefined) {
      return true;
    }
    const startIdx = b.startYear * 12 + (b.startMonth - 1);
    const endIdx = b.endYear * 12 + (b.endMonth - 1);
    return endIdx > startIdx;
  }

  /** Label do mês de referência usado no modal de exclusão. */
  get pendingDeleteMonthLabel(): string {
    return this.referenceMonthLabel;
  }

  get pendingDeleteIsInvestment(): boolean {
    return this.pendingDeleteBudget?.scope === 'investment';
  }

  get pendingEditIsInvestment(): boolean {
    return this.pendingEditPayload?.existing.scope === 'investment';
  }

  async confirmDeleteScope(scope: 'single' | 'forward' | 'all'): Promise<void> {
    const id = this.pendingDeleteId;
    const budget = this.pendingDeleteBudget;
    if (!id || !budget) {
      this.cancelDelete();
      return;
    }

    this.pendingDeleteId = null;
    this.pendingDeleteBudget = null;

    try {
      if (scope === 'all') {
        await this.budgetsService.remove(id);
        return;
      }

      const refYear = this.referenceDate.getFullYear();
      const refMonth = this.referenceDate.getMonth() + 1;
      const refKey = `${refYear}-${String(refMonth).padStart(2, '0')}`;

      if (scope === 'single') {
        const next = Array.from(new Set([...(budget.excludedMonths ?? []), refKey]));
        await this.budgetsService.update(id, { excludedMonths: next });
        return;
      }

      // scope === 'forward': encerra a vigência no mês anterior ao de referência.
      // Se isso a tornar vazia (end < start), apaga a meta para evitar lixo.
      const prevMonth = refMonth === 1 ? 12 : refMonth - 1;
      const prevYear = refMonth === 1 ? refYear - 1 : refYear;

      const startYear = budget.startYear;
      const startMonth = budget.startMonth;
      const wouldBeEmpty =
        startYear !== undefined && startMonth !== undefined &&
        (prevYear * 12 + (prevMonth - 1)) < (startYear * 12 + (startMonth - 1));

      if (wouldBeEmpty) {
        await this.budgetsService.remove(id);
        return;
      }

      await this.budgetsService.update(id, {
        endYear: prevYear,
        endMonth: prevMonth
      });
    } catch (error) {
      console.error('[GoalsTab] Erro ao remover meta:', error);
      this.errorMessage = 'Não foi possível remover a meta. Tente novamente.';
    }
  }

  /** Mantido para compat caso algo ainda chame; delega para "all". */
  async confirmDelete(): Promise<void> {
    await this.confirmDeleteScope('all');
  }

  async toggleActive(budget: Budget): Promise<void> {
    try {
      await this.budgetsService.setActive(budget.id, !(budget.active !== false));
    } catch (error) {
      console.error('[GoalsTab] Erro ao alternar meta:', error);
      this.errorMessage = 'Não foi possível atualizar a meta.';
    }
  }

  // ------------------------------------------------------------- Internals

  private recomputeProgress(): void {
    this.progresses = this.calculator.computeAll(this.budgets, {
      months: this.months,
      cardLaunches: this.cardLaunches,
      cards: this.cards,
      now: this.referenceForCalculator()
    });
  }

  private referenceForCalculator(): Date {
    const ref = this.referenceDate;
    const sameYear = ref.getFullYear() === this.today.getFullYear();
    const sameMonth = ref.getMonth() === this.today.getMonth();
    if (sameYear && sameMonth) {
      return this.today;
    }
    const refFirst = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const todayFirst = new Date(this.today.getFullYear(), this.today.getMonth(), 1);
    if (refFirst.getTime() < todayFirst.getTime()) {
      return new Date(ref.getFullYear(), ref.getMonth() + 1, 0); // último dia
    }
    return refFirst; // primeiro dia (futuro)
  }

  goToPreviousMonth(): void {
    this.referenceDate = new Date(
      this.referenceDate.getFullYear(),
      this.referenceDate.getMonth() - 1,
      1
    );
    this.recomputeProgress();
  }

  goToNextMonth(): void {
    this.referenceDate = new Date(
      this.referenceDate.getFullYear(),
      this.referenceDate.getMonth() + 1,
      1
    );
    this.recomputeProgress();
  }

  goToCurrentMonth(): void {
    this.referenceDate = new Date(this.today.getFullYear(), this.today.getMonth(), 1);
    this.recomputeProgress();
  }

  isCurrentMonth(): boolean {
    return (
      this.referenceDate.getFullYear() === this.today.getFullYear() &&
      this.referenceDate.getMonth() === this.today.getMonth()
    );
  }

  get referenceMonthLabel(): string {
    return `${this.monthNames[this.referenceDate.getMonth()]} ${this.referenceDate.getFullYear()}`;
  }

  // ── KPI computed properties ──────────────────────────────────────────────────

  private get activeProgresses(): BudgetProgress[] {
    return this.progresses.filter((p) => p.budget.active !== false);
  }

  get totalBudgeted(): number {
    return this.activeProgresses.reduce((sum, p) => sum + (p.budget.amount || 0), 0);
  }

  get totalSpent(): number {
    return this.activeProgresses.reduce((sum, p) => sum + p.spent, 0);
  }

  get totalRemaining(): number {
    const remaining = this.totalBudgeted - this.totalSpent;
    return remaining > 0 ? remaining : 0;
  }

  get overallPercent(): number {
    if (this.totalBudgeted <= 0) return 0;
    return Math.min(1, this.totalSpent / this.totalBudgeted);
  }

  get overallStatus(): 'ok' | 'warning' | 'over' {
    if (this.totalBudgeted <= 0) return 'ok';
    const ratio = this.totalSpent / this.totalBudgeted;
    if (ratio >= 1) return 'over';
    if (ratio >= 0.85) return 'warning';
    return 'ok';
  }

  private validateForm(): string | null {
    if (!this.form.amount || this.form.amount <= 0) {
      return this.form.scope === 'investment'
        ? 'Informe um valor de meta maior que zero.'
        : 'Informe um valor de teto maior que zero.';
    }
    if (this.form.scope === 'tag' && !this.form.targetId) {
      return 'Selecione uma tag para a meta.';
    }
    if (this.form.scope === 'investment' && !this.form.targetId.trim()) {
      return 'Informe um nome para a meta de investimento.';
    }
    if (this.form.scope === 'card' && !this.form.targetId) {
      return 'Selecione um cartão para a meta.';
    }
    if (this.form.period === 'invoice-cycle' && this.form.scope !== 'card') {
      return 'O ciclo de fatura só é válido para metas de cartão.';
    }
    if (this.form.vigencia === 'range') {
      const startIndex = this.form.startYear * 12 + (this.form.startMonth - 1);
      const endIndex = this.form.endYear * 12 + (this.form.endMonth - 1);
      if (endIndex < startIndex) {
        return 'O mês final precisa ser igual ou posterior ao inicial.';
      }
    }
    return null;
  }

  private resolveTargetName(scope: BudgetScope, targetId: string): string {
    if (scope === 'tag') {
      const found = this.tags.find((t) => normalizeTagName(t.name) === normalizeTagName(targetId));
      return found?.name ?? targetId;
    }
    if (scope === 'investment') {
      return targetId.trim();
    }
    if (scope === 'card') {
      return this.getCardName(targetId);
    }
    return 'Geral';
  }

  private emptyForm(): BudgetFormState {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    return {
      scope: 'tag',
      targetId: '',
      amount: null,
      period: 'monthly',
      rollover: false,
      active: true,
      notes: '',
      vigencia: 'forever',
      startYear: year,
      startMonth: month,
      endYear: year,
      endMonth: month,
      overwriteExisting: false
    };
  }

  // ------------------------------------------------------------- Vigencia helpers (template)

  setVigencia(value: BudgetFormState['vigencia']): void {
    this.form.vigencia = value;
    if (value === 'range') {
      const startIndex = this.form.startYear * 12 + (this.form.startMonth - 1);
      const endIndex = this.form.endYear * 12 + (this.form.endMonth - 1);
      if (endIndex < startIndex) {
        this.form.endYear = this.form.startYear;
        this.form.endMonth = this.form.startMonth;
      }
    }
  }

  getStartMonthLabel(): string {
    const m = this.monthOptions.find((opt) => opt.value === this.form.startMonth);
    return `${m?.label ?? ''} de ${this.form.startYear}`;
  }
}
