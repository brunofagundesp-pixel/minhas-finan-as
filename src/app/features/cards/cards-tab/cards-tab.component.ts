import { Component, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { CardLaunch, CreditCard, FinanceApiService, LaunchRepeatMode } from '../../../core/services/finance-api.service';
import { TagsService } from '../../../core/services/tags.service';
import { forkJoin, of, Subscription } from 'rxjs';
import { getInvoiceMonthForDate as getCardInvoiceMonthForDate, getDueDateForInvoiceMonth as getCardDueDateForInvoiceMonth, getClosingDateForInvoiceMonth as getCardClosingDateForInvoiceMonth, getCycleStartDateForInvoiceMonth as getCardCycleStartDateForInvoiceMonth, InvoiceMonth } from '../../../core/utils/card-cycle.util';

type CardDeleteScope = 'single' | 'forward' | 'series';

interface CreditCardFormState {
  name: string;
  brand: string;
  limit: number | null;
  dueDay: number;
  firstDueDate: string;
  closeDay: number;
  dueMonthOffset: number;
  parentCardName: string;
}

interface CardLaunchFormState {
  amount: number | null;
  date: string;
  invoiceMonthRef: string;
  repeatMode: LaunchRepeatMode;
  installmentCount: number;
  account: string;
  description: string;
  notes: string;
  tags: string[];
}

interface LaunchTagCatalogItem {
  name: string;
  color: string;
}



interface CardInvoiceDay {
  day: number;
  expense: number;
  availableLimit: number;
  launches: CardLaunch[];
  status: 'negative' | 'warning' | 'healthy';
}

interface LaunchPreviewData {
  title: string;
  period?: string;
  details: string[];
}

const AVATAR_COLORS = [
  '#e85d26', '#1f5cc2', '#0b9e6e', '#9c3fa6',
  '#c9820a', '#2478b5', '#b03060', '#4a6741'
];

@Component({
  selector: 'app-cards-tab',
  templateUrl: './cards-tab.component.html',
  styleUrls: ['./cards-tab.component.scss']
})
export class CardsTabComponent implements OnInit, OnDestroy {
  cards: CreditCard[] = [];
  launches: CardLaunch[] = [];
  selectedCardId: string | number | null = null;
  isCardModalOpen = false;
  isLaunchModalOpen = false;
  editingLaunchId: string | number | null = null;
  isEditMode = false;
  isSaving = false;
  isSavingLaunch = false;
  isLoading = false;
  cardError: string | null = null;
  launchError: string | null = null;
  deletingLaunchIds = new Set<string>();
  isClosingInvoice = false;
  isDeletingCard = false;
  activeLaunchMenuId: string | number | null = null;
  pendingDeleteLaunch: CardLaunch | null = null;
  pendingDeleteHasRecurringOptions = false;
  pendingDeleteCard: CreditCard | null = null;
  pendingEditLaunch: CardLaunch | null = null;
  editScope: CardDeleteScope = 'single';

  @Output() faturaFechada = new EventEmitter<{ amount: number; dueDate: string; description: string }>();
  launchSearchTerm = '';
  launchRepeatFilter: 'all' | 'single' | 'installment' | 'fixed' = 'all';
  selectedLaunchFilterTags: string[] = [];
  invoiceMonth: InvoiceMonth = this.currentYearMonth();
  launchForm: CardLaunchFormState = this.createEmptyLaunchForm();
  launchAmountInput = '';
  availableTags: LaunchTagCatalogItem[] = [];
  selectedExistingTag = '';
  newTagInput = '';
  private launchFilterTagsCache: {
    availableTags: LaunchTagCatalogItem[];
    availableTagsLength: number;
    launches: CardLaunch[];
    selectedCardId: string | number | null;
    monthKey: string;
    result: LaunchTagCatalogItem[];
  } | null = null;
  private redirectToCurrentMonthAfterSave = false;
  private saveAndNewLaunchRequested = false;
  private openLaunchAfterCardCreate = false;

  readonly cardTypeOptions = ['Cartão de Credito'];
  private readonly tagPalette = ['#1168d9', '#0f9f78', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#4d7c0f', '#be185d'];
  private readonly currencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2
  });

  cardForm: CreditCardFormState = this.createEmptyCardForm();

  constructor(
    private readonly api: FinanceApiService,
    private readonly tagsService: TagsService
  ) {}

  private tagsSubscription?: Subscription;

  ngOnInit(): void {
    this.loadAvailableTags();
    this.loadCards();
    this.loadLaunches();
  }

  ngOnDestroy(): void {
    this.tagsSubscription?.unsubscribe();
  }

  get availableTagsForSelection(): LaunchTagCatalogItem[] {
    return this.availableTags.filter(
      (tag) => !this.launchForm.tags.some((selected) => this.normalizeTagName(selected) === this.normalizeTagName(tag.name))
    );
  }

  get selectedCard(): CreditCard | null {
    return this.cards.find(c => String(c.id) === String(this.selectedCardId)) ?? null;
  }

  get invoiceMonthLabel(): string {
    const months = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    return `${months[this.invoiceMonth.month - 1]} ${this.invoiceMonth.year}`;
  }

  /** Date no primeiro dia do mes da fatura selecionada — usado para sincronizar widgets externos. */
  get invoiceMonthDate(): Date {
    return new Date(this.invoiceMonth.year, this.invoiceMonth.month - 1, 1);
  }

  get invoiceClosingDate(): string {
    if (!this.selectedCard) return '-';
    return this.formatDate(getCardClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard));
  }

  get invoiceDueDate(): string {
    if (!this.selectedCard) return '-';
    return this.formatDate(getCardDueDateForInvoiceMonth(this.invoiceMonth, this.selectedCard));
  }

  get minLaunchInvoiceMonthRef(): string {
    if (!this.selectedCard) {
      return '';
    }

    return this.formatInvoiceMonthRef(this.getFirstControlledInvoiceMonth(this.selectedCard));
  }

  get selectedCardLaunches(): CardLaunch[] {
    const selectedCard = this.selectedCard;
    if (!this.selectedCardId || !selectedCard) return [];

    return this.launches
      .filter((l) => {
        if (String(l.cardId) !== String(this.selectedCardId)) return false;
        const inv = getCardInvoiceMonthForDate(l.date, selectedCard);
        return inv != null && inv.year === this.invoiceMonth.year && inv.month === this.invoiceMonth.month;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  get hasLaunches(): boolean {
    return this.filteredSelectedCardLaunches.length > 0;
  }

  get filteredSelectedCardLaunches(): CardLaunch[] {
    const term = this.launchSearchTerm.trim().toLowerCase();
    const normalizedSelectedTags = this.selectedLaunchFilterTags.map((tag) => this.normalizeTagName(tag));

    return this.selectedCardLaunches.filter((launch) => {
      const repeatMatch = this.launchRepeatFilter === 'all' || launch.repeatMode === this.launchRepeatFilter;
      if (!repeatMatch) {
        return false;
      }

      const launchTags = this.parseLaunchTagsInput(launch.tags);
      const tagMatch = normalizedSelectedTags.length === 0
        || launchTags.some((tag) => normalizedSelectedTags.includes(this.normalizeTagName(tag)));
      if (!tagMatch) {
        return false;
      }

      if (!term) {
        return true;
      }

      const haystack = [launch.description, launch.tags, launch.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(term);
    });
  }

  get hasActiveFilters(): boolean {
    return this.launchRepeatFilter !== 'all' || !!this.launchSearchTerm.trim() || this.selectedLaunchFilterTags.length > 0;
  }

  get launchFilterTags(): LaunchTagCatalogItem[] {
    const launches = this.launches;
    const availableTags = this.availableTags;
    const selectedCardId = this.selectedCardId;
    const monthKey = `${this.invoiceMonth.year}-${this.invoiceMonth.month}`;

    const cache = this.launchFilterTagsCache;
    if (
      cache &&
      cache.availableTags === availableTags &&
      cache.availableTagsLength === availableTags.length &&
      cache.launches === launches &&
      cache.selectedCardId === selectedCardId &&
      cache.monthKey === monthKey
    ) {
      return cache.result;
    }

    const tagsByName = new Map<string, LaunchTagCatalogItem>();

    for (const tag of availableTags) {
      const normalized = this.normalizeTagName(tag.name);
      if (normalized && !tagsByName.has(normalized)) {
        tagsByName.set(normalized, { name: tag.name, color: tag.color });
      }
    }

    for (const launch of this.selectedCardLaunches) {
      for (const tag of this.parseLaunchTagsInput(launch.tags)) {
        const normalized = this.normalizeTagName(tag);
        if (normalized && !tagsByName.has(normalized)) {
          tagsByName.set(normalized, { name: tag, color: this.getTagColor(tag) });
        }
      }
    }

    const result = Array.from(tagsByName.values()).sort((left, right) =>
      left.name.localeCompare(right.name, 'pt-BR')
    );

    this.launchFilterTagsCache = {
      availableTags,
      availableTagsLength: availableTags.length,
      launches,
      selectedCardId,
      monthKey,
      result
    };

    return result;
  }

  get firstLaunchDayInInvoiceMonth(): number | null {
    return this.selectedCardLaunches.length
      ? new Date(`${this.selectedCardLaunches[this.selectedCardLaunches.length - 1].date}T00:00:00`).getDate()
      : null;
  }

  get launchTotal(): number {
    return this.selectedCardLaunches.reduce((sum, l) => sum + l.amount, 0);
  }

  get paidTotal(): number {
    return this.selectedCardLaunches
      .filter((launch) => !!launch.paid)
      .reduce((sum, launch) => sum + launch.amount, 0);
  }

  get pendingTotal(): number {
    return Math.max(0, this.launchTotal - this.paidTotal);
  }

  get fixedLaunchesTotal(): number {
    return this.selectedCardLaunches
      .filter((l) => l.repeatMode === 'fixed')
      .reduce((sum, l) => sum + l.amount, 0);
  }

  get futureParcelsTotal(): number {
    if (!this.selectedCard) return 0;
    const card = this.selectedCard;
    return this.launches
      .filter((l) => {
        if (String(l.cardId) !== String(this.selectedCardId)) return false;
        if (l.repeatMode !== 'installment') return false;
        const invMonth = getCardInvoiceMonthForDate(l.date, card);
        if (!invMonth) return false;
        return (
          invMonth.year > this.invoiceMonth.year ||
          (invMonth.year === this.invoiceMonth.year && invMonth.month > this.invoiceMonth.month)
        );
      })
      .reduce((sum, l) => sum + l.amount, 0);
  }

  get launchModalMonthLabel(): string {
    const months = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    return `${months[this.invoiceMonth.month - 1]} de ${this.invoiceMonth.year}`;
  }

  get utilizedAmount(): number {
    return this.launchTotal;
  }

  get availableLimit(): number {
    if (!this.selectedCard) return 0;
    return this.selectedCard.limit - this.utilizedAmount;
  }

  get limitUsagePercent(): number {
    const limit = this.selectedCard?.limit ?? 0;

    if (limit <= 0) {
      return this.utilizedAmount > 0 ? 100 : 0;
    }

    return Math.max(0, Math.round((this.utilizedAmount / limit) * 100));
  }

  get invoiceHealthTone(): 'ok' | 'warn' | 'danger' {
    if (this.limitUsagePercent > 80) {
      return 'danger';
    }

    if (this.limitUsagePercent > 50) {
      return 'warn';
    }

    return 'ok';
  }

  get invoiceHealthLabel(): string {
    switch (this.invoiceHealthTone) {
      case 'danger':
        return 'No limite';
      case 'warn':
        return 'Em atenção';
      default:
        return 'Confortavel';
    }
  }

  get cardInitial(): string {
    return (this.selectedCard?.name ?? '?').charAt(0).toUpperCase();
  }

  get isEditingLaunch(): boolean {
    return this.editingLaunchId !== null;
  }

  get launchModalTitle(): string {
    return this.isEditingLaunch ? 'Editar despesa' : 'Nova despesa';
  }

  get launchSubmitLabel(): string {
    if (this.isSavingLaunch) {
      return 'Salvando...';
    }

    return this.isEditingLaunch ? 'Salvar alterações' : 'Salvar';
  }

  get launchPreviewData(): LaunchPreviewData | null {
    const selectedInvoiceMonth = this.parseInvoiceMonthRef(this.launchForm.invoiceMonthRef);
    if (!selectedInvoiceMonth) {
      return {
        title: 'Selecione o mês da fatura',
        details: ['Escolha o mês para ver o resumo do lançamento.']
      };
    }

    const invoiceLabel = this.formatInvoiceMonthLabel(selectedInvoiceMonth);
    const invoiceShortLabel = this.formatInvoiceMonthShortLabel(selectedInvoiceMonth);
    const amount = this.launchForm.amount || 0;
    const amountLabel = this.formatCurrency(amount);

    if (!this.selectedCard) {
      return {
        title: `Lançamento de ${amountLabel}`,
        period: invoiceShortLabel,
        details: [`Fatura de ${invoiceLabel}.`]
      };
    }

    const baseDate = this.launchForm.date || this.getTodayInputDate();
    const baseDateLabel = this.formatDate(new Date(`${baseDate}T00:00:00`));
    const closingDate = this.formatDate(getCardClosingDateForInvoiceMonth(selectedInvoiceMonth, this.selectedCard));
    const dueDate = this.formatDate(getCardDueDateForInvoiceMonth(selectedInvoiceMonth, this.selectedCard));

    if (!this.isEditingLaunch && this.launchForm.repeatMode === 'installment') {
      const installments = Math.max(2, Number(this.launchForm.installmentCount || 2));
      const finalInvoiceMonth = this.shiftInvoiceMonth(selectedInvoiceMonth, installments - 1);
      const finalShortLabel = this.formatInvoiceMonthShortLabel(finalInvoiceMonth);

      return {
        title: `${installments} ${installments === 1 ? 'parcela' : 'parcelas'} de ${amountLabel}`,
        period: `${invoiceShortLabel} a ${finalShortLabel}`,
        details: [
          `1a fatura: fecha ${closingDate} e vence ${dueDate}.`,
          `Data da compra: ${baseDateLabel}.`
        ]
      };
    }

    if (this.launchForm.repeatMode === 'fixed') {
      return {
        title: `Fixo de ${amountLabel}`,
        period: `A partir de ${invoiceShortLabel}`,
        details: [
          `Fatura atual: fecha ${closingDate} e vence ${dueDate}.`,
          `Data da compra: ${baseDateLabel}.`
        ]
      };
    }

    return {
      title: `1 lançamento de ${amountLabel}`,
      period: invoiceShortLabel,
      details: [
        `Fatura: fecha ${closingDate} e vence ${dueDate}.`,
        `Data da compra: ${baseDateLabel}.`
      ]
    };
  }

  get editScopeTitle(): string {
    if (!this.pendingEditLaunch) {
      return 'Editar lançamento';
    }
    return `Editar "${this.describeCardLaunch(this.pendingEditLaunch)}"`;
  }

  get editScopeDescription(): string {
    if (!this.pendingEditLaunch) {
      return '';
    }
    return 'Esse lançamento faz parte de uma repetição. Escolha quais deseja editar.';
  }

  get deleteScopeTitle(): string {
    if (!this.pendingDeleteLaunch) {
      return 'Excluir lançamento';
    }

    return `Excluir "${this.describeCardLaunch(this.pendingDeleteLaunch)}"`;
  }

  get deleteScopeDescription(): string {
    if (!this.pendingDeleteLaunch) {
      return '';
    }

    if (!this.pendingDeleteHasRecurringOptions) {
      return 'Essa ação não pode ser desfeita.';
    }

    return 'Esse lançamento faz parte de uma repetição. Escolha o que deseja excluir.';
  }

  get showInstallmentCountField(): boolean {
    return !this.isEditingLaunch && this.launchForm.repeatMode === 'installment';
  }

  get modalTitle(): string {
    return this.isEditMode ? 'Editar cartão' : 'Novo cartão de credito';
  }

  get deleteCardTitle(): string {
    if (!this.pendingDeleteCard) {
      return 'Excluir cartão';
    }

    return `Excluir "${this.pendingDeleteCard.name}"`;
  }

  get deleteCardDescription(): string {
    if (!this.pendingDeleteCard) {
      return '';
    }

    const relatedLaunches = this.launches.filter((launch) => String(launch.cardId) === String(this.pendingDeleteCard?.id)).length;
    if (!relatedLaunches) {
      return 'Esse cartão será removido permanentemente. Essa ação não pode ser desfeita.';
    }

    return `Esse cartão será removido junto com ${relatedLaunches} ${relatedLaunches === 1 ? 'lancamento relacionado' : 'lancamentos relacionados'}. Essa ação não pode ser desfeita.`;
  }

  get isCurrentInvoiceMonth(): boolean {
    const now = new Date();
    return this.invoiceMonth.year === now.getFullYear() && this.invoiceMonth.month === (now.getMonth() + 1);
  }

  get isAtFirstControlledInvoiceMonth(): boolean {
    if (!this.selectedCard) {
      return false;
    }

    const firstInvoiceMonth = this.getFirstControlledInvoiceMonth(this.selectedCard);
    return this.invoiceMonth.year === firstInvoiceMonth.year && this.invoiceMonth.month === firstInvoiceMonth.month;
  }

  get isInvoicePastClosingDate(): boolean {
    if (!this.selectedCard) {
      return false;
    }
    const closing = getCardClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today >= closing;
  }

  fecharFatura(): void {
    if (!this.selectedCard || this.launchTotal <= 0 || this.isClosingInvoice) {
      return;
    }

    const targets = this.selectedCardLaunches.filter((launch) => !!launch.id && !launch.paid);
    const paidAt = this.getTodayInputDate();
    this.isClosingInvoice = true;
    this.launchError = null;

    const finish = (): void => {
      const dueDate = getCardDueDateForInvoiceMonth(this.invoiceMonth, this.selectedCard!);
      const yyyy = dueDate.getFullYear();
      const mm = String(dueDate.getMonth() + 1).padStart(2, '0');
      const dd = String(dueDate.getDate()).padStart(2, '0');
      const dueDateStr = `${yyyy}-${mm}-${dd}`;
      const description = `Fatura ${this.selectedCard!.name}`;
      this.faturaFechada.emit({ amount: this.launchTotal, dueDate: dueDateStr, description });
      this.isClosingInvoice = false;
    };

    if (!targets.length) {
      finish();
      return;
    }

    const updates = targets.map((launch) => this.api.updateCardLaunch({
      ...launch,
      paid: true,
      paidAt,
    }));

    forkJoin(updates).subscribe({
      next: (saved) => {
        const savedById = new Map(saved.map((item) => [String(item.id), item]));
        this.launches = this.launches.map((launch) => {
          const id = String(launch.id);
          return savedById.get(id) ?? launch;
        });
        finish();
      },
      error: () => {
        this.isClosingInvoice = false;
        this.launchError = 'Não foi possivel fechar a fatura. Tente novamente.';
      }
    });
  }

  get cardInvoiceDays(): CardInvoiceDay[] {
    const daysInMonth = new Date(this.invoiceMonth.year, this.invoiceMonth.month, 0).getDate();
    const launchesByDay = new Map<number, CardLaunch[]>();

    for (const launch of this.selectedCardLaunches) {
      const date = new Date(`${launch.date}T00:00:00`);
      const day = date.getDate();
      const items = launchesByDay.get(day) ?? [];
      items.push(launch);
      launchesByDay.set(day, items);
    }

    const result: CardInvoiceDay[] = [];
    const cardLimit = this.selectedCard?.limit ?? 0;
    let runningAvailableLimit = cardLimit;

    for (let day = 1; day <= daysInMonth; day += 1) {
      const launches = (launchesByDay.get(day) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const expense = launches.reduce((sum, launch) => sum + launch.amount, 0);
      runningAvailableLimit -= expense;

      let status: CardInvoiceDay['status'] = 'healthy';
      if (runningAvailableLimit < 0) {
        status = 'negative';
      } else if (cardLimit > 0 && runningAvailableLimit <= cardLimit * 0.2) {
        status = 'warning';
      }

      result.push({
        day,
        expense,
        availableLimit: Number(runningAvailableLimit.toFixed(2)),
        launches,
        status
      });
    }

    return result;
  }

  describeCardLaunch(launch: CardLaunch): string {
    return launch.description?.trim() || 'Despesa sem descrição';
  }

  getCardLaunchTags(launch: CardLaunch): string[] {
    return this.parseLaunchTagsInput(launch.tags);
  }

  describeRepeatMode(launch: CardLaunch): string {
    if (launch.repeatMode === 'fixed') {
      return 'Fixa';
    }

    if (launch.repeatMode === 'installment') {
      const current = launch.installmentNumber ?? 1;
      const total = launch.installmentTotal ?? 1;
      return `Parcelada ${current}/${total}`;
    }

    return 'Unica';
  }

  isDeletingLaunch(id?: string | number): boolean {
    return !!id && this.deletingLaunchIds.has(String(id));
  }

  isCurrentInvoiceDay(day: number): boolean {
    if (!this.isCurrentInvoiceMonth) {
      return false;
    }

    return day === new Date().getDate();
  }

  trackInvoiceDay(_index: number, day: CardInvoiceDay): number {
    return day.day;
  }

  trackInvoiceLaunch(index: number, launch: CardLaunch): string {
    return String(launch.id ?? `${launch.date}-${launch.amount}-${index}`);
  }

  clearLaunchFilters(): void {
    this.launchSearchTerm = '';
    this.launchRepeatFilter = 'all';
    this.selectedLaunchFilterTags = [];
  }

  toggleLaunchFilterTag(tagName: string): void {
    const normalizedTagName = this.normalizeTagName(tagName);
    const isActive = this.selectedLaunchFilterTags.some((tag) => this.normalizeTagName(tag) === normalizedTagName);

    this.selectedLaunchFilterTags = isActive
      ? this.selectedLaunchFilterTags.filter((tag) => this.normalizeTagName(tag) !== normalizedTagName)
      : [...this.selectedLaunchFilterTags, tagName];
  }

  isLaunchFilterTagActive(tagName: string): boolean {
    const normalizedTagName = this.normalizeTagName(tagName);
    return this.selectedLaunchFilterTags.some((tag) => this.normalizeTagName(tag) === normalizedTagName);
  }

  toggleLaunchMenu(event: Event, launch: CardLaunch): void {
    event.stopPropagation();
    this.activeLaunchMenuId = this.activeLaunchMenuId === (launch.id ?? null) ? null : (launch.id ?? null);
  }

  closeLaunchMenu(): void {
    this.activeLaunchMenuId = null;
  }

  closeDeleteScopePrompt(): void {
    this.pendingDeleteLaunch = null;
    this.pendingDeleteHasRecurringOptions = false;
  }

  loadCards(): void {
    this.isLoading = true;
    this.cardError = null;
    this.api.getCards().subscribe({
      next: (cards) => {
        this.cards = cards;
        if (this.selectedCardId === null && cards.length > 0) {
          this.selectedCardId = cards[0].id!;
        }
        if (this.selectedCard) {
          this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
        }
        this.isLoading = false;
      },
      error: () => {
        this.cardError = 'Não foi possivel carregar os cartões. Verifique o backend.';
        this.isLoading = false;
      }
    });
  }

  loadLaunches(): void {
    this.api.getCardLaunches().subscribe({
      next: (launches) => {
        this.launches = launches;
        this.syncTagCatalogWithLaunches();
        if (this.selectedCard) {
          this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
        }
        this.scrollToFirstLaunchDay();
      },
      error: () => {
        this.launchError = 'Não foi possivel carregar os lançamentos do cartão.';
      }
    });
  }

  openCardModal(): void {
    this.cardForm = this.createEmptyCardForm();
    this.isEditMode = false;
    this.cardError = null;
    this.isCardModalOpen = true;
  }

  openEditModal(card: CreditCard): void {
    const closeDay = card.closeDay ?? (card.dueDay - card.closeDaysBefore);
    const dueMonthOffset = card.dueMonthOffset ?? 1;
    this.cardForm = {
      name: card.name,
      brand: card.brand,
      limit: card.limit,
      dueDay: card.dueDay,
      firstDueDate: (card.firstDueDate || '').slice(0, 7),
      closeDay,
      dueMonthOffset,
      parentCardName: card.parentCardName,
    };
    this.isEditMode = true;
    this.cardError = null;
    this.isCardModalOpen = true;
  }

  closeCardModal(): void {
    this.isCardModalOpen = false;
    this.cardError = null;
  }

  onDueMonthToggle(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.cardForm.dueMonthOffset = checked ? 1 : 0;
  }

  requestDeleteCard(card: CreditCard): void {
    if (!card.id || this.isDeletingCard) {
      return;
    }

    this.pendingDeleteCard = card;
    this.cardError = null;
  }

  closeDeleteCardPrompt(): void {
    this.pendingDeleteCard = null;
  }

  openLaunchModal(options?: { redirectToCurrentMonthOnSave?: boolean }): void {
    this.redirectToCurrentMonthAfterSave = !!options?.redirectToCurrentMonthOnSave;
    this.saveAndNewLaunchRequested = false;
    const baseInvoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(this.invoiceMonth, this.selectedCard)
      : this.invoiceMonth;
    this.invoiceMonth = baseInvoiceMonth;
    this.editingLaunchId = null;
    this.launchForm = this.createEmptyLaunchForm(
      this.getTodayInputDate(),
      this.formatInvoiceMonthRef(baseInvoiceMonth)
    );
    this.selectedExistingTag = '';
    this.newTagInput = '';
    this.syncLaunchAmountInput();
    this.launchError = null;
    this.isLaunchModalOpen = true;
  }

  openLaunchModalFromShortcut(retryCount = 0): void {
    this.invoiceMonth = this.currentYearMonth();

    if (this.isLoading && this.cards.length === 0 && retryCount < 10) {
      setTimeout(() => this.openLaunchModalFromShortcut(retryCount + 1), 120);
      return;
    }

    if (this.cards.length === 0) {
      this.openLaunchAfterCardCreate = true;
      this.cardError = 'Cadastre um cartão antes de lançar uma despesa.';
      this.openCardModal();
      return;
    }

    if (this.selectedCardId === null) {
      this.selectedCardId = this.cards[0].id ?? null;
    }

    this.openLaunchModal({ redirectToCurrentMonthOnSave: true });
  }

  openEditLaunchModal(launch: CardLaunch): void {
    if (this.hasRecurringDeleteOptions(launch)) {
      this.pendingEditLaunch = launch;
      return;
    }

    this.editScope = 'single';
    this.doOpenEditLaunchModal(launch);
  }

  confirmEditScope(scope: CardDeleteScope): void {
    if (!this.pendingEditLaunch) {
      return;
    }
    const launch = this.pendingEditLaunch;
    this.pendingEditLaunch = null;
    this.editScope = scope;
    this.doOpenEditLaunchModal(launch);
  }

  closeEditScopePrompt(): void {
    this.pendingEditLaunch = null;
  }

  private doOpenEditLaunchModal(launch: CardLaunch): void {
    const launchInvoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(getCardInvoiceMonthForDate(launch.date, this.selectedCard) ?? this.invoiceMonth, this.selectedCard)
      : this.parseInvoiceMonthFromInputDate(launch.date);

    this.editingLaunchId = launch.id ?? null;
    this.launchForm = {
      amount: launch.amount,
      date: launch.date,
      invoiceMonthRef: this.formatInvoiceMonthRef(launchInvoiceMonth),
      repeatMode: launch.repeatMode,
      installmentCount: launch.installmentTotal ?? 2,
      account: launch.account,
      description: launch.description,
      notes: launch.notes,
      tags: this.parseLaunchTagsInput(launch.tags),
    };
    this.selectedExistingTag = '';
    this.newTagInput = '';
    this.syncLaunchAmountInput();
    this.launchError = null;
    this.isLaunchModalOpen = true;
  }

  onLaunchAmountInputChange(rawValue: string): void {
    const masked = this.maskCurrencyFromDigits(rawValue);
    this.launchAmountInput = masked.display;
    this.launchForm.amount = masked.amount;
  }

  closeLaunchModal(): void {
    this.isLaunchModalOpen = false;
    this.launchError = null;
    this.editingLaunchId = null;
    this.selectedExistingTag = '';
    this.newTagInput = '';
    this.redirectToCurrentMonthAfterSave = false;
    this.saveAndNewLaunchRequested = false;
  }

  submitLaunchFormAndAddAnother(): void {
    if (this.isSavingLaunch || this.isEditingLaunch) {
      return;
    }

    this.saveAndNewLaunchRequested = true;
    this.submitLaunchForm();
  }

  onLaunchDateChange(): void {
    if (!this.selectedCard || !this.launchForm.date) return;
    const invMonth = getCardInvoiceMonthForDate(this.launchForm.date, this.selectedCard);
    if (invMonth) {
      this.launchForm.invoiceMonthRef = this.formatInvoiceMonthRef(invMonth);
    }
  }

  submitLaunchForm(): void {
    if (this.isSavingLaunch) {
      return;
    }

    const keepOpenAfterSave = this.saveAndNewLaunchRequested && !this.isEditingLaunch;
    this.saveAndNewLaunchRequested = false;

    if (!this.selectedCardId) {
      this.launchError = 'Selecione um cartão para lançar a despesa.';
      return;
    }

    if (!this.launchForm.amount || this.launchForm.amount <= 0) {
      this.launchError = 'Informe um valor maior que zero.';
      return;
    }

    if (!this.launchForm.date) {
      this.launchError = 'Informe a data da despesa.';
      return;
    }

    const isInstallmentCreation = !this.isEditingLaunch && this.launchForm.repeatMode === 'installment';
    const installmentCount = Number(this.launchForm.installmentCount || 0);

    if (isInstallmentCreation && (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 72)) {
      this.launchError = 'Informe a quantidade de parcelas entre 2 e 72.';
      return;
    }

    this.isSavingLaunch = true;
    const parsedInvoiceMonth = this.parseInvoiceMonthRef(this.launchForm.invoiceMonthRef) ?? this.invoiceMonth;
    const selectedInvoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(parsedInvoiceMonth, this.selectedCard)
      : parsedInvoiceMonth;
    const normalizedDate = this.launchForm.date;
    const targetInvoiceMonth = selectedInvoiceMonth;
    const preferredDate = this.launchForm.date || this.getTodayInputDate();
    const preferredInvoiceMonthRef = this.formatInvoiceMonthRef(targetInvoiceMonth);
    const editingLaunch = this.isEditingLaunch
      ? this.launches.find((item) => String(item.id) === String(this.editingLaunchId))
      : null;
    const baseLaunch: Omit<CardLaunch, 'id'> = {
      cardId: this.selectedCardId,
      amount: this.launchForm.amount,
      date: normalizedDate,
      repeatMode: this.launchForm.repeatMode,
      seriesId: editingLaunch?.seriesId,
      installmentNumber: editingLaunch?.installmentNumber,
      installmentTotal: editingLaunch?.installmentTotal,
      paid: editingLaunch?.paid ?? false,
      paidAt: editingLaunch?.paidAt,
      account: this.launchForm.account,
      description: this.launchForm.description,
      notes: this.launchForm.notes,
      tags: this.serializeLaunchTags(this.launchForm.tags),
    };

    this.syncTagCatalogWithTags(this.launchForm.tags);

    if (isInstallmentCreation) {
      const launches = this.buildInstallmentLaunches(baseLaunch, installmentCount);
      forkJoin(launches.map((item) => this.api.createCardLaunch(item))).subscribe({
        next: (savedLaunches) => {
          const shouldRedirectToCurrentMonth = this.redirectToCurrentMonthAfterSave;
          this.invoiceMonth = targetInvoiceMonth;
          this.launches = [...savedLaunches, ...this.launches];
          this.isSavingLaunch = false;

          if (keepOpenAfterSave) {
            this.launchError = null;
            this.launchForm = this.createEmptyLaunchForm(preferredDate, preferredInvoiceMonthRef);
            this.selectedExistingTag = '';
            this.newTagInput = '';
            this.syncLaunchAmountInput();
            this.scrollToFirstLaunchDay();
            return;
          }

          this.closeLaunchModal();
          if (shouldRedirectToCurrentMonth) {
            this.invoiceMonth = this.currentYearMonth();
          }
          this.scrollToFirstLaunchDay();
        },
        error: () => {
          this.launchError = 'Erro ao salvar lançamento. Tente novamente.';
          this.isSavingLaunch = false;
        }
      });
      return;
    }

    const launch: CardLaunch = {
      ...(this.isEditingLaunch ? { id: this.editingLaunchId! } : {}),
      ...baseLaunch,
      seriesId: undefined,
      installmentNumber: undefined,
      installmentTotal: undefined,
    };

    if (launch.repeatMode === 'installment') {
      launch.seriesId = editingLaunch?.seriesId;
      launch.installmentNumber = editingLaunch?.installmentNumber ?? 1;
      launch.installmentTotal = editingLaunch?.installmentTotal ?? 1;
    }

    // Multi-launch edit (forward / series scope)
    if (this.isEditingLaunch && this.editScope !== 'single' && editingLaunch) {
      const targets = this.getDeleteTargets(editingLaunch, this.editScope);
      const updates: CardLaunch[] = targets.map((t) => ({
        ...t,
        amount: baseLaunch.amount,
        account: baseLaunch.account,
        description: baseLaunch.description,
        notes: baseLaunch.notes,
        tags: baseLaunch.tags,
      }));

      forkJoin(updates.map((u) => this.api.updateCardLaunch(u))).subscribe({
        next: (saved) => {
          const shouldRedirectToCurrentMonth = this.redirectToCurrentMonthAfterSave;
          this.invoiceMonth = targetInvoiceMonth;
          saved.forEach((s) => {
            const idx = this.launches.findIndex((item) => String(item.id) === String(s.id));
            if (idx !== -1) { this.launches[idx] = s; }
          });
          this.launches = [...this.launches];
          this.isSavingLaunch = false;
          this.closeLaunchModal();
          if (shouldRedirectToCurrentMonth) {
            this.invoiceMonth = this.currentYearMonth();
          }
          this.scrollToFirstLaunchDay();
        },
        error: () => {
          this.launchError = 'Erro ao salvar lançamento. Tente novamente.';
          this.isSavingLaunch = false;
        }
      });
      return;
    }

    const request$ = this.isEditingLaunch
      ? this.api.updateCardLaunch(launch)
      : this.api.createCardLaunch(launch);

    request$.subscribe({
      next: (saved) => {
        const shouldRedirectToCurrentMonth = this.redirectToCurrentMonthAfterSave;
        this.invoiceMonth = targetInvoiceMonth;

        if (this.isEditingLaunch) {
          const index = this.launches.findIndex((item) => String(item.id) === String(saved.id));
          if (index !== -1) {
            this.launches[index] = saved;
          }
        } else {
          this.launches.unshift(saved);
        }

        this.isSavingLaunch = false;

        if (keepOpenAfterSave) {
          this.launchError = null;
          this.launchForm = this.createEmptyLaunchForm(preferredDate, preferredInvoiceMonthRef);
          this.selectedExistingTag = '';
          this.newTagInput = '';
          this.syncLaunchAmountInput();
          this.scrollToFirstLaunchDay();
          return;
        }

        this.closeLaunchModal();
        if (shouldRedirectToCurrentMonth) {
          this.invoiceMonth = this.currentYearMonth();
        }
        this.scrollToFirstLaunchDay();
      },
      error: () => {
        this.launchError = 'Erro ao salvar lançamento. Tente novamente.';
        this.isSavingLaunch = false;
      }
    });
  }

  deleteLaunch(launch: CardLaunch): void {
    if (!launch.id || this.isDeletingLaunch(launch.id)) {
      return;
    }

    this.pendingDeleteLaunch = launch;
    this.pendingDeleteHasRecurringOptions = this.hasRecurringDeleteOptions(launch);
  }

  confirmDeleteScope(scope: CardDeleteScope): void {
    if (!this.pendingDeleteLaunch) {
      return;
    }

    const launch = this.pendingDeleteLaunch;
    this.pendingDeleteLaunch = null;
    this.pendingDeleteHasRecurringOptions = false;
    this.deleteLaunchesByScope(launch, scope);
  }

  submitCardForm(): void {
    this.isSaving = true;
    this.cardError = null;

    const closeDay = this.cardForm.closeDay;
    const dueDay = this.cardForm.dueDay;
    const dueMonthOffset = this.cardForm.dueMonthOffset;
    const firstDueDate = this.normalizeFirstDueDate(this.cardForm.firstDueDate);
    const closeDaysBefore = dueMonthOffset === 0
      ? Math.max(0, dueDay - closeDay)
      : 31 - closeDay + dueDay;

    if (this.isEditMode && this.selectedCard) {
      const updated: CreditCard = {
        ...this.selectedCard,
        name: this.cardForm.name || 'Cartao',
        brand: this.cardForm.brand,
        limit: this.cardForm.limit ?? 0,
        dueDay,
        firstDueDate,
        closeDay,
        dueMonthOffset,
        closeDaysBefore,
        parentCardName: this.cardForm.parentCardName,
      };
      this.api.updateCard(updated).subscribe({
        next: (saved) => {
          const idx = this.cards.findIndex(c => c.id === saved.id);
          if (idx !== -1) this.cards[idx] = saved;
          this.invoiceMonth = this.clampInvoiceMonthToCard(this.invoiceMonth, saved);
          this.isSaving = false;
          this.isCardModalOpen = false;
        },
        error: () => {
          this.cardError = 'Erro ao salvar. Tente novamente.';
          this.isSaving = false;
        }
      });
    } else {
      const color = AVATAR_COLORS[this.cards.length % AVATAR_COLORS.length];
      const newCard: CreditCard = {
        name: this.cardForm.name || 'Cartao',
        brand: this.cardForm.brand,
        limit: this.cardForm.limit ?? 0,
        dueDay,
        firstDueDate,
        closeDay,
        dueMonthOffset,
        closeDaysBefore,
        parentCardName: this.cardForm.parentCardName,
        avatarColor: color,
      };
      this.api.createCard(newCard).subscribe({
        next: (saved) => {
          this.cards.push(saved);
          if (this.selectedCardId === null) {
            this.selectedCardId = saved.id!;
          }
          const shouldOpenLaunch = this.openLaunchAfterCardCreate;
          this.openLaunchAfterCardCreate = false;
          this.isSaving = false;
          this.isCardModalOpen = false;
          if (shouldOpenLaunch) {
            this.selectedCardId = saved.id!;
            this.cardError = null;
            this.invoiceMonth = this.currentYearMonth();
            this.openLaunchModal({ redirectToCurrentMonthOnSave: true });
          }
        },
        error: () => {
          this.cardError = 'Erro ao salvar. Tente novamente.';
          this.isSaving = false;
        }
      });
    }
  }

  confirmDeleteCard(): void {
    const card = this.pendingDeleteCard;
    if (!card?.id || this.isDeletingCard) {
      return;
    }

    const cardId = String(card.id);
    const relatedLaunchIds = this.launches
      .filter((launch) => String(launch.cardId) === cardId && !!launch.id)
      .map((launch) => String(launch.id));

    this.isDeletingCard = true;
    this.cardError = null;

    const deleteLaunches$ = relatedLaunchIds.length
      ? forkJoin(relatedLaunchIds.map((id) => this.api.deleteCardLaunch(id)))
      : of([]);

    deleteLaunches$.subscribe({
      next: () => {
        this.api.deleteCard(card.id!).subscribe({
          next: () => {
            this.launches = this.launches.filter((launch) => String(launch.cardId) !== cardId);
            this.cards = this.cards.filter((item) => String(item.id) !== cardId);

            if (String(this.selectedCardId) === cardId) {
              this.selectedCardId = this.cards.length ? this.cards[0].id ?? null : null;
            }

            if (this.selectedCard) {
              this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
            }

            this.isDeletingCard = false;
            this.pendingDeleteCard = null;
            this.closeCardModal();
            this.scrollToFirstLaunchDay();
          },
          error: () => {
            this.isDeletingCard = false;
            this.cardError = 'Erro ao excluir cartão. Tente novamente.';
          }
        });
      },
      error: () => {
        this.isDeletingCard = false;
        this.cardError = 'Erro ao excluir lançamentos do cartão. Tente novamente.';
      }
    });
  }

  selectCard(id: string | number): void {
    this.selectedCardId = id;
    if (this.selectedCard) {
      this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
    }
    this.scrollToFirstLaunchDay();
  }

  focusInvoiceMonth(cardId: string | number, year: number, month: number): void {
    this.selectedCardId = cardId;
    this.invoiceMonth = { year, month };
    this.scrollToFirstLaunchDay();
  }

  prevMonth(): void {
    let { year, month } = this.invoiceMonth;
    month--;
    if (month < 1) { month = 12; year--; }
    const previousMonth = { year, month };
    this.invoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(previousMonth, this.selectedCard)
      : previousMonth;
    this.scrollToFirstLaunchDay();
  }

  nextMonth(): void {
    let { year, month } = this.invoiceMonth;
    month++;
    if (month > 12) { month = 1; year++; }
    const nextMonth = { year, month };
    this.invoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(nextMonth, this.selectedCard)
      : nextMonth;
    this.scrollToFirstLaunchDay();
  }

  goToCurrentMonth(): void {
    this.invoiceMonth = this.selectedCard
      ? this.clampInvoiceMonthToCard(this.currentYearMonth(), this.selectedCard)
      : this.currentYearMonth();
    this.scrollToFirstLaunchDay();
  }

  private currentYearMonth(): InvoiceMonth {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }

  private formatDate(date: Date): string {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${d}/${m}/${date.getFullYear()}`;
  }

  private createEmptyCardForm(): CreditCardFormState {
    return {
      name: '',
      brand: this.cardTypeOptions[0],
      limit: null,
      dueDay: 20,
      firstDueDate: this.getTodayInputDate().slice(0, 7),
      closeDay: 10,
      dueMonthOffset: 1,
      parentCardName: '',
    };
  }

  private normalizeFirstDueDate(value: string): string {
    if (!value) {
      return value;
    }
    // Form usa <input type="month"> que devolve YYYY-MM; persistimos como YYYY-MM-01.
    if (/^\d{4}-\d{2}$/.test(value)) {
      return `${value}-01`;
    }
    return value;
  }

  private createEmptyLaunchForm(
    date = this.getTodayInputDate(),
    invoiceMonthRef = this.formatInvoiceMonthRef(this.invoiceMonth)
  ): CardLaunchFormState {
    return {
      amount: null,
      date,
      invoiceMonthRef,
      repeatMode: 'single',
      installmentCount: 2,
      account: 'Inter',
      description: '',
      notes: '',
      tags: [],
    };
  }

  getTagBadgeStyle(tagName: string): Record<string, string> {
    const base = this.getTagColor(tagName);
    return {
      '--tag-bg': this.hexToRgba(base, 0.16),
      '--tag-border': this.hexToRgba(base, 0.36),
      '--tag-fg': base
    };
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

  addTagToLaunch(tag: string): void {
    const trimmedTag = this.normalizeTagLabel(tag);
    if (!trimmedTag) {
      return;
    }

    const catalogTag = this.findTagInCatalog(trimmedTag) ?? this.createCatalogTag(trimmedTag);
    const tagExists = this.launchForm.tags.some((existingTag) => this.normalizeTagName(existingTag) === this.normalizeTagName(catalogTag.name));
    if (!tagExists) {
      this.launchForm.tags = [...this.launchForm.tags, catalogTag.name];
      this.newTagInput = '';
    }
  }

  removeTagFromLaunch(tag: string): void {
    this.launchForm.tags = this.launchForm.tags.filter((existingTag) => this.normalizeTagName(existingTag) !== this.normalizeTagName(tag));
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

  private syncLaunchAmountInput(): void {
    this.launchAmountInput = this.launchForm.amount === null ? '' : this.formatCurrencyInput(this.launchForm.amount);
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

  private parseLaunchTagsInput(rawTags: string): string[] {
    if (!rawTags) {
      return [];
    }

    const parsed = rawTags
      .split(',')
      .map((tag) => this.normalizeTagLabel(tag))
      .filter((tag) => !!tag);

    const unique: string[] = [];
    for (const tag of parsed) {
      if (!unique.some((item) => this.normalizeTagName(item) === this.normalizeTagName(tag))) {
        unique.push(tag);
      }
    }

    return unique;
  }

  private serializeLaunchTags(tags: string[]): string {
    return tags.map((tag) => this.normalizeTagLabel(tag)).filter((tag) => !!tag).join(', ');
  }

  private loadAvailableTags(): void {
    this.tagsSubscription?.unsubscribe();
    this.tagsSubscription = this.tagsService.tags$.subscribe((tags) => {
      this.availableTags = tags.map((tag) => ({ name: tag.name, color: tag.color }));
      // Re-sync any tag found on existing launches that the catalog might not
      // know about yet (e.g. data created before tags moved to Firestore).
      if (this.launches.length) {
        this.syncTagCatalogWithLaunches();
      }
    });
  }

  private persistAvailableTags(): void {
    void this.tagsService.upsertMany(this.availableTags);
  }

  private syncTagCatalogWithLaunches(): void {
    const tagNames = this.launches.flatMap((launch) => this.parseLaunchTagsInput(launch.tags));
    this.syncTagCatalogWithTags(tagNames);
  }

  private syncTagCatalogWithTags(tags: string[]): void {
    const normalizedNames = new Set(this.availableTags.map((tag) => this.normalizeTagName(tag.name)));
    let changed = false;

    for (const rawTag of tags) {
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
    return (value ?? '').trim().toLocaleLowerCase('pt-BR');
  }

  private normalizeTagLabel(value: string): string {
    return (value ?? '').trim().replace(/\s+/g, ' ');
  }

  private pickTagColor(catalog: LaunchTagCatalogItem[]): string {
    const usedColors = new Set(catalog.map((tag) => tag.color));
    const availableColor = this.tagPalette.find((color) => !usedColors.has(color));
    return availableColor ?? this.tagPalette[catalog.length % this.tagPalette.length];
  }

  private getTagColor(tagName: string): string {
    return this.findTagInCatalog(tagName)?.color ?? '#1f5cc2';
  }

  private hexToRgba(hex: string, alpha: number): string {
    const sanitized = hex.replace('#', '');
    const normalized = sanitized.length === 3
      ? sanitized.split('').map((char) => `${char}${char}`).join('')
      : sanitized;

    if (normalized.length !== 6) {
      return `rgba(31, 92, 194, ${alpha})`;
    }

    const red = parseInt(normalized.slice(0, 2), 16);
    const green = parseInt(normalized.slice(2, 4), 16);
    const blue = parseInt(normalized.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  private hasRecurringDeleteOptions(launch: CardLaunch): boolean {
    if (launch.repeatMode === 'single') {
      return false;
    }

    return this.findLaunchSeriesItems(launch).length > 1;
  }

  private findLaunchSeriesItems(launch: CardLaunch): CardLaunch[] {
    if (!launch.seriesId) {
      return [launch];
    }

    return this.launches
      .filter((item) => item.seriesId === launch.seriesId)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private deleteLaunchesByScope(launch: CardLaunch, scope: CardDeleteScope): void {
    const targets = this.getDeleteTargets(launch, scope).filter((item) => !!item.id);
    if (!targets.length) {
      return;
    }

    const targetIds = Array.from(new Set(targets.map((item) => String(item.id))));
    targetIds.forEach((id) => this.deletingLaunchIds.add(id));
    this.launchError = null;

    forkJoin(targetIds.map((id) => this.api.deleteCardLaunch(id))).subscribe({
      next: () => {
        const idSet = new Set(targetIds);
        this.launches = this.launches.filter((item) => !idSet.has(String(item.id)));
        targetIds.forEach((id) => this.deletingLaunchIds.delete(id));
        this.scrollToFirstLaunchDay();
      },
      error: () => {
        targetIds.forEach((id) => this.deletingLaunchIds.delete(id));
        this.launchError = 'Erro ao excluir lançamento. Tente novamente.';
      }
    });
  }

  private getDeleteTargets(launch: CardLaunch, scope: CardDeleteScope): CardLaunch[] {
    const seriesItems = this.findLaunchSeriesItems(launch);
    if (seriesItems.length <= 1) {
      return [launch];
    }

    if (scope === 'series') {
      return seriesItems;
    }

    if (scope === 'single') {
      return [launch];
    }

    if (launch.repeatMode === 'installment') {
      const currentInstallment = launch.installmentNumber ?? 1;
      return seriesItems.filter((item) => (item.installmentNumber ?? 1) >= currentInstallment);
    }

    return seriesItems.filter((item) => item.date >= launch.date);
  }

  private getTodayInputDate(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  private getSuggestedLaunchDate(): string {
    if (!this.selectedCard) {
      return this.getTodayInputDate();
    }

    const today = new Date(`${this.getTodayInputDate()}T00:00:00`);
    const cycleStart = getCardCycleStartDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);
    const cycleEnd = getCardClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);

    if (today >= cycleStart && today <= cycleEnd) {
      return this.getTodayInputDate();
    }

    return this.toInputDate(cycleEnd);
  }

  private parseInvoiceMonthFromInputDate(dateInput: string): InvoiceMonth {
    const parsed = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return this.invoiceMonth;
    }

    return {
      year: parsed.getFullYear(),
      month: parsed.getMonth() + 1,
    };
  }

  private formatInvoiceMonthRef(invoiceMonth: InvoiceMonth): string {
    return `${invoiceMonth.year}-${String(invoiceMonth.month).padStart(2, '0')}`;
  }

  private parseInvoiceMonthRef(invoiceMonthRef: string): InvoiceMonth | null {
    const match = /^(\d{4})-(\d{2})$/.exec(invoiceMonthRef || '');
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!year || month < 1 || month > 12) {
      return null;
    }

    return { year, month };
  }

  private formatInvoiceMonthLabel(invoiceMonth: InvoiceMonth): string {
    const months = [
      'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    return `${months[invoiceMonth.month - 1]} de ${invoiceMonth.year}`;
  }

  private formatInvoiceMonthShortLabel(invoiceMonth: InvoiceMonth): string {
    const months = [
      'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    return `${months[invoiceMonth.month - 1]}/${invoiceMonth.year}`;
  }

  private shiftInvoiceMonth(invoiceMonth: InvoiceMonth, monthsToAdd: number): InvoiceMonth {
    const shifted = new Date(invoiceMonth.year, invoiceMonth.month - 1 + monthsToAdd, 1);
    return {
      year: shifted.getFullYear(),
      month: shifted.getMonth() + 1,
    };
  }

  formatCurrency(value: number): string {
    return this.currencyFormatter.format(Number.isFinite(value) ? value : 0);
  }

  private buildInstallmentLaunches(baseLaunch: Omit<CardLaunch, 'id'>, installmentCount: number): CardLaunch[] {
    const seriesId = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return Array.from({ length: installmentCount }, (_value, index) => ({
      ...baseLaunch,
      date: this.addMonthsToInputDate(baseLaunch.date, index),
      repeatMode: 'installment',
      seriesId,
      installmentNumber: index + 1,
      installmentTotal: installmentCount,
    }));
  }

  private addMonthsToInputDate(dateInput: string, monthsToAdd: number): string {
    const source = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(source.getTime())) {
      return dateInput;
    }

    const sourceDay = source.getDate();
    const target = new Date(source.getFullYear(), source.getMonth() + monthsToAdd, 1);
    const targetLastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(sourceDay, targetLastDay));

    return this.toInputDate(target);
  }

  private getPreferredInvoiceMonth(card: CreditCard): InvoiceMonth {
    return this.clampInvoiceMonthToCard(this.currentYearMonth(), card);
  }

  private getFirstControlledInvoiceMonth(card: CreditCard): InvoiceMonth {
    const parsed = new Date(`${card.firstDueDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return this.currentYearMonth();
    }

    const dueMonth = parsed.getMonth() + 1;
    const dueYear = parsed.getFullYear();
    const oldOffset = card.dueMonthOffset ?? (card.closeDay ?? (card.dueDay - card.closeDaysBefore) > card.dueDay ? 1 : 0);

    let refMonth = dueMonth - (oldOffset + 1);
    let refYear = dueYear;
    while (refMonth < 1) { refMonth += 12; refYear -= 1; }

    return { year: refYear, month: refMonth };
  }

  private clampInvoiceMonthToCard(invoiceMonth: InvoiceMonth, card: CreditCard): InvoiceMonth {
    const firstInvoiceMonth = this.getFirstControlledInvoiceMonth(card);
    if (invoiceMonth.year < firstInvoiceMonth.year) {
      return firstInvoiceMonth;
    }

    if (invoiceMonth.year === firstInvoiceMonth.year && invoiceMonth.month < firstInvoiceMonth.month) {
      return firstInvoiceMonth;
    }

    return invoiceMonth;
  }

  private toInputDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  scrollToFirstLaunchDay(): void {
    if (typeof document === 'undefined') {
      return;
    }

    requestAnimationFrame(() => {
      const target = document.querySelector('.launch-item') as HTMLElement | null;
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}
