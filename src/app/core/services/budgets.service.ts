import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { Observable, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

import { Budget, BudgetInput, BudgetPatch } from '../models/budget.model';

interface StoredBudgetDoc extends Partial<Omit<Budget, 'id'>> {
  id?: string;
}

/**
 * CRUD reativo das metas (`budgets`) do usuário autenticado.
 *
 * Coleção: `users/{uid}/budgets/{budgetId}`
 * - IDs são gerados pelo Firestore (`createId`).
 * - Documento contém apenas o "contrato" (escopo, alvo, valor, período…);
 *   o gasto realizado é sempre derivado em runtime pelo `BudgetCalculatorService`.
 */
@Injectable({ providedIn: 'root' })
export class BudgetsService {
  constructor(
    private readonly firestore: AngularFirestore,
    private readonly afAuth: AngularFireAuth
  ) {}

  /** Stream reativo da lista de metas. Emite `[]` quando deslogado. */
  readonly budgets$: Observable<Budget[]> = this.afAuth.authState.pipe(
    switchMap((user) => {
      if (!user) {
        return of([] as Budget[]);
      }
      return this.firestore
        .collection<StoredBudgetDoc>(this.collectionPath(user.uid), (ref) => ref.orderBy('createdAt', 'desc'))
        .valueChanges({ idField: 'id' })
        .pipe(map((docs) => docs.map((doc) => this.normalize(doc))));
    })
  );

  /** Cria uma meta nova. Retorna o id gerado. */
  async create(input: BudgetInput): Promise<string> {
    const uid = await this.requireUid();
    const id = this.firestore.createId();
    const now = new Date().toISOString();
    const payload: Budget = {
      id,
      ...input,
      createdAt: now,
      updatedAt: now
    };
    await this.firestore
      .doc(`${this.collectionPath(uid)}/${id}`)
      .set(this.stripUndefined(payload));
    return id;
  }

  /** Atualiza campos arbitrários da meta. */
  async update(id: string, patch: BudgetPatch): Promise<void> {
    const uid = await this.requireUid();
    if (!id) {
      throw new Error('Budget id é obrigatório.');
    }
    const payload = this.stripUndefined({
      ...patch,
      updatedAt: new Date().toISOString()
    });
    await this.firestore.doc(`${this.collectionPath(uid)}/${id}`).update(payload);
  }

  /** Atalho para alternar `active`. */
  async setActive(id: string, active: boolean): Promise<void> {
    return this.update(id, { active });
  }

  /** Remove permanentemente a meta. */
  async remove(id: string): Promise<void> {
    const uid = await this.requireUid();
    if (!id) {
      return;
    }
    await this.firestore.doc(`${this.collectionPath(uid)}/${id}`).delete();
  }

  private async requireUid(): Promise<string> {
    const user = await this.afAuth.currentUser;
    if (!user) {
      throw new Error('Usuário não autenticado');
    }
    return user.uid;
  }

  private collectionPath(uid: string): string {
    return `users/${uid}/budgets`;
  }

  private normalize(doc: StoredBudgetDoc & { id?: string }): Budget {
    const now = new Date().toISOString();
    const monthlyAmounts: Record<string, number> = {};
    if (doc.monthlyAmounts && typeof doc.monthlyAmounts === 'object') {
      for (const [key, value] of Object.entries(doc.monthlyAmounts as Record<string, unknown>)) {
        const num = Number(value);
        if (Number.isFinite(num) && /^\d{4}-\d{2}$/.test(key)) {
          monthlyAmounts[key] = num;
        }
      }
    }

    const excludedMonths: string[] = [];
    if (Array.isArray(doc.excludedMonths)) {
      for (const item of doc.excludedMonths as unknown[]) {
        if (typeof item === 'string' && /^\d{4}-\d{2}$/.test(item)) {
          excludedMonths.push(item);
        }
      }
    }

    const toMonth = (value: unknown): number | undefined => {
      const num = Number(value);
      return Number.isFinite(num) && num >= 1 && num <= 12 ? num : undefined;
    };
    const toYear = (value: unknown): number | undefined => {
      const num = Number(value);
      return Number.isFinite(num) && num >= 1900 && num <= 9999 ? num : undefined;
    };

    return {
      id: String(doc.id ?? ''),
      scope: (doc.scope ?? 'tag') as Budget['scope'],
      targetId: String(doc.targetId ?? ''),
      targetName: String(doc.targetName ?? ''),
      amount: Number(doc.amount ?? 0),
      period: (doc.period ?? 'monthly') as Budget['period'],
      rollover: Boolean(doc.rollover),
      active: doc.active !== false,
      notes: typeof doc.notes === 'string' ? doc.notes : undefined,
      startYear: toYear(doc.startYear),
      startMonth: toMonth(doc.startMonth),
      endYear: toYear(doc.endYear),
      endMonth: toMonth(doc.endMonth),
      monthlyAmounts: Object.keys(monthlyAmounts).length > 0 ? monthlyAmounts : undefined,
      excludedMonths: excludedMonths.length > 0 ? excludedMonths : undefined,
      createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : now,
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : now
    };
  }

  private stripUndefined<T extends object>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }
}
