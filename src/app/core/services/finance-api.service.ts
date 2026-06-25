import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { map, Observable, of, switchMap } from 'rxjs';

export interface CreditCard {
  id?: number | string;
  name: string;
  brand: string;
  limit: number;
  dueDay: number;
  firstDueDate: string;
  closeDaysBefore: number;
  closeDay?: number;
  dueMonthOffset?: number;
  parentCardName: string;
  avatarColor: string;
}

export type LaunchRepeatMode = 'single' | 'installment' | 'fixed';

export interface CardLaunch {
  id?: number | string;
  cardId: number | string;
  amount: number;
  date: string;
  invoiceMonthRef?: string;
  repeatMode: LaunchRepeatMode;
  seriesId?: string;
  installmentNumber?: number;
  installmentTotal?: number;
  paid?: boolean;
  paidAt?: string;
  account: string;
  description: string;
  notes: string;
  tags: string;
}

export type EventType = 'income' | 'expense' | 'investment' | 'daily';
export type RepeatMode = 'daily' | 'weekly' | 'monthly';
export type RecurrenceKind = 'single' | 'installment' | 'fixed';

export interface FinancialEvent {
  id?: string;
  seriesId?: string;
  recurrenceKind?: RecurrenceKind;
  repeatMode?: RepeatMode;
  seriesOccurrences?: number | null;
  suppressed?: boolean;
  dailyOccurrenceAction?: 'skip' | 'override';
  paid?: boolean;
  paidAt?: string;
  day: number;
  label: string;
  amount: number;
  type: EventType;
  tags?: string[];
  investmentSourceEventId?: string;
  investmentMovement?: 'withdrawal';
}

export interface MonthDefinition {
  id: string;
  key: string;
  title: string;
  year: number;
  monthNumber: number;
  openingBalance: number;
  dailyFixedCost: number;
  events: FinancialEvent[];
}

/**
 * Janela opcional para limitar a leitura de `users/{uid}/months`. Útil para
 * acelerar o boot evitando trazer anos antigos. Quando omitido, retorna todos
 * os meses do usuário.
 */
export interface MonthsQueryRange {
  /** Inclusive — só traz meses com `year >= fromYear`. */
  fromYear?: number;
  /** Inclusive — só traz meses com `year <= toYear`. */
  toYear?: number;
}

@Injectable({ providedIn: 'root' })
export class FinanceApiService {
  private readonly monthsCollection = 'months';
  private readonly cardsCollection = 'cards';
  private readonly cardLaunchesCollection = 'cardLaunches';

  constructor(
    private readonly firestore: AngularFirestore,
    private readonly afAuth: AngularFireAuth
  ) {}

  private async uid(): Promise<string> {
    const user = await this.afAuth.currentUser;
    if (!user) throw new Error('Usuário não autenticado');
    return user.uid;
  }

  getMonths(range?: MonthsQueryRange): Observable<MonthDefinition[]> {
    return this.afAuth.authState.pipe(
      switchMap(user => {
        if (!user) return of([]);
        return this.firestore
          .collection<MonthDefinition>(
            `users/${user.uid}/${this.monthsCollection}`,
            (ref) => {
              let query: firebase.firestore.Query = ref;
              if (range?.fromYear !== undefined) {
                query = query.where('year', '>=', range.fromYear);
              }
              if (range?.toYear !== undefined) {
                query = query.where('year', '<=', range.toYear);
              }
              return query;
            }
          )
          .valueChanges({ idField: 'id' });
      }),
      map(months => months.sort((a, b) => (a.year - b.year) || (a.monthNumber - b.monthNumber)))
    );
  }

  updateMonth(month: MonthDefinition): Observable<MonthDefinition> {
    const payload = JSON.parse(JSON.stringify(month));
    return new Observable<MonthDefinition>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection(`users/${uid}/${this.monthsCollection}`).doc(String(month.id)).set(payload)
      ).then(() => {
        observer.next(month);
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  getCards(): Observable<CreditCard[]> {
    return this.afAuth.authState.pipe(
      switchMap(user => {
        if (!user) return of([]);
        return this.firestore
          .collection<CreditCard>(`users/${user.uid}/${this.cardsCollection}`)
          .valueChanges({ idField: 'id' });
      })
    );
  }

  createCard(card: CreditCard): Observable<CreditCard> {
    return new Observable<CreditCard>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection<CreditCard>(`users/${uid}/${this.cardsCollection}`).add(card)
      ).then((ref) => {
        observer.next({ ...card, id: ref.id });
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  updateCard(card: CreditCard): Observable<CreditCard> {
    const id = String(card.id);
    const payload = { ...card };
    delete payload.id;

    return new Observable<CreditCard>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection(`users/${uid}/${this.cardsCollection}`).doc(id).update(payload)
      ).then(() => {
        observer.next(card);
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  deleteCard(id: string | number): Observable<void> {
    return new Observable<void>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection(`users/${uid}/${this.cardsCollection}`).doc(String(id)).delete()
      ).then(() => {
        observer.next();
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  getCardLaunches(): Observable<CardLaunch[]> {
    return this.afAuth.authState.pipe(
      switchMap(user => {
        if (!user) return of([]);
        return this.firestore
          .collection<CardLaunch>(`users/${user.uid}/${this.cardLaunchesCollection}`)
          .valueChanges({ idField: 'id' });
      })
    );
  }

  createCardLaunch(launch: CardLaunch): Observable<CardLaunch> {
    return new Observable<CardLaunch>((observer) => {
      const payload = JSON.parse(JSON.stringify(launch));
      delete payload.id;
      this.uid().then(uid =>
        this.firestore.collection<CardLaunch>(`users/${uid}/${this.cardLaunchesCollection}`).add(payload)
      ).then((ref) => {
        observer.next({ ...launch, id: ref.id });
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  updateCardLaunch(launch: CardLaunch): Observable<CardLaunch> {
    const id = String(launch.id);
    const payload = JSON.parse(JSON.stringify(launch));
    delete payload.id;

    return new Observable<CardLaunch>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection(`users/${uid}/${this.cardLaunchesCollection}`).doc(id).update(payload)
      ).then(() => {
        observer.next(launch);
        observer.complete();
      }).catch((error) => observer.error(error));
    });
  }

  deleteCardLaunch(id: string | number): Observable<void> {
    return new Observable<void>((observer) => {
      this.uid().then(uid =>
        this.firestore.collection(`users/${uid}/${this.cardLaunchesCollection}`).doc(String(id)).delete()
      ).then(() => {
        observer.next();
        observer.complete();
        })
        .catch((error) => observer.error(error));
    });
  }
}
