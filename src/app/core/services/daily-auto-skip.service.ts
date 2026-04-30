import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable } from 'rxjs';

import { FinanceApiService, FinancialEvent, MonthDefinition } from './finance-api.service';

/**
 * Service responsável por "fechar" automaticamente o dia anterior quando o
 * relógio cruza a meia-noite. Regra:
 *
 *   Se o dia que acabou de passar não recebeu NENHUM lançamento manual de
 *   diário (nada do tipo `daily` cadastrado para aquele dia), assume-se que
 *   o usuário não gastou nada — e marcamos um `dailyOccurrenceAction: 'skip'`
 *   para cada série diária ativa, zerando o custo daquele dia.
 *
 * Observações:
 * - Só roda enquanto o app está aberto (não há cron/back-end).
 * - Limite: considera apenas séries com âncora dentro dos meses carregados em
 *   memória. Casos cross-month muito antigos podem não ser detectados (raro).
 * - Idempotente: se já existe qualquer evento de diário no dia, não faz nada.
 */
@Injectable({ providedIn: 'root' })
export class DailyAutoSkipService implements OnDestroy {
  private timerHandle?: ReturnType<typeof setInterval>;
  private lastSeenDateKey?: string;
  private getMonths?: () => MonthDefinition[];

  /** Intervalo de checagem em ms (default: 60s). */
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly financeApi: FinanceApiService,
    private readonly zone: NgZone
  ) {}

  /**
   * Inicia o relógio. Recebe um getter para os meses correntes (assim a
   * service não precisa duplicar a fonte de verdade).
   */
  start(getMonths: () => MonthDefinition[]): void {
    this.stop();
    this.getMonths = getMonths;
    this.lastSeenDateKey = this.todayKey();

    // Roda fora do Angular zone para não disparar change detection a cada
    // minuto sem necessidade.
    this.zone.runOutsideAngular(() => {
      this.timerHandle = setInterval(() => this.tick(), this.tickIntervalMs);
    });
  }

  stop(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  ngOnDestroy(): void {
    this.stop();
  }

  // --- internals ---

  private tick(): void {
    const nowKey = this.todayKey();
    if (nowKey === this.lastSeenDateKey) return;

    // Cruzou a meia-noite: processa o dia que acabou de passar.
    const yesterday = this.previousLocalDay();
    this.lastSeenDateKey = nowKey;

    const months = this.getMonths?.() ?? [];
    if (months.length === 0) return;

    const update = this.buildAutoSkipForDay(yesterday, months);
    if (!update) return;

    // Volta pro Angular zone para que a UI reaja ao update.
    this.zone.run(() => {
      this.financeApi.updateMonth(update).subscribe({
        error: (err) => console.warn('[daily-auto-skip] falhou ao salvar', err)
      });
    });
  }

  /**
   * Calcula a versão atualizada do `MonthDefinition` para o dia `target`,
   * inserindo eventos de skip para cada série diária ativa que não tenha
   * lançamento naquele dia. Retorna `null` quando nada precisa mudar.
   */
  buildAutoSkipForDay(
    target: { year: number; month: number; day: number },
    months: MonthDefinition[]
  ): MonthDefinition | null {
    const month = months.find(
      (m) => m.year === target.year && m.monthNumber === target.month
    );
    if (!month) return null;

    // Se há QUALQUER evento de diário nesse dia (single, override, skip,
    // mudança de taxa), considera que o usuário interagiu — não mexe.
    const hasDailyActivity = month.events.some(
      (e) => e.type === 'daily' && e.day === target.day
    );
    if (hasDailyActivity) return null;

    // Coleta séries diárias fixas com âncora em algum mês <= target. Pega
    // sempre a primeira ocorrência (anchor) por seriesId — basta para saber
    // que a série existe e estava rodando.
    const activeSeriesIds = new Set<string>();
    for (const m of months) {
      const monthKeyNum = m.year * 100 + m.monthNumber;
      const targetKeyNum = target.year * 100 + target.month;
      if (monthKeyNum > targetKeyNum) continue;

      for (const e of m.events) {
        if (
          e.type === 'daily' &&
          e.seriesId &&
          (e.recurrenceKind ?? 'single') === 'fixed' &&
          (e.repeatMode ?? null) === 'daily' &&
          (e.dailyOccurrenceAction ?? null) !== 'skip'
        ) {
          // Para o mês de referência, só considera âncoras com day <= target.day.
          if (m.year === target.year && m.monthNumber === target.month && e.day > target.day) {
            continue;
          }
          activeSeriesIds.add(e.seriesId);
        }
      }
    }

    if (activeSeriesIds.size === 0) return null;

    const newEvents: FinancialEvent[] = [...month.events];
    for (const seriesId of activeSeriesIds) {
      newEvents.push({
        id: this.generateEventId(),
        seriesId,
        recurrenceKind: 'fixed',
        repeatMode: 'daily',
        type: 'daily',
        day: target.day,
        amount: 0,
        label: 'Sem gasto (auto)',
        suppressed: true,
        dailyOccurrenceAction: 'skip'
      });
    }

    return { ...month, events: newEvents };
  }

  // --- helpers ---

  /** Chave do dia local no formato YYYY-MM-DD. */
  private todayKey(): string {
    const now = new Date();
    return this.dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  private dateKey(year: number, month: number, day: number): string {
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${year}-${m}-${d}`;
  }

  private previousLocalDay(): { year: number; month: number; day: number } {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate()
    };
  }

  private generateEventId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `evt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
}
