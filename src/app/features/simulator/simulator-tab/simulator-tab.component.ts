import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { TagCatalogItem, normalizeTagName } from '../../../core/models/tag.model';
import {
  CardLaunch,
  FinanceApiService,
  FinancialEvent,
  MonthDefinition
} from '../../../core/services/finance-api.service';
import {
  MonthProjection,
  SimulationResult,
  SimulatorProjectionService,
  SimulatorScenario,
  defaultScenario
} from '../../../core/services/simulator-projection.service';
import { TagsService } from '../../../core/services/tags.service';

interface TagExpenseBreakdown {
  /** Chave normalizada (lowercase). Usada para `selectedTagKeys`. */
  key: string;
  /** Label exibido. */
  label: string;
  /** Cor da tag (do catálogo) ou fallback. */
  color: string;
  /** Soma das despesas + investimentos do mês com essa tag. */
  amount: number;
}

/** Chave da tag implícita para eventos do tipo `daily`. */
const DAILY_IMPLICIT_TAG_KEY = normalizeTagName('diário');
const FALLBACK_COLOR = '#94a3b8';

/**
 * Aba "Simulador" — permite testar cenários de queda de renda e descobrir
 * por quanto tempo o usuário consegue se manter (runway) e qual é o impacto
 * no saldo dos próximos meses.
 *
 * MVP: cenários NÃO são persistidos no Firestore, vivem apenas em memória.
 */
@Component({
  selector: 'app-simulator-tab',
  templateUrl: './simulator-tab.component.html',
  styleUrls: ['./simulator-tab.component.scss']
})
export class SimulatorTabComponent implements OnInit, OnDestroy {
  isLoading = true;
  errorMessage: string | null = null;

  scenario: SimulatorScenario = defaultScenario();

  /**
   * Renda detectada automaticamente: soma dos eventos `type === 'income'` do
   * primeiro mês do horizonte da projeção. É o valor de referência mostrado
   * para o usuário na pergunta "qual será sua nova renda?".
   */
  detectedIncome = 0;

  /**
   * Renda nova que o usuário declara (em R$). A partir disso e de
   * `detectedIncome` calculamos o `incomeMultiplier` automaticamente.
   * Quando `null`, assume "sem mudança" (igual à detectada).
   */
  newIncomeInput: number | null = null;
  /** Valor formatado exibido no input (máscara em R$). */
  newIncomeInputDisplay = '';

  /** True quando o usuário editou manualmente o input de renda nova. */
  private userTouchedIncome = false;

  /** True quando o usuário mudou manualmente o mês inicial — para não auto-ajustar. */
  private userPickedStartMonth = false;

  /** Total de despesas variáveis do mês de referência (despesas + investimentos + custo diário fixo). */
  detectedExpensesTotal = 0;
  /** Subtotal por tag das despesas/investimentos do mês de referência. */
  tagBreakdown: TagExpenseBreakdown[] = [];
  /** Tags marcadas pelo usuário como "posso cortar". */
  selectedTagKeys = new Set<string>();
  /** Valor manual digitado para o corte adicional (R$/mês). */
  manualCutInput: number | null = 0;
  /** Valor formatado exibido no input de corte manual (máscara em R$). */
  manualCutInputDisplay = '';

  /** Versões formatadas (máscara R$) dos campos numéricos do cenário. */
  emergencyFundDisplay = '';
  severanceDisplay = '';
  unemploymentMonthlyDisplay = '';

  baseline: SimulationResult | null = null;
  current: SimulationResult | null = null;

  private months: MonthDefinition[] = [];
  private cardLaunches: CardLaunch[] = [];
  private tagCatalog: TagCatalogItem[] = [];
  private subscription = new Subscription();

  constructor(
    private readonly api: FinanceApiService,
    private readonly projection: SimulatorProjectionService,
    private readonly tagsService: TagsService
  ) {}

  ngOnInit(): void {
    // Dados financeiros (mês + lançamentos) controlam loading e detecção.
    this.subscription.add(
      combineLatest([this.api.getMonths(), this.api.getCardLaunches()]).subscribe({
        next: ([months, launches]) => {
          this.months = months;
          this.cardLaunches = launches;
          this.alignStartMonthToData();
          this.refreshDetection();
          this.isLoading = false;
          this.recompute();
        },
        error: (err) => {
          console.error('[simulator] erro carregando dados', err);
          this.errorMessage = 'Não foi possível carregar dados para simular.';
          this.isLoading = false;
        }
      })
    );

    // Catálogo de tags vem em stream separado para não bloquear a detecção
    // de receitas/despesas caso ainda não tenha emitido.
    this.subscription.add(
      this.tagsService.tags$.subscribe((tags) => {
        this.tagCatalog = tags;
        // Só reaplica cor das tags já detectadas.
        this.tagBreakdown = this.computeTagBreakdown();
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  // --- ações de UI ---

  /** Atalhos rápidos: aplica um multiplicador pré-definido sobre a renda detectada. */
  applyQuickIncomeChange(multiplier: number): void {
    const newValue = Math.max(0, Math.round(this.detectedIncome * multiplier));
    this.newIncomeInput = newValue;
    this.newIncomeInputDisplay = newValue === 0 ? '' : this.formatCurrencyInput(newValue);
    this.userTouchedIncome = true;
    this.applyIncomeFromValue(newValue);
  }

  onNewIncomeInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.newIncomeInputDisplay = masked.display;
    const safe = masked.amount ?? 0;
    this.newIncomeInput = safe;
    this.userTouchedIncome = true;
    this.applyIncomeFromValue(safe);
  }

  private applyIncomeFromValue(newIncome: number): void {
    // Quando o usuário declara explicitamente um valor de renda nova, esse
    // valor passa a ser FIXO em todos os meses (override). Isso evita que
    // receitas variáveis lançadas (freela, cashback, etc.) sejam escaladas
    // proporcionalmente e gerem surpresa do tipo "digitei 850 mas aparece 891".
    this.scenario = {
      ...this.scenario,
      incomeMultiplier: 1,
      monthlyIncomeOverride: newIncome
    };
    this.recompute();
  }

  /** Variação percentual entre renda nova e detectada (ex.: -40 = caiu 40%). */
  get incomeDeltaPercent(): number | null {
    if (this.detectedIncome <= 0 || this.newIncomeInput === null) return null;
    return ((this.newIncomeInput - this.detectedIncome) / this.detectedIncome) * 100;
  }

  updateScenario<K extends keyof SimulatorScenario>(field: K, value: SimulatorScenario[K]): void {
    this.scenario = { ...this.scenario, [field]: value };
    this.recompute();
  }

  updateUnemploymentInsurance(field: 'monthlyAmount' | 'months', value: number): void {
    this.scenario = {
      ...this.scenario,
      unemploymentInsurance: { ...this.scenario.unemploymentInsurance, [field]: value }
    };
    this.recompute();
  }

  resetScenario(): void {
    this.scenario = defaultScenario();
    this.userTouchedIncome = false;
    this.userPickedStartMonth = false;
    this.alignStartMonthToData();
    this.newIncomeInput = this.detectedIncome;
    this.manualCutInput = 0;
    this.selectedTagKeys.clear();
    this.syncCurrencyDisplays();
    this.recompute();
  }

  /**
   * Ajusta o mês inicial da projeção para o primeiro mês com dados a partir
   * de hoje. Evita confusão quando o usuário lança a partir de meses futuros
   * (ex.: começou em maio mas hoje é abril) — sem isso o simulador iniciava
   * em abril sem dados e podia trazer falsos positivos via cardLaunches.
   * Não sobrescreve quando o usuário já mudou manualmente o mês.
   */
  private alignStartMonthToData(): void {
    if (this.userPickedStartMonth) return;
    if (this.months.length === 0) return;

    const today = new Date();
    const todayKey = today.getFullYear() * 12 + today.getMonth();
    const sorted = [...this.months].sort(
      (a, b) => a.year - b.year || a.monthNumber - b.monthNumber
    );

    // Procura o primeiro mês cadastrado com chave >= mês atual.
    const firstFuture = sorted.find(
      (m) => m.year * 12 + (m.monthNumber - 1) >= todayKey
    );
    const target = firstFuture ?? sorted[0];

    this.scenario = {
      ...this.scenario,
      startYear: target.year,
      startMonth: target.monthNumber
    };
  }

  /**
   * Recalcula totais detectados a partir dos dados atuais e mantém o input
   * de renda sincronizado com o detectado até o usuário editar manualmente.
   */
  private refreshDetection(): void {
    this.detectedIncome = this.computeDetectedIncome();
    this.detectedExpensesTotal = this.computeDetectedExpensesTotal();
    this.tagBreakdown = this.computeTagBreakdown();

    if (!this.userTouchedIncome) {
      this.newIncomeInput = this.detectedIncome;
      // Mantém o multiplicador neutro até o usuário mexer.
      this.scenario = {
        ...this.scenario,
        incomeMultiplier: 1,
        monthlyIncomeOverride: null
      };
    }

    // Limpa tags selecionadas que não existem mais no breakdown atual.
    if (this.selectedTagKeys.size > 0) {
      const validKeys = new Set(this.tagBreakdown.map((t) => t.key));
      for (const key of Array.from(this.selectedTagKeys)) {
        if (!validKeys.has(key)) this.selectedTagKeys.delete(key);
      }
      this.scenario = { ...this.scenario, expenseCutAmount: this.totalCutAmount };
    }

    this.syncCurrencyDisplays();
  }

  // --- corte de despesas ---

  /** Soma do corte vindo de tags marcadas. */
  get tagsCutAmount(): number {
    let total = 0;
    for (const tag of this.tagBreakdown) {
      if (this.selectedTagKeys.has(tag.key)) total += tag.amount;
    }
    return total;
  }

  /** Total de corte (manual + tags), capado pelo total de despesas detectado. */
  get totalCutAmount(): number {
    const raw = (this.manualCutInput ?? 0) + this.tagsCutAmount;
    if (this.detectedExpensesTotal > 0) {
      return Math.min(raw, this.detectedExpensesTotal);
    }
    return Math.max(0, raw);
  }

  /** Percentual equivalente do corte sobre o total de despesas detectado. */
  get cutDeltaPercent(): number | null {
    if (this.detectedExpensesTotal <= 0) return null;
    return (this.totalCutAmount / this.detectedExpensesTotal) * 100;
  }

  isTagSelected(key: string): boolean {
    return this.selectedTagKeys.has(key);
  }

  toggleTag(key: string): void {
    if (this.selectedTagKeys.has(key)) {
      this.selectedTagKeys.delete(key);
    } else {
      this.selectedTagKeys.add(key);
    }
    this.applyExpenseCut();
  }

  onManualCutChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.manualCutInputDisplay = masked.display;
    this.manualCutInput = masked.amount ?? 0;
    this.applyExpenseCut();
  }

  onEmergencyFundInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.emergencyFundDisplay = masked.display;
    this.updateScenario('emergencyFund', masked.amount ?? 0);
  }

  onSeveranceInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.severanceDisplay = masked.display;
    this.updateScenario('severance', masked.amount ?? 0);
  }

  onUnemploymentMonthlyInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.unemploymentMonthlyDisplay = masked.display;
    this.updateUnemploymentInsurance('monthlyAmount', masked.amount ?? 0);
  }

  /** Converte string com dígitos em valor R$ + texto formatado pt-BR. */
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

  /** Reescreve todos os displays de máscara conforme valores numéricos atuais. */
  private syncCurrencyDisplays(): void {
    this.newIncomeInputDisplay =
      this.newIncomeInput == null || this.newIncomeInput === 0
        ? ''
        : this.formatCurrencyInput(this.newIncomeInput);
    this.manualCutInputDisplay =
      !this.manualCutInput ? '' : this.formatCurrencyInput(this.manualCutInput);
    this.emergencyFundDisplay = this.scenario.emergencyFund
      ? this.formatCurrencyInput(this.scenario.emergencyFund)
      : '';
    this.severanceDisplay = this.scenario.severance
      ? this.formatCurrencyInput(this.scenario.severance)
      : '';
    this.unemploymentMonthlyDisplay = this.scenario.unemploymentInsurance.monthlyAmount
      ? this.formatCurrencyInput(this.scenario.unemploymentInsurance.monthlyAmount)
      : '';
  }

  private applyExpenseCut(): void {
    this.scenario = { ...this.scenario, expenseCutAmount: this.totalCutAmount };
    this.recompute();
  }

  // --- detecção de renda ---

  private computeDetectedIncome(): number {
    const target = this.findReferenceMonth();
    if (!target) return 0;
    let total = 0;
    for (const ev of target.events ?? []) {
      if (ev.suppressed) continue;
      if (ev.type !== 'income') continue;
      total += Number(ev.amount) || 0;
    }
    return total;
  }

  private computeDetectedExpensesTotal(): number {
    const target = this.findReferenceMonth();
    if (!target) return 0;
    const eventsTotal = (target.events ?? [])
      .filter((e) => !e.suppressed && (e.type === 'expense' || e.type === 'investment'))
      .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
    const dailyTotal = (target.dailyFixedCost ?? 0) * this.daysInMonth(target.year, target.monthNumber);
    return eventsTotal + dailyTotal;
  }

  private computeTagBreakdown(): TagExpenseBreakdown[] {
    const target = this.findReferenceMonth();
    if (!target) return [];
    const tagTotals = new Map<string, { label: string; amount: number }>();

    for (const ev of target.events ?? []) {
      if (ev.suppressed) continue;
      if (ev.type !== 'expense' && ev.type !== 'investment') continue;
      const amount = Number(ev.amount) || 0;
      if (!amount) continue;
      const tagKeys = this.collectEventTagKeys(ev);
      for (const { key, label } of tagKeys) {
        const existing = tagTotals.get(key);
        if (existing) {
          existing.amount += amount;
        } else {
          tagTotals.set(key, { label, amount });
        }
      }
    }

    const result: TagExpenseBreakdown[] = [];
    tagTotals.forEach(({ label, amount }, key) => {
      result.push({
        key,
        label,
        color: this.colorForTagKey(key),
        amount
      });
    });
    return result.sort((a, b) => b.amount - a.amount);
  }

  private collectEventTagKeys(event: FinancialEvent): Array<{ key: string; label: string }> {
    const seen = new Map<string, string>();
    const declared = Array.isArray(event.tags) ? event.tags : [];
    for (const raw of declared) {
      const label = (raw ?? '').trim();
      if (!label) continue;
      const key = normalizeTagName(label);
      if (!seen.has(key)) seen.set(key, label);
    }
    // Eventos `daily` ganham automaticamente a tag implícita "diário".
    if (event.type === 'daily' && !seen.has(DAILY_IMPLICIT_TAG_KEY)) {
      seen.set(DAILY_IMPLICIT_TAG_KEY, 'diário');
    }
    // Despesas/investimentos sem tag entram em "(sem tag)" para dar visibilidade.
    if (seen.size === 0) {
      seen.set('__untagged__', '(sem tag)');
    }
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
  }

  private colorForTagKey(key: string): string {
    if (key === '__untagged__') return FALLBACK_COLOR;
    const hit = this.tagCatalog.find((t) => normalizeTagName(t.name) === key);
    return hit?.color || FALLBACK_COLOR;
  }

  private findReferenceMonth(): MonthDefinition | undefined {
    const { startYear, startMonth } = this.scenario;
    const exact = this.months.find(
      (m) => m.year === startYear && m.monthNumber === startMonth
    );
    if (exact) return exact;
    // fallback: último mês cadastrado
    return [...this.months]
      .sort((a, b) => a.year - b.year || a.monthNumber - b.monthNumber)
      .pop();
  }

  // --- cálculos ---

  private recompute(): void {
    const baselineScenario: SimulatorScenario = {
      ...this.scenario,
      incomeMultiplier: 1,
      severance: 0,
      unemploymentInsurance: { monthlyAmount: 0, months: 0 },
      expenseCutAmount: 0
      // emergencyFund é mantido — representa quanto você TEM hoje, e isso vale para os dois.
    };
    this.baseline = this.projection.simulate(this.months, this.cardLaunches, baselineScenario);
    this.current = this.projection.simulate(this.months, this.cardLaunches, this.scenario);
  }

  // --- formatadores ---

  formatBRL(value: number): string {
    return value.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      maximumFractionDigits: 0
    });
  }

  /** Label do mês inicial da projeção (ex.: "mai/2026"). */
  get referenceMonthLabel(): string {
    const labels = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return `${labels[this.scenario.startMonth - 1]}/${this.scenario.startYear}`;
  }

  formatRunway(months: number | null): string {
    if (months === null) return 'além do horizonte 🎉';
    if (months <= 0) return 'já está no vermelho';
    if (months < 1) {
      const days = Math.round(months * 30);
      return `~${days} dias`;
    }
    return `${months.toFixed(1)} meses`;
  }

  trackByMonth(_: number, m: MonthProjection): string {
    return `${m.year}-${m.month}`;
  }

  /** Altura proporcional para a barra de saldo (0..100). */
  balanceBarHeight(month: MonthProjection, all: MonthProjection[]): number {
    const max = Math.max(1, ...all.map((m) => Math.abs(m.cumulativeBalance)));
    return Math.min(100, Math.max(2, (Math.abs(month.cumulativeBalance) / max) * 100));
  }

  private daysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
  }
}
