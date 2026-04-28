import { Component, OnInit, Output, EventEmitter } from '@angular/core';
import { CardLaunch, CreditCard, FinanceApiService, LaunchRepeatMode } from './finance-api.service';
import { forkJoin } from 'rxjs';

type CardDeleteScope = 'single' | 'forward' | 'series';

interface CreditCardFormState {
  name: string;
  brand: string;
  limit: number | null;
  dueDay: number;
  firstDueDate: string;
  closeDaysBefore: number;
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
  tags: string;
}

interface InvoiceMonth {
  year: number;
  month: number; // 1–12
}

interface CardInvoiceDay {
  day: number;
  expense: number;
  availableLimit: number;
  launches: CardLaunch[];
  status: 'negative' | 'warning' | 'healthy';
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
export class CardsTabComponent implements OnInit {
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
  pendingDeleteLaunch: CardLaunch | null = null;
  pendingDeleteHasRecurringOptions = false;
  pendingEditLaunch: CardLaunch | null = null;
  editScope: CardDeleteScope = 'single';

  @Output() faturaFechada = new EventEmitter<{ amount: number; dueDate: string; description: string }>();
  launchSearchTerm = '';
  launchRepeatFilter: 'all' | 'single' | 'installment' | 'fixed' = 'all';
  invoiceMonth: InvoiceMonth = this.currentYearMonth();
  launchForm: CardLaunchFormState = this.createEmptyLaunchForm();

  readonly cardTypeOptions = ['Cartao de Credito'];
  private readonly currencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 2
  });

  cardForm: CreditCardFormState = this.createEmptyCardForm();

  constructor(private readonly api: FinanceApiService) {}

  ngOnInit(): void {
    this.loadCards();
    this.loadLaunches();
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

  get invoiceClosingDate(): string {
    if (!this.selectedCard) return '—';
    return this.formatDate(this.getClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard));
  }

  get invoiceDueDate(): string {
    if (!this.selectedCard) return '—';
    return this.formatDate(this.getDueDateForInvoiceMonth(this.invoiceMonth, this.selectedCard));
  }

  get selectedCardLaunches(): CardLaunch[] {
    const selectedCard = this.selectedCard;
    if (!this.selectedCardId || !selectedCard) return [];
    return this.launches
      .filter(l => {
        if (String(l.cardId) !== String(this.selectedCardId)) {
          return false;
        }

        const invoiceMonth = this.getInvoiceMonthForDate(l.date, selectedCard);
        return invoiceMonth.year === this.invoiceMonth.year
          && invoiceMonth.month === this.invoiceMonth.month;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  get hasLaunches(): boolean {
    return this.filteredSelectedCardLaunches.length > 0;
  }

  get filteredSelectedCardLaunches(): CardLaunch[] {
    const term = this.launchSearchTerm.trim().toLowerCase();

    return this.selectedCardLaunches.filter((launch) => {
      const repeatMatch = this.launchRepeatFilter === 'all' || launch.repeatMode === this.launchRepeatFilter;
      if (!repeatMatch) {
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
    return this.launchRepeatFilter !== 'all' || !!this.launchSearchTerm.trim();
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
        return 'Em atencao';
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

    return this.isEditingLaunch ? 'Salvar alteracoes' : 'Salvar';
  }

  get launchPreviewText(): string {
    const selectedInvoiceMonth = this.parseInvoiceMonthRef(this.launchForm.invoiceMonthRef);
    if (!selectedInvoiceMonth) {
      return 'Selecione o mes da fatura para ver onde o lancamento sera registrado.';
    }

    const invoiceLabel = this.formatInvoiceMonthLabel(selectedInvoiceMonth);
    const amount = this.launchForm.amount || 0;
    const amountLabel = this.formatCurrency(amount);

    if (!this.selectedCard) {
      return `O lancamento sera registrado na fatura de ${invoiceLabel}.`;
    }

    const baseDate = this.launchForm.date || this.getTodayInputDate();
    const normalizedDate = this.ensureDateInsideInvoiceMonth(baseDate, selectedInvoiceMonth, this.selectedCard);
    const normalizedDateLabel = this.formatDate(new Date(`${normalizedDate}T00:00:00`));
    const dateAdjusted = normalizedDate !== baseDate;
    const closingDate = this.formatDate(this.getClosingDateForInvoiceMonth(selectedInvoiceMonth, this.selectedCard));
    const dueDate = this.formatDate(this.getDueDateForInvoiceMonth(selectedInvoiceMonth, this.selectedCard));
    const adjustedText = dateAdjusted
      ? ` A data base sera ajustada para ${normalizedDateLabel} para cair nesse ciclo.`
      : '';

    if (!this.isEditingLaunch && this.launchForm.repeatMode === 'installment') {
      const installments = Math.max(2, Number(this.launchForm.installmentCount || 2));
      const finalInvoiceMonth = this.shiftInvoiceMonth(selectedInvoiceMonth, installments - 1);
      const finalLabel = this.formatInvoiceMonthLabel(finalInvoiceMonth);

      return `Vai criar ${installments} parcelas de ${amountLabel} cada, da fatura ${invoiceLabel} ate ${finalLabel}. O valor inserido ja e o valor de cada parcela. Primeira fatura fecha em ${closingDate} e vence em ${dueDate}.${adjustedText}`;
    }

    if (this.launchForm.repeatMode === 'fixed') {
      return `Lancamento fixo de ${amountLabel}, iniciando na fatura de ${invoiceLabel}. Esta fatura fecha em ${closingDate} e vence em ${dueDate}.${adjustedText}`;
    }

    return `Vai criar 1 lancamento de ${amountLabel} na fatura de ${invoiceLabel}. Esta fatura fecha em ${closingDate} e vence em ${dueDate}.${adjustedText}`;
  }

  get editScopeTitle(): string {
    if (!this.pendingEditLaunch) {
      return 'Editar lancamento';
    }
    return `Editar "${this.describeCardLaunch(this.pendingEditLaunch)}"`;
  }

  get editScopeDescription(): string {
    if (!this.pendingEditLaunch) {
      return '';
    }
    return 'Esse lancamento faz parte de uma repeticao. Escolha quais deseja editar.';
  }

  get deleteScopeTitle(): string {
    if (!this.pendingDeleteLaunch) {
      return 'Excluir lancamento';
    }

    return `Excluir "${this.describeCardLaunch(this.pendingDeleteLaunch)}"`;
  }

  get deleteScopeDescription(): string {
    if (!this.pendingDeleteLaunch) {
      return '';
    }

    if (!this.pendingDeleteHasRecurringOptions) {
      return 'Essa acao nao pode ser desfeita.';
    }

    return 'Esse lancamento faz parte de uma repeticao. Escolha o que deseja excluir.';
  }

  get showInstallmentCountField(): boolean {
    return !this.isEditingLaunch && this.launchForm.repeatMode === 'installment';
  }

  get modalTitle(): string {
    return this.isEditMode ? 'Editar cartao' : 'Novo cartao de credito';
  }

  get isCurrentInvoiceMonth(): boolean {
    const now = new Date();
    return this.invoiceMonth.year === now.getFullYear() && this.invoiceMonth.month === (now.getMonth() + 1);
  }

  get isInvoicePastClosingDate(): boolean {
    if (!this.selectedCard) {
      return false;
    }
    const closing = this.getClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);
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
      const dueDate = this.getDueDateForInvoiceMonth(this.invoiceMonth, this.selectedCard!);
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
        this.launchError = 'Nao foi possivel fechar a fatura. Tente novamente.';
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
    return launch.description?.trim() || 'Despesa sem descricao';
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
        this.cardError = 'Nao foi possivel carregar os cartoes. Verifique o backend.';
        this.isLoading = false;
      }
    });
  }

  loadLaunches(): void {
    this.api.getCardLaunches().subscribe({
      next: (launches) => {
        this.launches = launches;
        if (this.selectedCard) {
          this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
        }
        this.scrollToFirstLaunchDay();
      },
      error: () => {
        this.launchError = 'Nao foi possivel carregar os lancamentos do cartao.';
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
    this.cardForm = {
      name: card.name,
      brand: card.brand,
      limit: card.limit,
      dueDay: card.dueDay,
      firstDueDate: card.firstDueDate,
      closeDaysBefore: card.closeDaysBefore,
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

  openLaunchModal(): void {
    this.editingLaunchId = null;
    this.launchForm = this.createEmptyLaunchForm(
      this.getSuggestedLaunchDate(),
      this.formatInvoiceMonthRef(this.invoiceMonth)
    );
    this.launchError = null;
    this.isLaunchModalOpen = true;
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
      ? this.getInvoiceMonthForDate(launch.date, this.selectedCard)
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
      tags: launch.tags,
    };
    this.launchError = null;
    this.isLaunchModalOpen = true;
  }

  closeLaunchModal(): void {
    this.isLaunchModalOpen = false;
    this.launchError = null;
    this.editingLaunchId = null;
  }

  submitLaunchForm(): void {
    if (!this.selectedCardId) {
      this.launchError = 'Selecione um cartao para lancar a despesa.';
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
    const selectedInvoiceMonth = this.parseInvoiceMonthRef(this.launchForm.invoiceMonthRef) ?? this.invoiceMonth;
    const normalizedDate = this.selectedCard
      ? this.ensureDateInsideInvoiceMonth(this.launchForm.date, selectedInvoiceMonth, this.selectedCard)
      : this.launchForm.date;
    const targetInvoiceMonth = selectedInvoiceMonth;
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
      tags: this.launchForm.tags,
    };

    if (isInstallmentCreation) {
      const launches = this.buildInstallmentLaunches(baseLaunch, installmentCount);
      forkJoin(launches.map((item) => this.api.createCardLaunch(item))).subscribe({
        next: (savedLaunches) => {
          this.invoiceMonth = targetInvoiceMonth;
          this.launches = [...savedLaunches, ...this.launches];
          this.isSavingLaunch = false;
          this.closeLaunchModal();
          this.scrollToFirstLaunchDay();
        },
        error: () => {
          this.launchError = 'Erro ao salvar lancamento. Tente novamente.';
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
          this.invoiceMonth = targetInvoiceMonth;
          saved.forEach((s) => {
            const idx = this.launches.findIndex((item) => String(item.id) === String(s.id));
            if (idx !== -1) { this.launches[idx] = s; }
          });
          this.launches = [...this.launches];
          this.isSavingLaunch = false;
          this.closeLaunchModal();
          this.scrollToFirstLaunchDay();
        },
        error: () => {
          this.launchError = 'Erro ao salvar lancamento. Tente novamente.';
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
        this.closeLaunchModal();
        this.scrollToFirstLaunchDay();
      },
      error: () => {
        this.launchError = 'Erro ao salvar lancamento. Tente novamente.';
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

    if (this.isEditMode && this.selectedCard) {
      const updated: CreditCard = {
        ...this.selectedCard,
        name: this.cardForm.name || 'Cartao',
        brand: this.cardForm.brand,
        limit: this.cardForm.limit ?? 0,
        dueDay: this.cardForm.dueDay,
        firstDueDate: this.cardForm.firstDueDate,
        closeDaysBefore: this.cardForm.closeDaysBefore,
        parentCardName: this.cardForm.parentCardName,
      };
      this.api.updateCard(updated).subscribe({
        next: (saved) => {
          const idx = this.cards.findIndex(c => c.id === saved.id);
          if (idx !== -1) this.cards[idx] = saved;
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
        dueDay: this.cardForm.dueDay,
        firstDueDate: this.cardForm.firstDueDate,
        closeDaysBefore: this.cardForm.closeDaysBefore,
        parentCardName: this.cardForm.parentCardName,
        avatarColor: color,
      };
      this.api.createCard(newCard).subscribe({
        next: (saved) => {
          this.cards.push(saved);
          if (this.selectedCardId === null) {
            this.selectedCardId = saved.id!;
          }
          this.isSaving = false;
          this.isCardModalOpen = false;
        },
        error: () => {
          this.cardError = 'Erro ao salvar. Tente novamente.';
          this.isSaving = false;
        }
      });
    }
  }

  selectCard(id: string | number): void {
    this.selectedCardId = id;
    if (this.selectedCard) {
      this.invoiceMonth = this.getPreferredInvoiceMonth(this.selectedCard);
    }
    this.scrollToFirstLaunchDay();
  }

  prevMonth(): void {
    let { year, month } = this.invoiceMonth;
    month--;
    if (month < 1) { month = 12; year--; }
    this.invoiceMonth = { year, month };
    this.scrollToFirstLaunchDay();
  }

  nextMonth(): void {
    let { year, month } = this.invoiceMonth;
    month++;
    if (month > 12) { month = 1; year++; }
    this.invoiceMonth = { year, month };
    this.scrollToFirstLaunchDay();
  }

  goToCurrentMonth(): void {
    this.invoiceMonth = this.currentYearMonth();
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
      firstDueDate: this.getTodayInputDate(),
      closeDaysBefore: 10,
      parentCardName: '',
    };
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
      tags: '',
    };
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
        this.launchError = 'Erro ao excluir lancamento. Tente novamente.';
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
    const cycleStart = this.getCycleStartDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);
    const cycleEnd = this.getClosingDateForInvoiceMonth(this.invoiceMonth, this.selectedCard);

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

  private shiftInvoiceMonth(invoiceMonth: InvoiceMonth, monthsToAdd: number): InvoiceMonth {
    const shifted = new Date(invoiceMonth.year, invoiceMonth.month - 1 + monthsToAdd, 1);
    return {
      year: shifted.getFullYear(),
      month: shifted.getMonth() + 1,
    };
  }

  private formatCurrency(value: number): string {
    return this.currencyFormatter.format(Number.isFinite(value) ? value : 0);
  }

  private ensureDateInsideInvoiceMonth(dateInput: string, targetInvoiceMonth: InvoiceMonth, card: CreditCard): string {
    const originalMonth = this.getInvoiceMonthForDate(dateInput, card);
    if (originalMonth.year === targetInvoiceMonth.year && originalMonth.month === targetInvoiceMonth.month) {
      return dateInput;
    }

    return this.toInputDate(this.getClosingDateForInvoiceMonth(targetInvoiceMonth, card));
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

  private getInvoiceMonthForDate(dateInput: string, card: CreditCard): InvoiceMonth {
    const transactionDate = new Date(`${dateInput}T00:00:00`);
    if (Number.isNaN(transactionDate.getTime())) {
      return this.invoiceMonth;
    }

    const dueDateSameMonth = new Date(transactionDate.getFullYear(), transactionDate.getMonth(), card.dueDay);
    const closeDateSameMonth = new Date(dueDateSameMonth);
    closeDateSameMonth.setDate(closeDateSameMonth.getDate() - card.closeDaysBefore);

    const invoiceDueDate = transactionDate <= closeDateSameMonth
      ? dueDateSameMonth
      : new Date(transactionDate.getFullYear(), transactionDate.getMonth() + 1, card.dueDay);

    return {
      year: invoiceDueDate.getFullYear(),
      month: invoiceDueDate.getMonth() + 1,
    };
  }

  private getPreferredInvoiceMonth(_card: CreditCard): InvoiceMonth {
    return this.currentYearMonth();
  }

  private getDueDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
    return new Date(invoiceMonth.year, invoiceMonth.month - 1, card.dueDay);
  }

  private getClosingDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
    const dueDate = this.getDueDateForInvoiceMonth(invoiceMonth, card);
    const closingDate = new Date(dueDate);
    closingDate.setDate(closingDate.getDate() - card.closeDaysBefore);
    return closingDate;
  }

  private getCycleStartDateForInvoiceMonth(invoiceMonth: InvoiceMonth, card: CreditCard): Date {
    const dueDate = this.getDueDateForInvoiceMonth(invoiceMonth, card);
    const previousDueDate = new Date(dueDate.getFullYear(), dueDate.getMonth() - 1, card.dueDay);
    const previousClosingDate = new Date(previousDueDate);
    previousClosingDate.setDate(previousClosingDate.getDate() - card.closeDaysBefore);
    previousClosingDate.setDate(previousClosingDate.getDate() + 1);
    return previousClosingDate;
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
