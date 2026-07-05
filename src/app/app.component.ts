import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren } from '@angular/core';
import { CardLaunch, CreditCard, FinanceApiService, EventType, FinancialEvent, MonthDefinition, SeriesDefinition, SeriesOccurrenceOverride, RecurrenceKind, RepeatMode } from './core/services/finance-api.service';
import { CardsTabComponent } from './features/cards/cards-tab/cards-tab.component';
import { AuthService } from './core/services/auth.service';
import { TagsService } from './core/services/tags.service';

import { DailyAutoSkipService } from './core/services/daily-auto-skip.service';
import { AnnouncementsService } from './core/services/announcements.service';
import { BudgetsService } from './core/services/budgets.service';
import { forkJoin, Observable, of, Subscription } from 'rxjs';
import { map, startWith, switchMap } from 'rxjs/operators';
import { getInvoiceMonthForDate, getDueDateForInvoiceMonth, getClosingDateForInvoiceMonth, InvoiceMonth } from './core/utils/card-cycle.util';
import {
  CategoryScale,
  Chart,
  ChartConfiguration,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, CategoryScale, LinearScale, Filler, Tooltip, Legend);

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

interface PendingInvestmentWithdrawal {
  monthKey: string;
  event: FinancialEvent;
  availableAmount: number;
  withdrawnAmount: number;
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
  invoiceYear: number;
  invoiceMonth: number;
  isPaid?: boolean;
}

interface DayProjection {
  day: number;
  income: number;
  expense: number;
  otherExpense: number;
  cardExpense: number;
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
  totalOtherExpenses: number;
  totalCardExpenses: number;
  totalInvestments: number;
  totalFixedCosts: number;
  negativeDays: number;
  chartHeights: number[];
  chartPoints: Array<{ day: number; balance: number; height: number; tone: 'healthy' | 'warning' | 'negative' }>;
  chartZeroLine: number;
  projection: DayProjection[];
}

interface SimplifiedMonthEntry {
  key: string;
  monthKey: string;
  kind: 'event' | 'card-forecast';
  type: EventType | 'card';
  title: string;
  dateLabel: string;
  tagLabel: string;
  secondaryTag?: string;
  tags?: string[];
  amount: number;
  statusLabel: string;
  paid: boolean;
  day: number;
  monthYear: number;
  monthNumber: number;
  event?: FinancialEvent;
  forecast?: CardInvoiceForecast;
}

interface WindowSummary {
  label: string;
  months: MonthSummary[];
  totalIncome: number;
  totalExpenses: number;
  totalOtherExpenses: number;
  totalCardExpenses: number;
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

interface LaunchTagCatalogItem {
  name: string;
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
  tags: string[];
}

interface LaunchFiltersState {
  query: string;
  tags: string[];
}

interface LaunchDecisionAdvice {
  tone: 'good' | 'warn' | 'risk';
  title: string;
  summary: string;
  detail: string;
  launchLabel?: string;
  beforeBalance?: number;
  launchDelta?: number;
  afterBalance?: number;
}

interface DailyFormState {
  amount: number | null;
  effectiveDate: string;
  description: string;
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

type AppTab = 'entries' | 'dashboard' | 'cards' | 'goals' | 'investment' | 'config' | 'simulator';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, AfterViewChecked, OnDestroy {
  readonly title = 'previsa';
  private readonly windowSize = 3;
  private readonly planningHorizonMonths = 24;
  private readonly planningEndYear = 2028;
  activeTab: AppTab = 'entries';
  windowStartIndex = 0;
  authorizationState$: Observable<'checking' | 'authorized' | 'blocked'>;
  isLoading = true;
  dataError = '';
  isSavingLaunch = false;

  /** Data alvo (YYYY-MM-DD) consultada no card de previsão de saldo. */
  forecastDateInput = '';
  entriesFeedback = '';
  private feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

  setFeedback(msg: string): void {
    if (this.feedbackTimeout) {
      clearTimeout(this.feedbackTimeout);
    }
    this.entriesFeedback = msg;
    this.feedbackTimeout = setTimeout(() => {
      this.entriesFeedback = '';
      this.feedbackTimeout = null;
    }, 3000);
  }

  feedbackOpen = false;

  openFeedback(): void {
    this.feedbackOpen = true;
  }

  closeFeedback(): void {
    this.feedbackOpen = false;
  }

  activeDayDetails: ActiveDayDetails | null = null;
  activeContextMenuEvent: FinancialEvent | null = null;
  sortMode: 'recent' | 'highest' | 'lowest' = 'recent';
  deletingEventIds = new Set<string>();
  payingEventIds = new Set<string>();
  payingInvoiceKeys = new Set<string>();

  // ── Email verification ──────────────────────────────────────────────────────
  verifying = false;
  editingVerificationEmail = false;
  newVerificationEmail = '';
  verificationErrorMessage = '';

  get showVerificationScreen(): boolean {
    return !!localStorage.getItem('pendingVerification');
  }

  get pendingVerificationEmail(): string {
    return this.auth.pendingVerificationEmail ?? 'seu e-mail';
  }

  async resendVerificationEmail(): Promise<void> {
    this.verifying = true;
    this.verificationErrorMessage = '';
    try {
      await this.auth.sendVerificationEmail();
    } catch (err: any) {
      this.verificationErrorMessage = err?.message ?? 'Erro ao reenviar e-mail de verificação.';
    } finally {
      this.verifying = false;
    }
  }

  async checkAndConfirmVerification(): Promise<void> {
    this.verifying = true;
    this.verificationErrorMessage = '';
    try {
      const verified = await this.auth.checkEmailVerified();
      if (verified) {
        this.auth.clearPendingVerification();
      } else {
        this.verificationErrorMessage = 'O e-mail ainda não foi verificado. Verifique sua caixa de entrada (incluindo spam) e tente novamente, ou peça um novo link.';
      }
    } catch (err: any) {
      this.verificationErrorMessage = err?.message ?? 'Erro ao verificar e-mail.';
    } finally {
      this.verifying = false;
    }
  }

  startEditVerificationEmail(): void {
    this.editingVerificationEmail = true;
    this.newVerificationEmail = this.pendingVerificationEmail;
    this.verificationErrorMessage = '';
  }

  async confirmVerificationEmailEdit(): Promise<void> {
    const email = this.newVerificationEmail.trim();
    if (!email) {
      this.verificationErrorMessage = 'Informe um e-mail válido.';
      return;
    }
    this.verifying = true;
    this.verificationErrorMessage = '';
    try {
      await this.auth.updateEmailAndVerify(email);
      this.editingVerificationEmail = false;
    } catch (err: any) {
      this.verificationErrorMessage = err?.message ?? 'Erro ao atualizar e-mail.';
    } finally {
      this.verifying = false;
    }
  }

  cancelVerificationEmailEdit(): void {
    this.editingVerificationEmail = false;
    this.newVerificationEmail = '';
    this.verificationErrorMessage = '';
  }

  cancelVerification(): void {
    this.auth.clearPendingVerification();
    this.auth.logout();
  }
  // ── Fim email verification ─────────────────────────────────────────────────

  private saveAndNewLaunchRequested = false;
  private saveAndNewDailyRequested = false;
  private currentUserId: string | null = null;
  private seededMonthsUserId: string | null = null;

  userMenuOpen = false;
  mobileTopbarMenuOpen = false;
  mobileEntriesControlsOpen = false;
  mobileSimplifiedSummaryOpen = false;
  openSimplifiedEntryMenuKey: string | null = null;
  darkMode = false;

  showOnboarding = false;
  onboardingStep = 0;
  readonly onboardingSteps: OnboardingStep[] = [
    {
      icon: '👋',
      title: 'Bem-vindo ao Previsa',
      body: 'Um gestor financeiro pessoal focado em previsibilidade. Lance entradas, saídas e investimentos e veja para onde o seu caixa vai, mês a mês, antes de acontecer.',
      tip: 'Use o botão ? no canto superior para abrir este guia novamente a qualquer momento.'
    },
    {
      icon: '➕',
      title: 'Adicionando lançamentos',
      body: 'Clique no botão azul + no canto inferior direito para abrir o formulario. Você pode lançar:',
      bullets: [
        'Entrada: receitas recebidas (salario, freelance, transferencia)',
        'Saída: despesas e contas a pagar',
        'Investido: reserva que sai do caixa',
        'Diária: custo que se repete diariamente (ex: transporte R$ 8 por dia)'
      ],
      tip: 'Lançamentos parcelados usam o valor de cada parcela, não o total da compra.'
    },
    {
      icon: '✏️',
      title: 'Editando e excluindo',
      body: 'Passe o mouse sobre qualquer linha da tabela de dias para ver os botões de ação.',
      bullets: [
        'Lançamentos únicos são alterados diretamente.',
        'Para series (parcelados ou fixos), você escolhe: so este, este e os próximos, ou toda a serie.',
        'Despesas podem ser marcadas como pagas, e o registro permanece visivel no mês.'
      ]
    },
    {
      icon: '📅',
      title: 'Modos de visualizacao',
      body: 'Use os botões no topo da aba Lançamentos para alternar entre quatro modos:',
      bullets: [
        'Simplificado: lista apenas os dias com movimento no mês, sem repetir a diária dia a dia',
        '3 meses: tres colunas lado a lado, bom para acompanhamento diário',
        '12 meses: visao anual em blocos, boa para planejamento de longo prazo',
        'Personalizado: selecione exatamente os meses que quer comparar'
      ],
      tip: 'O botão "mês atual" leva você de volta ao mês de hoje com um clique.'
    },
    {
      icon: '💳',
      title: 'Cartões de credito',
      body: 'Cadastre seus cartões na aba Cartões e registre compras com a data da compra.',
      bullets: [
        'O Previsa calcula a fatura prevista e projeta o debito no mês do vencimento.',
        'O impacto aparece como uma linha roxa na tabela de dias desse mês.',
        'Você enxerga o peso da fatura no caixa antes de ela chegar.'
      ]
    },
    {
      icon: '🎯',
      title: 'Metas de gasto',
      body: 'Na aba Metas você define quanto pretende gastar por mês e o Previsa acompanha o progresso pra você, sem precisar abrir planilha.',
      bullets: [
        'Defina metas para a carteira inteira, para um cartão específico ou para uma tag (ex: alimentação, lazer).',
        'Acompanhe o quanto já gastou, o quanto ainda pode gastar e a projeção de fechamento na barra de progresso.',
        'Receba um alerta visual quando estourar o limite, no Dashboard e na aba Cartões.'
      ],
      tip: 'Metas de cartão podem usar o ciclo da fatura no lugar do mês do calendário, pra bater com o que vai ser cobrado.'
    },
    {
      icon: '🧪',
      title: 'Simulador de cenários',
      body: 'A aba Simulador responde uma pergunta simples: se a sua renda mudar agora, por quanto tempo o seu padrão de vida atual se sustenta?',
      bullets: [
        'Informe quanto pretende ganhar nos próximos meses (ou aplique uma redução percentual).',
        'Marque as tags de gasto que dá pra cortar no cenário e veja o impacto imediato no caixa.',
        'Some uma rescisão ou seguro-desemprego pra ver o fôlego que isso te dá.',
        'O resultado mostra mês a mês quando o saldo cruza o zero, pra você se planejar com calma.'
      ],
      tip: 'Use também pra testar o oposto: "e se eu ganhasse 20% a mais e investisse a diferença?".'
    }
  ];

  viewMode: 'custom' | '1month' | '3month' | '12month' | 'balance' = '3month';
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
  pendingInvestmentWithdrawal: PendingInvestmentWithdrawal | null = null;
  launchError = '';
  dailyError = '';
  investmentWithdrawalError = '';
  isSavingInvestmentWithdrawal = false;
  launchForm: LaunchFormState = {
    type: 'expense',
    amount: null,
    date: '',
    label: '',
    recurrenceKind: 'single',
    repeatMode: 'monthly',
    installments: 1,
    tags: []
  };
  launchAmountInput = '';

  dailyForm: DailyFormState = {
    amount: null,
    effectiveDate: '',
    description: '',
    repeatMode: 'none',
    recurrenceKind: 'fixed',
    installments: 1
  };
  dailyAmountInput = '';
  investmentWithdrawalAmountInput = '';
  investmentWithdrawalAmount: number | null = null;
  investmentWithdrawalDate = '';

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
    { value: 'daily', label: 'Diária' }
  ];

  readonly repeatModeOptions: Array<{ value: RepeatMode; label: string }> = [
    { value: 'daily', label: 'Todo dia' },
    { value: 'weekly', label: 'Toda semana' },
    { value: 'monthly', label: 'Todo mês' }
  ];

  readonly dailyRepeatModeOptions: Array<{ value: DailyRepeatSelection; label: string }> = [
    { value: 'none', label: 'Não repetir' },
    { value: 'daily', label: 'Todo dia' },
    { value: 'weekly', label: 'Toda semana' },
    { value: 'monthly', label: 'Todo mês' }
  ];

  readonly dailyRecurrenceKindOptions: Array<{ value: Exclude<RecurrenceKind, 'single'>; label: string }> = [
    { value: 'fixed', label: 'Fixa' },
    { value: 'installment', label: 'Quantidade de vezes' }
  ];

  readonly visionCards: VisionCard[] = [
    {
      title: 'Linha do tempo de compromissos',
      description: 'Agrupa vencimentos, aportes e entradas futuras em uma faixa cronologica para você enxergar onde o caixa aperta.'
    },
    {
      title: 'Mapa de calor do saldo diário',
      description: 'Troca dezenas de linhas por intensidade visual, destacando dias de conforto, alerta e saldo negativo.'
    },
    {
      title: 'Pontes entre meses',
      description: 'Mostra quanto saldo cada mês entrega para o próximo, deixando claro o efeito acumulado das decisoes.'
    }
  ];

  availableTags: LaunchTagCatalogItem[] = [];
  investmentGoalOptions: Array<{ name: string; normalizedName: string }> = [];
  private readonly defaultInvestmentGoalOption = {
    name: 'Reserva de emergência',
    normalizedName: this.normalizeTagName('Reserva de emergência')
  };
  private readonly defaultInvestmentGoalAliases = [
    this.defaultInvestmentGoalOption.normalizedName,
    this.normalizeTagName('Reserva de emergencia')
  ];
  newTagInput = '';
  selectedExistingTag = '';
  isCreatingLaunchTag = false;
  private visibleLaunchFilterTagsCache: {
    source: LaunchTagCatalogItem[];
    length: number;
    result: LaunchTagCatalogItem[];
  } | null = null;
  launchFilters: LaunchFiltersState = {
    query: '',
    tags: []
  };

  private readonly tagPalette = ['#1168d9', '#0f9f78', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#4d7c0f', '#be185d'];

  private readonly currencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2
  });

  private readonly shortDateFormatter = new Intl.DateTimeFormat('pt-BR');
  private readonly dashboardExpensePalette = ['#16c6a0', '#3f8df6', '#e5cc3a', '#f97316', '#a78bfa', '#f43f5e'];

  private monthDefinitions: MonthDefinition[] = [];
  private seriesDefinitions: SeriesDefinition[] = [];
  private cards: CreditCard[] = [];
  private cardLaunches: CardLaunch[] = [];

  // Cache de monthSummaries: o getter eh consultado dezenas de vezes por ciclo
  // de change detection (direto e via outros getters dependentes). Sem cache, cada
  // CD reconstroi todas as projecoes diarias, o que com varios meses + eventos
  // congela a aba. A invalidacao usa uma assinatura barata baseada nos dados de
  // entrada (definicoes, cards, lancamentos).
  private summariesCache: MonthSummary[] | null = null;
  private summariesCacheSignature = '';
  private investmentWithdrawnCache: Map<string, number> | null = null;
  private investmentWithdrawnCacheSignature = '';

  // Caches do dashboard. Os getters abaixo sao consultados varias vezes por ciclo
  // (1x para *ngIf, 1x para *ngFor, 1x para cada [style.X] etc.). Cada chamada
  // fazia O(meses * eventos) ou O(cards * launches), o que com volume real de
  // dados travava a aba ao montar. A invalidacao depende dos mesmos inputs.
  private dashboardExpenseSlicesCache: DashboardExpenseSlice[] | null = null;
  private _dashboardExpenseSlicesMonthKey = '';
  private dashboardCardSummariesCache: DashboardCardSummary[] | null = null;
  private dashboardCardSummariesSignature = '';
  private readonly monthCharts = new Map<string, Chart<'line'>>();
  private monthChartsRenderSignature = '';

  @ViewChildren('monthBalanceChart')
  private monthBalanceChartRefs?: QueryList<ElementRef<HTMLCanvasElement>>;

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
    totalOtherExpenses: 0,
    totalCardExpenses: 0,
    totalInvestments: 0,
    totalFixedCosts: 0,
    negativeDays: 0,
    chartHeights: [],
    chartPoints: [],
    chartZeroLine: 0,
    projection: []
  };

  constructor(
    private readonly financeApi: FinanceApiService,
    public readonly auth: AuthService,
    private cdr: ChangeDetectorRef,
    private readonly tagsService: TagsService,
    private readonly budgetsService: BudgetsService,
    private readonly dailyAutoSkip: DailyAutoSkipService,
    private readonly announcementsService: AnnouncementsService
  ) {
    // Inicializa o input de previsão para hoje + 30 dias.
    const defaultForecast = new Date();
    defaultForecast.setDate(defaultForecast.getDate() + 30);
    const y = defaultForecast.getFullYear();
    const m = String(defaultForecast.getMonth() + 1).padStart(2, '0');
    const d = String(defaultForecast.getDate()).padStart(2, '0');
    this.forecastDateInput = `${y}-${m}-${d}`;

    this.authorizationState$ = this.auth.authState$.pipe(
      switchMap(authState => {
        if (!authState.ready || !authState.user) {
          return of<'checking' | 'authorized' | 'blocked'>('checking');
        }
        if (!authState.user.email) {
          return of<'blocked'>('blocked');
        }
        return this.auth.checkAuthorization(authState.user.email, authState.user.uid).pipe(
          map(authorized => authorized ? 'authorized' as const : 'blocked' as const),
          startWith<'checking' | 'authorized' | 'blocked'>('checking')
        );
      })
    );
  }

  ngOnInit(): void {
    // Fix iOS Safari: the virtual keyboard shrinks the visual viewport but
    // position:fixed elements stay anchored to the layout viewport.
    // We expose the real visible height as --vvh so modals can use it.
    const setVvh = () => {
      const vv = window.visualViewport;
      if (vv) {
        // --keyboard-h = how much the keyboard is covering (iOS: innerHeight stays
        // full-screen while vv.height shrinks; Android: both shrink together → 0)
        const kbh = Math.max(0, window.innerHeight - vv.height);
        document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
        document.documentElement.style.setProperty('--keyboard-h', `${kbh}px`);
      } else {
        document.documentElement.style.setProperty('--vvh', `${window.innerHeight}px`);
        document.documentElement.style.setProperty('--keyboard-h', '0px');
      }
    };
    setVvh();
    window.visualViewport?.addEventListener('resize', setVvh);
    window.visualViewport?.addEventListener('scroll', setVvh);

    // iOS Safari: when the keyboard opens with a position:fixed modal, the
    // browser scrolls the layout viewport to bring the focused input into view,
    // visually pushing the entire modal off-screen. Locking body scroll while
    // any modal is mounted prevents that, and forcing the focused input to
    // scroll into view inside its own scroll container keeps it visible above
    // the keyboard. (This is NOT reproducible in browser mobile emulators —
    // only real iOS / Android devices.)
    const MODAL_SELECTOR = '.launch-modal, .series-action-modal';
    let savedScrollY = 0;
    let bodyLocked = false;
    const lockBody = () => {
      if (bodyLocked) return;
      bodyLocked = true;
      savedScrollY = window.scrollY;
      const body = document.body;
      body.style.position = 'fixed';
      body.style.top = `-${savedScrollY}px`;
      body.style.left = '0';
      body.style.right = '0';
      body.style.width = '100%';
      body.classList.add('modal-open');
    };
    const unlockBody = () => {
      if (!bodyLocked) return;
      bodyLocked = false;
      const body = document.body;
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      body.classList.remove('modal-open');
      window.scrollTo(0, savedScrollY);
    };
    const syncBodyLock = () => {
      const anyOpen = !!document.querySelector(MODAL_SELECTOR);
      if (anyOpen) lockBody(); else unlockBody();
    };
    const observer = new MutationObserver(syncBodyLock);
    observer.observe(document.body, { childList: true, subtree: true });

    document.addEventListener('focusin', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.matches('input, textarea, select')) return;
      const scroller = target.closest('.launch-body, .launch-modal-body') as HTMLElement | null;
      if (!scroller) return;
      // Wait for the keyboard to finish animating so visualViewport.height is final.
      setTimeout(() => {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
          target.scrollIntoView();
        }
      }, 280);
    });

    const saved = localStorage.getItem('previsa-dark');
    this.darkMode = saved === 'true' || (saved === null && window.matchMedia('(prefers-color-scheme: dark)').matches);

    this.auth.user$.subscribe((user) => {
      this.userMenuOpen = false;
      this.currentUserId = user?.uid ?? null;

      if (!user) {
        // Login deve permanecer sempre em modo claro.
        document.body.classList.remove('dark');
        this.showOnboarding = false;
        this.seededMonthsUserId = null;
        return;
      }

      document.body.classList.toggle('dark', this.darkMode);

      this.showOnboarding = !localStorage.getItem(this.getOnboardingStorageKey(user.uid));
    });

    this.loadMonths();
    this.loadCardForecastData();
    this.loadAvailableTags();
    this.loadInvestmentGoals();

    // Auto-skip do diário quando o dia vira (00h00).
    this.dailyAutoSkip.start(() => this.monthDefinitions);
  }

  ngAfterViewChecked(): void {
    this.syncMonthCharts();
  }

  ngOnDestroy(): void {
    this.destroyMonthCharts();
  }

  toggleUserMenu(): void {
    this.userMenuOpen = !this.userMenuOpen;
  }

  toggleMobileTopbarMenu(): void {
    this.mobileTopbarMenuOpen = !this.mobileTopbarMenuOpen;
  }

  toggleMobileEntriesControls(): void {
    this.mobileEntriesControlsOpen = !this.mobileEntriesControlsOpen;
  }

  toggleMobileSimplifiedSummary(): void {
    this.mobileSimplifiedSummaryOpen = !this.mobileSimplifiedSummaryOpen;
  }

  toggleSimplifiedEntryMenu(entry: SimplifiedMonthEntry): void {
    if (this.openSimplifiedEntryMenuKey === entry.key) {
      this.openSimplifiedEntryMenuKey = null;
    } else {
      this.openSimplifiedEntryMenuKey = entry.key;
    }
  }

  closeSimplifiedEntryMenus(): void {
    this.openSimplifiedEntryMenuKey = null;
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
    // Se for a primeira vez que o usuario fecha o tutorial, considera que ele
    // ja conhece tudo que existe hoje no app: marca todos os anuncios pendentes
    // como vistos para nao bombardear com "novidades" do que, para ele, ja e o
    // estado inicial. Anuncios futuros (publicados depois) seguem aparecendo.
    const isFirstClose = !localStorage.getItem(this.getOnboardingStorageKey());
    this.showOnboarding = false;
    localStorage.setItem(this.getOnboardingStorageKey(), 'true');
    if (isFirstClose) {
      this.announcementsService.pending$
        .subscribe((pending) => {
          if (pending.length) {
            this.announcementsService.markAsSeen(pending.map((a) => a.id));
          }
        })
        .unsubscribe();
    }
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
    const signature = this.computeSummariesSignature();
    if (this.summariesCache && signature === this.summariesCacheSignature) {
      return this.summariesCache;
    }
    this.summariesCacheSignature = signature;
    this.summariesCache = this.buildMonthSummaries();
    return this.summariesCache;
  }

  private computeSummariesSignature(): string {
    let eventsCount = 0;
    let amountSum = 0;
    let flagsHash = 0;
    let dayHash = 0;
    let tagHash = 0;
    for (const month of this.monthDefinitions) {
      eventsCount += month.events.length;
      amountSum += month.openingBalance || 0;
      amountSum += month.dailyFixedCost || 0;
      for (const event of month.events) {
        amountSum += event.amount || 0;
        dayHash = (dayHash + event.day) | 0;
        if (event.paid) flagsHash++;
        if (event.suppressed) flagsHash += 7;
        if (event.tags && event.tags.length) {
          for (const tag of event.tags) {
            for (let i = 0; i < tag.length; i++) {
              tagHash = ((tagHash * 31) + tag.charCodeAt(i)) | 0;
            }
            tagHash = (tagHash + 1) | 0;
          }
        }
      }
      if (month.seriesOverrides?.length) {
        for (const override of month.seriesOverrides) {
          amountSum += override.amount || 0;
          if (override.paid) flagsHash++;
          if (override.action === 'skip') flagsHash += 13;
        }
      }
    }
    for (const series of this.seriesDefinitions) {
      amountSum += series.amount || 0;
      dayHash = (dayHash + series.day) | 0;
      if (!series.isActive) flagsHash += 17;
      if (series.endedInMonthKey) flagsHash += 23;
      if (series.tags?.length) {
        for (const tag of series.tags) {
          for (let i = 0; i < tag.length; i++) {
            tagHash = ((tagHash * 31) + tag.charCodeAt(i)) | 0;
          }
          tagHash = (tagHash + 1) | 0;
        }
      }
    }
    let launchSum = 0;
    let launchPaid = 0;
    for (const launch of this.cardLaunches) {
      launchSum += launch.amount || 0;
      if (launch.paid) launchPaid++;
      const tagsCsv = launch.tags;
      if (tagsCsv) {
        for (let i = 0; i < tagsCsv.length; i++) {
          tagHash = ((tagHash * 31) + tagsCsv.charCodeAt(i)) | 0;
        }
      }
    }
    return [
      this.monthDefinitions.length,
      eventsCount,
      amountSum.toFixed(2),
      flagsHash,
      dayHash,
      tagHash,
      this.cards.length,
      this.cardLaunches.length,
      launchSum.toFixed(2),
      launchPaid
    ].join('|');
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

  // -------------------------------------------------------------------------
  // Card "Previsão de saldo" (dashboard)
  // -------------------------------------------------------------------------

  /** Linha do tempo dia-a-dia de todos os meses carregados. */
  private get forecastTimeline(): Array<{ date: Date; balance: number; iso: string }> {
    // Há cenários em que existem dois `MonthSummary` para o mesmo (ano, mês)
    // — por exemplo, docs com keys "2026-05" e "mai-2026". Aqui escolhemos
    // exatamente um summary por mês civil, preferindo o que carrega mais
    // movimentação (maior soma de income+expense+investment+fixedCost), para
    // não pegar o doc duplicado/vazio.
    const byMonth = new Map<string, MonthSummary>();
    const score = (m: MonthSummary) =>
      (m.totalIncome ?? 0) + (m.totalExpenses ?? 0) + (m.totalInvestments ?? 0) + (m.totalFixedCosts ?? 0);
    for (const month of this.monthSummaries) {
      const monthKey = `${month.year}-${String(month.monthNumber).padStart(2, '0')}`;
      const existing = byMonth.get(monthKey);
      if (!existing || score(month) > score(existing)) {
        byMonth.set(monthKey, month);
      }
    }
    const timeline: Array<{ date: Date; balance: number; iso: string }> = [];
    for (const month of byMonth.values()) {
      for (const day of month.projection) {
        const date = new Date(month.year, month.monthNumber - 1, day.day);
        const iso = `${month.year}-${String(month.monthNumber).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
        timeline.push({ date, balance: day.closingBalance, iso });
      }
    }
    return timeline.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /** Saldo previsto na data informada (ou null se fora do horizonte). */
  get forecastBalanceAtDate(): number | null {
    const iso = (this.forecastDateInput || '').trim();
    if (!iso) {
      return null;
    }
    const point = this.forecastTimeline.find((p) => p.iso === iso);
    return point ? point.balance : null;
  }

  /** Label amigável da data alvo (ou string vazia se inválida). */
  get forecastDateLabel(): string {
    const iso = (this.forecastDateInput || '').trim();
    if (!iso) return '';
    const parsed = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** True quando a data está fora do horizonte projetado. */
  get forecastDateOutOfRange(): boolean {
    const iso = (this.forecastDateInput || '').trim();
    if (!iso) return false;
    const timeline = this.forecastTimeline;
    if (!timeline.length) return false;
    return !timeline.some((p) => p.iso === iso);
  }

  /** Primeiro dia do horizonte em que o saldo fica negativo (ou null). */
  get forecastFirstNegative(): { dateLabel: string; balance: number } | null {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = this.forecastTargetDate;
    for (const point of this.forecastTimeline) {
      if (point.date.getTime() < today.getTime()) {
        continue;
      }
      if (limit && point.date.getTime() > limit.getTime()) {
        break;
      }
      if (point.balance < 0) {
        return {
          dateLabel: point.date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }),
          balance: point.balance
        };
      }
    }
    return null;
  }

  /** Menor saldo previsto entre hoje e a data alvo. */
  get forecastMinPoint(): { dateLabel: string; balance: number } | null {
    return this.findExtremePoint('min');
  }

  /** Maior saldo previsto entre hoje e a data alvo. */
  get forecastMaxPoint(): { dateLabel: string; balance: number } | null {
    return this.findExtremePoint('max');
  }

  /** Date object da `forecastDateInput` (ou null se inválido/vazio). */
  private get forecastTargetDate(): Date | null {
    const iso = (this.forecastDateInput || '').trim();
    if (!iso) return null;
    const parsed = new Date(`${iso}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private findExtremePoint(kind: 'min' | 'max'): { dateLabel: string; balance: number } | null {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = this.forecastTargetDate;
    let best: { date: Date; balance: number } | null = null;
    for (const point of this.forecastTimeline) {
      if (point.date.getTime() < today.getTime()) continue;
      if (limit && point.date.getTime() > limit.getTime()) break;
      if (
        !best ||
        (kind === 'min' && point.balance < best.balance) ||
        (kind === 'max' && point.balance > best.balance)
      ) {
        best = { date: point.date, balance: point.balance };
      }
    }
    if (!best) return null;
    return {
      dateLabel: best.date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }),
      balance: best.balance
    };
  }

  /** Limites min/max do input de data (formato YYYY-MM-DD). */
  get forecastDateMin(): string {
    const tl = this.forecastTimeline;
    return tl.length ? tl[0].iso : '';
  }
  get forecastDateMax(): string {
    const tl = this.forecastTimeline;
    return tl.length ? tl[tl.length - 1].iso : '';
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
        totalOtherExpenses: 0,
        totalCardExpenses: 0,
        totalInvestments: 0,
        totalFixedCosts: 0,
        openingBalance: 0,
        closingBalance: 0
      };
    }

    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];

    // Label compacto para nao quebrar em varias linhas no pill de navegacao.
    // Mesmo ano  -> "Abril a Junho · 2026"
    // Anos diff  -> "Dez/2026 a Fev/2027"
    let label: string;
    if (months.length === 1) {
      label = `${firstMonth.title} · ${firstMonth.year}`;
    } else if (firstMonth.year === lastMonth.year) {
      label = `${firstMonth.title} a ${lastMonth.title} · ${firstMonth.year}`;
    } else {
      label = `${firstMonth.title}/${firstMonth.year} a ${lastMonth.title}/${lastMonth.year}`;
    }

    return {
      label,
      months,
      totalIncome: months.reduce((total, month) => total + month.totalIncome, 0),
      totalExpenses: months.reduce((total, month) => total + month.totalExpenses, 0),
      totalOtherExpenses: months.reduce((total, month) => total + month.totalOtherExpenses, 0),
      totalCardExpenses: months.reduce((total, month) => total + month.totalCardExpenses, 0),
      totalInvestments: months.reduce((total, month) => total + month.totalInvestments, 0),
      totalFixedCosts: months.reduce((total, month) => total + month.totalFixedCosts, 0),
      openingBalance: firstMonth.openingBalance,
      closingBalance: lastMonth.closingBalance
    };
  }

  get focusMonth(): MonthSummary {
    return this.visibleMonths[0] ?? this.monthSummaries[0] ?? this.emptyMonthSummary;
  }

  // ── Dashboard month selector ────────────────────────────────────────────

  private _dashboardMonthIndex = -1;
  /** Cache da data de referência do dashboard (evita new Date() a cada CD). */
  private _dashboardReferenceDate: Date | null = null;

  /** Inicializa/retorna o índice do mês selecionado no Dashboard. */
  private get dashboardMonthIndex(): number {
    if (this._dashboardMonthIndex < 0 || this._dashboardMonthIndex >= this.monthSummaries.length) {
      this._dashboardMonthIndex = this.findClosestDashboardMonthIndex();
    }
    return this._dashboardMonthIndex;
  }

  private findClosestDashboardMonthIndex(): number {
    if (!this.monthSummaries.length) return -1;
    const now = new Date();
    const targetYear = now.getFullYear();
    const targetMonth = now.getMonth() + 1;
    // Procura o mês exato (year + monthNumber)
    const exact = this.monthSummaries.findIndex(m => m.year === targetYear && m.monthNumber === targetMonth);
    if (exact >= 0) return exact;
    // Se não achar, procura o mais próximo (menor diferença)
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < this.monthSummaries.length; i++) {
      const m = this.monthSummaries[i];
      const diff = Math.abs(m.year - targetYear) * 12 + Math.abs(m.monthNumber - targetMonth);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  get dashboardSelectedMonth(): MonthSummary | null {
    const idx = this.dashboardMonthIndex;
    return idx >= 0 && idx < this.monthSummaries.length ? this.monthSummaries[idx] : null;
  }

  get dashboardSelectedMonthLabel(): string {
    const m = this.dashboardSelectedMonth;
    return m ? `${m.title} ${m.year}` : '—';
  }

  get dashboardReferenceDate(): Date {
    const m = this.dashboardSelectedMonth;
    if (!m) {
      if (!this._dashboardReferenceDate) this._dashboardReferenceDate = new Date();
      return this._dashboardReferenceDate;
    }
    const candidate = new Date(m.year, m.monthNumber - 1, 1);
    if (!this._dashboardReferenceDate || this._dashboardReferenceDate.getTime() !== candidate.getTime()) {
      this._dashboardReferenceDate = candidate;
    }
    return this._dashboardReferenceDate;
  }

  get canGoDashboardPrev(): boolean {
    const idx = this.dashboardMonthIndex;
    return this.monthSummaries.length > 0 && idx > 0;
  }

  get canGoDashboardNext(): boolean {
    const idx = this.dashboardMonthIndex;
    return this.monthSummaries.length > 0 && idx < this.monthSummaries.length - 1;
  }

  get dashboardIsCurrentMonth(): boolean {
    const m = this.dashboardSelectedMonth;
    if (!m) return false;
    const now = new Date();
    return m.year === now.getFullYear() && m.monthNumber === now.getMonth() + 1;
  }

  dashboardGoToPreviousMonth(): void {
    const idx = this.dashboardMonthIndex;
    if (idx > 0) {
      this._dashboardMonthIndex = idx - 1;
      this._dashboardReferenceDate = null;
      this.dashboardExpenseSlicesCache = null;
      this._dashboardExpenseSlicesMonthKey = '';
    }
  }

  dashboardGoToNextMonth(): void {
    const idx = this.dashboardMonthIndex;
    if (idx < this.monthSummaries.length - 1) {
      this._dashboardMonthIndex = idx + 1;
      this._dashboardReferenceDate = null;
      this.dashboardExpenseSlicesCache = null;
      this._dashboardExpenseSlicesMonthKey = '';
    }
  }

  dashboardGoToCurrentMonth(): void {
    this._dashboardMonthIndex = -1;
    this._dashboardReferenceDate = null;
    this.dashboardExpenseSlicesCache = null;
    this._dashboardExpenseSlicesMonthKey = '';
  }

  // ── Year forecast (dashboard) ───────────────────────────────────────────

  private get currentYearMonths(): MonthSummary[] {
    const currentYear = new Date().getFullYear();
    return this.monthSummaries.filter((m) => m.year === currentYear);
  }

  get currentYear(): number {
    return new Date().getFullYear();
  }

  get dashboardYearProjectedBalance(): number {
    const months = this.currentYearMonths;
    return months.length > 0 ? months[months.length - 1].closingBalance : 0;
  }

  get dashboardYearMinPoint(): { dateLabel: string; balance: number } | null {
    let min = Infinity;
    let minMonth = '';
    for (const month of this.currentYearMonths) {
      if (month.minBalance < min) {
        min = month.minBalance;
        minMonth = `${month.title} ${month.year}`;
      }
    }
    return min < Infinity ? { dateLabel: minMonth, balance: min } : null;
  }

  get dashboardYearMaxPoint(): { dateLabel: string; balance: number } | null {
    let max = -Infinity;
    let maxMonth = '';
    for (const month of this.currentYearMonths) {
      if (month.closingBalance > max) {
        max = month.closingBalance;
        maxMonth = `${month.title} ${month.year}`;
      }
    }
    return max > -Infinity ? { dateLabel: maxMonth, balance: max } : null;
  }

  get dashboardYearProtectedDays(): number {
    return this.currentYearMonths.reduce(
      (count, month) => count + month.projection.filter((day) => day.closingBalance > 0).length,
      0
    );
  }

  get dashboardYearTotalDays(): number {
    return this.currentYearMonths.reduce(
      (count, month) => count + month.projection.length,
      0
    );
  }

  /** Dia com maior total de saídas no mês selecionado (dashboard). */
  get dashboardBiggestExpenseDay(): { day: number; amount: number } | null {
    const month = this.dashboardSelectedMonth;
    if (!month || !month.projection.length) return null;

    let maxDay: { day: number; amount: number } | null = null;

    for (const proj of month.projection) {
      const outflow = proj.expense + proj.fixedCost + proj.cardExpense + proj.investment;
      if (outflow <= 0) continue;
      if (!maxDay || outflow > maxDay.amount) {
        maxDay = { day: proj.day, amount: outflow };
      }
    }

    return maxDay;
  }

  get dashboardCardSummaries(): DashboardCardSummary[] {
    const signature = `${this.cards.length}|${this.cardLaunches.length}|${this.windowStartIndex}|${this.cardLaunches.reduce((s, l) => s + (l.amount || 0) + (l.paid ? 1 : 0), 0).toFixed(2)}`;
    if (this.dashboardCardSummariesCache && signature === this.dashboardCardSummariesSignature) {
      return this.dashboardCardSummariesCache;
    }

    const todayRef = this.getTodayInputDate();

    const result = this.cards
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

    this.dashboardCardSummariesSignature = signature;
    this.dashboardCardSummariesCache = result;
    return result;
  }

  get dashboardExpenseSlices(): DashboardExpenseSlice[] {
    const selected = this.dashboardSelectedMonth;
    if (!selected) return [];

    // Cache: só recalcula se o mês mudou
    const monthKey = `${selected.year}-${selected.monthNumber}`;
    if (this.dashboardExpenseSlicesCache && this._dashboardExpenseSlicesMonthKey === monthKey) {
      return this.dashboardExpenseSlicesCache;
    }

    const idx = this.monthSummaries.indexOf(selected);
    const targetMonth = idx >= 0 ? this.monthDefinitions[idx] : null;
    if (!targetMonth) {
      this._dashboardExpenseSlicesMonthKey = monthKey;
      this.dashboardExpenseSlicesCache = [];
      return this.dashboardExpenseSlicesCache;
    }

    const expenseByLabel = new Map<string, number>();

    for (const event of targetMonth.events) {
      if (event.type !== 'expense' || event.suppressed) {
        continue;
      }

      const baseLabel = this.normalizeText(event.label ?? '').trim();
      const label = baseLabel || 'Sem categoria';
      expenseByLabel.set(label, (expenseByLabel.get(label) ?? 0) + event.amount);
    }

    const sorted = Array.from(expenseByLabel.entries())
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => b.amount - a.amount);

    const total = sorted.reduce((sum, item) => sum + item.amount, 0);
    if (total <= 0) {
      this._dashboardExpenseSlicesMonthKey = monthKey;
      this.dashboardExpenseSlicesCache = [];
      return this.dashboardExpenseSlicesCache;
    }

    const topSlices = sorted.slice(0, 5);
    const othersAmount = sorted.slice(5).reduce((sum, item) => sum + item.amount, 0);
    const combined = othersAmount > 0
      ? [...topSlices, { label: 'Outros', amount: othersAmount }]
      : topSlices;

    const result = combined.map((slice, index) => ({
      label: slice.label,
      amount: Number(slice.amount.toFixed(2)),
      percent: Number(((slice.amount / total) * 100).toFixed(2)),
      color: this.dashboardExpensePalette[index % this.dashboardExpensePalette.length]
    }));

    this._dashboardExpenseSlicesMonthKey = monthKey;
    this.dashboardExpenseSlicesCache = result;
    return result;
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

  get availableTagNames(): string[] {
    return this.availableTags.map((tag) => tag.name);
  }

  get tagSuggestions(): LaunchTagCatalogItem[] {
    const normalizedInput = this.normalizeTagName(this.newTagInput);
    if (!normalizedInput) {
      return [];
    }

    return this.availableTags
      .filter((tag) => {
        const normalizedName = this.normalizeTagName(tag.name);
        if (!normalizedName.includes(normalizedInput)) {
          return false;
        }

        return !this.launchForm.tags.some((selectedTag) => this.normalizeTagName(selectedTag) === normalizedName);
      })
      .slice(0, 6);
  }

  get availableTagsForSelection(): LaunchTagCatalogItem[] {
    return this.availableTags.filter(
      (tag) => !this.launchForm.tags.some((selected) => this.normalizeTagName(selected) === this.normalizeTagName(tag.name))
    );
  }

  get selectedInvestmentGoalName(): string {
    if (this.launchForm.type !== 'investment') {
      return '';
    }

    for (const tag of this.launchForm.tags) {
      const normalizedTag = this.normalizeTagName(tag);
      const matchedOption = this.investmentGoalOptions.find((option) => option.normalizedName === normalizedTag);
      if (matchedOption) {
        return matchedOption.name;
      }
    }

    return '';
  }

  get launchMonths(): MonthSummary[] {
    if (this.viewMode === 'balance') {
      return this.monthSummaries.filter((month) => month.year === this.twelveMonthYear);
    }
    if (this.viewMode === '12month') {
      return this.monthSummaries.filter((month) => month.year === this.twelveMonthYear);
    }
    if (this.viewMode === 'custom') {
      return this.monthSummaries.slice(this.customStartIndex, this.customEndIndex + 1);
    }
    if (this.viewMode === '1month') {
      return this.monthSummaries.slice(this.windowStartIndex, this.windowStartIndex + 1);
    }
    return this.visibleMonths;
  }

  get entriesTitle(): string {
    if (this.viewMode === 'balance') {
      return `Evolucao de saldo de ${this.twelveMonthYear}`;
    }
    if (this.viewMode === '1month') {
      const month = this.launchMonths[0];
      return month ? `${month.title} de ${month.year}` : 'Lancamentos';
    }
    if (this.viewMode === '12month') {
      return `Lançamentos de ${this.twelveMonthYear}`;
    }
    if (this.viewMode === 'custom') {
      const months = this.launchMonths;
      if (!months.length) return 'Período personalizado';
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
    if (this.viewMode === '12month' || this.viewMode === 'balance') {
      return this.monthSummaries.length > 0;
    }

    return this.windowStartIndex > 0;
  }

  get canGoNext(): boolean {
    return this.viewMode !== 'custom' && this.monthSummaries.length > 0;
  }

  get singleMonthProgressLabel(): string {
    if (!this.monthSummaries.length) {
      return '0 de 0 meses';
    }

    return `${this.windowStartIndex + 1} de ${this.monthSummaries.length} meses`;
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
          ? 'Edição ativa: ajuste o valor e a data de início desta diária.'
          : 'Defina valor e data para aplicar a diária dali em diante.';
      }

      const parsedDate = new Date(`${this.dailyForm.effectiveDate}T00:00:00`);
      if (Number.isNaN(parsedDate.getTime())) {
        return 'A data selecionada para a diária e invalida.';
      }

      const startIndex = this.findMonthIndex(parsedDate.getFullYear(), parsedDate.getMonth() + 1);
      if (startIndex < 0) {
        return 'A data selecionada esta fora dos meses carregados.';
      }

      const recurrenceKind = this.getDailyRecurrenceKind();
      const repeatMode = this.getDailyRepeatMode();
      const installments = this.showDailyInstallmentsField ? this.dailyForm.installments : 1;

      if (recurrenceKind === 'single' || !repeatMode) {
        return `A diária será aplicada apenas no dia ${parsedDate.getDate()}.`;
      }

      const preview = this.buildRecurrencePreview(parsedDate, recurrenceKind, repeatMode, installments);
      if (!preview || preview.occurrences <= 0) {
        return 'Nenhuma diária será criada com as regras atuais.';
      }

      const first = this.formatMonthRef(preview.firstMonthIndex);
      const last = this.formatMonthRef(preview.lastMonthIndex);

      if (preview.occurrences === 1) {
        return `Vai criar 1 ponto de início para a diária em ${first}.`;
      }

      return `Vai criar ${preview.occurrences} pontos de início para a diária entre ${first} e ${last}.`;
    }

    if (this.isEditingSeries) {
      if (!this.launchForm.date || !this.monthDefinitions.length) {
        return 'Edição ativa: as alterações valem para toda a serie.';
      }
    }

    if (this.isEditingSingleLaunch) {
      return 'Edição ativa: as alterações valem somente para este lançamento.';
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
      return 'Nenhum lançamento será criado com as regras atuais.';
    }

    const first = this.formatMonthRef(preview.firstMonthIndex);
    const last = this.formatMonthRef(preview.lastMonthIndex);
    const isInstallment = this.launchForm.recurrenceKind === 'installment';
    const isFixedSeries = this.launchForm.recurrenceKind === 'fixed';
    const valueStr = this.formatCurrency(this.launchForm.amount || 0);

    if (preview.occurrences === 1) {
      return `Vai criar 1 lançamento em ${first}.`;
    }

    if (isInstallment) {
      return `Vai criar ${preview.occurrences} parcelas de ${valueStr} cada entre ${first} e ${last}. O valor inserido já e o valor de cada parcela.`;
    }

    if (isFixedSeries) {
      return `Vai criar lançamentos recorrentes de ${valueStr} entre ${first} e ${last}. A serie continua nos novos meses até você excluir.`;
    }

    return `Vai criar ${preview.occurrences} lançamentos de ${valueStr} entre ${first} e ${last}.`;
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
    const scenarioDayBalance = findDayBalance(scenarioSummaries, parsedDate);
    const launchImpact = this.launchForm.type === 'income'
      ? Number(this.launchForm.amount.toFixed(2))
      : -Number(this.launchForm.amount.toFixed(2));
    const attachDayBalance = (advice: LaunchDecisionAdvice): LaunchDecisionAdvice => ({
      ...advice,
      launchLabel: this.getLaunchAdviceMetricLabel(this.launchForm.type),
      beforeBalance: currentDayBalance ?? undefined,
      launchDelta: currentDayBalance !== null && scenarioDayBalance !== null
        ? Number((scenarioDayBalance - currentDayBalance).toFixed(2))
        : undefined,
      afterBalance: scenarioDayBalance ?? undefined
    });

    // Encontrar próximo dia em que esse mesmo lançamento ainda cabe no saldo.
    const findNextViableDay = (
      summaries: MonthSummary[],
      afterDate: Date,
      minimumResultBalance = 0
    ): { day: string; balance: number; resultingBalance: number } | null => {
      for (const month of summaries) {
        for (const day of month.projection) {
          const dayDate = new Date(month.year, month.monthNumber - 1, day.day);
          if (dayDate <= afterDate) {
            continue;
          }

          const resultingBalance = Number((day.closingBalance + launchImpact).toFixed(2));
          if (resultingBalance >= minimumResultBalance) {
            return {
              day: `${day.day} de ${month.title}`,
              balance: day.closingBalance,
              resultingBalance
            };
          }
        }
      }
      return null;
    };

    // Casos de entrada (income)
    if (this.launchForm.type === 'income') {
      if (scenarioWorst > currentWorst) {
        return attachDayBalance({
          tone: 'good',
          title: 'Essa entrada reforça o caixa',
          summary: `Melhora o menor saldo previsto em ${this.formatCurrency(worstDelta)}.`,
          detail: !scenarioRed
            ? 'Depois dela, a janela fica sem pontos de aperto.'
            : `Reduz o tempo em vermelho. O primeiro dia crítico fica em ${scenarioRed.day}.`
        });
      }
      return null;
    }

    // Casos de despesa (expense) ou investimento (investment)

    // SUPER IMPORTANTE: Verificar como o saldo do dia fica DEPOIS do lançamento.
    if (currentDayBalance !== null && scenarioDayBalance !== null && scenarioDayBalance < 0) {
      const nextGood = findNextViableDay(currentSummaries, parsedDate, 0);
      return attachDayBalance({
        tone: 'risk',
        title: 'Essa compra te deixa no vermelho nesse dia',
        summary: `No dia ${parsedDate.getDate()}, seu saldo sai de ${this.formatCurrency(currentDayBalance)} para ${this.formatCurrency(scenarioDayBalance)}.`,
        detail: nextGood
          ? `Melhor esperar até ${nextGood.day}, quando esse lançamento ainda deixa o saldo em ${this.formatCurrency(nextGood.resultingBalance)}.`
          : `Seu caixa fica no vermelho nesse período. Melhor esperar uma entrada ou reduzir esse valor.`
      });
    }

    // Se já estava negativo antes mesmo do lançamento, continua sendo um risco claro.
    if (currentDayBalance !== null && currentDayBalance < 0) {
      const nextGood = findNextViableDay(currentSummaries, parsedDate, 0);
      return attachDayBalance({
        tone: 'risk',
        title: 'Pessimo dia pra fazer essa despesa',
        summary: `No dia ${parsedDate.getDate()}, o saldo já esta em ${this.formatCurrency(currentDayBalance)}.`,
        detail: nextGood
          ? `Melhor esperar até ${nextGood.day}, quando esse lançamento ainda deixa o saldo em ${this.formatCurrency(nextGood.resultingBalance)}.`
          : `Seu caixa fica no vermelho nesse período. Espere uma entrada.`
      });
    }

    // Saldo do dia fica muito apertado depois do lançamento.
    if (scenarioDayBalance !== null && scenarioDayBalance >= 0 && scenarioDayBalance < 250) {
      const nextGood = findNextViableDay(currentSummaries, parsedDate, 0);
      return attachDayBalance({
        tone: 'warn',
        title: 'Dia muito apertado pra essa compra',
        summary: `Depois desse lançamento, o saldo do dia fica em apenas ${this.formatCurrency(scenarioDayBalance)}.`,
        detail: nextGood
          ? `Prefere esperar? No dia ${nextGood.day}, esse lançamento ainda deixa o saldo em ${this.formatCurrency(nextGood.resultingBalance)}.`
          : `Tem pouca folga nesse dia. Vale acompanhar de perto.`
      });
    }

    // Saldo do dia continua confortavel depois do lançamento.
    if (scenarioDayBalance !== null && scenarioDayBalance > 1000) {
      // Mas se é parcelado de valor alto, precisa checar o impacto global
      if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
        const monthlyInstallment = Number((this.launchForm.amount / installments).toFixed(2));
        
        // Se as parcelas reduzem MAS tem impacto significativo, avisar
        if (worstDelta < -1000) {
          return attachDayBalance({
            tone: 'warn',
            title: 'Parcelado reduz bastante no futuro',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada mês.`,
            detail: `O menor saldo da janela cai ${this.formatCurrency(Math.abs(worstDelta))} nos próximos meses. Sustentavel, mas aperta.`
          });
        }

        // Se fica negativo em algum ponto, é risco
        if (scenarioWorst < 0) {
          return attachDayBalance({
            tone: 'risk',
            title: 'Parcelado quebra o caixa nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica no vermelho em algum ponto. Reduz a quantidade ou o valor?`
          });
        }
      }

      return attachDayBalance({
        tone: 'good',
        title: 'Essa compra e tranquila nesse dia',
        summary: `Depois desse lançamento, o saldo do dia fica em ${this.formatCurrency(scenarioDayBalance)}.`,
        detail: `Tem folga confortavel. Segue firme com a compra.`
      });
    }

    // Saldo do dia segue positivo e razoavel depois do lançamento.
    if (scenarioDayBalance !== null && scenarioDayBalance >= 250 && scenarioDayBalance <= 1000) {
      // Se é parcelado, avaliar impacto nos próximos meses
      if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
        const monthlyInstallment = Number((this.launchForm.amount / installments).toFixed(2));
        
        // Se fica negativo, é risco
        if (scenarioWorst < 0) {
          return attachDayBalance({
            tone: 'risk',
            title: 'Parcelado quebra o caixa nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica no vermelho. Reduz a quantidade ou o valor?`
          });
        }

        // Se reduz muito, é atenção
        if (worstDelta < -500) {
          return attachDayBalance({
            tone: 'warn',
            title: 'Parcelado aperta nos próximos meses',
            summary: `${installments} parcelas de ${this.formatCurrency(monthlyInstallment)} cada.`,
            detail: `O caixa fica bem apertado depois. Tem entrada vindo?`
          });
        }
      }

      return attachDayBalance({
        tone: 'good',
        title: 'Essa compra cabe bem nesse dia',
        summary: `Depois desse lançamento, o saldo do dia fica em ${this.formatCurrency(scenarioDayBalance)}.`,
        detail: `Positivo e com margem. Você pode fazer a compra tranquilo.`
      });
    }

    // Cenário 1: Despesa cria novo dia no vermelho que antes não existia
    if (!currentRed && scenarioRed) {
      const bestAfter = bestAfterLaunch;
      if (bestAfter > 2000) {
        // Volta bem depois
        return attachDayBalance({
          tone: 'warn',
          title: 'Essa despesa aperta, mas volta rápido',
          summary: `Você fica no vermelho em ${scenarioRed.day} com saldo de ${this.formatCurrency(scenarioRed.balance)}.`,
          detail: `Mas depois volta a ${this.formatCurrency(bestAfter)}. E uma situacao temporaria.`
        });
      }
      // Fica vermelho e não volta bem
      return attachDayBalance({
        tone: 'risk',
        title: 'Essa despesa quebra o fluxo',
        summary: `Você fica no vermelho em ${scenarioRed.day}.`,
        detail: `Depois disso o saldo fica em torno de ${this.formatCurrency(bestAfter)}. Prefere remarcar ou buscar uma entrada?`
      });
    }

    // Cenário 2: Já tinha dia vermelho, despesa piora a situação
    if (currentRed && scenarioRed) {
      // Piora significativamente
      if (worstDelta < -500) {
        return attachDayBalance({
          tone: 'risk',
          title: 'Essa despesa aperta muito',
          summary: `Já existem dias em vermelho. Essa ainda reduz mais o saldo em ${this.formatCurrency(Math.abs(worstDelta))}.`,
          detail: `O pior fica em ${this.formatCurrency(scenarioWorst)}. Tem entrada vindo que regularize?`
        });
      }

      // Se lançamento é DEPOIS do dia vermelho e volta bem
      const launchAfterRed = launchDateObj > new Date(currentRed.day);
      if (launchAfterRed && bestAfterLaunch > 2000) {
        return attachDayBalance({
          tone: 'good',
          title: 'Você coloca isso depois dos dias criticos',
          summary: `Os dias em vermelho já estao agendados (${currentRed.day}).`,
          detail: `Seu lançamento no dia 25 e depois disso, e o caixa volta pra ${this.formatCurrency(bestAfterLaunch)}. Tranquilo.`
        });
      }

      // Já tinha vermelho, não piora muito
      return attachDayBalance({
        tone: 'warn',
        title: 'Já tem dias comprometidos no horizonte',
        summary: `O primeiro fica em ${currentRed.day} com saldo de ${this.formatCurrency(currentRed.balance)}.`,
        detail: `Essa despesa piora um pouco mais. Mas se já esta planejando, segue o plano.`
      });
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
        detail: `Depois dela o saldo mínimo fica em ${this.formatCurrency(scenarioWorst)}. Tem folga, mas pouca.`
      };
    }

    // Atenção: despesa parcelada
    if (this.launchForm.recurrenceKind === 'installment' && installments > 1) {
      return {
        tone: 'warn',
        title: 'Essa despesa e parcelada',
        summary: `${installments} parcelas de ${this.formatCurrency(this.launchForm.amount)} cada.`,
        detail: `Lembre de levar em conta as outras ${installments - 1} próximas no planejamento.`
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

  formatSignedCurrency(value: number): string {
    const signal = value >= 0 ? '+' : '-';
    return `${signal}${this.currencyFormatter.format(Math.abs(value))}`;
  }

  formatEventValue(event: FinancialEvent): string {
    const formatted = this.currencyFormatter.format(Math.abs(event.amount));
    return event.type === 'income' ? `+${formatted}` : `-${formatted}`;
  }

  getMonthProjectedDateLabel(month: MonthSummary): string {
    const lastDay = new Date(month.year, month.monthNumber, 0).getDate();
    return `${String(lastDay).padStart(2, '0')}/${String(month.monthNumber).padStart(2, '0')}`;
  }

  getMonthDeltaVsPrevious(month: MonthSummary): number | null {
    const monthIndex = this.monthSummaries.findIndex((summary) => summary.key === month.key);
    if (monthIndex <= 0) {
      return null;
    }

    const previousMonth = this.monthSummaries[monthIndex - 1];
    return Number((month.closingBalance - previousMonth.closingBalance).toFixed(2));
  }

  getPreviousMonthProjectedDateLabel(month: MonthSummary): string | null {
    const monthIndex = this.monthSummaries.findIndex((summary) => summary.key === month.key);
    if (monthIndex <= 0) {
      return null;
    }

    const previousMonth = this.monthSummaries[monthIndex - 1];
    return this.getMonthProjectedDateLabel(previousMonth);
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

  getMonthChartPoints(month: MonthSummary): Array<{ day: number; balance: number; height: number; tone: 'healthy' | 'warning' | 'negative' }> {
    const checkpoints = [1, 5, 10, 15, 20, 25, 31];
    const daysInMonth = new Date(month.year, month.monthNumber, 0).getDate();
    const { min, amplitude } = this.getMonthChartRange(month, daysInMonth);

    return checkpoints.map((checkpointDay) => {
      const day = Math.min(checkpointDay, daysInMonth);
      const projection = month.projection.find((entry) => entry.day === day);
      const balance = projection?.closingBalance ?? month.closingBalance;
      const height = 24 + ((balance - min) / amplitude) * 76;
      const tone: 'healthy' | 'warning' | 'negative' = projection?.status ?? (balance < 0 ? 'negative' : 'healthy');

      return {
        day,
        balance,
        height,
        tone
      };
    });
  }

  getMonthChartZeroLine(month: MonthSummary): number {
    const daysInMonth = new Date(month.year, month.monthNumber, 0).getDate();
    const { min, max, amplitude } = this.getMonthChartRange(month, daysInMonth);

    if (max <= 0) {
      return 100;
    }

    if (min >= 0) {
      return 0;
    }

    const relative = ((0 - min) / amplitude) * 100;
    return Math.min(100, Math.max(0, relative));
  }

  get hasLaunchFilters(): boolean {
    return this.launchFilters.query.trim().length > 0 || this.launchFilters.tags.length > 0;
  }

  trackByMonthKey(_index: number, month: MonthSummary): string {
    return month.key;
  }

  trackByChartDay(_index: number, point: { day: number }): number {
    return point.day;
  }

  private syncMonthCharts(): void {
    if (this.activeTab !== 'dashboard') {
      if (this.monthCharts.size > 0) {
        this.destroyMonthCharts();
      }
      this.monthChartsRenderSignature = '';
      return;
    }

    const refs = this.monthBalanceChartRefs?.toArray() ?? [];
    const months = this.visibleMonths;
    const nextSignature = `${months.map((month) => `${month.key}:${month.chartPoints.map((point) => point.balance).join(',')}`).join('|')}|${refs.length}`;

    if (!months.length || !refs.length) {
      if (this.monthCharts.size > 0) {
        this.destroyMonthCharts();
      }
      this.monthChartsRenderSignature = nextSignature;
      return;
    }

    if (this.monthChartsRenderSignature === nextSignature) {
      return;
    }

    const refsByMonthKey = new Map<string, HTMLCanvasElement>();
    for (const ref of refs) {
      const canvas = ref.nativeElement;
      const key = canvas.dataset['monthKey'];
      if (key) {
        refsByMonthKey.set(key, canvas);
      }
    }

    const activeKeys = new Set(months.map((month) => month.key));
    for (const [key, chart] of this.monthCharts) {
      if (!activeKeys.has(key)) {
        chart.destroy();
        this.monthCharts.delete(key);
      }
    }

    for (const month of months) {
      const canvas = refsByMonthKey.get(month.key);
      if (!canvas) {
        continue;
      }

      const labels = month.chartPoints.map((point) => String(point.day));
      const balances = month.chartPoints.map((point) => point.balance);
      const pointColors = month.chartPoints.map((point) => this.getMonthChartToneColor(point.tone));
      const zeroLine = balances.map(() => 0);
      const xLabelStep = Math.max(2, Math.ceil(labels.length / 8));

      const existing = this.monthCharts.get(month.key);
      if (existing) {
        existing.data.labels = labels;
        existing.data.datasets[0].data = balances;
        existing.data.datasets[0].pointBackgroundColor = pointColors;
        existing.data.datasets[1].data = zeroLine;
        existing.update('none');
        continue;
      }

      const config: ChartConfiguration<'line'> = {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Saldo projetado',
              data: balances,
              borderColor: '#3f78c9',
              borderWidth: 2,
              tension: 0.35,
              fill: true,
              pointRadius: 3,
              pointHoverRadius: 4,
              pointBorderWidth: 1,
              pointBorderColor: '#ffffff',
              pointBackgroundColor: pointColors,
              backgroundColor: (ctx) => {
                const chart = ctx.chart;
                const area = chart.chartArea;
                if (!area) {
                  return 'rgba(63, 120, 201, 0.16)';
                }
                const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                gradient.addColorStop(0, 'rgba(63, 120, 201, 0.28)');
                gradient.addColorStop(1, 'rgba(63, 120, 201, 0.03)');
                return gradient;
              }
            },
            {
              label: 'Zero',
              data: zeroLine,
              borderColor: '#cfd9e8',
              borderWidth: 1,
              borderDash: [5, 4],
              pointRadius: 0,
              pointHoverRadius: 0,
              fill: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: {
            duration: 240
          },
          plugins: {
            legend: {
              display: false
            },
            tooltip: {
              intersect: false,
              mode: 'index',
              callbacks: {
                title: (context) => `Dia ${context[0]?.label ?? ''}`,
                label: (context) => `Saldo: ${this.formatCurrency(Number(context.parsed.y ?? 0))}`
              }
            }
          },
          scales: {
            x: {
              grid: {
                display: false
              },
              ticks: {
                color: '#74869f',
                autoSkip: false,
                maxRotation: 0,
                callback: (_value, index) => {
                  const isFirst = index === 0;
                  const isLast = index === labels.length - 1;
                  return isFirst || isLast || index % xLabelStep === 0 ? String(labels[index]) : '';
                }
              }
            },
            y: {
              grid: {
                color: '#e8eef7',
                drawTicks: false
              },
              ticks: {
                maxTicksLimit: 4,
                color: '#74869f',
                callback: (value) => this.formatAbbreviatedCurrency(Number(value))
              }
            }
          }
        }
      };

      this.monthCharts.set(month.key, new Chart(canvas, config));
    }

    this.monthChartsRenderSignature = nextSignature;
  }

  private destroyMonthCharts(): void {
    for (const chart of this.monthCharts.values()) {
      chart.destroy();
    }
    this.monthCharts.clear();
  }

  private getMonthChartToneColor(tone: 'healthy' | 'warning' | 'negative'): string {
    if (tone === 'negative') {
      return '#d95873';
    }

    if (tone === 'warning') {
      return '#d9952d';
    }

    return '#2f9a7a';
  }

  private formatAbbreviatedCurrency(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1000) {
      return `${value < 0 ? '-' : ''}${(abs / 1000).toFixed(1)}k`;
    }

    return `${value < 0 ? '-' : ''}${abs.toFixed(0)}`;
  }

  get visibleLaunchFilterTags(): LaunchTagCatalogItem[] {
    const availableTags = this.availableTags;
    const cache = this.visibleLaunchFilterTagsCache;
    if (cache && cache.source === availableTags && cache.length === availableTags.length) {
      return cache.result;
    }

    const result = [...availableTags].sort((left, right) =>
      left.name.localeCompare(right.name, 'pt-BR')
    );
    this.visibleLaunchFilterTagsCache = {
      source: availableTags,
      length: availableTags.length,
      result
    };
    return result;
  }

  get launchFilterResultCount(): number {
    if (this.viewMode === '1month') {
      return this.launchMonths.reduce((count, month) => count + this.getSimplifiedMonthEntries(month).length, 0);
    }

    return this.launchMonths.reduce((count, month) => count + this.getFilteredMonthResultCount(month), 0);
  }

  get launchFilterMatchedMonthCount(): number {
    if (this.viewMode === '1month') {
      return this.launchMonths.filter((month) => this.getSimplifiedMonthEntries(month).length > 0).length;
    }

    return this.launchMonths.filter((month) => this.getFilteredMonthProjection(month).length > 0).length;
  }

  getDayDetailCount(day: DayProjection): number {
    return day.notes.length + day.cardInvoiceForecasts.length;
  }

  getDayPaidCount(day: DayProjection): number {
    return day.events.filter((event) => this.canTogglePaid(event) && this.isEventPaid(event)).length;
  }

  getCardInvoiceForecastLabel(forecast: CardInvoiceForecast): string {
    const launchLabel = forecast.launchesCount === 1 ? '1 compra' : `${forecast.launchesCount} compras`;
    return `Fatura prevista ${forecast.cardName}: ${this.formatCurrency(forecast.amount)} (${launchLabel})`;
  }

  onLaunchFilterQueryChange(): void {
    this.refreshActiveDayDetails();
  }

  clearLaunchFilters(): void {
    this.launchFilters = {
      query: '',
      tags: []
    };
    this.refreshActiveDayDetails();
  }

  toggleLaunchFilterTag(tagName: string): void {
    const normalizedTagName = this.normalizeTagName(tagName);
    const isActive = this.launchFilters.tags.some((tag) => this.normalizeTagName(tag) === normalizedTagName);

    this.launchFilters.tags = isActive
      ? this.launchFilters.tags.filter((tag) => this.normalizeTagName(tag) !== normalizedTagName)
      : [...this.launchFilters.tags, tagName];

    this.refreshActiveDayDetails();
  }

  isLaunchFilterTagActive(tagName: string): boolean {
    const normalizedTagName = this.normalizeTagName(tagName);
    return this.launchFilters.tags.some((tag) => this.normalizeTagName(tag) === normalizedTagName);
  }

  getFilteredMonthResultCount(month: MonthSummary): number {
    return this.getFilteredMonthProjection(month).reduce(
      (count, day) => count + day.events.length + day.cardInvoiceForecasts.length,
      0
    );
  }

  getFilteredMonthProjection(month: MonthSummary): DayProjection[] {
    if (!this.hasLaunchFilters) {
      return month.projection;
    }

    return month.projection
      .map((day) => this.buildFilteredDayProjection(month, day))
      .filter((day): day is DayProjection => day !== null);
  }

  getSimplifiedMonthEntries(month: MonthSummary): SimplifiedMonthEntry[] {
    return month.projection
      .flatMap((day) => {
        const eventEntries = day.events
          .filter((event) => event.type !== 'daily')
          .map((event, index) => this.buildSimplifiedEventEntry(month, day, event, index));
        const cardEntries = day.cardInvoiceForecasts
          .map((forecast, index) => this.buildSimplifiedCardForecastEntry(month, day, forecast, index));

        return [...eventEntries, ...cardEntries];
      })
      .filter((entry) => this.matchesSimplifiedEntry(entry))
      .sort((left, right) => {
        if (left.day !== right.day) {
          return left.day - right.day;
        }

        if (left.kind !== right.kind) {
          return left.kind === 'event' ? -1 : 1;
        }

        return left.title.localeCompare(right.title);
      });
  }

  getSimplifiedEntryAmountClass(entry: SimplifiedMonthEntry): string {
    switch (entry.type) {
      case 'income':
        return 'simplified-entry-value--income';
      case 'investment':
        return 'simplified-entry-value--investment';
      default:
        return 'simplified-entry-value--expense';
    }
  }

  getSimplifiedEntryStatusClass(entry: SimplifiedMonthEntry): string {
    if (entry.paid) {
      return 'simplified-entry-status--paid';
    }

    if (entry.type === 'expense' || entry.type === 'card') {
      return 'simplified-entry-status--pending';
    }

    return 'simplified-entry-status--info';
  }

  canSimplifiedEntryTogglePaid(entry: SimplifiedMonthEntry): boolean {
    if (entry.kind === 'card-forecast') {
      return true;
    }

    return !!entry.event && this.canTogglePaid(entry.event);
  }

  isSimplifiedEntryPayDisabled(entry: SimplifiedMonthEntry): boolean {
    if (entry.kind === 'card-forecast') {
      const forecast = entry.forecast;
      return !forecast || forecast.isPaid || this.isPayingInvoice(forecast.cardId, entry.monthYear, entry.monthNumber);
    }

    const event = entry.event;
    return !event || this.isPayingEvent(event.id) || this.isDeletingEvent(event.id);
  }

  getSimplifiedEntryPayLabel(entry: SimplifiedMonthEntry): string {
    if (entry.kind === 'card-forecast') {
      const forecast = entry.forecast;
      if (!forecast) {
        return 'Pagar';
      }

      if (this.isPayingInvoice(forecast.cardId, entry.monthYear, entry.monthNumber)) {
        return '...';
      }

      return forecast.isPaid ? 'Pago' : 'Pagar';
    }

    const event = entry.event;
    if (!event) {
      return 'Marcar pago';
    }

    if (this.isPayingEvent(event.id)) {
      return '...';
    }

    return this.isEventPaid(event) ? 'Pago' : 'Marcar pago';
  }

  toggleSimplifiedEntryPaid(entry: SimplifiedMonthEntry): void {
    if (!this.canSimplifiedEntryTogglePaid(entry) || this.isSimplifiedEntryPayDisabled(entry)) {
      return;
    }

    if (entry.kind === 'card-forecast') {
      const forecast = entry.forecast;
      if (!forecast) {
        return;
      }

      this.payCardInvoiceForecast(forecast.cardId, entry.monthYear, entry.monthNumber);
      return;
    }

    if (!entry.event) {
      return;
    }

    this.toggleEventPaid(entry.monthKey, entry.event);
  }

  editSimplifiedEntry(entry: SimplifiedMonthEntry): void {
    if (!entry.event || this.isDeletingEvent(entry.event.id)) {
      return;
    }

    this.openEventActionPrompt('edit', entry.monthKey, entry.event);
  }

  deleteSimplifiedEntry(entry: SimplifiedMonthEntry): void {
    if (!entry.event || this.isDeletingEvent(entry.event.id)) {
      return;
    }

    this.openEventActionPrompt('delete', entry.monthKey, entry.event);
  }

  openSimplifiedEntryWithdrawal(entry: SimplifiedMonthEntry): void {
    if (!entry.event || this.isDeletingEvent(entry.event.id)) {
      return;
    }

    this.openInvestmentWithdrawal(entry.monthKey, entry.event);
  }

  openCardForecastMonth(entry: SimplifiedMonthEntry): void {
    const forecast = entry.forecast;
    if (!forecast) {
      return;
    }

    this.setActiveTab('cards');
    this.cdr.detectChanges();
    setTimeout(() => {
      this.cardsTab?.focusInvoiceMonth(forecast.cardId, entry.monthYear, entry.monthNumber);
    }, 0);
  }

  goToCardInvoice(cardId: string | number, year: number, monthNumber: number): void {
    this.closeDayDetails();
    this.closeDayEntryMenu();
    this.setActiveTab('cards');
    this.cdr.detectChanges();
    setTimeout(() => {
      this.cardsTab?.focusInvoiceMonth(cardId, year, monthNumber);
    }, 0);
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
    return this.isEditingLaunch ? 'Editar lançamento' : 'Novo lançamento';
  }

  get dailyModalTitle(): string {
    return this.isEditingLaunch ? 'Editar diária' : 'Nova diária';
  }

  get seriesActionTitle(): string {
    if (!this.pendingEventAction) {
      return 'Recorrencia';
    }

    const actionLabel = this.pendingEventAction.type === 'edit' ? 'Editar' : 'Excluir';
    const targetLabel = this.pendingEventAction.event.type === 'daily' ? 'serie de diária' : 'recorrencia';
    return `${actionLabel} ${targetLabel}`;
  }

  get seriesActionDescription(): string {
    if (!this.pendingEventAction) {
      return 'Escolha se a ação vale apenas para este item ou para toda a serie.';
    }

    if (this.pendingEventAction.type === 'delete') {
      if (this.pendingEventAction.event.type === 'daily') {
        return 'Essa diária faz parte de uma serie. Você quer excluir so esta, estas e as próximas, ou toda a serie desta diária?';
      }

      return 'Esse lançamento faz parte de uma serie. Você quer excluir so este, este e os próximos, ou toda a serie?';
    }

    if (this.pendingEventAction.type === 'edit') {
      if (this.pendingEventAction.event.type === 'daily') {
        return 'Essa diária faz parte de uma serie. Você quer editar so esta, estas e as próximas, ou toda a serie desta diária?';
      }

      return 'Esse lançamento faz parte de uma serie. Você quer editar so este, este e os próximos, ou toda a serie?';
    }

    if (this.pendingEventAction.event.type === 'daily') {
      return 'Essa diária faz parte de uma serie. Você quer aplicar a ação so nesta diária ou em toda a serie desta diária?';
    }

    return 'Esse lançamento faz parte de uma serie. Você quer aplicar a ação so neste lançamento ou em toda a serie?';
  }

  // ---- Preview do lancamento sob acao (mostrado na modal de escopo) ----

  get pendingEventTypeLabel(): string {
    const ev = this.pendingEventAction?.event;
    if (!ev) return '';
    switch (ev.type) {
      case 'income': return 'Entrada';
      case 'investment': return 'Investimento';
      case 'daily': return 'Diária';
      default: return 'Saida';
    }
  }

  get pendingEventLabel(): string {
    return this.pendingEventAction?.event.label?.trim() || 'Sem descrição';
  }

  get pendingEventAmountLabel(): string {
    const ev = this.pendingEventAction?.event;
    if (!ev) return '';
    return this.formatCurrency(ev.amount || 0);
  }

  get pendingEventDateLabel(): string {
    const action = this.pendingEventAction;
    if (!action) return '';
    const day = action.event.day;
    const monthKey = action.monthKey;
    // monthKey costuma ser "yyyy-mm"; cobre tambem fallback simples.
    const match = /^(\d{4})-(\d{2})/.exec(monthKey);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
      return `Dia ${day} · ${monthLabel} ${year}`;
    }
    return `Dia ${day}`;
  }

  get pendingEventIsRecurring(): boolean {
    const ev = this.pendingEventAction?.event;
    return !!(ev && (ev.seriesId || ev.recurrenceKind === 'installment' || ev.recurrenceKind === 'fixed'));
  }

  get pendingEventRecurrenceLabel(): string {
    const ev = this.pendingEventAction?.event;
    if (!ev || !this.pendingEventIsRecurring) return '';
    if (ev.recurrenceKind === 'installment') {
      return ev.seriesOccurrences ? `Parcelado em ${ev.seriesOccurrences}x` : 'Parcelado';
    }
    if (ev.recurrenceKind === 'fixed') {
      return 'Recorrência fixa';
    }
    return 'Faz parte de uma serie';
  }

  // ---- Preview do lancamento na confirmacao final de exclusao ----

  get pendingDeleteTypeLabel(): string {
    const ev = this.pendingDeleteConfirmation?.event;
    if (!ev) return '';
    if (this.isInvestmentWithdrawalEvent(ev)) {
      return 'Resgate de investimento';
    }
    switch (ev.type) {
      case 'income': return 'Entrada';
      case 'investment': return 'Investimento';
      case 'daily': return 'Diária';
      default: return 'Saida';
    }
  }

  get pendingDeleteLabel(): string {
    const ev = this.pendingDeleteConfirmation?.event;
    if (!ev) {
      return 'Sem descrição';
    }

    if (this.isInvestmentWithdrawalEvent(ev)) {
      return `Resgate de ${ev.label?.trim() || 'investimento'}`;
    }

    return ev.label?.trim() || 'Sem descrição';
  }

  get pendingDeleteAmountLabel(): string {
    const ev = this.pendingDeleteConfirmation?.event;
    if (!ev) return '';
    return this.formatCurrency(ev.amount || 0);
  }

  get pendingDeleteDateLabel(): string {
    const action = this.pendingDeleteConfirmation;
    if (!action) return '';
    const day = action.event.day;
    const monthKey = action.monthKey;
    const match = /^(\d{4})-(\d{2})/.exec(monthKey);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long' });
      return `Dia ${day} · ${monthLabel} ${year}`;
    }
    return `Dia ${day}`;
  }

  get pendingDeleteScopeLabel(): string {
    const c = this.pendingDeleteConfirmation;
    if (!c) return '';
    if (c.scope === 'series') return 'Toda a serie';
    if (c.scope === 'forward') return 'Este e os próximos';
    return 'Apenas este';
  }

  get deleteConfirmationTitle(): string {
    if (!this.pendingDeleteConfirmation) {
      return 'Confirmar exclusão';
    }

    if (this.isInvestmentWithdrawalEvent(this.pendingDeleteConfirmation.event)) {
      return 'Excluir resgate';
    }

    const isDaily = this.pendingDeleteConfirmation.event.type === 'daily';
    const isSeries = this.pendingDeleteConfirmation.scope === 'series';
    const isForward = this.pendingDeleteConfirmation.scope === 'forward';

    if (isDaily && isSeries) {
      return 'Excluir serie de diária';
    }

    if (isDaily && isForward) {
      return 'Excluir diária e próximas';
    }

    if (isDaily) {
      return 'Excluir diária';
    }

    if (isForward) {
      return 'Excluir lançamento e próximos';
    }

    return isSeries ? 'Excluir serie de lançamentos' : 'Excluir lançamento';
  }

  get deleteConfirmationDescription(): string {
    if (!this.pendingDeleteConfirmation) {
      return 'Confirme a exclusão.';
    }

    if (this.isInvestmentWithdrawalEvent(this.pendingDeleteConfirmation.event)) {
      return 'Você vai excluir este resgate. O valor retornará ao saldo investido disponível do lançamento original.';
    }

    const { event, scope } = this.pendingDeleteConfirmation;
    const isDaily = event.type === 'daily';

    if (isDaily && scope === 'series') {
      return 'Você vai excluir toda a serie desta diária. Essa ação não pode ser desfeita.';
    }

    if (isDaily && scope === 'forward') {
      return 'Você vai excluir esta diária e todas as próximas dessa recorrência. As diárias anteriores serão mantidas.';
    }

    if (scope === 'forward') {
      return 'Você vai excluir este lançamento e todos os próximos dessa recorrência. Os lançamentos anteriores serão mantidos.';
    }

    if (isDaily) {
      return 'Você vai excluir esta diária. Essa ação não pode ser desfeita.';
    }

    if (scope === 'series') {
      return 'Você vai excluir toda a serie deste lançamento. Essa ação não pode ser desfeita.';
    }

    return 'Você vai excluir este lançamento. Essa ação não pode ser desfeita.';
  }

  get manualLaunchTypeOptions(): Array<{ value: LaunchType; label: string }> {
    return this.launchTypeOptions;
  }

  setActiveTab(tab: AppTab): void {
    this.activeTab = tab;
    this.mobileTopbarMenuOpen = false;
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

  canWithdrawInvestment(event: FinancialEvent): boolean {
    return event.type === 'investment' && !!event.id;
  }

  private isInvestmentWithdrawalEvent(event: FinancialEvent): boolean {
    return event.type === 'income' && !!event.investmentSourceEventId && event.suppressed !== true;
  }

  isRecordedInvestmentWithdrawal(event?: FinancialEvent): boolean {
    return !!event && this.isInvestmentWithdrawalEvent(event);
  }

  getInvestmentAvailableAmount(event: FinancialEvent): number {
    if (!event.id) {
      return 0;
    }

    const withdrawn = this.getInvestmentWithdrawnAmount(event.id);
    return Number(Math.max(0, event.amount - withdrawn).toFixed(2));
  }

  openInvestmentWithdrawal(monthKey: string, event: FinancialEvent): void {
    this.closeDayEntryMenu();

    if (!this.canWithdrawInvestment(event) || !event.id) {
      return;
    }

    const availableAmount = this.getInvestmentAvailableAmount(event);
    if (availableAmount <= 0) {
      this.entriesFeedback = 'Esse investimento já foi totalmente resgatado.';
      return;
    }

    this.pendingInvestmentWithdrawal = {
      monthKey,
      event,
      availableAmount,
      withdrawnAmount: Number((event.amount - availableAmount).toFixed(2))
    };
    this.investmentWithdrawalDate = this.getTodayInputDate();
    this.investmentWithdrawalAmount = null;
    this.investmentWithdrawalAmountInput = '';
    this.investmentWithdrawalError = '';
  }

  closeInvestmentWithdrawal(): void {
    this.pendingInvestmentWithdrawal = null;
    this.investmentWithdrawalError = '';
    this.investmentWithdrawalAmount = null;
    this.investmentWithdrawalAmountInput = '';
    this.investmentWithdrawalDate = '';
    this.isSavingInvestmentWithdrawal = false;
  }

  onInvestmentWithdrawalAmountInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.investmentWithdrawalAmountInput = masked.display;
    this.investmentWithdrawalAmount = masked.amount;
    this.cdr.markForCheck();
  }

  submitInvestmentWithdrawal(): void {
    if (!this.pendingInvestmentWithdrawal || this.isSavingInvestmentWithdrawal) {
      return;
    }

    this.investmentWithdrawalError = '';
    const sourceEvent = this.pendingInvestmentWithdrawal.event;
    if (!sourceEvent.id) {
      this.investmentWithdrawalError = 'Não foi possivel identificar o investimento original.';
      return;
    }

    const amount = this.investmentWithdrawalAmount;
    if (amount === null || Number.isNaN(amount) || amount <= 0) {
      this.investmentWithdrawalError = 'Informe um valor valido para o resgate.';
      return;
    }

    if (amount > this.pendingInvestmentWithdrawal.availableAmount) {
      this.investmentWithdrawalError = `O valor máximo disponível para resgate é ${this.formatCurrency(this.pendingInvestmentWithdrawal.availableAmount)}.`;
      return;
    }

    if (!this.investmentWithdrawalDate) {
      this.investmentWithdrawalError = 'Informe a data do resgate.';
      return;
    }

    const parsedDate = new Date(`${this.investmentWithdrawalDate}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      this.investmentWithdrawalError = 'Data invalida para o resgate.';
      return;
    }

    this.ensureMonthsForDateRangeInMemory(parsedDate, parsedDate);
    const targetMonth = this.monthDefinitions.find(
      (month) => month.year === parsedDate.getFullYear() && month.monthNumber === parsedDate.getMonth() + 1
    );

    if (!targetMonth) {
      this.investmentWithdrawalError = 'Não foi possivel encontrar o mês da data escolhida.';
      return;
    }

    const amountRounded = Number(amount.toFixed(2));
    const baseLabel = this.normalizeText(sourceEvent.label).trim() || 'investimento';
    const withdrawalEvent = this.createEvent(
      parsedDate.getDate(),
      `Resgate de ${baseLabel}`,
      amountRounded,
      'income',
      undefined,
      'single',
      undefined,
      undefined,
      sourceEvent.tags
    );
    withdrawalEvent.investmentSourceEventId = sourceEvent.id;
    withdrawalEvent.investmentMovement = 'withdrawal';

    const previousEvents = [...targetMonth.events];
    targetMonth.events = [...targetMonth.events, withdrawalEvent];

    this.isSavingInvestmentWithdrawal = true;
    this.entriesFeedback = '';

    this.financeApi.updateMonth(targetMonth).subscribe({
      next: () => {
        this.isSavingInvestmentWithdrawal = false;
        this.entriesFeedback = `Resgate registrado: ${this.formatCurrency(amountRounded)} em ${this.formatDateLabel(parsedDate)}.`;
        this.closeInvestmentWithdrawal();
      },
      error: () => {
        targetMonth.events = previousEvents;
        this.isSavingInvestmentWithdrawal = false;
        this.investmentWithdrawalError = 'Não foi possivel registrar o resgate no backend.';
      }
    });
  }

  isEventPaid(event: FinancialEvent): boolean {
    return !!event.paid;
  }

  isPayingEvent(eventId?: string): boolean {
    return !!eventId && this.payingEventIds.has(eventId);
  }

  isPayingEventAction(monthKey: string, event: FinancialEvent): boolean {
    return this.payingEventIds.has(this.getEventPaymentKey(monthKey, event));
  }

  private getEventPaymentKey(monthKey: string, event: FinancialEvent): string {
    return event.id ?? `${monthKey}:${event.seriesId ?? 'event'}:${event.day}:${event.type}:${event.label}:${event.amount}`;
  }

  isDayFullyPaid(day: DayProjection): boolean {
    const payableEvents = day.events.filter((event) => this.canTogglePaid(event));
    if (!payableEvents.length) {
      return false;
    }

    return payableEvents.every((event) => this.isEventPaid(event));
  }

  toggleEventPaid(monthKey: string, event: FinancialEvent): void {
    this.closeDayEntryMenu();

    if (!this.canTogglePaid(event) || this.isPayingEventAction(monthKey, event) || this.isDeletingEvent(event.id)) {
      return;
    }

    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month) {
      return;
    }

    const eventPaymentKey = this.getEventPaymentKey(monthKey, event);
    const paid = !event.paid;
    const paidAt = paid ? this.getTodayInputDate() : undefined;
    const previousEvents = [...month.events];
    const previousOverrides = [...(month.seriesOverrides ?? [])];
    const storedEvent = event.id
      ? month.events.find((item) => item.id === event.id)
      : month.events.find((item) => item === event || (
        item.day === event.day &&
        item.type === event.type &&
        item.label === event.label &&
        item.amount === event.amount
      ));
    const isVirtualSeriesEvent = !!event.seriesId && !storedEvent && this.seriesDefinitions.some(s => s.id === event.seriesId);

    // Virtual series event: store in seriesOverrides
    if (isVirtualSeriesEvent) {
      const seriesId = event.seriesId as string;
      const overrides = month.seriesOverrides ?? [];
      const existingIdx = overrides.findIndex(o => o.seriesId === seriesId && o.day === event.day);
      if (existingIdx >= 0) {
        overrides[existingIdx] = { ...overrides[existingIdx], paid, paidAt };
      } else {
        overrides.push({ seriesId, day: event.day, paid, paidAt });
      }
      month.seriesOverrides = overrides;
    } else {
      // Physical event: modify directly in month.events
      month.events = month.events.map((item) => {
        const isTarget = event.id
          ? item.id === event.id
          : item === event || (
            item.day === event.day &&
            item.type === event.type &&
            item.label === event.label &&
            item.amount === event.amount
          );

        if (!isTarget) {
          return item;
        }

        return {
          ...item,
          paid,
          paidAt,
        };
      });
    }
    this.payingEventIds.add(eventPaymentKey);
    this.refreshActiveDayDetails();
    this.cdr.detectChanges();

    this.entriesFeedback = paid
      ? 'Lançamento marcado como pago.'
      : 'Lançamento marcado como pendente.';
    setTimeout(() => { this.entriesFeedback = ''; }, 3000);

    this.financeApi.updateMonth(month).subscribe({
      next: () => {
        this.payingEventIds.delete(eventPaymentKey);
        this.refreshActiveDayDetails();
        this.cdr.detectChanges();
        this.entriesFeedback = paid
          ? 'Lançamento marcado como pago.'
          : 'Lançamento marcado como pendente.';
        setTimeout(() => { this.entriesFeedback = ''; }, 3000);
      },
      error: () => {
        // Rollback
        if (isVirtualSeriesEvent) {
          month.seriesOverrides = previousOverrides;
        } else {
          month.events = previousEvents;
        }
        this.payingEventIds.delete(eventPaymentKey);
        this.refreshActiveDayDetails();
        this.cdr.detectChanges();
        this.entriesFeedback = 'Não foi possivel atualizar o status de pagamento do lançamento.';
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
        return 'Diária';
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

  /** Indica se o evento faz parte de uma recorrencia (parcelado ou fixo). */
  hasRecurrence(event: FinancialEvent): boolean {
    // Importante: nao usar `seriesId` como fallback — eventos legados podem ter
    // `seriesId` mesmo apos a recorrencia ter sido removida, levando ao icone aparecer
    // em lancamentos que efetivamente nao repetem mais. Exigimos `recurrenceKind`
    // explicito como fonte de verdade.
    return !!event && (event.recurrenceKind === 'installment' || event.recurrenceKind === 'fixed');
  }

  /**
   * Texto descritivo do tipo de recorrencia, usado como tooltip e
   * tambem como aria-label do icone na lista de lancamentos.
   * Combina `recurrenceKind` (parcelado/fixo) com `repeatMode` (diario/semanal/mensal)
   * para detalhar a frequencia.
   */
  getRecurrenceLabel(event: FinancialEvent): string {
    if (!this.hasRecurrence(event)) {
      return '';
    }

    const repeatLabel = (() => {
      switch (event.repeatMode) {
        case 'daily': return 'todo dia';
        case 'weekly': return 'toda semana';
        case 'monthly': return 'todo mês';
        default: return '';
      }
    })();

    if (event.recurrenceKind === 'installment') {
      const totals = event.seriesOccurrences ? `em ${event.seriesOccurrences}x` : '';
      const parts = ['Parcelado', totals, repeatLabel ? `(${repeatLabel})` : ''].filter(Boolean);
      return parts.join(' ');
    }

    if (event.recurrenceKind === 'fixed') {
      const parts = ['Recorrência fixa', repeatLabel ? `(${repeatLabel})` : ''].filter(Boolean);
      return parts.join(' ');
    }

    // Fallback (seriesId presente sem kind explicito)
    return repeatLabel ? `Repete ${repeatLabel}` : 'Faz parte de uma serie';
  }

  getSecondaryInfo(event: FinancialEvent): string {
    const parts: string[] = [];
    if (event.type === 'income') parts.push('Receita');
    if (event.type === 'investment') parts.push('Investimento');
    if (event.type === 'daily') parts.push('Diária');
    if (event.tags && event.tags.length > 0) {
      parts.push(event.tags.join(', '));
    }
    if (this.hasRecurrence(event)) {
      parts.push(this.getRecurrenceLabel(event));
    }
    return parts.join(' • ');
  }

  trackMonthBy(_index: number, month: MonthSummary): string {
    return month.key;
  }

  trackDayBy(_index: number, day: DayProjection): number {
    return day.day;
  }

  trackEventBy(index: number, event: FinancialEvent): string {
    const paidFlag = event.paid ? '-p' : '';
    if (event.id) {
      return `${event.id}${paidFlag}`;
    }

    return `${event.seriesId ?? 'evt'}-${event.day}-${event.amount}-${event.type}-${index}${paidFlag}`;
  }

  trackSimplifiedEntryBy(_index: number, entry: SimplifiedMonthEntry): string {
    return entry.key;
  }

  get sortedEvents(): FinancialEvent[] {
    if (!this.activeDayDetails) {
      return [];
    }

    const events = this.activeDayDetails.day.events;
    switch (this.sortMode) {
      case 'highest':
        return [...events].sort((a, b) => b.amount - a.amount);
      case 'lowest':
        return [...events].sort((a, b) => a.amount - b.amount);
      default:
        return events;
    }
  }

  onSortChange(): void {
    this.cdr.detectChanges();
  }

  getEventIcon(event: FinancialEvent): string {
    switch (event.type) {
      case 'income':      return '↑';
      case 'expense':     return '↓';
      case 'investment':  return '📈';
      case 'daily':       return '📅';
      default:            return '📌';
    }
  }

  hasEventActions(event: FinancialEvent): boolean {
    return this.canTogglePaid(event) || event.type === 'income' || event.type === 'daily' || event.type === 'investment' || this.hasSeries(event);
  }

  isRecurring(event: FinancialEvent): boolean {
    return this.hasRecurrence(event);
  }

  getChipLabel(event: FinancialEvent): string {
    if (this.hasRecurrence(event)) {
      return 'Fixa';
    }
    return 'Variável';
  }

  // ── Novos helpers para o redesign da modal "Detalhes do Dia" ────────────────

  getFinancialTypeBadge(event: FinancialEvent): string {
    switch (event.type) {
      case 'income': return 'ENTRADA';
      case 'investment': return 'INVESTIMENTO';
      default: return 'SAÍDA';
    }
  }

  getBehaviorChip(event: FinancialEvent): string {
    if (!this.hasRecurrence(event)) return 'Variável';
    if (event.recurrenceKind === 'installment') return 'Parcelado';
    return 'Recorrente';
  }

  getPeriodicityChip(event: FinancialEvent): string {
    if (!this.hasRecurrence(event)) return 'Sem repetição';
    if (event.recurrenceKind === 'installment') {
      return event.seriesOccurrences ? `${event.seriesOccurrences} parcelas` : 'Parcelado';
    }
    switch (event.repeatMode) {
      case 'daily': return 'Todo dia';
      case 'weekly': return 'Toda semana';
      case 'monthly': return 'Todo mês';
      default: return 'Recorrente';
    }
  }

  getEventDescription(event: FinancialEvent): string {
    const base = event.type === 'income' ? 'Receita' : event.type === 'investment' ? 'Investimento' : 'Despesa';
    if (!this.hasRecurrence(event)) {
      if (event.type === 'daily') return `${base} diária avulsa`;
      return `${base} ${event.type === 'income' ? 'avulsa' : 'avulsa'}`;
    }
    if (event.recurrenceKind === 'installment') {
      return `Parcelado em ${event.seriesOccurrences ?? 'N'}x`;
    }
    const freq = (() => {
      switch (event.repeatMode) {
        case 'daily': return 'diária';
        case 'weekly': return 'semanal';
        case 'monthly': return 'mensal';
        default: return 'recorrente';
      }
    })();
    return `${base} recorrente ${freq}`;
  }

  getEventValueClass(event: FinancialEvent): string {
    if (event.type === 'income') return 'text-income';
    return 'text-expense';
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

  setViewMode(mode: 'custom' | '1month' | '3month' | '12month' | 'balance'): void {
    this.viewMode = mode;
    this.mobileEntriesControlsOpen = false;
    this.mobileSimplifiedSummaryOpen = false;

    if (mode === '12month' || mode === 'balance') {
      const anchor = mode === 'balance'
        ? this.monthSummaries.find((month) => month.year === this.twelveMonthYear) ?? this.visibleMonths[0] ?? this.monthSummaries[0]
        : this.visibleMonths[0] ?? this.monthSummaries[0];
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

  toggleDayEntryMenu(event: Event, targetEvent: FinancialEvent): void {
    event.stopPropagation();
    this.activeContextMenuEvent =
      this.activeContextMenuEvent === targetEvent ? null : targetEvent;
  }

  closeDayEntryMenu(): void {
    this.activeContextMenuEvent = null;
  }

  duplicateEvent(event: FinancialEvent): void {
    this.closeDayEntryMenu();
    this.openDuplicateLaunchForm(event);
  }

  openMoveEventPrompt(event: FinancialEvent): void {
    this.closeDayEntryMenu();
    this.entriesFeedback = 'Função "Mover" será implementada em breve.';
    setTimeout(() => { this.entriesFeedback = ''; }, 3000);
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

  closeDayNotes(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.target as HTMLElement | null;
    const details = trigger?.closest('details.day-notes') as HTMLDetailsElement | null;
    if (details) {
      details.open = false;
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
    const currentDay = currentMonth
      ? this.getFilteredMonthProjection(currentMonth).find((day) => day.day === this.activeDayDetails?.day.day)
      : undefined;

    if (!currentMonth || !currentDay) {
      this.activeDayDetails = null;
      return;
    }

    const sortedEvents = [...currentDay.events].sort((a, b) => {
      const aPaid = this.canTogglePaid(a) && this.isEventPaid(a) ? 1 : 0;
      const bPaid = this.canTogglePaid(b) && this.isEventPaid(b) ? 1 : 0;
      return aPaid - bPaid;
    });

    this.activeDayDetails = {
      month: currentMonth,
      day: {
        ...currentDay,
        events: sortedEvents,
      },
    };
  }

  goToCurrentMonth(): void {
    this.mobileEntriesControlsOpen = false;
    this.mobileSimplifiedSummaryOpen = false;

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

    if (this.viewMode === '12month' || this.viewMode === 'balance') {
      this.twelveMonthYear = today.getFullYear();
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    if (this.viewMode === '1month') {
      this.windowStartIndex = currentMonthIndex;
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

    if (this.viewMode === '1month') {
      this.mobileSimplifiedSummaryOpen = false;
    }

    if (this.viewMode === '12month' || this.viewMode === 'balance') {
      this.twelveMonthYear -= 1;
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    const step = this.viewMode === '1month' ? 1 : this.windowSize;
    this.windowStartIndex = Math.max(0, this.windowStartIndex - step);
  }

  goToNextWindow(): void {
    if (!this.canGoNext) {
      return;
    }

    if (this.viewMode === '1month') {
      this.mobileSimplifiedSummaryOpen = false;
    }

    if (this.viewMode === '12month' || this.viewMode === 'balance') {
      this.twelveMonthYear += 1;
      this.ensureYearMonths(this.twelveMonthYear);
      return;
    }

    const step = this.viewMode === '1month' ? 1 : this.windowSize;
    const visibleCount = this.viewMode === '1month' ? 1 : this.windowSize;
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
    this.selectedExistingTag = '';
    this.syncLaunchAmountInput();
    this.isLaunchFormOpen = true;
  }

  openDuplicateLaunchForm(event: FinancialEvent): void {
    this.closeFabMenu();
    this.launchError = '';
    this.dailyError = '';
    this.entriesFeedback = '';
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
    this.launchForm = {
      type: event.type,
      amount: event.amount,
      date: '',
      label: event.label,
      recurrenceKind: event.recurrenceKind ?? 'single',
      repeatMode: event.repeatMode ?? 'monthly',
      installments: event.seriesOccurrences ?? 1,
      tags: [...(event.tags ?? [])],
    };
    this.selectedExistingTag = '';
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
    this.saveAndNewDailyRequested = false;
    this.dailyForm = this.createEmptyDailyForm();
    this.syncDailyAmountInput();
    this.isDailyFormOpen = true;
  }

  openCardLaunchForm(): void {
    this.closeFabMenu();
    this.setActiveTab('cards');
    this.cdr.detectChanges();
    setTimeout(() => {
      this.cardsTab?.openLaunchModalFromShortcut();
    }, 0);
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
      installments: 1,
      tags: []
    };
    this.selectedExistingTag = '';
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
      installments: scope !== 'single' ? event.seriesOccurrences ?? 1 : 1,
      tags: event.tags ?? []
    };
    this.selectedExistingTag = '';
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
      description: event.label ?? '',
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
    this.newTagInput = '';
    this.selectedExistingTag = '';
    this.isCreatingLaunchTag = false;
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
    this.saveAndNewDailyRequested = false;
    this.editingEventId = null;
    this.editingSeriesId = null;
    this.editingScope = null;
    this.editingSourceMonthKey = null;
    this.editingAnchorDay = null;
  }

  submitDailyFormAndAddAnother(): void {
    if (this.isSavingLaunch || this.isEditingLaunch) {
      return;
    }

    this.saveAndNewDailyRequested = true;
    this.submitDailyForm();
  }

  deleteEvent(monthKey: string, eventId?: string, scope: DeleteActionScope = 'single'): void {
    if (!eventId || this.deletingEventIds.has(eventId)) {
      return;
    }

    const month = this.monthDefinitions.find((item) => item.key === monthKey);
    if (!month) {
      return;
    }

    let event = month.events.find((item) => item.id === eventId);

    // Virtual series event: find in expanded view instead
    if (!event) {
      event = this.getMonthEvents(month).find((item) => item.id === eventId);
    }

    if (!event) {
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
    let hasChanged = false;

    // Virtual series event: add skip override
    if (!targetEvent && eventId) {
      const virtualSource = this.getMonthEvents(month).find(e => e.id === eventId);
      if (virtualSource?.seriesId && this.seriesDefinitions.some(s => s.id === virtualSource.seriesId)) {
        const overrides = month.seriesOverrides ?? [];
        const existingIdx = overrides.findIndex(o => o.seriesId === virtualSource.seriesId && o.day === virtualSource.day);
        if (existingIdx >= 0) {
          overrides[existingIdx] = { ...overrides[existingIdx], action: 'skip' };
        } else {
          overrides.push({ seriesId: virtualSource.seriesId, day: virtualSource.day, action: 'skip' });
        }
        month.seriesOverrides = overrides;
        hasChanged = true;
      }
    }

    if (!hasChanged) {
      if (!targetEvent) {
        return;
      }

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
    }

    if (!hasChanged) {
      return;
    }

    this.entriesFeedback = '';
    this.deletingEventIds.add(eventId);

    this.financeApi.updateMonth(month).subscribe({
      next: () => {
        this.refreshActiveDayDetails();
        this.deletingEventIds.delete(eventId);
        this.entriesFeedback = eventType === 'daily' ? 'Diária removida.' : 'Lançamento removido.';
      },
      error: () => {
        month.events = previousEvents;
        this.deletingEventIds.delete(eventId);
        this.entriesFeedback = eventType === 'daily'
          ? 'Não foi possivel excluir a diária. Confira o backend e tente novamente.'
          : 'Não foi possivel excluir o lançamento. Confira o backend e tente novamente.';
      }
    });
  }

  submitLaunchForm(): void {
    if (this.isSavingLaunch) {
      return;
    }

    this.commitPendingTagInput();

    const keepOpenAfterSave = this.saveAndNewLaunchRequested && !this.isEditingLaunch;
    this.saveAndNewLaunchRequested = false;

    this.launchError = '';

    if (!this.launchForm.date) {
      this.launchError = 'Informe a data do lançamento.';
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
    const seriesId = recurrenceKind !== 'single' ? this.generateEventId() : undefined;

    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      this.launchForm.type,
      amount,
      label,
      recurrenceKind,
      repeatMode,
      installments,
      seriesId,
      this.launchForm.tags
    );

    if (!touchedMonths.length) {
      this.isSavingLaunch = false;
      this.launchError = 'Não foi possivel aplicar a repetição dentro dos meses carregados.';
      return;
    }

    const saveOps: Observable<unknown>[] = touchedMonths.map((month) => this.financeApi.updateMonth(month));

    if (seriesId && repeatMode === 'monthly') {
      const monthKey = `${year}-${String(monthNumber).padStart(2, '0')}`;
      const now = new Date().toISOString();
      const series: SeriesDefinition = {
        id: seriesId,
        label,
        amount,
        type: this.launchForm.type,
        day: parsedDate.getDate(),
        repeatMode,
        recurrenceKind,
        seriesOccurrences: recurrenceKind === 'installment' ? installments : null,
        tags: this.launchForm.tags?.length ? this.launchForm.tags : undefined,
        isActive: true,
        createdInMonthKey: monthKey,
        createdAt: now,
        updatedAt: now,
      };
      this.seriesDefinitions = [...this.seriesDefinitions, series];
      saveOps.push(this.financeApi.saveSeries(series));
    }

    forkJoin(saveOps).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.syncTagCatalogWithEvents();
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
        this.launchError = 'Não foi possivel salvar no backend. Confira se o servidor esta ativo.';
      }
    });
  }

  submitDailyForm(): void {
    if (this.isSavingLaunch) {
      return;
    }

    const keepOpenAfterSave = this.saveAndNewDailyRequested && !this.isEditingLaunch;
    this.saveAndNewDailyRequested = false;

    this.dailyError = '';

    if (!this.dailyForm.effectiveDate) {
      this.dailyError = 'Informe a data inicial da diária.';
      return;
    }

    if (this.dailyForm.amount === null || Number.isNaN(this.dailyForm.amount) || this.dailyForm.amount <= 0) {
      this.dailyError = 'Informe um valor valido para a diária.';
      return;
    }

    const parsedDate = new Date(`${this.dailyForm.effectiveDate}T00:00:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      this.dailyError = 'Não foi possivel identificar a data efetiva da diária.';
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
      this.dailyError = 'Informe uma quantidade valida de repetições para a diária.';
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
    const description = this.dailyForm.description?.trim() || 'diária manual';
    const touchedMonths = this.applyRecurringLaunches(
      parsedDate,
      'daily',
      amount,
      description,
      recurrenceKind,
      repeatMode ?? 'monthly',
      installments
    );

    if (!touchedMonths.length) {
      this.isSavingLaunch = false;
      this.dailyError = 'Não foi possivel aplicar a diária dentro dos meses carregados.';
      return;
    }

    forkJoin(touchedMonths.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Diária criada.';

        if (keepOpenAfterSave) {
          const preferredEffectiveDate = this.dailyForm.effectiveDate || this.getTodayInputDate();
          this.dailyError = '';
          this.dailyForm = this.createEmptyDailyForm(preferredEffectiveDate);
          this.syncDailyAmountInput();
          return;
        }

        this.closeDailyForm();
      },
      error: () => {
        this.isSavingLaunch = false;
        this.dailyError = 'Não foi possivel salvar a diária no backend.';
      }
    });
  }

  onLaunchTypeChange(type: LaunchType): void {
    this.launchForm.type = type;

    if (type !== 'investment') {
      this.clearInvestmentGoalTagFromLaunch();
    }

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

  onInvestmentGoalSelected(goalName: string): void {
    this.clearInvestmentGoalTagFromLaunch();

    if (!goalName) {
      return;
    }

    const normalizedGoalName = this.normalizeTagName(goalName);
    const selectedOption = this.investmentGoalOptions.find((option) => option.normalizedName === normalizedGoalName);
    this.addTagToLaunch(selectedOption?.name ?? goalName);
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
      this.launchError = 'Não foi possivel identificar o lançamento para edição.';
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

    // Virtual series event: add override instead of modifying events array
    if (!originalEvent && this.editingEventId) {
      const virtualSource = this.getMonthEvents(sourceMonth).find(e => e.id === this.editingEventId);
      if (virtualSource?.seriesId && this.seriesDefinitions.some(s => s.id === virtualSource.seriesId)) {
        const month = targetMonth;
        const overrides = month.seriesOverrides ?? [];
        const existingIdx = overrides.findIndex(o => o.seriesId === virtualSource.seriesId && o.day === virtualSource.day);
        const override = { seriesId: virtualSource.seriesId, day: parsedDate.getDate(), amount, label };
        if (existingIdx >= 0) {
          overrides[existingIdx] = { ...overrides[existingIdx], ...override };
        } else {
          overrides.push(override);
        }
        month.seriesOverrides = overrides;

        this.isSavingLaunch = true;
        this.financeApi.updateMonth(month).subscribe({
          next: () => {
            this.isSavingLaunch = false;
            this.entriesFeedback = 'Lançamento atualizado.';
            this.closeLaunchForm();
          },
          error: () => {
            this.isSavingLaunch = false;
            this.launchError = 'Não foi possivel salvar a edição no backend.';
          }
        });
        return;
      }

      this.launchError = 'Lançamento não encontrado para editar.';
      return;
    }

    if (!originalEvent) {
      this.launchError = 'Lançamento não encontrado para editar.';
      return;
    }

    sourceMonth.events = sourceMonth.events.filter((event) => event.id !== this.editingEventId);

    const updatedEvent: FinancialEvent = {
      ...originalEvent,
      day: parsedDate.getDate(),
      amount,
      label,
      type: this.launchForm.type,
      tags: this.launchForm.tags.length > 0 ? this.launchForm.tags : undefined
    };

    targetMonth.events = [...targetMonth.events, updatedEvent];

    const monthsToSave = sourceMonth === targetMonth ? [sourceMonth] : [sourceMonth, targetMonth];

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.refreshActiveDayDetails();
        this.entriesFeedback = 'Lançamento atualizado.';
        this.closeLaunchForm();
      },
      error: () => {
        sourceMonth.events = originalSourceEvents;
        if (sourceMonth !== targetMonth) {
          targetMonth.events = originalTargetEvents;
        }
        this.isSavingLaunch = false;
        this.launchError = 'Não foi possivel salvar a edição no backend.';
      }
    });
  }

  private submitDailySingleEdit(parsedDate: Date, amount: number): void {
    if (!this.editingEventId || !this.editingSourceMonthKey) {
      this.dailyError = 'Não foi possivel identificar a diária para edição.';
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
      this.dailyError = 'Diária não encontrada para editar.';
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
          label: this.dailyForm.description?.trim() || event.label,
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
        amount,
        label: this.dailyForm.description?.trim() || originalEvent.label
      };

      targetMonth.events = [...targetMonth.events, updatedEvent];
    }

    const monthsToSave = sourceMonth === targetMonth ? [sourceMonth] : [sourceMonth, targetMonth];

    this.isSavingLaunch = true;
    forkJoin(monthsToSave.map((month) => this.financeApi.updateMonth(month))).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Diária atualizada.';
        this.closeDailyForm();
      },
      error: () => {
        sourceMonth.events = originalSourceEvents;
        if (sourceMonth !== targetMonth) {
          targetMonth.events = originalTargetEvents;
        }
        this.isSavingLaunch = false;
        this.dailyError = 'Não foi possivel salvar a edição da diária.';
      }
    });
  }

  private submitDailySeriesEdit(parsedDate: Date, amount: number, recurrenceKind: RecurrenceKind, repeatMode: RepeatMode | null, installments: number): void {
    if (!this.editingSeriesId) {
      this.dailyError = 'Não foi possivel identificar a serie de diária.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const referenceEvent = this.findEventBySeriesId(this.editingSeriesId);
    if (!referenceEvent) {
      this.dailyError = 'Serie de diária não encontrada.';
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
      this.dailyForm.description?.trim() || referenceEvent.label,
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
        this.entriesFeedback = 'Serie de diária atualizada.';
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
        this.dailyError = 'Não foi possivel salvar a serie de diária.';
      }
    });
  }

  private submitDailyForwardSeriesEdit(parsedDate: Date, amount: number, recurrenceKind: RecurrenceKind, repeatMode: RepeatMode | null, installments: number): void {
    if (!this.editingSeriesId || !this.editingSourceMonthKey || this.editingAnchorDay === null) {
      this.dailyError = 'Não foi possivel identificar a recorrência de diária para edição.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const referenceEvent = this.findEventBySeriesId(this.editingSeriesId);
    if (!referenceEvent) {
      this.dailyError = 'Serie de diária não encontrada.';
      return;
    }

    const triggerMonthIndex = this.monthDefinitions.findIndex((month) => month.key === this.editingSourceMonthKey);
    if (triggerMonthIndex < 0) {
      this.dailyError = 'Não foi possivel identificar o ponto inicial da edição.';
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
      this.dailyForm.description?.trim() || referenceEvent.label,
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
        this.entriesFeedback = 'Esta diária e as próximas foram atualizadas.';
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
        this.dailyError = 'Não foi possivel salvar esta diária e as próximas.';
      }
    });
  }

  private submitSeriesEdit(parsedDate: Date, amount: number, label: string): void {
    if (!this.editingSeriesId) {
      this.launchError = 'Não foi possivel identificar a serie para edição.';
      return;
    }

    const existingSeries = this.seriesDefinitions.find(s => s.id === this.editingSeriesId);
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
      this.editingSeriesId,
      this.launchForm.tags
    );

    const monthsToSave = this.monthDefinitions.filter((month) => {
      const previous = backups.get(month.key);
      if (!previous) {
        return touchedMonths.some((item) => item.key === month.key);
      }

      return previous.length !== month.events.length || touchedMonths.some((item) => item.key === month.key);
    });

    if (!monthsToSave.length && !existingSeries) {
      for (const [monthKey, events] of backups) {
        const month = this.monthDefinitions.find((item) => item.key === monthKey);
        if (month) {
          month.events = events;
        }
      }
      this.launchError = 'Não foi possivel aplicar a edição da serie.';
      return;
    }

    this.isSavingLaunch = true;
    const saveOps: Observable<unknown>[] = monthsToSave.map((month) => this.financeApi.updateMonth(month));

    if (existingSeries && existingSeries.repeatMode === 'monthly') {
      existingSeries.amount = amount;
      existingSeries.label = label;
      existingSeries.tags = this.launchForm.tags;
      existingSeries.updatedAt = new Date().toISOString();
      saveOps.push(this.financeApi.saveSeries(existingSeries));
    }

    forkJoin(saveOps).subscribe({
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
        this.launchError = 'Não foi possivel salvar a serie no backend.';
      }
    });
  }

  private submitForwardSeriesEdit(parsedDate: Date, amount: number, label: string): void {
    if (!this.editingSeriesId || !this.editingSourceMonthKey || this.editingAnchorDay === null) {
      this.launchError = 'Não foi possivel identificar a recorrência para edição.';
      return;
    }

    const anchorDay = this.editingAnchorDay;
    const triggerMonthIndex = this.monthDefinitions.findIndex((month) => month.key === this.editingSourceMonthKey);
    if (triggerMonthIndex < 0) {
      this.launchError = 'Não foi possivel identificar o ponto inicial da edição.';
      return;
    }

    const existingSeries = this.seriesDefinitions.find(s => s.id === this.editingSeriesId);
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
      this.editingSeriesId,
      this.launchForm.tags
    );

    const monthsToSave = this.monthDefinitions.filter((month) => backups.has(month.key) || touchedMonths.some((item) => item.key === month.key));
    const now = new Date().toISOString();

    this.isSavingLaunch = true;
    const saveOps: Observable<unknown>[] = monthsToSave.map((month) => this.financeApi.updateMonth(month));

    // Virtual series: end the original and create a new one from anchor forward
    if (existingSeries && existingSeries.repeatMode === 'monthly') {
      const prevMonth = this.monthDefinitions[triggerMonthIndex - 1];
      existingSeries.endedInMonthKey = prevMonth ? prevMonth.key : this.editingSourceMonthKey;
      existingSeries.updatedAt = now;
      saveOps.push(this.financeApi.saveSeries(existingSeries));

      const newSeriesId = this.generateEventId();
      const newSeries: SeriesDefinition = {
        ...existingSeries,
        id: newSeriesId,
        amount,
        label,
        tags: this.launchForm.tags,
        endedInMonthKey: undefined,
        createdInMonthKey: this.editingSourceMonthKey,
        createdAt: now,
        updatedAt: now,
      };
      this.seriesDefinitions = [...this.seriesDefinitions, newSeries];
      saveOps.push(this.financeApi.saveSeries(newSeries));

      // Update events in months to use new seriesId
      for (const month of touchedMonths) {
        for (const event of month.events) {
          if (event.seriesId === this.editingSeriesId) {
            event.seriesId = newSeriesId;
          }
        }
      }
    }

    forkJoin(saveOps).subscribe({
      next: () => {
        this.isSavingLaunch = false;
        this.entriesFeedback = 'Este lançamento e os próximos foram atualizados.';
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
        this.launchError = 'Não foi possivel salvar este lançamento e os próximos.';
      }
    });
  }

  getTagBadgeStyle(tagName: string): Record<string, string> {
    const base = this.getTagColor(tagName);
    return {
      '--tag-bg': this.hexToRgba(base, 0.16),
      '--tag-border': this.hexToRgba(base, 0.36),
      '--tag-fg': base
    };
  }

  selectSuggestedTag(tagName: string): void {
    this.addTagToLaunch(tagName);
    this.newTagInput = '';
  }

  onExistingTagSelected(tagName: string): void {
    this.selectedExistingTag = tagName;
    if (!tagName) {
      return;
    }

    this.addTagToLaunch(tagName);
    this.selectedExistingTag = '';
  }

  onTagInputEnter(event: Event): void {
    event.preventDefault();
    this.createNewTagFromInput();
  }

  /** Alterna o campo de tag do modal de lancamento para o input inline de criacao. */
  startCreatingLaunchTag(): void {
    this.isCreatingLaunchTag = true;
    this.newTagInput = '';
  }

  /** Cancela a criacao inline e volta ao select. */
  cancelCreatingLaunchTag(): void {
    this.isCreatingLaunchTag = false;
    this.newTagInput = '';
  }

  /** Confirma a criacao da nova tag e volta ao modo select. */
  confirmCreatingLaunchTag(): void {
    const trimmed = this.newTagInput.trim();
    if (!trimmed) {
      return;
    }
    this.createNewTagFromInput();
    this.isCreatingLaunchTag = false;
  }

  private defaultLabelForType(type: LaunchType): string {
    if (type === 'income') {
      return 'entrada manual';
    }

    if (type === 'expense') {
      return 'saída manual';
    }

    if (type === 'investment') {
      return 'investimento manual';
    }

    return 'diária manual';
  }

  private createEmptyLaunchForm(): LaunchFormState {
    return {
      type: 'expense',
      amount: null,
      date: this.getTodayInputDate(),
      label: '',
      recurrenceKind: 'single',
      repeatMode: 'monthly',
      installments: 1,
      tags: []
    };
  }

  private createEmptyDailyForm(effectiveDate = this.getTodayInputDate()): DailyFormState {
    return {
      amount: null,
      effectiveDate,
      description: '',
      repeatMode: 'none',
      recurrenceKind: 'fixed',
      installments: 1
    };
  }

  addTagToLaunch(tag: string): void {
    const trimmedTag = this.normalizeTagLabel(tag);
    if (!trimmedTag) {
      return;
    }

    const catalogTag = this.findTagInCatalog(trimmedTag) ?? this.createCatalogTag(trimmedTag);
    const tagExists = this.launchForm.tags.some(t => this.normalizeTagName(t) === this.normalizeTagName(catalogTag.name));
    if (!tagExists) {
      this.launchForm.tags.push(catalogTag.name);
      this.newTagInput = '';
    }
  }

  removeTagFromLaunch(tag: string): void {
    this.launchForm.tags = this.launchForm.tags.filter(t => t !== tag);
  }

  createNewTagFromInput(): void {
    const newTag = this.normalizeTagLabel(this.newTagInput);
    if (!newTag) {
      this.newTagInput = '';
      return;
    }

    const existingTag = this.findTagInCatalog(newTag);
    if (existingTag) {
      this.addTagToLaunch(existingTag.name);
      this.newTagInput = '';
      return;
    }

    const createdTag = this.createCatalogTag(newTag);
    this.addTagToLaunch(createdTag.name);
    this.persistAvailableTags();
  }

  private commitPendingTagInput(): void {
    if (!this.newTagInput.trim()) {
      return;
    }

    this.createNewTagFromInput();
  }

  getTagColor(tagName: string): string {
    return this.findTagInCatalog(tagName)?.color ?? '#1f5cc2';
  }

  private tagsSubscription?: Subscription;
  private investmentGoalsSubscription?: Subscription;

  private loadAvailableTags(): void {
    this.tagsSubscription?.unsubscribe();
    this.tagsSubscription = this.tagsService.tags$.subscribe((tags) => {
      this.availableTags = tags.map((tag) => ({ name: tag.name, color: tag.color }));
      // NOTE: NÃO chamar syncTagCatalogWithEvents() aqui — isso gera loop:
      // tags$ emite → sync detecta diff de normalização → persiste → Firestore
      // reemite → loop infinito que congela a aba. A propagação a partir dos
      // eventos já é feita em loadMonths() depois que os meses chegam.
    });
  }

  private persistAvailableTags(): void {
    void this.tagsService.upsertMany(this.availableTags);
  }

  private loadInvestmentGoals(): void {
    this.investmentGoalsSubscription?.unsubscribe();
    this.investmentGoalsSubscription = this.budgetsService.budgets$.subscribe((budgets) => {
      const seen = new Set<string>(this.defaultInvestmentGoalAliases);
      const options: Array<{ name: string; normalizedName: string }> = [
        this.defaultInvestmentGoalOption
      ];

      for (const budget of budgets) {
        if (budget.scope !== 'investment' || budget.active === false) {
          continue;
        }

        const label = this.normalizeTagLabel(budget.targetName || budget.targetId);
        if (!label) {
          continue;
        }

        const normalizedName = this.normalizeTagName(label);
        if (seen.has(normalizedName)) {
          continue;
        }

        seen.add(normalizedName);
        options.push({ name: label, normalizedName });
      }

      options.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      this.investmentGoalOptions = options;
      if (this.launchForm.type !== 'investment') {
        return;
      }

      const selected = this.selectedInvestmentGoalName;
      if (!selected) {
        this.clearInvestmentGoalTagFromLaunch();
      }
    });
  }

  private clearInvestmentGoalTagFromLaunch(): void {
    if (!this.launchForm.tags.length) {
      return;
    }

    const goalNames = new Set([
      ...this.defaultInvestmentGoalAliases,
      ...this.investmentGoalOptions.map((option) => option.normalizedName)
    ]);
    this.launchForm.tags = this.launchForm.tags.filter((tag) => !goalNames.has(this.normalizeTagName(tag)));
  }

  private syncTagCatalogWithEvents(): void {
    const normalizedNames = new Set(this.availableTags.map((tag) => this.normalizeTagName(tag.name)));
    let changed = false;

    for (const series of this.seriesDefinitions) {
      for (const rawTag of series.tags ?? []) {
        const tagName = this.normalizeTagLabel(rawTag);
        if (!tagName) {
          continue;
        }

        const normalizedName = this.normalizeTagName(tagName);
        if (normalizedNames.has(normalizedName)) {
          continue;
        }

        this.availableTags.push({
          name: tagName,
          color: this.pickTagColor(this.availableTags)
        });
        normalizedNames.add(normalizedName);
        changed = true;
      }
    }

    for (const month of this.monthDefinitions) {
      for (const event of month.events) {
        for (const rawTag of event.tags ?? []) {
          const tagName = this.normalizeTagLabel(rawTag);
          if (!tagName) {
            continue;
          }

          const normalizedName = this.normalizeTagName(tagName);
          if (normalizedNames.has(normalizedName)) {
            continue;
          }

          this.availableTags.push({
            name: tagName,
            color: this.pickTagColor(this.availableTags)
          });
          normalizedNames.add(normalizedName);
          changed = true;
        }
      }
    }

    if (changed) {
      this.persistAvailableTags();
    }
  }

  private normalizeStoredTagCatalog(payload: unknown): LaunchTagCatalogItem[] {
    if (!Array.isArray(payload)) {
      return [];
    }

    const normalized: LaunchTagCatalogItem[] = [];

    for (const item of payload) {
      if (typeof item === 'string') {
        const label = this.normalizeTagLabel(item);
        if (!label || normalized.some((tag) => this.normalizeTagName(tag.name) === this.normalizeTagName(label))) {
          continue;
        }

        normalized.push({
          name: label,
          color: this.pickTagColor(normalized)
        });
        continue;
      }

      if (item && typeof item === 'object') {
        const candidate = item as { name?: unknown; color?: unknown };
        const label = this.normalizeTagLabel(String(candidate.name ?? ''));
        if (!label || normalized.some((tag) => this.normalizeTagName(tag.name) === this.normalizeTagName(label))) {
          continue;
        }

        const color = typeof candidate.color === 'string' && candidate.color.trim().length
          ? candidate.color.trim()
          : this.pickTagColor(normalized);

        normalized.push({ name: label, color });
      }
    }

    return normalized;
  }

  private createCatalogTag(tagName: string): LaunchTagCatalogItem {
    const normalizedName = this.normalizeTagLabel(tagName);
    const existing = this.findTagInCatalog(normalizedName);
    if (existing) {
      return existing;
    }

    const created: LaunchTagCatalogItem = {
      name: normalizedName,
      color: this.pickTagColor(this.availableTags)
    };

    this.availableTags = [...this.availableTags, created];
    this.persistAvailableTags();
    return created;
  }

  private findTagInCatalog(tagName: string): LaunchTagCatalogItem | undefined {
    const normalized = this.normalizeTagName(tagName);
    return this.availableTags.find((tag) => this.normalizeTagName(tag.name) === normalized);
  }

  private normalizeTagName(value: string): string {
    return this.normalizeText(value).trim().toLocaleLowerCase('pt-BR');
  }

  private getLaunchAdviceMetricLabel(type: LaunchType): string {
    switch (type) {
      case 'income':
        return 'Entrada';
      case 'investment':
        return 'Investimento';
      case 'daily':
        return 'Diária';
      default:
        return 'Saida';
    }
  }

  private normalizeTagLabel(value: string): string {
    const normalized = this.normalizeText(value).trim();
    if (!normalized) {
      return '';
    }

    return normalized.replace(/\s+/g, ' ');
  }

  private pickTagColor(catalog: LaunchTagCatalogItem[]): string {
    const usedColors = new Set(catalog.map((tag) => tag.color.toLowerCase()));
    const availableColor = this.tagPalette.find((color) => !usedColors.has(color.toLowerCase()));
    if (availableColor) {
      return availableColor;
    }

    return this.tagPalette[catalog.length % this.tagPalette.length];
  }

  private hexToRgba(hex: string, alpha: number): string {
    const cleaned = hex.replace('#', '');
    if (cleaned.length !== 6) {
      return `rgba(31, 92, 194, ${alpha})`;
    }

    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);

    if ([r, g, b].some((component) => Number.isNaN(component))) {
      return `rgba(31, 92, 194, ${alpha})`;
    }

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

    this.financeApi.getMonths({ fromYear: new Date().getFullYear() - 1 }).subscribe({
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
          this.syncTagCatalogWithEvents();
          this.isLoading = false;
          return;
        }

        this.loadSeriesAndFinish(hadMonthsBefore);
      },
      error: () => {
        this.monthDefinitions = [];
        this.seriesDefinitions = [];
        this.isLoading = false;
        this.dataError = 'Não foi possivel carregar os dados do backend. Inicie o servidor local e tente novamente.';
      }
    });
  }

  private loadSeriesAndFinish(hadMonthsBefore: boolean): void {
    this.financeApi.getSeries().subscribe({
      next: (series) => {
        this.seriesDefinitions = series.filter(s => s.isActive);
        this.finishLoadingMonths(hadMonthsBefore);
      },
      error: () => {
        this.seriesDefinitions = [];
        this.finishLoadingMonths(hadMonthsBefore);
      }
    });
  }

  private finishLoadingMonths(hadMonthsBefore: boolean): void {
    if (!hadMonthsBefore) {
      this.syncWindowToCurrentMonth();
    }

    this.syncTagCatalogWithEvents();
    this.isLoading = false;
  }

  private parseMonthKey(key: string): { year: number; month: number } | null {
    if (!key) return null;
    const parts = key.split('-');
    if (parts.length !== 2) return null;

    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);

    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      if (a > 12) return { year: a, month: b };
      return { year: b, month: a };
    }

    const MONTH_MAP: Record<string, number> = {
      jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
      jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
    };
    const month = MONTH_MAP[parts[0]?.toLowerCase()];
    const year = parseInt(parts[1], 10);
    if (month && !Number.isNaN(year)) return { year, month };

    return null;
  }

  getMonthEvents(month: MonthDefinition): FinancialEvent[] {
    const events = [...month.events];
    const mY = month.year;
    const mM = month.monthNumber;
    if (!mY || !mM) return events;

    const monthKey = month.key;
    const daysInMonth = new Date(mY, mM, 0).getDate();
    const existingSeriesIds = new Set(
      month.events.filter(e => e.seriesId).map(e => e.seriesId)
    );

    for (const series of this.seriesDefinitions) {
      if (!series.isActive) continue;
      if (series.type === 'daily') continue;

      const parsed = this.parseMonthKey(series.createdInMonthKey);
      if (!parsed) { console.warn('[getMonthEvents] createdInMonthKey invalido', series.createdInMonthKey, series.id?.slice(0,8)); continue; }

      if (parsed.year > mY || (parsed.year === mY && parsed.month > mM)) continue;

      if (series.endedInMonthKey) {
        const ended = this.parseMonthKey(series.endedInMonthKey);
        if (ended && (mY > ended.year || (mY === ended.year && mM > ended.month))) continue;
      }

      if (series.recurrenceKind === 'installment' && series.seriesOccurrences != null && series.seriesOccurrences > 0) {
        const offset = (mY - parsed.year) * 12 + (mM - parsed.month);
        if (offset >= series.seriesOccurrences) continue;
      }

      if (existingSeriesIds.has(series.id)) { continue; }

      const override = month.seriesOverrides?.find(o => o.seriesId === series.id);
      if (override?.action === 'skip') continue;

      const day = Math.min(series.day, daysInMonth);
      const amount = override?.amount ?? series.amount;
      const label = override?.label ?? series.label;

      const virtualEvent: FinancialEvent = {
        id: `v:${series.id}:${monthKey}:${day}`,
        seriesId: series.id,
        recurrenceKind: series.recurrenceKind,
        repeatMode: series.repeatMode,
        seriesOccurrences: series.seriesOccurrences,
        day,
        label,
        amount,
        type: series.type,
        tags: series.tags,
        paid: override?.paid,
        paidAt: override?.paidAt,
      };

      events.push(virtualEvent);
    }

    return events;
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
    forcedSeriesId?: string,
    tags?: string[]
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
      this.pushEventToMonth(this.monthDefinitions[startIndex], this.createEvent(day, label, amount, type, undefined, undefined, undefined, undefined, tags), touched);
      return Array.from(touched.values());
    }

    // Monthly recurring (non-daily): only touch the starting month.
    // SeriesDefinition handles virtual expansion for all months.
    if (repeatMode === 'monthly' && type !== 'daily') {
      this.pushEventToMonth(
        this.monthDefinitions[startIndex],
        this.createEvent(day, label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences, tags),
        touched
      );
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
          this.createEvent(cursor.getDate(), label, amount, type, seriesId, recurrenceKind, repeatMode, seriesOccurrences, tags),
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
      return 'mês indisponivel';
    }

    return `${month.title}/${month.year}`;
  }

  private ensureMonthsForDateRange(startDate: Date, endDate: Date): void {
    const created = this.ensureMonthsForDateRangeInMemory(startDate, endDate);
    if (!created.length) {
      return;
    }

    forkJoin(created.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Não foi possivel persistir alguns meses futuros no backend.';
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

    forkJoin(created.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Não foi possivel atualizar o horizonte de meses no backend.';
      }
    });
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

    this.monthDefinitions = [...this.monthDefinitions, ...created].sort((a, b) => {
      if (a.year === b.year) {
        return a.monthNumber - b.monthNumber;
      }
      return a.year - b.year;
    });

    forkJoin(created.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Não foi possivel persistir alguns meses futuros no backend.';
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

    forkJoin(created.map((month) => this.financeApi.updateMonth(month))).subscribe({
      error: () => {
        this.entriesFeedback = 'Não foi possivel persistir alguns meses do ano selecionado no backend.';
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

    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    this.windowStartIndex = Math.floor(safeIndex / this.windowSize) * this.windowSize;
    this.customStartIndex = safeIndex;
    this.customEndIndex = Math.min(safeIndex + 2, Math.max(this.monthDefinitions.length - 1, 0));
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

  private getInvestmentWithdrawnAmount(investmentEventId: string): number {
    return this.getInvestmentWithdrawnMap().get(investmentEventId) ?? 0;
  }

  private getInvestmentWithdrawnMap(): Map<string, number> {
    const signature = this.summariesCacheSignature || this.computeSummariesSignature();
    if (this.investmentWithdrawnCache && signature === this.investmentWithdrawnCacheSignature) {
      return this.investmentWithdrawnCache;
    }

    const totals = new Map<string, number>();
    for (const month of this.monthDefinitions) {
      for (const event of month.events) {
        if (event.type !== 'income' || !event.investmentSourceEventId || event.suppressed) {
          continue;
        }

        const previous = totals.get(event.investmentSourceEventId) ?? 0;
        totals.set(event.investmentSourceEventId, Number((previous + event.amount).toFixed(2)));
      }
    }

    this.investmentWithdrawnCacheSignature = signature;
    this.investmentWithdrawnCache = totals;
    return totals;
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
    seriesOccurrences?: number | null,
    tags?: string[]
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
      type,
      tags: tags && tags.length > 0 ? tags : undefined
    };
  }

  private generateEventId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }

    return `evt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  getInstallmentReference(event: FinancialEvent, monthKey?: string): string | null {
    if ((event.recurrenceKind ?? 'single') !== 'installment' || !event.seriesId || !monthKey) {
      return null;
    }

    // Series-based computation for virtual events
    if (event.seriesId) {
      const series = this.seriesDefinitions.find(s => s.id === event.seriesId);
      if (series && series.seriesOccurrences != null && series.seriesOccurrences > 0) {
        const parsedKey = this.parseMonthKey(monthKey);
        const parsedSeries = this.parseMonthKey(series.createdInMonthKey);
        if (parsedKey && parsedSeries) {
          const offset = (parsedKey.year - parsedSeries.year) * 12 + (parsedKey.month - parsedSeries.month);
          if (offset >= 0 && offset < series.seriesOccurrences) {
            return `${offset + 1}/${series.seriesOccurrences}`;
          }
        }
      }

      // Fallback: extract from deterministic virtual ID format v:{seriesId}:{monthKey}:{day}
      if (event.id && event.id.startsWith('v:')) {
        const parts = event.id.split(':');
        if (parts.length >= 3) {
          const evMonthKey = parts[2];
          const parsedKey = this.parseMonthKey(evMonthKey);
          const parsedSeries = series ? this.parseMonthKey(series.createdInMonthKey) : null;
          const total = series?.seriesOccurrences ?? event.seriesOccurrences;
          if (parsedKey && parsedSeries && total != null && total > 0) {
            const offset = (parsedKey.year - parsedSeries.year) * 12 + (parsedKey.month - parsedSeries.month);
            if (offset >= 0 && offset < total) {
              return `${offset + 1}/${total}`;
            }
          }
        }
      }
    }

    // Fallback: scan events from months (backward compat for old data)
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

  private buildSimplifiedEventEntry(month: MonthSummary, day: DayProjection, event: FinancialEvent, index: number): SimplifiedMonthEntry {
    const installmentRef = this.getInstallmentReference(event, month.key);
    const typeLabel = this.getEventTypeLabel(event.type);
    const isExpense = event.type === 'expense';
    const statusLabel = isExpense
      ? (this.isEventPaid(event) ? 'Pago' : 'Em aberto')
      : (event.type === 'income' ? 'Previsto' : 'Planejado');

    return {
      key: event.id ?? `${month.key}-${day.day}-${event.type}-${index}`,
      monthKey: month.key,
      kind: 'event',
      type: event.type,
      title: this.normalizeText(event.label),
      dateLabel: this.formatDateLabel(new Date(month.year, month.monthNumber - 1, day.day)),
      tagLabel: typeLabel,
      secondaryTag: installmentRef ? `Parcela ${installmentRef}` : undefined,
      tags: event.tags,
      amount: event.amount,
      statusLabel,
      paid: this.isEventPaid(event),
      day: day.day,
      monthYear: month.year,
      monthNumber: month.monthNumber,
      event,
    };
  }

  private buildSimplifiedCardForecastEntry(month: MonthSummary, day: DayProjection, forecast: CardInvoiceForecast, index: number): SimplifiedMonthEntry {
    const launchesLabel = forecast.launchesCount === 1 ? '1 compra' : `${forecast.launchesCount} compras`;
    const invoiceYear = forecast.invoiceYear || month.year;
    const invoiceMonth = forecast.invoiceMonth || month.monthNumber;

    return {
      key: `card-${forecast.cardId}-${month.key}-${day.day}-${index}`,
      monthKey: month.key,
      kind: 'card-forecast',
      type: 'card',
      title: `Fatura ${forecast.cardName}`,
      dateLabel: this.formatDateLabel(new Date(month.year, month.monthNumber - 1, day.day)),
      tagLabel: 'Cartao',
      secondaryTag: launchesLabel,
      amount: forecast.amount,
      statusLabel: forecast.isPaid ? 'Pago' : 'Abrir cartão',
      paid: !!forecast.isPaid,
      day: day.day,
      monthYear: invoiceYear,
      monthNumber: invoiceMonth,
      forecast,
    };
  }

  private buildFilteredDayProjection(month: MonthSummary, day: DayProjection): DayProjection | null {
    const matchingEvents = day.events.filter((event) => this.matchesEventAgainstLaunchFilters(month, event));
    const matchingForecasts = day.cardInvoiceForecasts.filter((forecast) => this.matchesForecastAgainstLaunchFilters(forecast));

    if (!matchingEvents.length && !matchingForecasts.length) {
      return null;
    }

    const income = Number(matchingEvents
      .filter((event) => event.type === 'income' && !this.isInvestmentWithdrawalEvent(event))
      .reduce((sum, event) => sum + event.amount, 0)
      .toFixed(2));
    const expense = Number((matchingEvents
      .filter((event) => event.type === 'expense')
      .reduce((sum, event) => sum + event.amount, 0) + matchingForecasts.reduce((sum, forecast) => sum + forecast.amount, 0))
      .toFixed(2));
    const investment = Number(matchingEvents
      .reduce((sum, event) => {
        if (event.type === 'investment') {
          return sum + event.amount;
        }

        if (this.isInvestmentWithdrawalEvent(event)) {
          return sum - event.amount;
        }

        return sum;
      }, 0)
      .toFixed(2));
    const fixedCost = Number(matchingEvents
      .filter((event) => event.type === 'daily')
      .reduce((sum, event) => sum + event.amount, 0)
      .toFixed(2));

    return {
      ...day,
      income,
      expense,
      investment,
      fixedCost,
      events: matchingEvents,
      notes: matchingEvents.map((event) => this.describeEvent(event, month.key)),
      cardInvoiceForecasts: matchingForecasts,
    };
  }

  private matchesSimplifiedEntry(entry: SimplifiedMonthEntry): boolean {
    if (!this.hasLaunchFilters) {
      return true;
    }

    if (!this.matchesSelectedTags(entry.tags)) {
      return false;
    }

    return this.matchesSearchQuery([
      entry.title,
      entry.tagLabel,
      entry.secondaryTag,
      ...(entry.tags ?? [])
    ]);
  }

  private matchesEventAgainstLaunchFilters(month: MonthSummary, event: FinancialEvent): boolean {
    if (!this.hasLaunchFilters) {
      return true;
    }

    if (!this.matchesSelectedTags(event.tags)) {
      return false;
    }

    return this.matchesSearchQuery([
      this.normalizeText(event.label),
      this.describeEvent(event, month.key),
      this.getEventTypeLabel(event.type),
      ...(event.tags ?? [])
    ]);
  }

  private matchesForecastAgainstLaunchFilters(forecast: CardInvoiceForecast): boolean {
    if (!this.hasLaunchFilters) {
      return true;
    }

    if (this.launchFilters.tags.length > 0) {
      return false;
    }

    return this.matchesSearchQuery([
      forecast.cardName,
      this.getCardInvoiceForecastLabel(forecast),
      'cartao',
      'fatura'
    ]);
  }

  private matchesSelectedTags(tags?: string[]): boolean {
    if (this.launchFilters.tags.length === 0) {
      return true;
    }

    if (!tags || tags.length === 0) {
      return false;
    }

    const selectedTags = this.launchFilters.tags.map((tag) => this.normalizeTagName(tag));
    return tags.some((tag) => selectedTags.includes(this.normalizeTagName(tag)));
  }

  private matchesSearchQuery(values: Array<string | undefined>): boolean {
    const normalizedQuery = this.normalizeSearchValue(this.launchFilters.query);
    if (!normalizedQuery) {
      return true;
    }

    return values
      .map((value) => this.normalizeSearchValue(value ?? ''))
      .some((value) => value.includes(normalizedQuery));
  }

  private normalizeSearchValue(value: string): string {
    return this.normalizeText(value ?? '').trim().toLocaleLowerCase('pt-BR');
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

  private getMonthChartRange(month: MonthSummary, daysInMonth: number): { min: number; max: number; amplitude: number } {
    const balances = month.projection
      .filter((entry) => entry.day <= daysInMonth)
      .map((entry) => entry.closingBalance);

    const min = Math.min(0, month.openingBalance, ...balances);
    const max = Math.max(0, month.openingBalance, ...balances);

    return {
      min,
      max,
      amplitude: max - min || 1
    };
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
        label: 'diária base',
        amount: month.dailyFixedCost,
        type: 'daily'
      }
    ];
  }

  private deleteSeries(seriesId: string, triggerEventId?: string): void {
    const existingSeries = this.seriesDefinitions.find(s => s.id === seriesId);
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

    if (triggerEventId) {
      this.deletingEventIds.add(triggerEventId);
    }

    const saveOps: Observable<unknown>[] = monthsToSave.map((month) => this.financeApi.updateMonth(month));

    if (existingSeries) {
      existingSeries.isActive = false;
      existingSeries.updatedAt = new Date().toISOString();
      this.seriesDefinitions = this.seriesDefinitions.filter(s => s.id !== seriesId);
      saveOps.push(this.financeApi.saveSeries(existingSeries));
    }

    if (!saveOps.length) {
      if (triggerEventId) {
        this.deletingEventIds.delete(triggerEventId);
      }
      return;
    }

    forkJoin(saveOps).subscribe({
      next: () => {
        this.refreshActiveDayDetails();
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
        if (existingSeries) {
          existingSeries.isActive = true;
          this.seriesDefinitions = [...this.seriesDefinitions, existingSeries];
        }
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = 'Não foi possivel excluir a serie. Confira o backend e tente novamente.';
      }
    });
  }

  private deleteSeriesForward(monthKey: string, triggerEvent: FinancialEvent, triggerEventId?: string): void {
    if (!triggerEvent.seriesId) {
      return;
    }

    const existingSeries = this.seriesDefinitions.find(s => s.id === triggerEvent.seriesId);
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

    if (triggerEventId) {
      this.deletingEventIds.add(triggerEventId);
    }

    const saveOps: Observable<unknown>[] = monthsToSave.map((month) => this.financeApi.updateMonth(month));

    if (existingSeries && existingSeries.repeatMode === 'monthly') {
      const prevMonth = this.monthDefinitions[triggerMonthIndex - 1];
      existingSeries.endedInMonthKey = prevMonth ? prevMonth.key : monthKey;
      existingSeries.updatedAt = new Date().toISOString();
      saveOps.push(this.financeApi.saveSeries(existingSeries));
    }

    if (!saveOps.length) {
      if (triggerEventId) {
        this.deletingEventIds.delete(triggerEventId);
      }
      return;
    }

    forkJoin(saveOps).subscribe({
      next: () => {
        this.refreshActiveDayDetails();
        if (triggerEventId) {
          this.deletingEventIds.delete(triggerEventId);
        }
        this.entriesFeedback = triggerEvent.type === 'daily'
          ? 'Esta diária e as próximas foram removidas.'
          : 'Este lançamento e os próximos foram removidos.';
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
          ? 'Não foi possivel excluir esta diária e as próximas. Confira o backend e tente novamente.'
          : 'Não foi possivel excluir este lançamento e os próximos. Confira o backend e tente novamente.';
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
    const expandedEvents = this.getMonthEvents(definition);

    for (const event of expandedEvents) {
      const dayEvents = eventsByDay.get(event.day) ?? [];
      dayEvents.push(event);
      eventsByDay.set(event.day, dayEvents);
    }

    let runningBalance = openingBalanceOverride !== undefined ? openingBalanceOverride : definition.openingBalance;
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalOtherExpenses = 0;
    let totalCardExpenses = 0;
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
          otherExpense: 0,
          cardExpense: 0,
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
      let otherExpense = 0;
      let investment = 0;
      const cardExpense = projectedCardInvoiceExpense;
      expense += projectedCardInvoiceExpense;
      let singleDayDailyAmount = 0;
      const seriesUpdates = new Map<string, number>();
      const seriesSkips = new Set<string>();
      const seriesOverrides = new Map<string, number>();

      for (const event of events) {
        if (event.type === 'income' && !this.isInvestmentWithdrawalEvent(event)) {
          income += event.amount;
        }

        if (this.isInvestmentWithdrawalEvent(event)) {
          investment -= event.amount;
        }

        if (event.type === 'expense') {
          expense += event.amount;
          otherExpense += event.amount;
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
      totalOtherExpenses += otherExpense;
      totalCardExpenses += cardExpense;
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
        otherExpense,
        cardExpense,
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
    const checkpoints = projection.map((entry) => 26 + ((entry.closingBalance - minBalance) / amplitude) * 74);

    // Precomputa pontos do mini-grafico do dashboard. Antes era calculado por
    // getMonthChartPoints(month) dentro de *ngFor, alocando arrays a cada CD.
    const closingFinal = balances[balances.length - 1];
    const dashMin = Math.min(0, definition.openingBalance, ...balances);
    const dashMax = Math.max(0, definition.openingBalance, ...balances);
    const dashAmp = (dashMax - dashMin) || 1;
    const chartPoints = projection.map((entry) => {
      const balance = entry.closingBalance;
      const height = 24 + ((balance - dashMin) / dashAmp) * 76;
      const tone: 'healthy' | 'warning' | 'negative' = entry.status ?? (balance < 0 ? 'negative' : 'healthy');
      return { day: entry.day, balance, height, tone };
    });
    const chartZeroLine = dashMax <= 0
      ? 100
      : (dashMin >= 0 ? 0 : Math.min(100, Math.max(0, ((0 - dashMin) / dashAmp) * 100)));

    return {
      key: definition.key,
      title: definition.title,
      year: definition.year,
      monthNumber: definition.monthNumber,
      openingBalance: openingBalanceOverride !== undefined ? openingBalanceOverride : definition.openingBalance,
      closingBalance: closingFinal,
      minBalance,
      totalIncome,
      totalExpenses,
      totalOtherExpenses,
      totalCardExpenses,
      totalInvestments,
      totalFixedCosts: projection.reduce((total, day) => total + day.fixedCost, 0),
      negativeDays: projection.filter((day) => day.closingBalance < 0).length,
      chartHeights: checkpoints,
      chartPoints,
      chartZeroLine,
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
        existing.invoiceYear = invoiceMonth.year;
        existing.invoiceMonth = invoiceMonth.month;
        existing.isPaid = !!existing.isPaid && !!launch.paid;
      } else {
        forecasts.push({
          cardId,
          cardName: card.name,
          amount: Number(launch.amount.toFixed(2)),
          launchesCount: 1,
          invoiceYear: invoiceMonth.year,
          invoiceMonth: invoiceMonth.month,
          isPaid: !!launch.paid
        });
      }

      dayTotals.set(dueDay, forecasts);
      result.set(monthKey, dayTotals);
    }

    return result;
  }

  private getCardInvoiceMonthForDate(dateInput: string, card: CreditCard): { year: number; month: number } {
    const result = getInvoiceMonthForDate(dateInput, card);
    if (result) return result;
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() + 1 };
  }

  private getDueDateForInvoiceMonth(invoiceMonth: { year: number; month: number }, card: CreditCard): Date {
    return getDueDateForInvoiceMonth(invoiceMonth, card);
  }

  private getClosingDateForInvoiceMonth(invoiceMonth: { year: number; month: number }, card: CreditCard): Date {
    return getClosingDateForInvoiceMonth(invoiceMonth, card);
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
