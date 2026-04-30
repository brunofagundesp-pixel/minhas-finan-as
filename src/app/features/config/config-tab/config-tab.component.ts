import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription, forkJoin, of } from 'rxjs';
import { take } from 'rxjs/operators';

import {
  TAG_PALETTE,
  TagCatalogItem,
  normalizeTagName,
  normalizeTagLabel
} from '../../../core/models/tag.model';
import { AuthService } from '../../../core/services/auth.service';
import { FinanceApiService, MonthDefinition, CardLaunch } from '../../../core/services/finance-api.service';
import { TagsService } from '../../../core/services/tags.service';

interface TagEditState {
  originalName: string;
  name: string;
  color: string;
}

interface PendingTagDeletion {
  tag: TagCatalogItem;
  affectedEventsCount: number;
  affectedLaunchesCount: number;
  passwordInput: string;
  passwordError: string;
  /** Quando true, ignora o passo de senha (login via Google etc.). */
  passwordSkipped: boolean;
  isProcessing: boolean;
}

/**
 * Tela de configurações gerais. Por enquanto contém apenas o gerenciamento
 * do catálogo de tags (renomear, trocar cor, excluir). É o ponto de entrada
 * planejado para futuras seções de preferências.
 */
@Component({
  selector: 'app-config-tab',
  templateUrl: './config-tab.component.html',
  styleUrls: ['./config-tab.component.scss']
})
export class ConfigTabComponent implements OnInit, OnDestroy {
  tags: TagCatalogItem[] = [];
  isLoading = true;
  errorMessage = '';

  /** Tag em edição (null = ninguém). */
  editing: TagEditState | null = null;

  /** Estado da modal de exclusão (null = fechada). */
  pendingDelete: PendingTagDeletion | null = null;

  /** Paleta exposta para o template. */
  readonly palette: ReadonlyArray<string> = TAG_PALETTE;

  private subscription = new Subscription();
  private months: MonthDefinition[] = [];
  private cardLaunches: CardLaunch[] = [];

  constructor(
    private readonly tagsService: TagsService,
    private readonly financeApi: FinanceApiService,
    private readonly auth: AuthService
  ) {}

  ngOnInit(): void {
    this.subscription.add(
      this.tagsService.tags$.subscribe({
        next: (tags) => {
          this.tags = tags;
          this.isLoading = false;
        },
        error: () => {
          this.isLoading = false;
          this.errorMessage = 'Não foi possível carregar as tags.';
        }
      })
    );

    // Mantém as listas locais atualizadas para contagem e cleanup.
    this.subscription.add(
      this.financeApi.getMonths().subscribe((months) => {
        this.months = months ?? [];
      })
    );
    this.subscription.add(
      this.financeApi.getCardLaunches().subscribe((launches) => {
        this.cardLaunches = launches ?? [];
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  startEdit(tag: TagCatalogItem): void {
    this.editing = { originalName: tag.name, name: tag.name, color: tag.color };
    this.pendingDelete = null;
  }

  cancelEdit(): void {
    this.editing = null;
  }

  selectColor(color: string): void {
    if (this.editing) {
      this.editing.color = color;
    }
  }

  async confirmEdit(): Promise<void> {
    if (!this.editing) return;
    const newLabel = normalizeTagLabel(this.editing.name);
    if (!newLabel) {
      this.errorMessage = 'Informe um nome para a tag.';
      return;
    }

    const oldKey = normalizeTagName(this.editing.originalName);
    const newKey = normalizeTagName(newLabel);

    if (oldKey !== newKey && this.tags.some((t) => normalizeTagName(t.name) === newKey)) {
      this.errorMessage = `Já existe uma tag chamada "${newLabel}".`;
      return;
    }

    try {
      this.errorMessage = '';
      if (oldKey === newKey) {
        await this.tagsService.upsert({ name: newLabel, color: this.editing.color });
      } else {
        await this.tagsService.rename(this.editing.originalName, newLabel);
        await this.tagsService.upsert({ name: newLabel, color: this.editing.color });
      }
      this.editing = null;
    } catch (err) {
      console.error('[config] rename/upsert failed', err);
      this.errorMessage = 'Não foi possível salvar a tag.';
    }
  }

  // --------------------------------------------------------------------------
  // Exclusão com confirmação por senha + cleanup nos lançamentos.
  // --------------------------------------------------------------------------

  async requestDelete(tag: TagCatalogItem): Promise<void> {
    this.editing = null;
    const tagKey = normalizeTagName(tag.name);

    let affectedEventsCount = 0;
    for (const month of this.months) {
      for (const ev of month.events ?? []) {
        if (this.eventHasTag(ev.tags, tagKey)) {
          affectedEventsCount += 1;
        }
      }
    }
    let affectedLaunchesCount = 0;
    for (const launch of this.cardLaunches) {
      if (this.launchHasTag(launch.tags, tagKey)) {
        affectedLaunchesCount += 1;
      }
    }

    // Usuários que entraram via Google não têm senha — pula o passo.
    let passwordSkipped = true;
    try {
      passwordSkipped = !(await this.auth.hasPasswordProvider());
    } catch {
      passwordSkipped = false;
    }

    this.pendingDelete = {
      tag,
      affectedEventsCount,
      affectedLaunchesCount,
      passwordInput: '',
      passwordError: '',
      passwordSkipped,
      isProcessing: false
    };
  }

  cancelDelete(): void {
    if (this.pendingDelete?.isProcessing) return;
    this.pendingDelete = null;
  }

  async confirmDelete(): Promise<void> {
    if (!this.pendingDelete || this.pendingDelete.isProcessing) return;
    const state = this.pendingDelete;
    state.passwordError = '';

    if (!state.passwordSkipped) {
      const pwd = (state.passwordInput || '').trim();
      if (!pwd) {
        state.passwordError = 'Informe sua senha para confirmar.';
        return;
      }
      state.isProcessing = true;
      const ok = await this.auth.reauthenticateWithPassword(pwd);
      if (!ok) {
        state.isProcessing = false;
        state.passwordError = 'Senha incorreta. Tente novamente.';
        return;
      }
    } else {
      state.isProcessing = true;
    }

    try {
      this.errorMessage = '';
      await this.cleanupTagFromData(state.tag);
      await this.tagsService.remove(state.tag.name);
      this.pendingDelete = null;
    } catch (err) {
      console.error('[config] remove failed', err);
      state.isProcessing = false;
      state.passwordError = 'Não foi possível concluir a exclusão. Tente novamente.';
    }
  }

  trackByTagName(_index: number, item: TagCatalogItem): string {
    return normalizeTagName(item.name);
  }

  // --------------------------------------------------------------------------
  // Helpers internos
  // --------------------------------------------------------------------------

  private eventHasTag(tags: ReadonlyArray<string> | undefined, tagKey: string): boolean {
    if (!tags || !tagKey) return false;
    return tags.some((t) => normalizeTagName(t) === tagKey);
  }

  private launchHasTag(tagsCsv: string | undefined, tagKey: string): boolean {
    if (!tagsCsv || !tagKey) return false;
    return tagsCsv
      .split(',')
      .map((t) => normalizeTagName(t))
      .some((t) => t === tagKey);
  }

  /** Remove a tag de todos os eventos e lançamentos persistidos. */
  private async cleanupTagFromData(tag: TagCatalogItem): Promise<void> {
    const tagKey = normalizeTagName(tag.name);
    if (!tagKey) return;

    const monthsToUpdate: MonthDefinition[] = [];
    for (const month of this.months) {
      let touched = false;
      const newEvents = (month.events ?? []).map((ev) => {
        if (!this.eventHasTag(ev.tags, tagKey)) {
          return ev;
        }
        touched = true;
        const cleanedTags = (ev.tags ?? []).filter((t) => normalizeTagName(t) !== tagKey);
        return { ...ev, tags: cleanedTags };
      });
      if (touched) {
        monthsToUpdate.push({ ...month, events: newEvents });
      }
    }

    const launchesToUpdate: CardLaunch[] = [];
    for (const launch of this.cardLaunches) {
      if (!this.launchHasTag(launch.tags, tagKey)) {
        continue;
      }
      const cleanedTagsCsv = (launch.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && normalizeTagName(t) !== tagKey)
        .join(', ');
      launchesToUpdate.push({ ...launch, tags: cleanedTagsCsv });
    }

    const monthOps = monthsToUpdate.length
      ? forkJoin(monthsToUpdate.map((m) => this.financeApi.updateMonth(m).pipe(take(1))))
      : of([]);
    const launchOps = launchesToUpdate.length
      ? forkJoin(launchesToUpdate.map((l) => this.financeApi.updateCardLaunch(l).pipe(take(1))))
      : of([]);

    await Promise.all([monthOps.toPromise(), launchOps.toPromise()]);
  }
}
