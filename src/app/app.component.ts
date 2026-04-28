import { Component, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CardLaunch, CreditCard, FinanceApiService, EventType, FinancialEvent, MonthDefinition, RecurrenceKind, RepeatMode } from './finance-api.service';
import { CardsTabComponent } from './cards-tab.component';
import { AuthService } from './auth.service';
import { forkJoin } from 'rxjs';

type LaunchType = EventType;
type EventActionScope = 'single' | 'series' | 'forward';
type DeleteActionScope = EventActionScope;
type DailyRepeatSelection = RepeatMode | 'none';

interface PendingEventAction {
  type: 'edit' | 'delete';
  monthKey: string;
  event: FinancialEvent;
}

interface PendingDeleteConfirmation {
  monthKey: string;
  eventId: string;
  scope: DeleteActionScope;
  event: FinancialEvent;
}

interface RecurrencePreview {
  occurrences: number;
  firstMonthIndex: number;
  lastMonthIndex: number;
}

interface CardInvoiceForecast {
  cardId: string;
  cardName: string;
  amount: number;
  launchesCount: number;
  isPaid?: boolean;
}

interface DayProjection {
  day: number;
  income: number;
  expense: number;
  investment: number;
  fixedCost: number;
  closingBalance: number;
  events: FinancialEvent[];
  notes: string[];
  cardInvoiceForecasts: CardInvoiceForecast[];
  status: 'negative' | 'warning' | 'healthy';
}

interface ActiveDayDetails {
  month: MonthSummary;
  day: DayProjection;
}

interface MonthSummary {
  key: string;
  title: string;
  year: number;
  monthNumber: number;
  openingBalance: number;
  closingBalance: number;
  minBalance: number;
  totalIncome: number;
  totalExpenses: number;
  totalInvestments: number;
  totalFixedCosts: number;
  negativeDays: number;
  chartHeights: number[];
  projection: DayProjection[];
}

interface WindowSummary {
  label: string;
  months: MonthSummary[];
  totalIncome: number;
  totalExpenses: number;
  totalInvestments: number;
  totalFixedCosts: number;
  openingBalance: number;
  closingBalance: number;
}

interface DailyCarryState {
  singleTotal: number;
  seriesAmounts: Map<string, number>;
}

interface VisionCard {
  title: string;
  description: string;
}

interface DashboardCardSummary {
  cardId: string;
  cardName: string;
  invoiceTotal: number;
  paidTotal: number;
  pendingTotal: number;
  availableLimit: number;
  dueDateLabel: string;
  closingDateLabel: string;
}

interface DashboardExpenseSlice {
  label: string;
  amount: number;
  percent: number;
  color: string;
}

interface LaunchFormState {
  type: LaunchType;
  amount: number | null;
  date: string;
  label: string;
  recurrenceKind: RecurrenceKind;
  repeatMode: RepeatMode;
  installments: number;
}

interface LaunchDecisionAdvice {
  tone: 'good' | 'warn' | 'risk';
  title: string;
  summary: string;
  detail: string;
}

interface DailyFormState {
  amount: number | null;
  effectiveDate: string;
  repeatMode: DailyRepeatSelection;
  recurrenceKind: RecurrenceKind;
  installments: number;
}

interface OnboardingStep {
  icon: string;
  title: string;
  body: string;
  bullets?: string[];
  tip?: string;
}

type AppTab = 'entries' | 'dashboard' | 'cards';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  readonly title = 'previsa';
  private readonly windowSize = 3;
  private readonly planningHorizonMonths = 24;
  private readonly planningEndYear = 2028;
  activeTab: AppTab = 'entries';
  windowStartIndex = 0;
  isLoading = true;
  dataError = '';
  isSavingLaunch = false;
  entriesFeedback = '';
  activeDayDetails: ActiveDayDetails | null = null;
  deletingEventIds = new Set<string>();
  payingEventIds = new Set<string>();
  payingInvoiceKeys = new Set<string>();
  private saveAndNewLaunchRequested = false;
  private currentUserId: string | null = null;
  private seededMonthsUserId: string | null = null;

  userMenuOpen = false;
  darkMode = false;

  showOnboarding = false;
  onboardingStep = 0;
  readonly onboardingSteps: OnboardingStep[] = [
    {
      icon: '👋',
      title: 'Bem-vindo ao Previsa',
      body: 'Um gestor financeiro pessoal focado em previsibilidade. Lance entradas, saidas e investimentos e veja para onde o seu caixa vai — mes a mes — antes de acontecer.',
      tip: 'Use o botao ? no canto superior para abrir este guia novamente a qualquer momento.'
    },
    {
      icon: '➕',
      title: 'Adicionando lancamentos',
      body: 'Clique no botao azul + no canto inferior direito para abrir o formulario. Voce pode lancar:',
      bullets: [
        'Entrada — receitas recebidas (salario, freelance, transferencia)',
        'Saida — despesas e contas a pagar',
        'Investido — reserva que sai do caixa',
        'Diario — custo que se repete diariamente (ex: transporte R$ 8 por dia)'
      ],
      tip: 'Lancamentos parcelados usam o valor de cada parcela, nao o total da compra.'
    },
    {
      icon: '✏️',
      title: 'Editando e excluindo',
      body: 'Passe o mouse sobre qualquer linha da tabela de dias para ver os botoes de acao.',
      bullets: [
        'Lancamentos unicos sao alterados diretamente.',
        'Para series (parcelados ou fixos), voce escolhe: so este, este e os proximos, ou toda a serie.',
        'Despesas podem ser marcadas como pagas — o registro permanece visivel no mes.'
      ]
    },
    {
      icon: '📅',
      title: 'Modos de visualizacao',
      body: 'Use os botoes no topo da aba Lancamentos para alternar entre tres modos:',
      bullets: [
        '3 meses — tres colunas lado a lado, ideal para acompanhamento diario',
        '12 meses — visao anual em blocos, otima para planejamento de longo prazo',
        'Personalizado — selecione exatamente os meses que quer comparar'
      ],
      tip: 'O botao "mes atual" leva voce de volta ao mes de hoje com um clique.'
    },
    {
      icon: '💳',
      title: 'Cartoes de credito',
      body: 'Cadastre seus cartoes na aba Cartoes e registre compras com a data da compra.',
      bullets: [
        'O Previsa calcula a fatura prevista e projeta o debito no mes do vencimento.',
        'O impacto aparece como uma linha roxa na tabela de dias desse mes.',
        'Voce enxerga o peso da fatura no caixa antes de ela chegar.'
      ]
    }
  ];

  viewMode: 'custom' | '3month' | '12month' = '3month';
  twelveMonthYear = new Date().getFullYear();
  customStartIndex = 0;
  customEndIndex = 2;
  isFabMenuOpen = false;

  isLaunchFormOpen = false;
  isDailyFormOpen = false;
  editingEventId: string | null = null;
  editingSeriesId: string | null = null;
  editingScope: EventActionScope | null = null;
  editingSourceMonthKey: string | null = null;
  editingAnchorDay: number | null = null;
  pendingEventAction: PendingEventAction | null = null;
  pendingDeleteConfirmation: PendingDeleteConfirmation | null = null;
  launchError = '';
  dailyError = '';
  launchForm: LaunchFormState = {
    type: 'expense',
    amount: null,
    date: '',
    label: '',
    recurrenceKind: 'single',
    repeatMode: 'monthly',
    installments: 1
  };
  launchAmountInput = '';

  dailyForm: DailyFormState = {
    amount: null,
    effectiveDate: '',
    repeatMode: 'none',
    recurrenceKind: 'fixed',
    installments: 1
  };
  dailyAmountInput = '';

  @ViewChild('cardsTab', { static: false }) cardsTab?: CardsTabComponent;

  readonly recurrenceKindOptions: Array<{ value: RecurrenceKind; label: string }> = [
    { value: 'single', label: 'Unica' },
    { value: 'installment', label: 'Parcelada' },
    { value: 'fixed', label: 'Fixa' }
  ];

  readonly launchTypeOptions: Array<{ value: LaunchType; label: string }> = [
    { value: 'income', label: 'Entrada' },
    { value: 'expense', label: 'Saida' },
    { value: 'investment', label: 'Investido' },
    { value: 'daily', label: 'Diario' }
  ];

  readonly repeatModeOptions: Array<{ value: RepeatMode; label: string }> = [
    { value: 'daily', label: 'Todo dia' },
    { value: 'weekly', label: 'Toda semana' },
    { value: 'monthly', label: 'Todo mes' }
  ];

  readonly dailyRepeatModeOptions: Array<{ value: DailyRepeatSelection; label: string }> = [
    { value: 'none', label: 'Nao repetir' },
    { value: 'daily', label: 'Todo dia' },
    { value: 'weekly', label: 'Toda semana' },
    { value: 'monthly', label: 'Todo mes' }
  ];

  readonly dailyRecurrenceKindOptions: Array<{ value: Exclude<RecurrenceKind, 'single'>; label: string }> = [
    { value: 'fixed', label: 'Fixa' },
    { value: 'installment', label: 'Quantidade de vezes' }
  ];

  readonly visionCards: VisionCard[] = [
    {
      title: 'Linha do tempo de compromissos',
      description: 'Agrupa vencimentos, aportes e entradas futuras em uma faixa cronologica para voce enxergar onde o caixa aperta.'
    },
    {
      title: 'Mapa de calor do saldo diario',
      description: 'Troca dezenas de linhas por intensidade visual, destacando dias de conforto, alerta e saldo negativo.'
    },
    {
      title: 'Pontes entre meses',
      description: 'Mostra quanto saldo cada mes entrega para o proximo, deixando claro o efeito acumulado das decisoes.'
    }
  ];

  private readonly currencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2
  });

  private readonly shortDateFormatter = new Intl.DateTimeFormat('pt-BR');
  private readonly dashboardExpensePalette = ['#16c6a0', '#3f8df6', '#e5cc3a', '#f97316', '#a78bfa', '#f43f5e'];

  private monthDefinitions: MonthDefinition[] = [];
  private cards: CreditCard[] = [];
  private cardLaunches: CardLaunch[] = [];

  private readonly emptyMonthSummary: MonthSummary = {
    key: 'empty',
    title: 'Sem dados',
    year: 0,
    monthNumber: 0,
    openingBalance: 0,
    closingBalance: 0,
    minBalance: 0,
    totalIncome: 0,
    totalExpenses: 0,
    totalInvestments: 0,
    totalFixedCosts: 0,
    negativeDays: 0,
    chartHeights: [],
    projection: []
  };

  constructor(private readonly financeApi: FinanceApiService, public readonly auth: AuthService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    const saved = localStorage.getItem('previsa-dark');
    if (saved === 'true' || (saved === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      this.darkMode = true;
      document.body.classList.add('dark');
    }

    this.auth.user$.subscribe((user) => {
      this.userMenuOpen = false;
      this.currentUserId = user?.uid ?? null;

      if (!user) {
        this.showOnboarding = false;
        this.seededMonthsUserId = null;
        return;
      }

      this.showOnboarding = !localStorage.getItem(this.getOnboardingStorageKey(user.uid));
    });

    this.loadMonths();
    this.loadCardForecastData();
  }

  toggleUserMenu(): void {
    this.userMenuOpen = !this.userMenuOpen;
  }

  toggleDarkMode(): void {
    this.darkMode = !this.darkMode;
    document.body.classList.toggle('dark', this.darkMode);
    localStorage.setItem('previsa-dark', String(this.darkMode));
  }

  openOnboarding(): void {
    this.onboardingStep = 0;
    this.showOnboarding = true;
  }

  closeOnboarding(): void {
    this.showOnboarding = false;
    localStorage.setItem(this.getOnboardingStorageKey(), 'true');
  }

  nextOnboardingStep(): void {
    if (this.onboardingStep < this.onboardingSteps.length - 1) {
      this.onboardingStep++;
    } else {
      this.closeOnboarding();
    }
  }

  prevOnboardingStep(): void {
    if (this.onboardingStep > 0) {
      this.onboardingStep--;
    }
  }

  get monthSummaries(): MonthSummary[] {
    return this.buildMonthSummaries();
  }

  get projectedBalance(): number {
    if (!this.monthSummaries.length) {
      return 0;
    }

    return this.monthSummaries[this.monthSummaries.length - 1].closingBalance;
  }

  get worstProjectedBalance(): number {
    if (!this.monthSummaries.length) {
      return 0;
    }

    return Math.min(...this.monthSummaries.flatMap((month) => month.projection.map((day) => day.closingBalance)));
  }

  get protectedDays(): number {
    return this.monthSummaries.reduce(
      (count, month) => count + month.projection.filter((day) => day.closingBalance > 0).length,
      0
    );
  }

  get nextPressurePoint(): string {
    return this.findNextPressurePoint();
  }

  get visibleMonths(): MonthSummary[] {
    return this.monthSummaries.slice(this.windowStartIndex, this.windowStartIndex + this.windowSize);
  }

  get visibleWindow(): WindowSummary {
    const months = this.visibleMonths;
    if (!months.length) {
      return {
        label: 'Sem dados',
        months: [],
        totalIncome: 0,
        totalExpenses: 0,
        totalInvestments: 0,
        totalFixedCosts: 0,
        openingBalance: 0,
        closingBalance: 0
      };
    }

    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];

    return {
      label: months.map((month) => `${month.title}/${month.year}`).join(' + '),
      months,
      totalIncome: months.reduce((total, month) => total + month.totalIncome, 0),
      totalExpenses: months.reduce((total, month) => total + month.totalExpenses, 0),
      totalInvestments: months.reduce((total, month) => total + month.totalInvestments, 0),
      totalFixedCosts: months.reduce((total, month) => total + month.totalFixedCosts, 0),
      openingBalance: firstMonth.openingBalance,
      closingBalance: lastMonth.closingBalance
    };
  }

  get focusMonth(): MonthSummary {
    return this.visibleMonths[0] ?? this.monthSummaries[0] ?? this.emptyMonthSummary;
  }

  get dashboardCardSummaries(): DashboardCardSummary[] {
    const todayRef = this.getTodayInputDate();

    return this.cards
      .map((card) => {
        const invoiceMonth = this.getCardInvoiceMonthForDate(todayRef, card);
        const launches = this.cardLaunches.filter((launch) => {
          if (String(launch.cardId) !== String(card.id)) {
            return false;
          }

          const launchInvoiceMonth = this.getCardInvoiceMonthForDate(launch.date, card);
          return launchInvoiceMonth.year === invoiceMonth.year && launchInvoiceMonth.month === invoiceMonth.month;
        });

        const invoiceTotal = launches.reduce((sum, launch) => sum + launch.amount, 0);
        const paidTotal = launches.filter((launch) => !!launch.paid).reduce((sum, launch) => sum + launch.amount, 0);
        const pendingTotal = Math.max(0, invoiceTotal - paidTotal);

        return {
          cardId: String(card.id ?? card.name),
          cardName: card.name,
          invoiceTotal,
          paidTotal,
          pendingTotal,
          availableLimit: card.limit - invoiceTotal,
          dueDateLabel: this.formatDateLabel(this.getDueDateForInvoiceMonth(invoiceMonth, card)),
          closingDateLabel: this.formatDateLabel(this.getClosingDateForInvoiceMonth(invoiceMonth, card))
        };
      })
      .sort((a, b) => b.invoiceTotal - a.invoiceTotal);
  }

  get dashboardExpenseSlices(): DashboardExpenseSlice[] {
    const visibleKeys = new Set(this.visibleMonths.map((month) => month.key));
    const expenseByLabel = new Map<string, number>();

    for (const month of this.monthDefinitions) {
      if (!visibleKeys.has(month.key)) {
        continue;
      }

      for (const event of month.events) {
        if (event.type !== 'expense' || event.suppressed) {
          continue;
        }

        const baseLabel = this.normalizeText(event.label ?? '').trim();
        const label = baseLabel || 'Sem categoria';
        expenseByLabel.set(label, (expenseByLabel.get(label) ?? 0) + event.amount);
      }
    }

    const sorted = Array.from(expenseByLabel.entries())
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => b.amount - a.amount);

    const total = sorted.reduce((sum, item) => sum + item.amount, 0);
    if (total <= 0) {
      return [];
    }

    const topSlices = sorted.slice(0, 5);
    const othersAmount = sorted.slice(5).reduce((sum, item) => sum + item.amount, 0);
    const combined = othersAmount > 0
      ? [...topSlices, { label: 'Outros', amount: othersAmount }]
      : topSlices;

    return combined.map((slice, index) => ({
      label: slice.label,
      amount: Number(slice.amount.toFixed(2)),
      percent: Number(((slice.amount / total) * 100).toFixed(2)),
      color: this.dashboardExpensePalette[index % this.dashboardExpensePalette.length]
    }));
  }

  get dashboardExpenseTotal(): number {
    return this.dashboardExpenseSlices.reduce((sum, slice) => sum + slice.amount, 0);
  }

  get dashboardTopExpensePercent(): number {
    return this.dashboardExpenseSlices.length ? this.dashboardExpenseSlices[0].percent : 0;
  }

  get dashboardExpenseDonutStyle(): string {
    const slices = this.dashboardExpenseSlices;
    if (!slices.length) {
      return 'conic-gradient(#dbe4f0 0% 100%)';
    }

    let cursor = 0;
    const segments = slices.map((slice) => {
      const start = cursor;
      cursor = Number(Math.min(100, cursor + slice.percent).toFixed(2));
      return `${slice.color} ${start}% ${cursor}%`;
    });

    if (cursor < 100) {
      segments.push(`#dbe4f0 ${cursor}% 100%`);
    }

    return `conic-gradient(${segments.join(', ')})`;
  }

  get launchMonths(): MonthSummary[] {
    if (this.viewMode === '12month') {
      return this.monthSummaries.filter((month) => month.year === this.twelveMonthYear);
    }
    if (this.viewMode === 'custom') {
      return this.monthSummaries.slice(this.customStartIndex, this.customEndIndex + 1);
    }
    return this.visibleMonths;
  }

  get entriesTitle(): string {
    if (this.viewMode === '12month') {
      return `Lancamentos de ${this.twelveMonthYear}`;
    }
    if (this.viewMode === 'custom') {
      const months = this.launchMonths;
      if (!months.length) return 'Periodo personalizado';
      if (months.length === 1) return `${months[0].title} de ${months[0].year}`;
      const first = months[0];
      const last = months[months.length - 1];
      return first.year === last.year
        ? `${first.title} a ${last.title} · ${first.year}`
        : `${first.title}/${first.year} a ${last.title}/${last.year}`;
    }
    const months = this.visibleMonths;
    if (!months.length) return 'Lancamentos';
    const first = months[0];
    const last = months[months.length - 1];
    return first.year === last.year
      ? `${first.title} a ${last.title} · ${first.year}`
      : `${first.title}/${first.year} a ${last.title}/${last.year}`;
  }

  get canGoPrevious(): boolean {
    if (this.viewMode === '12month') {
      return this.monthSummaries.length > 0;
    }

    return this.windowStartIndex > 0;
  }

  get canGoNext(): boolean {
    return this.viewMode !== 'custom' && this.monthSummaries.length > 0;
  }

  get twelveMonthWindowLabel(): string {
    return String(this.twelveMonthYear);
  }

  get hasCurrentMonthInData(): boolean {
    const today = new Date();
    return this.findMonthIndex(today.getFullYear(), today.getMonth() + 1) >= 0;
  }

  get supportsRecurrence(): boolean {
    return true;
  }

  get showInstallmentsField(): boolean {
    return this.supportsRecurrence && this.launchForm.recurrenceKind === 'installment';
  }

  get showRecurrenceFrequencyField(): boolean {
    return this.supportsRecurrence && this.launchForm.recurrenceKind !== 'single';
  }

  get showDailyRecurrenceKindField(): boolean {
    return this.isDailyFormOpen && !this.isEditingSingleLaunch && this.dailyForm.repeatMode !== 'none';
  }

  get showDailyInstallmentsField(): boolean {
    return this.showDailyRecurrenceKindField && this.dailyForm.recurrenceKind === 'installment';
  }

  get recurrencePreviewText(): string {
    if (this.isDailyFormOpen) {
      if (!this.dailyForm.effectiveDate || !this.monthDefinitions.length) {
        return this.isEditingLaunch
          ? 'Edicao ativa: ajuste o valor e a data de inicio deste diario.'
          : 'Defina valor e data para aplicar o diario dali em diante.';
      }

      const parsedDate = new Date(`${this.dailyForm.effectiveDate}T00:00:00`);
      if (Number.isNaN(parsedDate.getTime())) {
        return 'A data selecionada para o diario e invalida.';
      }

      const startIndex = this.findMonthIndex(parsedDate.getFullYear(), parsedDate.getMonth() + 1);
      if (startIndex < 0) {
        return 'A data selecionada esta fora dos meses carregados.';
      }

      const recurrenceKind = this.getDailyRecurrenceKind();
      const repeatMode = this.getDailyRepeatMode();
      const installments = this.showDailyInstallmentsField ? this.dailyForm.installments : 1;

      if (recurrenceKind === 'single' || !repeatMode) {
        return `O diario sera aplicado apenas no dia ${parsedDate.getDate()}.`;
      }

      const preview = this.buildRecurrencePreview(parsedDate, recurrenceKind, repeatMode, installments);
      if (!preview || preview.occurrences <= 0) {
        return 'Nenhum diario sera criado com as regras atuais.';
      }

      const first = this.formatMonthRef(preview.firstMonthIndex);
      const last = this.formatMonthRef(preview.lastMonthIndex);

      if (preview.occurrences === 1) {
        return `Vai criar 1 ponto de inicio para o diario em ${first}.`;
      }

      return `Vai criar ${preview.occurrences} pontos de inicio para o diario entre ${first} e ${last}.`;
    }

    if (this.isEditingSeries) {
      if (!this.launchForm.date || !this.monthDefinitions.length) {
        return 'Edicao ativa: as alteracoes valem para toda a serie.';
      }
    }

    if (this.isEditingSingleLaunch) {
      return 'Edicao ativa: as alteracoes valem somente para este lancamento.';
    }

    if (!this.launchForm.date || !this.monthDefinitions.length) {
      return '';
    }

    const parsedDate = new Date(`${this.launchForm.date}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      return '';
    }

    const startIndex = this.findMonthIndex(parsedDate.getFullYear(), parsedDate.getMonth() + 1);
    if (startIndex < 0) {
      return 'A data selecionada esta fora dos meses carregados.';
    }

    const installments = this.showInstallmentsField ? this.launchForm.installments : 1;
    const preview = this.buildRecurrencePreview(
      parsedDate,
      this.launchForm.recurrenceKind,
      this.launchForm.repeatMode,
      installments
    );

    if (!preview || preview.occurrences <= 0) {
      return 'Nenhum lancamento sera criado com as regras atuais.';
    }

    const first = this.formatMonthRef(preview.firstMonthIndex);
    const last = this.formatMonthRef(preview.lastMonthIndex);
    const isInstallment = this.launchForm.recurrenceKind === 'installment';
    const isFixedSeries = this.launchForm.recurrenceKind === 'fixed';
    const valueStr = this.formatCurrency(this.launchForm.amount || 0);

    if (preview.occurrences === 1) {
      return `Vai criar 1 lancamento em ${first}.`;
    }

    if (isInstallment) {
      return `Vai criar ${preview.occurrences} parcelas de ${valueStr} cada entre ${first} e ${last}. O valor inserido ja e o valor de cada parcela.`;
    }

    if (isFixedSeries) {
      return `Vai criar lancamentos recorrentes de ${valueStr} entre ${first} e ${last}. A serie continua nos novos meses ate voce excluir.`;
    }

    return `Vai criar ${preview.occurrences} lancamentos de ${valueStr} entre ${first} e ${last}.`;
  }

  get launchDecisionAdvice(): LaunchDecisionAdvice | null {
    if (this.isDailyFormOpen || this.isEditingLaunch) {
      return null;
    }

    if (!this.launchForm.date || !this.monthDefinitions.length) {
      return null;
    }

    if (this.launchForm.amount === null || Number.isNaN(this.launchForm.amount) || this.launchForm.amount <= 0) {
      return null;
    }

    const parsedDate = new Date(`${this.launchForm.date}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    const startIndex = this.findMonthIndex(parsedDate.getFullYear(), parsedDate.getMonth() + 1);
    if (startIndex < 0) {
      return null;
    }

    const installments = this.showInstallmentsField ? this.launchForm.installments : 1;
    const scenarioMonths = this.cloneMonthDefinitions(this.monthDefinitions);
    const touchedMonths = this.applyRecurringLaunchesToDefinitions(
      scenarioMonths,
      parsedDate,
      this.launchForm.type,
      Number(this.launchForm.amount.toFixed(2)),
      this.normalizeText(this.launchForm.label.trim()) || this.defaultLabelForType(this.launchForm.type),
      this.launchForm.recurrenceKind,
      this.launchForm.repeatMode,
      installments
    );

    if (!touchedMonths.length) {
      return null;
    }

    const currentSummaries = this.monthSummaries;
    const scenarioSummaries = this.buildMonthSummariesFor(scenarioMonths);

    // Encontrar primeiro dia no vermelho em cada cenário
    const findFirstRedDay = (summaries: MonthSummary[]): { day: string; balance: number } | null => {
      for (const month of summaries) {
        const redDay = month.projection.find((day) => day.closingBalance < 0);
        if (redDay) {
          return { day: `${redDay.day} de ${month.title}`, balance: redDay.closingBalance };
        }
      }
      return null;
    };

    const currentRed = findFirstRedDay(currentSummaries);
    const scenarioRed = findFirstRedDay(scenarioSummaries);

    const currentWorst = currentSummaries.length
      ? Math.min(...currentSummaries.flatMap((month) => month.projection.map((day) => day.closingBalance)))
      : 0;
    const scenarioWorst = scenarioSummaries.length
      ? Math.min(...scenarioSummaries.flatMap((month) => month.projection.map((day) => day.closingBalance)))
      : 0;
    const worstDelta = Number((scenarioWorst - currentWorst).toFixed(2));

    // Encontrar melhor saldo após o lançamento (se voltou a positivo)
    const launchDateObj = new Date(`${this.launchForm.date}T00:00:00`);
    const findBestAfterLaunch = (summaries: MonthSummary[]): number => {
      let best = 0;
      let foundLaunch = false;
      for (const month of summaries) {
        for (const day of month.projection) {
          const dayDate = new Date(month.year, month.monthNumber - 1, day.day);
          if (!foundLaunch && dayDate >= launchDateObj) {
            foundLaunch = true;
          }
          if (foundLaunch && day.closingBalance > best) {
            best = day.closingBalance;
          }
        }
      }
      return best;
    };

    const bestAfterLaunch = findBestAfterLaunch(scenarioSummaries);

    // Encontrar saldo no dia específico do lançamento (ANTES de aplicar)
    const findDayBalance = (summaries: MonthSummary[], date: Date): number | null => {
      for (const month of summaries) {
        if (month.year === date.getFullYear() && month.monthNumber === date.getMonth() + 1) {
          const day = month.projection.find((d) => d.day === date.getDate());
          return day ? day.closingBalance : null;
        }
      }
      return null;
    };

    const currentDayBalance = findDayBalance(currentSummaries, parsedDate);

    // Encontrar próximo dia com saldo bom (>500) após o lançamento
    const findNextGoodDay = (summaries: MonthSummary[], afterDate: Date): { day: string; balance: number } | null => {
      for (const month of summaries) {
        for (const day of month.projection) {
          const dayDate = new Date(month.year, month.monthNumber - 1, day.day);
          if (dayDate > afterDate && day.closingBalance > 500) {
            return { day: `${day.day} de ${month.title}`, balance: day.closingBalance };
          }
        }
      }
      return null;
    };

    // Casos de entrada (income)
    if (this.launchForm.type === 'income') {
      if (scenarioWorst > currentWorst) {
        return {
          tone: 'good',
          title: 'Essa entrada reforça o caixa',
          summary: `Melhora o menor saldo previsto em ${this.formatCurrency(worstDelta)}.`,
          detail: !scenarioRed
            ? 'Depois dela, a janela fica sem pontos de aperto.'
            : `Reduz o tempo em vermelho. O primeiro dia crítico fica em ${scenarioRed.day}.`
        };
      }
      return null;
    }

    // Casos de despesa (expense) ou investimento (investment)

    // SUPER IMPORTANTE: Verificar o saldo do DIA do lançamento
    if (currentDayBalance !== null && currentDayBalance < 0) {
      // Está no vermelho naquele dia - é péssimo fazer ali
      const nextGood = findNextGoodDay(currentSummaries, parsedDate);
      return {
        tone: 'risk',
        title: 'Pessimo dia pra fazer essa despesa',
        summary: `No dia ${parsedDate.getDate()}, o saldo ja esta em ${this.formatCurrency(currentDayBalance)}.`,
        detail: nextGood
          ? `Melhor esperar até ${nextGood.day}, quando o saldo fica em ${this.formatCurrency(nextGood.balance)}.`
          : `Seu caixa fica no vermelho nesse período. Espere uma entrada.`
      };
    }

    // Saldo do dia está muito apertado (0 a 250)
    if (currentDayBalance !== null && currentDayBalance >= 0 && currentDayBalance < 250) {
      const nextGood = findNextGoodDay(currentSummaries, parsedDate);
      return {
        tone: 'warn',
        title: 'Dia muito apertado pra essa compra',
        summary: `No dia ${parsedDate.getDate()}, o saldo fica em apenas ${this.formatCurrency(currentDayBalance)}.`,
        detail: nextGood
          ? `Prefere esperar? No dia ${nextGood.day} o saldo fica em ${this.formatCurrency(nextGood.balance)}.`
          : `Tem pouca folga nesse dia. Vale acompanhar de perto.`
      };
    }

    // Saldo do dia é BOM (>1000) - não importa dias vermelhos no passado
    if (currentDayBalance !== null && currentDayBalance > 1000) {
      // Mas se é parcelado de valor alto, precisa checar o impacto global
      if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
        const monthlyInstallment = Number((this.launchForm.amount / installments).toFixed(2));
        
        // Se as parcelas reduzem MAS tem impacto significativo, avisar
        if (worstDelta < -1000) {
          return {
            tone: 'warn',
            title: 'Parcelado reduz bastante no futuro',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada mês.`,
            detail: `O menor saldo da janela cai ${this.formatCurrency(Math.abs(worstDelta))} nos próximos meses. Sustentavel, mas aperta.`
          };
        }

        // Se fica negativo em algum ponto, é risco
        if (scenarioWorst < 0) {
          return {
            tone: 'risk',
            title: 'Parcelado quebra o caixa nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica no vermelho em algum ponto. Reduz a quantidade ou o valor?`
          };
        }
      }

      return {
        tone: 'good',
        title: 'Essa compra e tranquila nesse dia',
        summary: `No dia ${parsedDate.getDate()}, o saldo esta em ${this.formatCurrency(currentDayBalance)}.`,
        detail: `Tem folga confortavel. Segue firme com a compra.`
      };
    }

    // Saldo do dia é positivo e razoável (250 a 1000)
    if (currentDayBalance !== null && currentDayBalance >= 250 && currentDayBalance <= 1000) {
      // Se é parcelado, avaliar impacto nos próximos meses
      if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
        const monthlyInstallment = Number((this.launchForm.amount / installments).toFixed(2));
        
        // Se fica negativo, é risco
        if (scenarioWorst < 0) {
          return {
            tone: 'risk',
            title: 'Parcelado quebra o caixa nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica no vermelho. Reduz a quantidade ou o valor?`
          };
        }

        // Se reduz muito, é atenção
        if (worstDelta < -500) {
          return {
            tone: 'warn',
            title: 'Parcelado aperta nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica bem apertado depois. Tem entrada vindo?`
          };
        }
      }

      return {
        tone: 'good',
        title: 'Essa compra cabe bem nesse dia',
        summary: `No dia ${parsedDate.getDate()}, o saldo esta em ${this.formatCurrency(currentDayBalance)}.`,
        detail: `Positivo e com margem. Voce pode fazer a compra tranquilo.`
      };
    }

    // Cenário 1: Despesa cria novo dia no vermelho que antes não existia
    if (!currentRed && scenarioRed) {
      const bestAfter = bestAfterLaunch;
      if (bestAfter > 2000) {
        // Volta bem depois
        return {
          tone: 'warn',
          title: 'Essa despesa aperta, mas volta rápido',
          summary: `Você fica no vermelho em ${scenarioRed.day} com saldo de ${this.formatCurrency(scenarioRed.balance)}.`,
          detail: `Mas depois volta a ${this.formatCurrency(bestAfter)}. E uma situacao temporaria.`
        };
      }
      // Fica vermelho e não volta bem
      return {
        tone: 'risk',
        title: 'Essa despesa quebra o fluxo',
        summary: `Você fica no vermelho em ${scenarioRed.day}.`,
        detail: `Depois disso o saldo fica em torno de ${this.formatCurrency(bestAfter)}. Prefere remarcar ou buscar uma entrada?`
      };
    }

    // Cenário 2: Já tinha dia vermelho, despesa piora a situação
    if (currentRed && scenarioRed) {
      // Piora significativamente
      if (worstDelta < -500) {
        return {
          tone: 'risk',
          title: 'Essa despesa aperta muito',
          summary: `Já existem dias em vermelho. Essa ainda reduz mais o saldo em ${this.formatCurrency(Math.abs(worstDelta))}.`,
          detail: `O pior fica em ${this.formatCurrency(scenarioWorst)}. Tem entrada vindo que regularize?`
        };
      }

      // Se lançamento é DEPOIS do dia vermelho e volta bem
      const launchAfterRed = launchDateObj > new Date(currentRed.day);
      if (launchAfterRed && bestAfterLaunch > 2000) {
        return {
          tone: 'good',
          title: 'Você coloca isso depois dos dias criticos',
          summary: `Os dias em vermelho ja estao agendados (${currentRed.day}).`,
          detail: `Seu lancamento no dia 25 e depois disso, e o caixa volta pra ${this.formatCurrency(bestAfterLaunch)}. Tranquilo.`
        };
      }

      // Já tinha vermelho, não piora muito
      return {
        tone: 'warn',
        title: 'Ja tem dias comprometidos no horizonte',
        summary: `O primeiro fica em ${currentRed.day} com saldo de ${this.formatCurrency(currentRed.balance)}.`,
        detail: `Essa despesa piora um pouco mais. Mas se ja esta planejando, segue o plano.`
      };
    }

    // Cenário 3: Não tem vermelho em nenhum cenário
    if (scenarioWorst < 0) {
      return {
        tone: 'risk',
        title: 'Essa despesa quebra o fluxo',
        summary: `Derruba o menor saldo para ${this.formatCurrency(scenarioWorst)}.`,
        detail: `Isso cria uma situacao de deficit. Prefere remarcar ou buscar uma entrada antes?`
      };
    }

    if (scenarioWorst < -1000) {
      return {
        tone: 'risk',
        title: 'Essa despesa aperta muito',
        summary: `O caixa cai para ${this.formatCurrency(scenarioWorst)}.`,
        detail: `Um deficit grande assim pode criar problemas. Vale a pena esperar uma entrada?`
      };
    }

    // Atenção: reduz folga significativa
    if (worstDelta < -500) {
      return {
        tone: 'warn',
        title: 'Essa despesa aperta o caixa',
        summary: `Reduz o menor saldo em ${this.formatCurrency(Math.abs(worstDelta))}.`,
        detail: `Depois dela o saldo minimo fica em ${this.formatCurrency(scenarioWorst)}. Tem folga, mas pouca.`
      };
    }

    // Atenção: despesa parcelada
    if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
      return {
        tone: 'warn',
        title: 'Essa despesa e parcelada',
        summary: `${installments} parcelas de ${this.formatCurrency(this.launchForm.amount)} cada.`,
        detail: `Lembre de levar em conta as outras ${installments - 1} proximas no planejamento.`
      };
    }

    // Confortável
    if (scenarioWorst > 500) {
      return {
        tone: 'good',
        title: 'Essa despesa e tranquila',
        summary: `Cabe bem no caixa atual.`,
        detail: `O menor saldo continua confortavel em ${this.formatCurrency(scenarioWorst)}.`
      };
    }

    // Seguro, mas com pouca folga
    if (scenarioWorst > 0) {
      return {
        tone: 'warn',
        title: 'Essa despesa deixa pouca folga',
        summary: `O menor saldo fica em ${this.formatCurrency(scenarioWorst)}.`,
        detail: `E positivo, mas vale acompanhar o caixa depois.`
      };
    }

    return null;
  }

  formatCurrency(value: number): string {
    return this.currencyFormatter.format(value);
  }

  getMonthPerformance(month: MonthSummary): number {
    return Number((month.closingBalance - month.openingBalance).toFixed(2));
  }

  getMonthDailyAverage(month: MonthSummary): number {
    const days = new Date(month.year, month.monthNumber, 0).getDate();
    if (days <= 0) {
      return 0;
    }

    return Number((month.totalFixedCosts / days).toFixed(2));
  }

  getMonthTotalOutflow(month: MonthSummary): number {
    return month.totalExpenses + month.totalInvestments + month.totalFixedCosts;
  }

  getMonthOutflowRiskClass(month: MonthSummary): string {
    const outflow = this.getMonthTotalOutflow(month);
    const income = month.totalIncome;

    if (outflow <= 0) {
      return 'ledger-outflow--ok';
    }

    if (income <= 0) {
      return 'ledger-outflow--danger';
    }

    const ratio = outflow / income;

    if (ratio >= 0.9) {
      return 'ledger-outflow--danger';
    }

    if (ratio >= 0.7) {
      return 'ledger-outflow--warn';
    }

    return 'ledger-outflow--ok';
  }

  getDayDetailCount(day: DayProjection): number {
    return day.notes.length + day.cardInvoiceForecasts.length;
  }

  getCardInvoiceForecastLabel(forecast: CardInvoiceForecast): string {
    const launchLabel = forecast.launchesCount === 1 ? '1 compra' : `${forecast.launchesCount} compras`;
    return `Fatura prevista ${forecast.cardName}: ${this.formatCurrency(forecast.amount)} (${launchLabel})`;
  }

  isPayingInvoice(cardId: string, year: number, monthNumber: number): boolean {
    return this.payingInvoiceKeys.has(`${cardId}-${year}-${monthNumber}`);
  }

  payCardInvoiceForecast(cardId: string, year: number, monthNumber: number): void {
    const key = `${cardId}-${year}-${monthNumber}`;
    if (this.payingInvoiceKeys.has(key)) return;

    const card = this.cards.find((c) => String(c.id) === cardId);
    if (!card) return;

    const toUpdate = this.cardLaunches.filter((l) => {
      if (String(l.cardId) !== cardId || l.paid) return false;
      const inv = this.getCardInvoiceMonthForDate(l.date, card);
      return inv.year === year && inv.month === monthNumber;
    });

    if (!toUpdate.length) return;

    this.payingInvoiceKeys.add(key);
    const today = new Date().toISOString().split('T')[0];

    forkJoin(
      toUpdate.map((l) => this.financeApi.updateCardLaunch({ ...l, paid: true, paidAt: today }))
    ).subscribe({
      next: (updated) => {
        this.payingInvoiceKeys.delete(key);
        updated.forEach((u) => {
          const idx = this.cardLaunches.findIndex((l) => String(l.id) === String(u.id));
          if (idx >= 0) this.cardLaunches[idx] = u;
        });
      },
      error: () => {
        this.payingInvoiceKeys.delete(key);
      }
    });
  }

  getBalanceClass(balance: number): string {
    if (balance < 0) return 'ledger-balance--negative';
    if (balance === 0) return '';
    if (balance <= 1000) return 'ledger-balance--low';
    if (balance <= 2000) return 'ledger-balance--mid';
    return 'ledger-balance--high';
  }

  get isEditingLaunch(): boolean {
    return this.isEditingSingleLaunch || this.isEditingSeries;
  }

  get isEditingSingleLaunch(): boolean {
    return !!this.editingEventId && this.editingScope === 'single';
  }

  get isEditingForwardLaunch(): boolean {
    return !!this.editingSeriesId && this.editingScope === 'forward';
  }

  get isEditingSeries(): boolean {
    return !!this.editingSeriesId && this.editingScope === 'series';
  }

  get launchModalTitle(): string {
    return this.isEditingLaunch ? 'Editar lancamento' : 'Novo lancamento';
  }

  get dailyModalTitle(): string {
    return this.isEditingLaunch ? 'Editar diario' : 'Novo diario';
  }

  get seriesActionTitle(): string {
    if (!this.pendingEventAction) {
      return 'Recorrencia';
    }

    const actionLabel = this.pendingEventAction.type === 'edit' ? 'Editar' : 'Excluir';
    const targetLabel = this.pendingEventAction.event.type === 'daily' ? 'serie de diario' : 'recorrencia';
    return `${actionLabel} ${targetLabel}`;
  }

  get seriesActionDescription(): string {
    if (!this.pendingEventAction) {
      return 'Escolha se a acao vale apenas para este item ou para toda a serie.';
    }

    if (this.pendingEventAction.type === 'delete') {
      if (this.pendingEventAction.event.type === 'daily') {
        return 'Esse diario faz parte de uma serie. Voce quer excluir so este, este e os proximos, ou toda a serie deste diario?';
      }

      return 'Esse lancamento faz parte de uma serie. Voce quer excluir so este, este e os proximos, ou toda a serie?';
    }

    if (this.pendingEventAction.type === 'edit') {
      if (this.pendingEventAction.event.type === 'daily') {
        return 'Esse diario faz parte de uma serie. Voce quer editar so este, este e os proximos, ou toda a serie deste diario?';
      }

      return 'Esse lancamento faz parte de uma serie. Voce quer editar so este, este e os proximos, ou toda a serie?';
    }

    if (this.pendingEventAction.event.type === 'daily') {
      return 'Esse diario faz parte de uma serie. Voce quer aplicar a acao so neste diario ou em toda a serie deste diario?';
    }

    return 'Esse lancamento faz parte de uma serie. Voce quer aplicar a acao so neste lancamento ou em toda a serie?';
  }

  get deleteConfirmationTitle(): string {
    if (!this.pendingDeleteConfirmation) {
      return 'Confirmar exclusao';
    }

    const isDaily = this.pendingDeleteConfirmation.event.type === 'daily';
    const isSeries = this.pendingDeleteConfirmation.scope === 'series';
    const isForward = this.pendingDeleteConfirmation.scope === 'forward';

    if (isDaily && isSeries) {
      return 'Excluir serie de diario';
    }

    if (isDaily && isForward) {
      return 'Excluir diario e proximos';
    }

    if (isDaily) {
      return 'Excluir diario';
    }

    if (isForward) {
      return 'Excluir lancamento e proximos';
    }

    return isSeries ? 'Excluir serie de lancamentos' : 'Excluir lancamento';
  }

  get deleteConfirmationDescription(): string {
    if (!this.pendingDeleteConfirmation) {
      return 'Confirme a exclusao.';
    }

    const { event, scope } = this.pendingDeleteConfirmation;
    const isDaily = event.type === 'daily';

    if (isDaily && scope === 'series') {
      return 'Voce vai excluir toda a serie deste diario. Essa acao nao pode ser desfeita.';
    }

    if (isDaily && scope === 'forward') {
      return 'Voce vai excluir este diario e todos os proximos dessa recorrencia. Os diarios anteriores serao mantidos.';
    }

    if (scope === 'forward') {
      return 'Voce vai excluir este lancamento e todos os proximos dessa recorrencia. Os lancamentos anteriores serao mantidos.';
    }

    if (isDaily) {
      return 'Voce vai excluir este diario. Essa acao nao pode ser desfeita.';
    }

    if (scope === 'series') {
      return 'Voce vai excluir toda a serie deste lancamento. Essa acao nao pode ser desfeita.';
    }

    return 'Voce vai excluir este lancamento. Essa acao nao pode ser desfeita.';
  }

  get manualLaunchTypeOptions(): Array<{ value: LaunchType; label: string }> {
    return this.launchTypeOptions.filter((option) => option.value !== 'daily');
  }

  setActiveTab(tab: AppTab): void {
    this.activeTab = tab;
  }

  retryLoadData(): void {
    this.loadMonths();
  }

  isDeletingEvent(eventId?: string): boolean {
    return !!eventId && this.deletingEventIds.has(eventId);
  }

  canTogglePaid(event: FinancialEvent): boolean {
    return event.type === 'expense';
  }

  isEventPaid(event: FinancialEvent): boolean {
    return !!event.paid;
  }

  isPayingEvent(eventId?: string): boolean {
    return !!eventId && this.payingEventIds.has(eventId);
  }

  isDayFullyPaid(day: DayProjection): boolean {
    const payableEvents = day.events.filter((event) => this.canTogglePaid(event));
    if (!payableEvents.length) {
      return false;
    }

    return payableEvents.every((event) => this.isEventPaid(event));
  }

  toggleEventPaid(monthKey: string, event: FinancialEvent): void {
    if (!event.id || !this.canTogglePaid(event) || this.isPayingEvent(event.id) || this.isDeletingEvent(event.id)) {
      return;
    }

    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month) {
      return;
    }

    const eventId = event.id;
    const previousEvents = [...month.events];
    const paid = !event.paid;
    const paidAt = paid ? this.getTodayInputDate() : undefined;

    month.events = month.events.map((item) => {
      if (item.id !== eventId) {
        return item;
      }

      return {
        ...item,
        paid,
        paidAt,
      };
    });
    this.refreshActiveDayDetails();

    this.payingEventIds.add(eventId);
    this.entriesFeedback = '';

    this.financeApi.updateMonth(month).subscribe({
      next: () => {
        this.payingEventIds.delete(eventId);
        this.refreshActiveDayDetails();
      },
      error: () => {
        month.events = previousEvents;
        this.payingEventIds.delete(eventId);
        this.refreshActiveDayDetails();
        this.entriesFeedback = 'Nao foi possivel atualizar o status de pagamento do lancamento.';
      }
    });
  }

  describeEvent(event: FinancialEvent, monthKey?: string): string {
    const label = this.normalizeText(event.label);
    const amount = this.formatCurrency(event.amount);
    const installmentRef = this.getInstallmentReference(event, monthKey);

    if (installmentRef) {
      return `${label} ${installmentRef}: ${amount}`;
    }

    return `${label}: ${amount}`;
  }

  getEventTypeLabel(type: EventType): string {
    switch (type) {
      case 'income':
        return 'Entrada';
      case 'expense':
        return 'Saida';
      case 'investment':
        return 'Investido';
      case 'daily':
        return 'Diario';
      default:
        return 'Tipo';
    }
  }

  getEventTypeIcon(type: EventType): string {
    switch (type) {
      case 'income':
        return '↑';
      case 'expense':
        return '↓';
      case 'investment':
        return '◆';
      case 'daily':
        return '●';
      default:
        return '•';
    }
  }

  trackMonthBy(_index: number, month: MonthSummary): string {
    return month.key;
  }

  trackDayBy(_index: number, day: DayProjection): number {
    return day.day;
  }

  trackEventBy(index: number, event: FinancialEvent): string {
    if (event.id) {
      return event.id;
    }

    return `${event.seriesId ?? 'evt'}-${event.day}-${event.amount}-${event.type}-${index}`;
  }

  hasSeries(event: FinancialEvent): boolean {
    return !!event.seriesId && event.recurrenceKind !== 'single';
  }

  openEventActionPrompt(type: 'edit' | 'delete', monthKey: string, event: FinancialEvent): void {
    if (!this.hasSeries(event)) {
      if (type === 'edit') {
        if (event.type === 'daily') {
          this.openEditDailyForm(monthKey, event, 'single');
        } else {
          this.openEditLaunchForm(monthKey, event, 'single');
        }
      } else {
        this.deleteEvent(monthKey, event.id, 'single');
      }
      return;
    }

    this.pendingEventAction = { type, monthKey, event };
  }

  closeEventActionPrompt(): void {
    this.pendingEventAction = null;
  }

  closeDeleteConfirmation(): void {
    this.pendingDeleteConfirmation = null;
  }

  confirmEventActionScope(scope: DeleteActionScope): void {
    if (!this.pendingEventAction) {
      return;
    }

    const { type, monthKey, event } = this.pendingEventAction;
    this.pendingEventAction = null;

    if (type === 'edit') {
      if (scope === 'forward') {
        if (event.type === 'daily') {
          this.openEditDailyForm(monthKey, event, 'forward');
        } else {
          this.openEditLaunchForm(monthKey, event, 'forward');
        }
        return;
      }

      if (event.type === 'daily') {
        this.openEditDailyForm(monthKey, event, scope);
      } else {
        this.openEditLaunchForm(monthKey, event, scope);
      }
      return;
    }

    this.deleteEvent(monthKey, event.id, scope);
  }

  setViewMode(mode: 'custom' | '3month' | '12month'): void {
    this.viewMode = mode;

    if (mode === '12month') {
      const anchor = this.visibleMonths[0] ?? this.monthSummaries[0];
      this.twelveMonthYear = anchor?.year ?? new Date().getFullYear();
      this.ensureYearMonths(this.twelveMonthYear);
    }
  }

  toggleFabMenu(): void {
    this.isFabMenuOpen = !this.isFabMenuOpen;
  }

  openFabMenu(): void {
    this.isFabMenuOpen = true;
  }

  closeFabMenu(): void {
    this.isFabMenuOpen = false;
  }

  onDayNotesToggle(event: Event): void {
    const details = event.target as HTMLDetailsElement | null;
    if (!details) {
      return;
    }

    details.classList.remove('day-notes--upward');

    if (!details.open) {
      return;
    }

    const popover = details.querySelector('.day-notes-popover') as HTMLElement | null;
    if (!popover) {
      return;
    }

    const viewportPadding = 10;
    const downRect = popover.getBoundingClientRect();

    if (downRect.bottom + viewportPadding <= window.innerHeight) {
      return;
    }

    details.classList.add('day-notes--upward');
    const upRect = popover.getBoundingClientRect();

    // If opening upward would clip at the top, keep the default downward placement.
    if (upRect.top < viewportPadding) {
      details.classList.remove('day-notes--upward');
    }
  }

  openDayDetails(month: MonthSummary, day: DayProjection): void {
    this.activeDayDetails = { month, day };
  }

  closeDayDetails(): void {
    this.activeDayDetails = null;
  }

  getDayDetailsTitle(month: MonthSummary, day: DayProjection): string {
    return `${day.day} de ${month.title} de ${month.year}`;
  }

  private refreshActiveDayDetails(): void {
    if (!this.activeDayDetails) {
      return;
    }

    const currentMonth = this.monthSummaries.find((month) => month.key === this.activeDayDetails?.month.key);
    const currentDay = currentMonth?.projection.find((day) => day.day === this.activeDayDetails?.day.day);

    if (!currentMonth || !currentDay) {
      this.activeDayDetails = null;
      return;
    }

    this.activeDayDetails = {
      month: currentMonth,
      day: currentDay,
    };
  }

  goToCurrentMonth(): void {
    const today = new Date();
    const currentMonthIndex = this.findMonthIndex(today.getFullYear(), today.getMonth() + 1);

    if (currentMonthIndex < 0) {
      return;
    }

    if (this.viewMode === 'custom') {
      this.customStartIndex = currentMonthIndex;
      this.customEndIndex = currentMonthIndex;
      return;
    }

    if (this.viewMode === '12month') {
      this.twelveMonthYear = today.getFullYear();
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    this.windowStartIndex = Math.floor(currentMonthIndex / this.windowSize) * this.windowSize;
  }

  isCurrentMonth(month: MonthSummary): boolean {
    const definition = this.monthDefinitions.find((item) => item.key === month.key);
    if (!definition) {
      return false;
    }

    const today = new Date();
    return definition.year === today.getFullYear() && definition.monthNumber === today.getMonth() + 1;
  }

  isCurrentDay(month: MonthSummary, day: number): boolean {
    if (!this.isCurrentMonth(month)) {
      return false;
    }

    return day === new Date().getDate();
  }

  onCustomStartChange(index: number): void {
    this.customStartIndex = +index;
    if (this.customEndIndex < this.customStartIndex) {
      this.customEndIndex = this.customStartIndex;
    }
  }

  onCustomEndChange(index: number): void {
    this.customEndIndex = Math.max(+index, this.customStartIndex);
  }

  goToPreviousWindow(): void {
    if (!this.canGoPrevious) {
      return;
    }

    if (this.viewMode === '12month') {
      this.twelveMonthYear -= 1;
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    const step = 3;
    this.windowStartIndex = Math.max(0, this.windowStartIndex - step);
  }

  goToNextWindow(): void {
    if (!this.canGoNext) {
      return;
    }

    if (this.viewMode === '12month') {
      this.twelveMonthYear += 1;
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    const step = 3;
    const visibleCount = this.windowSize;
    const requiredEnd = this.windowStartIndex + visibleCount + step;
    if (requiredEnd > this.monthSummaries.length) {
      this.ensureFutureMonths(requiredEnd - this.monthSummaries.length);
    }

    this.windowStartIndex += step;
  }

  openLaunchForm(): void {
    this.closeFabMenu();
    this.launchError = '';
    this.dailyError = '';
    this.entriesFeedback = '';
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
    this.launchForm = this.createEmptyLaunchForm();
    this.syncLaunchAmountInput();
    this.isLaunchFormOpen = true;
  }

  openDailyForm(): void {
    this.closeFabMenu();
    this.launchError = '';
    this.dailyError = '';
    this.entriesFeedback = '';
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
    this.dailyForm = this.createEmptyDailyForm();
    this.syncDailyAmountInput();
    this.isDailyFormOpen = true;
  }

  openCardLaunchForm(): void {
    this.closeFabMenu();
    this.cardsTab?.openLaunchModal();
  }

  onFaturaFechada(data: { amount: number; dueDate: string; description: string }): void {
    this.setActiveTab('entries');
    this.launchError = '';
    this.dailyError = '';
    this.entriesFeedback = '';
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
    this.launchForm = {
      type: 'expense',
      amount: data.amount,
      date: data.dueDate,
      label: data.description,
      recurrenceKind: 'single',
      repeatMode: 'monthly',
      installments: 1
    };
    this.syncLaunchAmountInput();
    this.isLaunchFormOpen = true;
  }

  openEditLaunchForm(monthKey: string, event: FinancialEvent, scope: EventActionScope): void {
    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month || !event.id) {
      return;
    }

    this.entriesFeedback = '';
    this.launchError = '';
    this.editingScope = scope;
    this.editingEventId = scope === 'single' ? event.id : null;
    this.editingSeriesId = scope !== 'single' ? event.seriesId ?? event.id : null;
    this.editingSourceMonthKey = monthKey;
    this.editingAnchorDay = event.day;
    this.launchForm = {
      type: event.type,
      amount: event.amount,
      date: this.toInputDate(month.year, month.monthNumber, event.day),
      label: event.label,
      recurrenceKind: scope !== 'single' ? event.recurrenceKind ?? 'single' : 'single',
      repeatMode: scope !== 'single' ? event.repeatMode ?? 'monthly' : 'monthly',
      installments: scope !== 'single' ? event.seriesOccurrences ?? 1 : 1
    };
    this.syncLaunchAmountInput();
    this.isLaunchFormOpen = true;
  }

  openEditDailyForm(monthKey: string, event: FinancialEvent, scope: EventActionScope): void {
    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month || !event.id) {
      return;
    }

    this.closeFabMenu();
    this.entriesFeedback = '';
    this.launchError = '';
    this.dailyError = '';
    this.editingScope = scope;
    this.editingEventId = scope === 'single' ? event.id : null;
    this.editingSeriesId = scope !== 'single' ? event.seriesId ?? event.id : null;
    this.editingSourceMonthKey = monthKey;
    this.editingAnchorDay = event.day;
    this.dailyForm = {
      amount: event.amount,
      effectiveDate: this.toInputDate(month.year, month.monthNumber, event.day),
      repeatMode: scope !== 'single' && (event.recurrenceKind ?? 'single') !== 'single' ? (event.repeatMode ?? 'monthly') : 'none',
      recurrenceKind: scope !== 'single' && (event.recurrenceKind ?? 'single') !== 'single' ? (event.recurrenceKind ?? 'fixed') : 'fixed',
      installments: scope !== 'single' && event.recurrenceKind === 'installment' ? (event.seriesOccurrences ?? 1) : 1
    };
    this.syncDailyAmountInput();
    this.isDailyFormOpen = true;
  }

  closeLaunchForm(): void {
    this.isLaunchFormOpen = false;
    this.launchError = '';
    this.saveAndNewLaunchRequested = false;
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
  }

  submitLaunchFormAndAddAnother(): void {
    if (this.isSavingLaunch || this.isEditingLaunch) {
      return;
    }

    this.saveAndNewLaunchRequested = true;
    this.submitLaunchForm();
  }

  closeDailyForm(): void {
    this.isDailyFormOpen = false;
    this.dailyError = '';
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
  }

  deleteEvent(monthKey: string, eventId?: string, scope: DeleteActionScope = 'single'): void {
    if (!eventId || this.deletingEventIds.has(eventId)) {
      return;
    }

    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    const event = month?.events.find((item) => item.id === eventId);
    if (!month || !event) {
      return;
    }

    this.pendingDeleteConfirmation = {
      monthKey,
      eventId,
      scope,
      event
    };
  }

  confirmDeleteEvent(): void {
    if (!this.pendingDeleteConfirmation) {
      return;
    }

    const { monthKey, eventId, scope, event } = this.pendingDeleteConfirmation;
    this.pendingDeleteConfirmation = null;

    if (scope === 'series' && event.seriesId) {
      this.deleteSeries(event.seriesId, eventId);
      return;
    }

    if (scope === 'forward' && event.seriesId) {
      this.deleteSeriesForward(monthKey, event, eventId);
      return;
    }

    this.performSingleDelete(monthKey, eventId, event.type);
  }

  private performSingleDelete(monthKey: string, eventId: string, eventType: EventType): void {
    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month) {
      return;
    }

    const previousEvents = [...month.events];
    const targetEvent = month.events.find((event) => event.id === eventId);
    if (!targetEvent) {
      return;
    }

    let hasChanged = false;

    if (eventType === 'daily' && targetEvent.seriesId && (targetEvent.recurrenceKind ?? 'single') !== 'single') {
      month.events = month.events.map((event) => {
        if (event.id !== eventId) {
          return event;
        }

        hasChanged = true;

        return {
          ...event,
          amount: 0,
          suppressed: true,
          dailyOccurrenceAction: 'skip'
        };
      });
    } else {
      month.events = month.events.filter((event) => event.id !== eventId);
      hasChanged = month.events.length !== previousEvents.length;
    }

    if (!hasChanged) {
      return;
    }

    this.entriesFeedback = '';
    this.deletingEventIds.add(eventId);

    this.financeApi.updateMonth(month).subscribe({
      next: () => {
        this.deletingEventIds.delete(eventId);
        this.entriesFeedback = eventType === 'daily' ? 'Diario removido.' : 'Lancamento removido.';
      },
      error: () => {
        month.events = previousEvents;
        this.deletingEventIds.delete(eventId);
        this.entriesFeedback = eventType === 'daily'
          ? 'Nao foi possivel excluir o diario. Confira o backend e tente novamente.'
          : 'Nao foi possivel excluir o lancamento. Confira o backend e tente novamente.';
      }
    });
  }

  submitLaunchForm(): void {
    if (this.isSavingLaunch) {
      return;
    }

    const keepOpenAfterSave = this.saveAndNewLaunchRequested && !this.isEditingLaunch;
    this.saveAndNewLaunchRequested = false;

    this.launchError = '';

    if (!this.launchForm.date) {
      this.launchError = 'Informe a data do lancamento.';
      return;
    }

    if (this.launchForm.amount === null || Number.isNaN(this.launchForm.amount) || this.launchForm.amount <= 0) {
      this.launchError = 'Informe um valor valido.';
      return;
    }

    const parsedDate = new Date(`${this.launchForm.date}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      this.launchError = 'Data invalida.';
      return;
    }

    const previewInstallments = this.showInstallmentsField ? this.launchForm.installments : 1;
    const recurrenceEndDate = this.computeRecurrenceEndDate(
      parsedDate,
      this.launchForm.recurrenceKind,
      this.launchForm.repeatMode,
      previewInstallments
    );
    this.ensureMonthsForDateRange(parsedDate, recurrenceEndDate);

    const year = parsedDate.getFullYear();
    const monthNumber = parsedDate.getMonth() + 1;
    const day = parsedDate.getDate();

    const targetMonth = this.monthDefinitions.find(
      (month) => month.year === year && month.monthNumber === monthNumber
    );

    if (!targetMonth) {
      this.launchError = 'A data esta fora dos 12 meses carregados na tela.';
      return;
    }

    const amount = Number(this.launchForm.amount.toFixed(2));
    const typedLabel = this.normalizeText(this.launchForm.label.trim());
    const label = typedLabel || this.defaultLabelForType(this.launchForm.type);

    if (this.isEditingSingleLaunch) {
      this.submitLaunchEdit(parsedDate, amount, label);
      return;
    }

    if (this.isEditingForwardLaunch) {
      this.submitForwardSeriesEdit(parsedDate, amount, label);
      return;
    }

    if (this.isEditingSeries) {
      this.submitSeriesEdit(parsedDate, amount, label);
      return;
    }

    if (this.showInstallmentsField && (!Number.isInteger(this.launchForm.installments) || this.launchForm.installments < 1)) {
      this.launchError = 'Informe uma quantidade de parcelas valida.';
      return;
    }

    this.isSavingLaunch = true;

    const recurrenceKind: RecurrenceKind = this.launchForm.recurrenceKind;
    const repeatMode = this.launchForm.repeatMode;
    const installments = this.showInstallmentsField ? this.launchForm.installments : 1;
    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      this.launchForm.type,
      amount,
      label,
      recurrenceKind,
      repeatMode,
      installments
    );

    if (!touchedMonths.length) {
      this.isSavingLaunch = false;
      this.launchError = 'Nao foi possivel aplicar a repeticao dentro dos meses carregados.';
      return;
    }

    forkJoin(touchedMonths.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        if (keepOpenAfterSave) {
          this.launchError = '';
          this.launchForm = this.createEmptyLaunchForm();
          this.syncLaunchAmountInput();
          return;
        }

        this.closeLaunchForm();
      },
      error: (err) => {
        console.error('[submitLaunchForm] Firestore error:', err);
        this.isSavingLaunch = false;
        this.launchError = 'Nao foi possivel salvar no backend. Confira se o servidor esta ativo.';
      }
    });
  }

  submitDailyForm(): void {
    if (this.isSavingLaunch) {
      return;
    }

    this.dailyError = '';

    if (!this.dailyForm.effectiveDate) {
      this.dailyError = 'Informe a data inicial do diario.';
      return;
    }

    if (this.dailyForm.amount === null || Number.isNaN(this.dailyForm.amount) || this.dailyForm.amount <= 0) {
      this.dailyError = 'Informe um valor valido para o diario.';
      return;
    }

    const parsedDate = new Date(`${this.dailyForm.effectiveDate}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      this.dailyError = 'Nao foi possivel identificar a data efetiva do diario.';
      return;
    }

    const targetMonth = this.monthDefinitions.find(
      (month) => month.year === parsedDate.getFullYear() && month.monthNumber === parsedDate.getMonth() + 1
    );

    if (!targetMonth) {
      this.dailyError = 'A data esta fora dos 12 meses carregados na tela.';
      return;
    }

    if (this.showDailyInstallmentsField && (!Number.isInteger(this.dailyForm.installments) || this.dailyForm.installments < 1)) {
      this.dailyError = 'Informe uma quantidade valida de repeticoes para o diario.';
      return;
    }

    const amount = Number(this.dailyForm.amount.toFixed(2));
    const recurrenceKind = this.getDailyRecurrenceKind();
    const repeatMode = this.getDailyRepeatMode();
    const installments = this.showDailyInstallmentsField ? this.dailyForm.installments : 1;

    if (this.isEditingSingleLaunch) {
      this.submitDailySingleEdit(parsedDate, amount);
      return;
    }

    if (this.isEditingForwardLaunch) {
      this.submitDailyForwardSeriesEdit(parsedDate, amount, recurrenceKind, repeatMode, installments);
      return;
    }

    if (this.isEditingSeries) {
      this.submitDailySeriesEdit(parsedDate, amount, recurrenceKind, repeatMode, installments);
      return;
    }

    this.isSavingLaunch = true;
    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      'daily',
      amount,
      'diario manual',
      recurrenceKind,
      repeatMode ?? 'monthly',
      installments
    );

    if (!touchedMonths.length) {
      this.isSavingLaunch = false;
      this.dailyError = 'Nao foi possivel aplicar o diario dentro dos meses carregados.';
      return;
    }

    forkJoin(touchedMonths.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Diario criado.';
        this.closeDailyForm();
      },
      error: () => {
        this.isSavingLaunch = false;
        this.dailyError = 'Nao foi possivel salvar o diario no backend.';
      }
    });
  }

  onLaunchTypeChange(type: LaunchType): void {
    this.launchForm.type = type;

    if (this.isEditingLaunch) {
      return;
    }

    this.launchForm.installments = 1;
  }

  onRecurrenceKindChange(kind: RecurrenceKind): void {
    if (this.isEditingLaunch) {
      return;
    }

    this.launchForm.recurrenceKind = kind;

    if (kind !== 'installment') {
      this.launchForm.installments = 1;
    }
  }

  onRepeatModeChange(mode: RepeatMode): void {
    if (this.isEditingLaunch) {
      return;
    }

    this.launchForm.repeatMode = mode;
  }


  onLaunchAmountInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.launchAmountInput = masked.display;
    this.launchForm.amount = masked.amount;
    this.cdr.markForCheck();
  }

  onDailyAmountInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.dailyAmountInput = masked.display;
    this.dailyForm.amount = masked.amount;
    this.cdr.markForCheck();
  }
  onDailyRepeatModeChange(mode: DailyRepeatSelection): void {
    if (this.isEditingSingleLaunch) {
      return;
    }

    this.dailyForm.repeatMode = mode;

    if (mode === 'none') {
      this.dailyForm.recurrenceKind = 'fixed';
      this.dailyForm.installments = 1;
    }
  }

  onDailyRecurrenceKindChange(kind: Exclude<RecurrenceKind, 'single'>): void {
    if (this.isEditingSingleLaunch) {
      return;
    }

    this.dailyForm.recurrenceKind = kind;

    if (kind !== 'installment') {
      this.dailyForm.installments = 1;
    }
  }

  private syncLaunchAmountInput(): void {
    this.launchAmountInput = this.launchForm.amount === null ? '' : this.formatCurrencyInput(this.launchForm.amount);
  }

  private syncDailyAmountInput(): void {
    this.dailyAmountInput = this.dailyForm.amount === null ? '' : this.formatCurrencyInput(this.dailyForm.amount);
  }

  private maskCurrencyFromDigits(rawValue: string): { display: string; amount: number | null } {
    const digits = (rawValue ?? '').replace(/\D/g, '');
    if (!digits) {
      return { display: '', amount: null };
    }

    const amount = Number((Number(digits) / 100).toFixed(2));
    return {
      display: this.formatCurrencyInput(amount),
      amount
    };
  }

  private formatCurrencyInput(value: number): string {
    return value.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  private submitLaunchEdit(parsedDate: Date, amount: number, label: string): void {
    if (!this.editingEventId || !this.editingSourceMonthKey) {
      this.launchError = 'Nao foi possivel identificar o lancamento para edicao.';
      return;
    }

    const sourceMonth = this.monthDefinitions.find((item) => item.key === this.editingSourceMonthKey);
    const targetMonth = this.monthDefinitions.find(
      (month) => month.year === parsedDate.getFullYear() && month.monthNumber === parsedDate.getMonth() + 1
    );

    if (!sourceMonth || !targetMonth) {
      this.launchError = 'A data esta fora dos 12 meses carregados na tela.';
      return;
    }

    const originalSourceEvents = [...sourceMonth.events];
    const originalTargetEvents = sourceMonth === targetMonth ? originalSourceEvents : [...targetMonth.events];
    const originalEvent = sourceMonth.events.find((event) => event.id === this.editingEventId);

    if (!originalEvent) {
      this.launchError = 'Lancamento nao encontrado para editar.';
      return;
    }

    sourceMonth.events = sourceMonth.events.filter((event) => event.id !== this.editingEventId);

    const updatedEvent: FinancialEvent = {
      ...originalEvent,
      day: parsedDate.getDate(),
      amount,
      label,
      type: this.launchForm.type
    };

    targetMonth.events = [...targetMonth.events, updatedEvent];

    const monthsToSave = sourceMonth === targetMonth ? [sourceMonth] : [sourceMonth, targetMonth];

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Lancamento atualizado.';
        this.closeLaunchForm();
      },
      error: () => {
        sourceMonth.events = originalSourceEvents;
        if (sourceMonth !== targetMonth) {
          targetMonth.events = originalTargetEvents;
        }
        this.isSavingLaunch = false;
        this.launchError = 'Nao foi possivel salvar a edicao no backend.';
      }
    });
  }

  private submitDailySingleEdit(parsedDate: Date, amount: number): void {
    if (!this.editingEventId || !this.editingSourceMonthKey) {
      this.dailyError = 'Nao foi possivel identificar o diario para edicao.';
      return;
    }

    const sourceMonth = this.monthDefinitions.find((item) => item.key === this.editingSourceMonthKey);
    const targetMonth = this.monthDefinitions.find(
      (month) => month.year === parsedDate.getFullYear() && month.monthNumber === parsedDate.getMonth() + 1
    );

    if (!sourceMonth || !targetMonth) {
      this.dailyError = 'A data esta fora dos 12 meses carregados na tela.';
      return;
    }

    const originalSourceEvents = [...sourceMonth.events];
    const originalTargetEvents = sourceMonth === targetMonth ? originalSourceEvents : [...targetMonth.events];
    const originalEvent = sourceMonth.events.find((event) => event.id === this.editingEventId);

    if (!originalEvent) {
      this.dailyError = 'Diario nao encontrado para editar.';
      return;
    }

    if (originalEvent.seriesId && (originalEvent.recurrenceKind ?? 'single') !== 'single') {
      sourceMonth.events = sourceMonth.events.map((event) => {
        if (event.id !== this.editingEventId) {
          return event;
        }

        return {
          ...event,
          amount,
          day: parsedDate.getDate(),
          suppressed: false,
          dailyOccurrenceAction: 'override'
        };
      });

      if (sourceMonth !== targetMonth) {
        const movedOverride = sourceMonth.events.find((event) => event.id === this.editingEventId);
        sourceMonth.events = sourceMonth.events.filter((event) => event.id !== this.editingEventId);
        if (movedOverride) {
          targetMonth.events = [...targetMonth.events, movedOverride];
        }
      }
    } else {
      sourceMonth.events = sourceMonth.events.filter((event) => event.id !== this.editingEventId);

      const updatedEvent: FinancialEvent = {
        ...originalEvent,
        day: parsedDate.getDate(),
        amount
      };

      targetMonth.events = [...targetMonth.events, updatedEvent];
    }

    const monthsToSave = sourceMonth === targetMonth ? [sourceMonth] : [sourceMonth, targetMonth];

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Diario atualizado.';
        this.closeDailyForm();
      },
      error: () => {
        sourceMonth.events = originalSourceEvents;
        if (sourceMonth !== targetMonth) {
          targetMonth.events = originalTargetEvents;
        }
        this.isSavingLaunch = false;
        this.dailyError = 'Nao foi possivel salvar a edicao do diario.';
      }
    });
  }

  private submitDailySeriesEdit(parsedDate: Date, amount: number, recurrenceKind: RecurrenceKind, repeatMode: RepeatMode | null, installments: number): void {
    if (!this.editingSeriesId) {
      this.dailyError = 'Nao foi possivel identificar a serie de diario.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const referenceEvent = this.findEventBySeriesId(this.editingSeriesId);
    if (!referenceEvent) {
      this.dailyError = 'Serie de diario nao encontrada.';
      return;
    }

    const backups = new Map<string, FinancialEvent[]>();
    for (const month of this.monthDefinitions) {
      const hasSeriesEvents = month.events.some((event) => event.seriesId === this.editingSeriesId);
      if (hasSeriesEvents) {
        backups.set(month.key, [...month.events]);
        month.events = month.events.filter((event) => event.seriesId !== this.editingSeriesId);
      }
    }

    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      'daily',
      amount,
      referenceEvent.label,
      recurrenceKind,
      repeatMode ?? 'monthly',
      recurrenceKind === 'installment' ? installments : 1,
      this.editingSeriesId
    );

    const monthsToSave = this.monthDefinitions.filter((month) => backups.has(month.key) || touchedMonths.some((item) => item.key === month.key));

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Serie de diario atualizada.';
        this.closeDailyForm();
      },
      error: () => {
        for (const [monthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === monthKey);
          if (month) {
            month.events = events;
          }
        }
        this.isSavingLaunch = false;
        this.dailyError = 'Nao foi possivel salvar a serie de diario.';
      }
    });
  }

  private submitDailyForwardSeriesEdit(parsedDate: Date, amount: number, recurrenceKind: RecurrenceKind, repeatMode: RepeatMode | null, installments: number): void {
    if (!this.editingSeriesId || !this.editingSourceMonthKey || this.editingAnchorDay === null) {
      this.dailyError = 'Nao foi possivel identificar a recorrencia de diario para edicao.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const referenceEvent = this.findEventBySeriesId(this.editingSeriesId);
    if (!referenceEvent) {
      this.dailyError = 'Serie de diario nao encontrada.';
      return;
    }

    const triggerMonthIndex = this.monthDefinitions.findIndex((month) => month.key === this.editingSourceMonthKey);
    if (triggerMonthIndex < 0) {
      this.dailyError = 'Nao foi possivel identificar o ponto inicial da edicao.';
      return;
    }

    const backups = new Map<string, FinancialEvent[]>();
    for (let monthIndex = triggerMonthIndex; monthIndex < this.monthDefinitions.length; monthIndex += 1) {
      const month = this.monthDefinitions[monthIndex];
      const previousEvents = [...month.events];
      const filteredEvents = month.events.filter((event) => {
        if (event.seriesId !== this.editingSeriesId) {
          return true;
        }

        if (monthIndex === triggerMonthIndex) {
          return event.day < anchorDay;
        }

        return false;
      });

      if (filteredEvents.length !== previousEvents.length) {
        backups.set(month.key, previousEvents);
        month.events = filteredEvents;
      }
    }

    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      'daily',
      amount,
      referenceEvent.label,
      recurrenceKind,
      repeatMode ?? 'monthly',
      recurrenceKind === 'installment' ? installments : 1,
      this.editingSeriesId
    );

    const monthsToSave = this.monthDefinitions.filter((month) => backups.has(month.key) || touchedMonths.some((item) => item.key === month.key));

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Este diario e os proximos foram atualizados.';
        this.closeDailyForm();
      },
      error: () => {
        for (const [monthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === monthKey);
          if (month) {
            month.events = events;
          }
        }
        this.isSavingLaunch = false;
        this.dailyError = 'Nao foi possivel salvar este diario e os proximos.';
      }
    });
  }

  private submitSeriesEdit(parsedDate: Date, amount: number, label: string): void {
    if (!this.editingSeriesId) {
      this.launchError = 'Nao foi possivel identificar a serie para edicao.';
      return;
    }

    const backups = new Map<string, FinancialEvent[]>();
    for (const month of this.monthDefinitions) {
      const hasSeriesEvents = month.events.some((event) => event.seriesId === this.editingSeriesId);
      if (hasSeriesEvents) {
        backups.set(month.key, [...month.events]);
        month.events = month.events.filter((event) => event.seriesId !== this.editingSeriesId);
      }
    }

    const installments = this.launchForm.recurrenceKind === 'installment' ? this.launchForm.installments : 1;
    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      this.launchForm.type,
      amount,
      label,
      this.launchForm.recurrenceKind,
      this.launchForm.repeatMode,
      installments,
      this.editingSeriesId
    );

    const monthsToSave = this.monthDefinitions.filter((month) => {
      const previous = backups.get(month.key);
      if (!previous) {
        return touchedMonths.some((item) => item.key === month.key);
      }

      return previous.length !== month.events.length || touchedMonths.some((item) => item.key === month.key);
    });

    if (!monthsToSave.length) {
      for (const [monthKey, events] of backups) {
        const month = this.monthDefinitions.find((item) => item.key === monthKey);
        if (month) {
          month.events = events;
        }
      }
      this.launchError = 'Nao foi possivel aplicar a edicao da serie.';
      return;
    }

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Serie atualizada.';
        this.closeLaunchForm();
      },
      error: () => {
        for (const [monthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === monthKey);
          if (month) {
            month.events = events;
          }
        }
        this.isSavingLaunch = false;
        this.launchError = 'Nao foi possivel salvar a serie no backend.';
      }
    });
  }

  private submitForwardSeriesEdit(parsedDate: Date, amount: number, label: string): void {
    if (!this.editingSeriesId || !this.editingSourceMonthKey || this.editingAnchorDay === null) {
      this.launchError = 'Nao foi possivel identificar a recorrencia para edicao.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const triggerMonthIndex = this.monthDefinitions.findIndex((month) => month.key === this.editingSourceMonthKey);
    if (triggerMonthIndex < 0) {
      this.launchError = 'Nao foi possivel identificar o ponto inicial da edicao.';
      return;
    }

    const backups = new Map<string, FinancialEvent[]>();
    for (let monthIndex = triggerMonthIndex; monthIndex < this.monthDefinitions.length; monthIndex += 1) {
      const month = this.monthDefinitions[monthIndex];
      const previousEvents = [...month.events];
      const filteredEvents = month.events.filter((event) => {
        if (event.seriesId !== this.editingSeriesId) {
          return true;
        }

        if (monthIndex === triggerMonthIndex) {
          return event.day < anchorDay;
        }

        return false;
      });

      if (filteredEvents.length !== previousEvents.length) {
        backups.set(month.key, previousEvents);
        month.events = filteredEvents;
      }
    }

    const installments = this.launchForm.recurrenceKind === 'installment' ? this.launchForm.installments : 1;
    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      this.launchForm.type,
      amount,
      label,
      this.launchForm.recurrenceKind,
      this.launchForm.repeatMode,
      installments,
      this.editingSeriesId
    );

    const monthsToSave = this.monthDefinitions.filter((month) => backups.has(month.key) || touchedMonths.some((item) => item.key === month.key));

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Este lancamento e os proximos foram atualizados.';
        this.closeLaunchForm();
      },
      error: () => {
        for (const [monthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === monthKey);
          if (month) {
            month.events = events;
          }
        }
        this.isSavingLaunch = false;
        this.launchError = 'Nao foi possivel salvar este lancamento e os proximos.';
      }
    });
  }

  private defaultLabelForType(type: LaunchType): string {
    if (type === 'income') {
      return 'entrada manual';
    }

    if (type === 'expense') {
      return 'saida manual';
    }

    if (type === 'investment') {
      return 'investimento manual';
    }

    return 'diario manual';
  }

  private createEmptyLaunchForm(): LaunchFormState {
    return {
      type: 'expense',
      amount: null,
      date: '',
      label: '',
      recurrenceKind: 'single',
      repeatMode: 'monthly',
      installments: 1
    };
  }

  private createEmptyDailyForm(): DailyFormState {
    return {
      amount: null,
      effectiveDate: this.getTodayInputDate(),
      repeatMode: 'none',
      recurrenceKind: 'fixed',
      installments: 1
    };
  }

  private getDailyRepeatMode(): RepeatMode | null {
    return this.dailyForm.repeatMode === 'none' ? null : this.dailyForm.repeatMode;
  }

  private getDailyRecurrenceKind(): RecurrenceKind {
    return this.dailyForm.repeatMode === 'none' ? 'single' : this.dailyForm.recurrenceKind;
  }

  private getTodayInputDate(): string {
    const today = new Date();
    return this.toInputDate(today.getFullYear(), today.getMonth() + 1, today.getDate());
  }

  private toInputDate(year: number, monthNumber: number, day: number): string {
    const month = String(monthNumber).padStart(2, '0');
    const safeDay = String(day).padStart(2, '0');
    return `${year}-${month}-${safeDay}`;
  }

  private loadMonths(): void {
    this.isLoading = true;
    this.dataError = '';

    this.financeApi.getMonths().subscribe({
      next: (months) => {
        const hadMonthsBefore = this.monthDefinitions.length > 0;

        this.monthDefinitions = this.normalizeMonths(months)
          .sort((a, b) => {
            if (a.year === b.year) {
              return a.monthNumber - b.monthNumber;
            }
            return a.year - b.year;
          })
          .reduce<MonthDefinition[]>((acc, month) => {
            const prev = acc[acc.length - 1];
            if (prev && prev.year === month.year && prev.monthNumber === month.monthNumber) {
              // Duplicata: manter o registro com mais eventos
              if (month.events.length > prev.events.length) {
                acc[acc.length - 1] = month;
              }
              return acc;
            }
            acc.push(month);
            return acc;
          }, []);

        if (!this.monthDefinitions.length) {
          if (this.currentUserId && this.seededMonthsUserId !== this.currentUserId) {
            this.seededMonthsUserId = this.currentUserId;
            const now = new Date();
            this.ensureMonthsForDateRange(now, this.getPlanningHorizonEndDate(now));
          }

          this.windowStartIndex = 0;
          this.customStartIndex = 0;
          this.customEndIndex = 0;
          this.isLoading = false;
          return;
        }

        this.ensurePlanningHorizonMonths();

        if (!hadMonthsBefore) {
          this.syncWindowToCurrentMonth();
        }

        this.isLoading = false;
      },
      error: () => {
        this.monthDefinitions = [];
        this.isLoading = false;
        this.dataError = 'Nao foi possivel carregar os dados do backend. Inicie o servidor local e tente novamente.';
      }
    });
  }

  private loadCardForecastData(): void {
    this.financeApi.getCards().subscribe({
      next: (cards) => {
        this.cards = cards;
      },
      error: () => {
        this.cards = [];
      }
    });

    this.financeApi.getCardLaunches().subscribe({
      next: (launches) => {
        this.cardLaunches = launches;
      },
      error: () => {
        this.cardLaunches = [];
      }
    });
  }

  private applyRecurringLaunches(
    startDate: Date,
    type: EventType,
    amount: number,
    label: string,
    recurrenceKind: RecurrenceKind,
    repeatMode: RepeatMode,
    installments: number,
    forcedSeriesId?: string
  ): MonthDefinition[] {
    const touched = new Map<string, MonthDefinition>();
    const startIndex = this.findMonthIndex(startDate.getFullYear(), startDate.getMonth() + 1);
    const seriesId = recurrenceKind === 'single' ? undefined : (forcedSeriesId ?? this.generateEventId());
    const seriesOccurrences = recurrenceKind === 'installment' ? installments : null;

    if (startIndex < 0) {
      return [];
    }

    const day = startDate.getDate();

    if (recurrenceKind === 'single') {
      this.pushEventToMonth(this.monthDefinitions[startIndex], this.createEvent(day, label, amount, type), touched);
      return Array.from(touched.values());
    }

    if (repeatMode === 'monthly') {
      const maxMonths = this.monthDefinitions.length - startIndex;
      const totalOccurrences = recurrenceKind === 'installment' ? Math.min(installments, maxMonths) : maxMonths;

      for (let offset = 0; offset < totalOccurrences; offset += 1) {
        this.pushEventToMonth(
          this.monthDefinitions[startIndex + offset],
          this.createEvent(day, label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences),
          touched
        );
      }

      return Array.from(touched.values());
    }

    const stepDays = repeatMode === 'weekly' ? 7 : 1;
    const lastMonth = this.monthDefinitions[this.monthDefinitions.length - 1];
    const endDate = new Date(lastMonth.year, lastMonth.monthNumber, 0);
    const cursor = new Date(startDate);
    let applied = 0;

    while (cursor <= endDate) {
      const monthIndex = this.findMonthIndex(cursor.getFullYear(), cursor.getMonth() + 1);
      if (monthIndex >= 0) {
        this.pushEventToMonth(
          this.monthDefinitions[monthIndex],
          this.createEvent(cursor.getDate(), label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences),
          touched
        );

        applied += 1;
        if (recurrenceKind === 'installment' && applied >= installments) {
          break;
        }
      }

      cursor.setDate(cursor.getDate() + stepDays);
    }

    return Array.from(touched.values());
  }

  private buildRecurrencePreview(
    startDate: Date,
    recurrenceKind: RecurrenceKind,
    repeatMode: RepeatMode,
    installments: number
  ): RecurrencePreview | null {
    const startIndex = this.findMonthIndex(startDate.getFullYear(), startDate.getMonth() + 1);
    if (startIndex < 0) {
      return null;
    }

    if (recurrenceKind === 'single') {
      return {
        occurrences: 1,
        firstMonthIndex: startIndex,
        lastMonthIndex: startIndex
      };
    }

    if (repeatMode === 'monthly') {
      const maxMonths = this.monthDefinitions.length - startIndex;
      const safeInstallments = Number.isInteger(installments) && installments > 0 ? installments : 1;
      const totalOccurrences = recurrenceKind === 'installment' ? Math.min(safeInstallments, maxMonths) : maxMonths;

      if (totalOccurrences <= 0) {
        return null;
      }

      return {
        occurrences: totalOccurrences,
        firstMonthIndex: startIndex,
        lastMonthIndex: startIndex + totalOccurrences - 1
      };
    }

    const stepDays = repeatMode === 'weekly' ? 7 : 1;
    const lastMonth = this.monthDefinitions[this.monthDefinitions.length - 1];
    const endDate = new Date(lastMonth.year, lastMonth.monthNumber, 0);
    const cursor = new Date(startDate);
    const maxOccurrences = recurrenceKind === 'installment' ? Math.max(1, installments) : Number.MAX_SAFE_INTEGER;
    let occurrences = 0;
    let firstTouched = -1;
    let lastTouched = -1;

    while (cursor <= endDate && occurrences < maxOccurrences) {
      const monthIndex = this.findMonthIndex(cursor.getFullYear(), cursor.getMonth() + 1);
      if (monthIndex >= 0) {
        occurrences += 1;
        if (firstTouched < 0) {
          firstTouched = monthIndex;
        }
        lastTouched = monthIndex;
      }

      cursor.setDate(cursor.getDate() + stepDays);
    }

    if (occurrences <= 0 || firstTouched < 0 || lastTouched < 0) {
      return null;
    }

    return {
      occurrences,
      firstMonthIndex: firstTouched,
      lastMonthIndex: lastTouched
    };
  }

  private formatMonthRef(monthIndex: number): string {
    const month = this.monthDefinitions[monthIndex];
    if (!month) {
      return 'mes indisponivel';
    }

    return `${month.title}/${month.year}`;
  }

  private ensureMonthsForDateRange(startDate: Date, endDate: Date): void {
    const created = this.ensureMonthsForDateRangeInMemory(startDate, endDate);
    if (!created.length) {
      return;
    }

    const propagated = this.propagateFixedMonthlySeriesToMonths(created);
    const monthsToPersistMap = new Map<string, MonthDefinition>();

    for (const month of [...created, ...propagated]) {
      monthsToPersistMap.set(month.key, month);
    }

    const monthsToPersist = Array.from(monthsToPersistMap.values());
    forkJoin(monthsToPersist.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Nao foi possivel persistir alguns meses futuros no backend.';
      }
    });
  }

  private ensureMonthsForDateRangeInMemory(startDate: Date, endDate: Date): MonthDefinition[] {
    const created: MonthDefinition[] = [];
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const limit = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    while (cursor <= limit) {
      const month = this.ensureMonthExists(cursor.getFullYear(), cursor.getMonth() + 1);
      if (month) {
        created.push(month);
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return created;
  }

  private ensurePlanningHorizonMonths(): void {
    if (!this.monthDefinitions.length) {
      return;
    }

    const now = new Date();
    const created = this.ensureMonthsForDateRangeInMemory(now, this.getPlanningHorizonEndDate(now));
    if (!created.length) {
      return;
    }

    const propagated = this.propagateFixedMonthlySeriesToMonths(created);
    const monthsToPersistMap = new Map<string, MonthDefinition>();

    for (const month of [...created, ...propagated]) {
      monthsToPersistMap.set(month.key, month);
    }

    const monthsToPersist = Array.from(monthsToPersistMap.values());
    forkJoin(monthsToPersist.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Nao foi possivel atualizar o horizonte de meses no backend.';
      }
    });
  }

  private propagateFixedMonthlySeriesToMonths(targetMonths: MonthDefinition[]): MonthDefinition[] {
    if (!targetMonths.length || !this.monthDefinitions.length) {
      return [];
    }

    const templateBySeriesId = new Map<string, FinancialEvent>();

    for (const month of this.monthDefinitions) {
      for (const event of month.events) {
        if (!event.seriesId || event.recurrenceKind !== 'fixed' || event.repeatMode !== 'monthly') {
          continue;
        }

        if (!templateBySeriesId.has(event.seriesId)) {
          templateBySeriesId.set(event.seriesId, event);
        }
      }
    }

    if (!templateBySeriesId.size) {
      return [];
    }

    const changed: MonthDefinition[] = [];

    for (const month of targetMonths) {
      let monthChanged = false;
      const maxDay = new Date(month.year, month.monthNumber, 0).getDate();

      for (const template of templateBySeriesId.values()) {
        const alreadyExists = month.events.some((event) => event.seriesId === template.seriesId);
        if (alreadyExists) {
          continue;
        }

        month.events = [
          ...month.events,
          this.createEvent(
            Math.min(template.day, maxDay),
            template.label,
            template.amount,
            template.type,
            template.seriesId,
            'fixed',
            'monthly',
            null
          )
        ];
        monthChanged = true;
      }

      if (monthChanged) {
        changed.push(month);
      }
    }

    return changed;
  }

  private getPlanningHorizonEndDate(referenceDate: Date): Date {
    const rollingEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    rollingEnd.setMonth(rollingEnd.getMonth() + Math.max(0, this.planningHorizonMonths - 1));
    const rollingMonthLastDay = new Date(rollingEnd.getFullYear(), rollingEnd.getMonth() + 1, 0).getDate();
    rollingEnd.setDate(rollingMonthLastDay);

    const fixedEnd = new Date(this.planningEndYear, 11, 31);
    return fixedEnd > rollingEnd ? fixedEnd : rollingEnd;
  }

  private ensureFutureMonths(monthsToCreate: number): void {
    const count = Math.max(0, Math.ceil(monthsToCreate));
    if (!count || !this.monthDefinitions.length) {
      return;
    }

    const last = this.monthDefinitions[this.monthDefinitions.length - 1];
    const baseOpeningBalance = this.monthSummaries[this.monthSummaries.length - 1]?.closingBalance ?? last.openingBalance;
    const created: MonthDefinition[] = [];

    for (let i = 1; i <= count; i += 1) {
      const nextRef = new Date(last.year, last.monthNumber - 1 + i, 1);
      const year = nextRef.getFullYear();
      const monthNumber = nextRef.getMonth() + 1;

      if (this.findMonthIndex(year, monthNumber) >= 0) {
        continue;
      }

      const key = `${year}-${String(monthNumber).padStart(2, '0')}`;
      created.push({
        id: key,
        key,
        title: this.getMonthName(monthNumber),
        year,
        monthNumber,
        openingBalance: baseOpeningBalance,
        dailyFixedCost: 0,
        events: []
      });
    }

    if (!created.length) {
      return;
    }

    const propagated = this.propagateFixedMonthlySeriesToMonths(created);
    const monthsToPersistMap = new Map<string, MonthDefinition>();
    for (const month of [...created, ...propagated]) {
      monthsToPersistMap.set(month.key, month);
    }
    const monthsToPersist = Array.from(monthsToPersistMap.values());

    this.monthDefinitions = [...this.monthDefinitions, ...created].sort((a, b) => {
      if (a.year === b.year) {
        return a.monthNumber - b.monthNumber;
      }
      return a.year - b.year;
    });

    forkJoin(monthsToPersist.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Nao foi possivel persistir alguns meses futuros no backend.';
      }
    });
  }

  private ensureYearMonths(year: number): void {
    const created: MonthDefinition[] = [];

    for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
      const month = this.ensureMonthExists(year, monthNumber);
      if (month) {
        created.push(month);
      }
    }

    if (!created.length) {
      return;
    }

    const propagated = this.propagateFixedMonthlySeriesToMonths(created);
    const monthsToPersistMap = new Map<string, MonthDefinition>();
    for (const month of [...created, ...propagated]) {
      monthsToPersistMap.set(month.key, month);
    }
    const monthsToPersist = Array.from(monthsToPersistMap.values());

    forkJoin(monthsToPersist.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Nao foi possivel persistir alguns meses do ano selecionado no backend.';
      }
    });
  }

  private ensureMonthExists(year: number, monthNumber: number): MonthDefinition | null {
    if (this.findMonthIndex(year, monthNumber) >= 0) {
      return null;
    }

    const previousRef = this.getPreviousMonthRef(year, monthNumber);
    const previousIndex = this.findMonthIndex(previousRef.year, previousRef.monthNumber);
    const previousSummary = previousIndex >= 0 ? this.monthSummaries[previousIndex] : undefined;
    const openingBalance = previousSummary?.closingBalance ?? 0;
    const key = `${year}-${String(monthNumber).padStart(2, '0')}`;

    const createdMonth: MonthDefinition = {
      id: key,
      key,
      title: this.getMonthName(monthNumber),
      year,
      monthNumber,
      openingBalance,
      dailyFixedCost: 0,
      events: []
    };

    this.monthDefinitions = [
      ...this.monthDefinitions,
      createdMonth
    ].sort((a, b) => {
      if (a.year === b.year) {
        return a.monthNumber - b.monthNumber;
      }
      return a.year - b.year;
    });

    return createdMonth;
  }

  private syncWindowToCurrentMonth(): void {
    const now = new Date();
    const currentIndex = this.monthDefinitions.findIndex(
      (month) => month.year === now.getFullYear() && month.monthNumber === (now.getMonth() + 1)
    );

    this.windowStartIndex = currentIndex >= 0 ? currentIndex : 0;
    this.customStartIndex = this.windowStartIndex;
    this.customEndIndex = Math.min(this.windowStartIndex + 2, Math.max(this.monthDefinitions.length - 1, 0));
  }

  private getOnboardingStorageKey(uid = this.currentUserId ?? 'guest'): string {
    return `previsa-onboarding-v1:${uid}`;
  }

  private getPreviousMonthRef(year: number, monthNumber: number): { year: number; monthNumber: number } {
    if (monthNumber === 1) {
      return { year: year - 1, monthNumber: 12 };
    }

    return { year, monthNumber: monthNumber - 1 };
  }

  private computeRecurrenceEndDate(
    startDate: Date,
    recurrenceKind: RecurrenceKind,
    repeatMode: RepeatMode,
    installments: number
  ): Date {
    if (recurrenceKind !== 'installment') {
      return new Date(startDate);
    }

    const safeInstallments = Number.isInteger(installments) && installments > 0 ? installments : 1;
    const endDate = new Date(startDate);

    if (repeatMode === 'monthly') {
      endDate.setMonth(endDate.getMonth() + (safeInstallments - 1));
      return endDate;
    }

    const stepDays = repeatMode === 'weekly' ? 7 : 1;
    endDate.setDate(endDate.getDate() + ((safeInstallments - 1) * stepDays));
    return endDate;
  }

  private getMonthName(monthNumber: number): string {
    const names = [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];

    return names[Math.max(1, Math.min(12, monthNumber)) - 1];
  }

  private buildMonthSummaries(): MonthSummary[] {
    return this.buildMonthSummariesFor(this.monthDefinitions);
  }

  private buildMonthSummariesFor(definitions: MonthDefinition[]): MonthSummary[] {
    const summaries: MonthSummary[] = [];
    const cardInvoiceForecastByMonth = this.buildCardInvoiceForecastByMonth();
    let carryState: DailyCarryState = {
      singleTotal: 0,
      seriesAmounts: new Map<string, number>()
    };
    let previousClosingBalance: number | undefined;

    for (const definition of definitions) {
      const openingOverride = previousClosingBalance !== undefined ? previousClosingBalance : definition.openingBalance;
      const summary = this.buildMonthSummary(
        definition,
        carryState,
        cardInvoiceForecastByMonth.get(this.getYearMonthKey(definition.year, definition.monthNumber)),
        openingOverride
      );
      summaries.push(summary);
      previousClosingBalance = summary.closingBalance;
      carryState = this.buildDailyCarryState(definition, carryState);
    }

    return summaries;
  }

  private findMonthIndex(year: number, monthNumber: number): number {
    return this.monthDefinitions.findIndex((month) => month.year === year && month.monthNumber === monthNumber);
  }

  private findEventBySeriesId(seriesId: string): FinancialEvent | undefined {
    for (const month of this.monthDefinitions) {
      const found = month.events.find((event) => event.seriesId === seriesId);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  private pushEventToMonth(month: MonthDefinition, event: FinancialEvent, touched: Map<string, MonthDefinition>): void {
    month.events = [...month.events, event];
    touched.set(month.id, month);
  }

  private cloneMonthDefinitions(definitions: MonthDefinition[]): MonthDefinition[] {
    return definitions.map((month) => ({
      ...month,
      events: month.events.map((event) => ({ ...event }))
    }));
  }

  private applyRecurringLaunchesToDefinitions(
    definitions: MonthDefinition[],
    startDate: Date,
    type: EventType,
    amount: number,
    label: string,
    recurrenceKind: RecurrenceKind,
    repeatMode: RepeatMode,
    installments: number,
    forcedSeriesId?: string
  ): MonthDefinition[] {
    const touched = new Map<string, MonthDefinition>();
    const startIndex = definitions.findIndex((month) => month.year === startDate.getFullYear() && month.monthNumber === (startDate.getMonth() + 1));
    const seriesId = recurrenceKind === 'single' ? undefined : (forcedSeriesId ?? this.generateEventId());
    const seriesOccurrences = recurrenceKind === 'installment' ? installments : null;

    if (startIndex < 0) {
      return [];
    }

    const day = startDate.getDate();

    if (recurrenceKind === 'single') {
      this.pushEventToMonth(definitions[startIndex], this.createEvent(day, label, amount, type), touched);
      return Array.from(touched.values());
    }

    if (repeatMode === 'monthly') {
      const maxMonths = definitions.length - startIndex;
      const totalOccurrences = recurrenceKind === 'installment' ? Math.min(installments, maxMonths) : maxMonths;

      for (let offset = 0; offset < totalOccurrences; offset += 1) {
        this.pushEventToMonth(
          definitions[startIndex + offset],
          this.createEvent(day, label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences),
          touched
        );
      }

      return Array.from(touched.values());
    }

    const stepDays = repeatMode === 'weekly' ? 7 : 1;
    const lastMonth = definitions[definitions.length - 1];
    const endDate = new Date(lastMonth.year, lastMonth.monthNumber, 0);
    const cursor = new Date(startDate);
    let applied = 0;

    while (cursor <= endDate) {
      const monthIndex = definitions.findIndex((month) => month.year === cursor.getFullYear() && month.monthNumber === (cursor.getMonth() + 1));
      if (monthIndex >= 0) {
        this.pushEventToMonth(
          definitions[monthIndex],
          this.createEvent(cursor.getDate(), label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences),
          touched
        );

        applied += 1;
        if (recurrenceKind === 'installment' && applied >= installments) {
          break;
        }
      }

      cursor.setDate(cursor.getDate() + stepDays);
    }

    return Array.from(touched.values());
  }

  private createEvent(
    day: number,
    label: string,
    amount: number,
    type: EventType,
    seriesId?: string,
    recurrenceKind?: RecurrenceKind,
    repeatMode?: RepeatMode,
    seriesOccurrences?: number | null
  ): FinancialEvent {
    return {
      id: this.generateEventId(),
      seriesId,
      recurrenceKind,
      repeatMode,
      seriesOccurrences,
      day,
      label,
      amount,
      type
    };
  }

  private generateEventId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `evt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  private getInstallmentReference(event: FinancialEvent, monthKey?: string): string | null {
    if ((event.recurrenceKind ?? 'single') !== 'installment' || !event.seriesId || !monthKey) {
      return null;
    }

    const seriesEvents = this.monthDefinitions
      .flatMap((month) => month.events.map((item) => ({ month, item })))
      .filter(({ item }) => item.seriesId === event.seriesId && (item.recurrenceKind ?? 'single') === 'installment')
      .sort((a, b) => {
        if (a.month.year !== b.month.year) {
          return a.month.year - b.month.year;
        }
        if (a.month.monthNumber !== b.month.monthNumber) {
          return a.month.monthNumber - b.month.monthNumber;
        }
        return a.item.day - b.item.day;
      });

    if (!seriesEvents.length) {
      return null;
    }

    const exactIndex = seriesEvents.findIndex(({ month, item }) => item.id === event.id && month.key === monthKey);
    const fallbackIndex = exactIndex >= 0
      ? exactIndex
      : seriesEvents.findIndex(({ month, item }) => (
        month.key === monthKey
        && item.day === event.day
        && item.amount === event.amount
        && item.label === event.label
      ));

    if (fallbackIndex < 0) {
      return null;
    }

    const total = Number.isInteger(event.seriesOccurrences) && (event.seriesOccurrences ?? 0) > 0
      ? Number(event.seriesOccurrences)
      : seriesEvents.length;

    return `${fallbackIndex + 1}/${total}`;
  }

  private normalizeText(text: string): string {
    if (!text || !/[\u00C3\u00C2]/.test(text)) {
      return text;
    }

    try {
      const bytes = new Uint8Array(Array.from(text).map((char) => char.charCodeAt(0)));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      return decoded.includes('\uFFFD') ? text : decoded;
    } catch {
      return text;
    }
  }

  private normalizeMonths(months: MonthDefinition[]): MonthDefinition[] {
    return months.map((month) => ({
      ...month,
      dailyFixedCost: month.dailyFixedCost > 0 && !month.events.some((event) => event.type === 'daily') ? 0 : month.dailyFixedCost,
      events: [
        ...month.events.map((event) => {
        const eventId = event.id ?? this.generateEventId();

        return {
          ...event,
          label: this.normalizeText(event.label),
          id: eventId,
          seriesId: event.seriesId ?? eventId,
          recurrenceKind: event.recurrenceKind ?? 'single',
          seriesOccurrences: event.seriesOccurrences ?? 1
        };
        }),
        ...this.createMigratedDailyEvents(month)
      ]
    }));
  }

  private createMigratedDailyEvents(month: MonthDefinition): FinancialEvent[] {
    if (month.dailyFixedCost <= 0 || month.events.some((event) => event.type === 'daily')) {
      return [];
    }

    const eventId = `daily-base-${month.key}`;
    return [
      {
        id: eventId,
        seriesId: eventId,
        recurrenceKind: 'fixed',
        repeatMode: 'monthly',
        seriesOccurrences: 1,
        day: 1,
        label: 'diario base',
        amount: month.dailyFixedCost,
        type: 'daily'
      }
    ];
  }

  private deleteSeries(seriesId: string, triggerEventId?: string): void {
    const backups = new Map<string, FinancialEvent[]>();
    const monthsToSave: MonthDefinition[] = [];

    for (const month of this.monthDefinitions) {
      const hasSeriesEvents = month.events.some((event) => event.seriesId === seriesId);
      if (!hasSeriesEvents) {
        continue;
      }

      backups.set(month.key, [...month.events]);
      month.events = month.events.filter((event) => event.seriesId !== seriesId);
      monthsToSave.push(month);
    }

    if (!monthsToSave.length) {
      return;
    }

    if (triggerEventId) {
      this.deletingEventIds.add(triggerEventId);
    }

    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = 'Serie removida.';
      },
      error: () => {
        for (const [monthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === monthKey);
          if (month) {
            month.events = events;
          }
        }
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = 'Nao foi possivel excluir a serie. Confira o backend e tente novamente.';
      }
    });
  }

  private deleteSeriesForward(monthKey: string, triggerEvent: FinancialEvent, triggerEventId?: string): void {
    if (!triggerEvent.seriesId) {
      return;
    }

    const triggerMonthIndex = this.monthDefinitions.findIndex((month) => month.key === monthKey);
    if (triggerMonthIndex < 0) {
      return;
    }

    const backups = new Map<string, FinancialEvent[]>();
    const monthsToSave: MonthDefinition[] = [];

    for (let monthIndex = triggerMonthIndex; monthIndex < this.monthDefinitions.length; monthIndex += 1) {
      const month = this.monthDefinitions[monthIndex];
      const previousEvents = [...month.events];
      const filteredEvents = month.events.filter((event) => {
        if (event.seriesId !== triggerEvent.seriesId) {
          return true;
        }

        if (monthIndex === triggerMonthIndex) {
          if (event.day < triggerEvent.day) {
            return true;
          }

          if (event.day === triggerEvent.day && event.id !== triggerEvent.id) {
            return true;
          }
        }

        return false;
      });

      if (filteredEvents.length === previousEvents.length) {
        continue;
      }

      backups.set(month.key, previousEvents);
      month.events = filteredEvents;
      monthsToSave.push(month);
    }

    if (!monthsToSave.length) {
      return;
    }

    if (triggerEventId) {
      this.deletingEventIds.add(triggerEventId);
    }

    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = triggerEvent.type === 'daily'
          ? 'Este diario e os proximos foram removidos.'
          : 'Este lancamento e os proximos foram removidos.';
      },
      error: () => {
        for (const [savedMonthKey, events] of backups) {
          const month = this.monthDefinitions.find((item) => item.key === savedMonthKey);
          if (month) {
            month.events = events;
          }
        }
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = triggerEvent.type === 'daily'
          ? 'Nao foi possivel excluir este diario e os proximos. Confira o backend e tente novamente.'
          : 'Nao foi possivel excluir este lancamento e os proximos. Confira o backend e tente novamente.';
      }
    });
  }

  private buildMonthSummary(
    definition: MonthDefinition,
    inheritedDailyState: DailyCarryState,
    cardInvoiceForecastByDay?: Map<number, CardInvoiceForecast[]>,
    openingBalanceOverride?: number
  ): MonthSummary {
    const eventsByDay = new Map<number, FinancialEvent[]>();
    const daysInMonth = new Date(definition.year, definition.monthNumber, 0).getDate();

    for (const event of definition.events) {
      const dayEvents = eventsByDay.get(event.day) ?? [];
      dayEvents.push(event);
      eventsByDay.set(event.day, dayEvents);
    }

    let runningBalance = openingBalanceOverride !== undefined ? openingBalanceOverride : definition.openingBalance;
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalInvestments = 0;
    const activeSeriesAmounts = new Map<string, number>(inheritedDailyState.seriesAmounts);
    let currentDailyFixedCost = this.sumMapValues(activeSeriesAmounts);

    const projection: DayProjection[] = [];

    for (let day = 1; day <= 31; day += 1) {
      if (day > daysInMonth) {
        projection.push({
          day,
          income: 0,
          expense: 0,
          investment: 0,
          fixedCost: 0,
          closingBalance: Number(runningBalance.toFixed(2)),
          events: [],
          notes: [],
          cardInvoiceForecasts: [],
          status: runningBalance < 0 ? 'negative' : 'healthy'
        });
        continue;
      }

      const events = eventsByDay.get(day) ?? [];
      const visibleEvents = events.filter((event) => !event.suppressed);
      const cardInvoiceForecasts = (cardInvoiceForecastByDay?.get(day) ?? []).map((forecast) => ({ ...forecast }));
      const projectedCardInvoiceExpense = cardInvoiceForecasts.reduce((sum, item) => sum + item.amount, 0);
      let income = 0;
      let expense = 0;
      let investment = 0;
      expense += projectedCardInvoiceExpense;
      let singleDayDailyAmount = 0;
      const seriesUpdates = new Map<string, number>();
      const seriesSkips = new Set<string>();
      const seriesOverrides = new Map<string, number>();

      for (const event of events) {
        if (event.type === 'income') {
          income += event.amount;
        }

        if (event.type === 'expense') {
          expense += event.amount;
        }

        if (event.type === 'investment') {
          investment += event.amount;
        }

        if (event.type === 'daily') {
          if ((event.recurrenceKind ?? 'single') === 'single' || !event.seriesId) {
            singleDayDailyAmount += event.amount;
          } else if (event.dailyOccurrenceAction === 'skip') {
            seriesSkips.add(event.seriesId);
          } else if (event.dailyOccurrenceAction === 'override') {
            seriesOverrides.set(event.seriesId, event.amount);
          } else {
            seriesUpdates.set(event.seriesId, event.amount);
          }
        }
      }

      if (seriesUpdates.size > 0) {
        for (const [seriesId, amount] of seriesUpdates) {
          activeSeriesAmounts.set(seriesId, amount);
        }
      }

      currentDailyFixedCost = this.sumDailySeriesValues(activeSeriesAmounts, seriesSkips, seriesOverrides) + singleDayDailyAmount;

      totalIncome += income;
      totalExpenses += expense;
      totalInvestments += investment;

      runningBalance += income;
      runningBalance -= expense + investment + currentDailyFixedCost;

      const notes = visibleEvents.map((event) => this.describeEvent(event, definition.key));
      const warningThreshold = currentDailyFixedCost > 0 ? currentDailyFixedCost * 18 : 250;
      const status = runningBalance < 0 ? 'negative' : runningBalance < warningThreshold ? 'warning' : 'healthy';

      projection.push({
        day,
        income,
        expense,
        investment,
        fixedCost: currentDailyFixedCost,
        closingBalance: Number(runningBalance.toFixed(2)),
        events: visibleEvents,
        notes,
        cardInvoiceForecasts,
        status
      });
    }

    const balances = projection.map((day) => day.closingBalance);
    const minBalance = Math.min(...balances);
    const maxBalance = Math.max(...balances);
    const amplitude = maxBalance - minBalance || 1;
    const checkpoints = [1, 5, 10, 15, 20, 25, 31]
      .map((day) => projection.find((entry) => entry.day === day)?.closingBalance ?? minBalance)
      .map((balance) => 26 + ((balance - minBalance) / amplitude) * 74);

    return {
      key: definition.key,
      title: definition.title,
      year: definition.year,
      monthNumber: definition.monthNumber,
      openingBalance: openingBalanceOverride !== undefined ? openingBalanceOverride : definition.openingBalance,
      closingBalance: balances[balances.length - 1],
      minBalance,
      totalIncome,
      totalExpenses,
      totalInvestments,
      totalFixedCosts: projection.reduce((total, day) => total + day.fixedCost, 0),
      negativeDays: projection.filter((day) => day.closingBalance < 0).length,
      chartHeights: checkpoints,
      projection
    };
  }

  private buildCardInvoiceForecastByMonth(): Map<string, Map<number, CardInvoiceForecast[]>> {
    const result = new Map<string, Map<number, CardInvoiceForecast[]>>();

    for (const launch of this.cardLaunches) {
      const card = this.cards.find((item) => String(item.id) === String(launch.cardId));
      if (!card) {
        continue;
      }

      const invoiceMonth = this.getCardInvoiceMonthForDate(launch.date, card);
      const dueDate = this.getDueDateForInvoiceMonth(invoiceMonth, card);
      const dueDay = dueDate.getDate();
      const monthKey = this.getYearMonthKey(dueDate.getFullYear(), dueDate.getMonth() + 1);
      const dayTotals = result.get(monthKey) ?? new Map<number, CardInvoiceForecast[]>();
      const forecasts = dayTotals.get(dueDay) ?? [];
      const cardId = String(card.id ?? launch.cardId);
      const existing = forecasts.find((item) => item.cardId === cardId);

      if (existing) {
        existing.amount = Number((existing.amount + launch.amount).toFixed(2));
        existing.launchesCount += 1;
        existing.isPaid = !!existing.isPaid && !!launch.paid;
      } else {
        forecasts.push({
          cardId,
          cardName: card.name,
          amount: Number(launch.amount.toFixed(2)),
          launchesCount: 1,
          isPaid: !!launch.paid
        });
      }

      dayTotals.set(dueDay, forecasts);
      result.set(monthKey, dayTotals);
    }

    return result;
  }

  private getCardInvoiceMonthForDate(dateInput: string, card: CreditCard): { year: number; month: number } {
    const transactionDate = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(transactionDate.getTime())) {
      const today = new Date();
      return { year: today.getFullYear(), month: today.getMonth() + 1 };
    }

    const dueDaySameMonth = this.getSafeDayForMonth(
      transactionDate.getFullYear(),
      transactionDate.getMonth() + 1,
      card.dueDay
    );
    const dueDateSameMonth = new Date(
      transactionDate.getFullYear(),
      transactionDate.getMonth(),
      dueDaySameMonth
    );
    const closeDateSameMonth = new Date(dueDateSameMonth);
    closeDateSameMonth.setDate(closeDateSameMonth.getDate() - card.closeDaysBefore);

    if (transactionDate <= closeDateSameMonth) {
      return {
        year: dueDateSameMonth.getFullYear(),
        month: dueDateSameMonth.getMonth() + 1
      };
    }

    const nextMonthRef = new Date(transactionDate.getFullYear(), transactionDate.getMonth() + 1, 1);
    return {
      year: nextMonthRef.getFullYear(),
      month: nextMonthRef.getMonth() + 1
    };
  }

  private getSafeDayForMonth(year: number, monthNumber: number, day: number): number {
    const maxDay = new Date(year, monthNumber, 0).getDate();
    return Math.min(Math.max(1, day), maxDay);
  }

  private getDueDateForInvoiceMonth(invoiceMonth: { year: number; month: number }, card: CreditCard): Date {
    const dueRef = new Date(invoiceMonth.year, invoiceMonth.month, 1);
    const dueDay = this.getSafeDayForMonth(dueRef.getFullYear(), dueRef.getMonth() + 1, card.dueDay);
    return new Date(dueRef.getFullYear(), dueRef.getMonth(), dueDay);
  }

  private getClosingDateForInvoiceMonth(invoiceMonth: { year: number; month: number }, card: CreditCard): Date {
    const closingDay = this.getSafeDayForMonth(invoiceMonth.year, invoiceMonth.month, card.dueDay);
    const closingDate = new Date(invoiceMonth.year, invoiceMonth.month - 1, closingDay);
    closingDate.setDate(closingDate.getDate() - card.closeDaysBefore);
    return closingDate;
  }

  private formatDateLabel(date: Date): string {
    return this.shortDateFormatter.format(date);
  }

  private getYearMonthKey(year: number, monthNumber: number): string {
    return `${year}-${monthNumber}`;
  }

  private buildDailyCarryState(definition: MonthDefinition, inheritedDailyState: DailyCarryState): DailyCarryState {
    let singleTotal = inheritedDailyState.singleTotal;
    const seriesAmounts = new Map<string, number>(inheritedDailyState.seriesAmounts);

    const sortedDailyEvents = definition.events
      .filter((event) => event.type === 'daily')
      .sort((left, right) => left.day - right.day);

    for (const event of sortedDailyEvents) {
      if (event.dailyOccurrenceAction === 'skip' || event.dailyOccurrenceAction === 'override') {
        continue;
      }

      if ((event.recurrenceKind ?? 'single') === 'single' || !event.seriesId) {
        continue;
      }

      seriesAmounts.set(event.seriesId, event.amount);
    }

    return {
      singleTotal,
      seriesAmounts
    };
  }

  private sumMapValues(values: Map<string, number>): number {
    let total = 0;

    for (const amount of values.values()) {
      total += amount;
    }

    return total;
  }

  private sumDailySeriesValues(values: Map<string, number>, skips: Set<string>, overrides: Map<string, number>): number {
    let total = 0;

    for (const [seriesId, amount] of values) {
      if (skips.has(seriesId)) {
        continue;
      }

      total += overrides.get(seriesId) ?? amount;
    }

    for (const [seriesId, amount] of overrides) {
      if (!values.has(seriesId) && !skips.has(seriesId)) {
        total += amount;
      }
    }

    return total;
  }

  private findNextPressurePoint(): string {
    return this.findNextPressurePointFor(this.monthSummaries);
  }

  private findNextPressurePointFor(months: MonthSummary[]): string {
    for (const month of months) {
      const pressureDay = month.projection.find((day) => day.status !== 'healthy');

      if (pressureDay) {
        return `${pressureDay.day} de ${month.title}`;
      }
    }

    return 'sem pressao prevista';
  }
}
