import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Item de anuncio mostrado no modal de "novidades".
 *
 * Cada anuncio tem um `id` unico e estavel. Quando o usuario fecha o modal,
 * todos os ids exibidos sao gravados em localStorage e nao aparecem novamente.
 *
 * Para adicionar um novo anuncio: incluir um item no `ANNOUNCEMENTS` abaixo
 * com um id novo. Os antigos seguem ocultos para quem ja viu, mas usuarios
 * que nunca abriram o app verao tudo de uma vez (sequenciado por prev/next).
 */
export interface Announcement {
  /** Identificador unico/estavel. NUNCA reaproveitar entre features diferentes. */
  id: string;
  /** Data de publicacao (informativa, mostrada no modal). ISO string AAAA-MM-DD. */
  publishedAt: string;
  /** Titulo curto. */
  title: string;
  /** Subtitulo opcional, ex: "novidade", "ajuste de comportamento". */
  badge?: string;
  /** Lista de paragrafos / bullets em texto simples. */
  body: string[];
}

const STORAGE_KEY = 'mf:announcements:seen';

const ANNOUNCEMENTS: Announcement[] = [
  {
    id: 'budgets-2026-04',
    publishedAt: '2026-04-29',
    badge: 'Novidade',
    title: 'Metas de gasto',
    body: [
      'Voce agora pode definir metas mensais de gasto para a sua carteira inteira, para um cartao especifico ou para uma tag.',
      'Configure na aba Metas. O acompanhamento aparece no Dashboard e na aba Cartoes, com barra de progresso, projecao de fechamento e alertas quando passar dos limites.',
      'Cada meta pode usar periodo Mensal (calendario das compras) ou Ciclo de fatura (somente para metas de cartao, agrupa pelo ciclo que sera cobrado).'
    ]
  },
  {
    id: 'cards-calendar-grouping-2026-04',
    publishedAt: '2026-04-29',
    badge: 'Ajuste',
    title: 'Cartoes agora agrupam por mes da compra',
    body: [
      'Na aba Cartoes, os lancamentos sao agrupados pelo mes calendario da compra ou parcela. Comprou em 29/04? Aparece em Abril, mesmo se a fatura for cobrada em Maio.',
      'As datas de Fechamento e Vencimento exibidas referem-se ao ciclo em que essa fatura sera cobrada (ou seja, o mes seguinte do agrupamento).',
      'Metas com periodo "Ciclo de fatura" mostram listras diagonais na barra de progresso para deixar claro que o valor representa o que sera cobrado naquela fatura, nao o gasto do mes calendario.'
    ]
  }
];

@Injectable({ providedIn: 'root' })
export class AnnouncementsService {
  private readonly pendingSubject = new BehaviorSubject<Announcement[]>([]);
  readonly pending$: Observable<Announcement[]> = this.pendingSubject.asObservable();

  constructor() {
    this.refresh();
  }

  /** Recalcula a lista de anuncios pendentes baseando-se no que ja foi visto. */
  refresh(): void {
    const seen = this.getSeenIds();
    const pending = ANNOUNCEMENTS.filter((a) => !seen.has(a.id));
    this.pendingSubject.next(pending);
  }

  /** Marca uma lista de ids como vistos e atualiza a stream de pendentes. */
  markAsSeen(ids: string[]): void {
    if (!ids.length) return;
    const seen = this.getSeenIds();
    let changed = false;
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.persistSeenIds(seen);
      this.refresh();
    }
  }

  /** Apaga o registro local. Util para testes manuais. */
  resetSeen(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage indisponivel (ex: modo privado): nada a fazer.
    }
    this.refresh();
  }

  private getSeenIds(): Set<string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      // JSON invalido ou storage bloqueado.
    }
    return new Set();
  }

  private persistSeenIds(seen: Set<string>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(seen)));
    } catch {
      // storage indisponivel: ignora silenciosamente.
    }
  }
}
