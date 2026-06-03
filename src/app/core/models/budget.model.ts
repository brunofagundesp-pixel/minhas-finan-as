/**
 * Modelo de "metas" (budgets) — tetos de gastos definidos pelo usuário,
 * persistidos em `users/{uid}/budgets/{budgetId}`.
 */

export type BudgetScope = 'tag' | 'card' | 'global' | 'investment';

/**
 * - `monthly`: mês civil (ano + mês). Aplica-se a qualquer escopo.
 * - `invoice-cycle`: ciclo de fatura do cartão. Só faz sentido com `scope='card'`.
 */
export type BudgetPeriod = 'monthly' | 'invoice-cycle';

export interface Budget {
  id: string;
  scope: BudgetScope;

  /**
   * Identificador do alvo dependente do escopo:
   * - `tag`  → nome normalizado da tag (lowercase pt-BR), igual ao docId em `tags/`.
   * - `card` → cardId (string).
   * - `global` → string vazia ou ausente.
   */
  targetId: string;

  /** Rótulo denormalizado para exibição rápida (nome da tag/cartão). */
  targetName: string;

  /** Teto em reais (BRL). */
  amount: number;

  period: BudgetPeriod;

  /** Quando true, sobra (ou estouro) acumula para o próximo período. */
  rollover: boolean;

  /** Metas inativas continuam visíveis em histórico mas não geram alertas. */
  active: boolean;

  /** Observação opcional do usuário. */
  notes?: string;

  /**
   * Janela de vigência. Quando ausente (metas legadas), considera-se "vale desde sempre".
   * `startMonth`/`endMonth` são 1-12.
   */
  startYear?: number;
  startMonth?: number;
  endYear?: number;
  endMonth?: number;

  /**
   * Overrides pontuais por mês civil (chave `yyyy-mm`). Quando o mês corrente
   * tem entrada aqui, esse valor sobrepõe `amount` no cálculo. Permite ter
   * uma única meta com tetos variáveis ao longo do tempo.
   */
  monthlyAmounts?: Record<string, number>;

  /**
   * Meses civis (chave `yyyy-mm`) excluídos da vigência. Permite "remover
   * apenas este mês" sem apagar a meta inteira nem mexer na janela. O
   * calculador trata esses meses como fora da vigência.
   */
  excludedMonths?: string[];

  /** Timestamps em ISO. */
  createdAt: string;
  updatedAt: string;
}

export type BudgetInput = Omit<Budget, 'id' | 'createdAt' | 'updatedAt'>;
export type BudgetPatch = Partial<Omit<Budget, 'id' | 'createdAt'>>;
