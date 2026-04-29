import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { map, switchMap, tap } from 'rxjs/operators';

import {
  TagCatalogItem,
  normalizeTagName,
  normalizeTagLabel,
  pickTagColor
} from '../models/tag.model';

const LEGACY_STORAGE_KEY = 'financial-tags';
const MIGRATION_FLAG_PREFIX = 'financial-tags:migrated:';

interface StoredTagDoc {
  name?: string;
  color?: string;
}

/**
 * Reactive catalog of tags persisted under `users/{uid}/tags/{tagId}`.
 *
 * - Document IDs are derived from the normalized tag name to enforce uniqueness.
 * - On first authenticated load, any catalog still living in `localStorage`
 *   under `financial-tags` is migrated up to Firestore (one-shot per uid).
 * - Components should read `tags$` and call the explicit mutation methods
 *   (`upsert`, `upsertMany`, `remove`, `rename`) instead of writing directly.
 */
@Injectable({ providedIn: 'root' })
export class TagsService {
  private readonly snapshot$ = new BehaviorSubject<TagCatalogItem[]>([]);
  private currentUid: string | null = null;

  /** Reactive snapshot, replays the latest emission to new subscribers. */
  readonly tags$: Observable<TagCatalogItem[]> = this.afAuth.authState.pipe(
    switchMap((user) => {
      if (!user) {
        this.currentUid = null;
        this.snapshot$.next([]);
        return of([] as TagCatalogItem[]);
      }

      this.currentUid = user.uid;

      return this.firestore
        .collection<StoredTagDoc>(this.collectionPath(user.uid), (ref) => ref.orderBy('name'))
        .valueChanges({ idField: 'id' })
        .pipe(
          map((docs) => this.normalizeDocs(docs)),
          tap((tags) => {
            this.snapshot$.next(tags);
            // Run one-time migration once we know the remote state.
            void this.maybeMigrateLocalStorage(user.uid, tags);
          })
        );
    })
  );

  constructor(
    private readonly firestore: AngularFirestore,
    private readonly afAuth: AngularFireAuth
  ) {}

  /** Synchronous snapshot of the most recent emission. */
  current(): TagCatalogItem[] {
    return this.snapshot$.getValue();
  }

  /**
   * Insert or update a single tag (idempotent).
   * Returns the canonical tag (with normalized label and assigned color).
   */
  async upsert(tag: TagCatalogItem): Promise<TagCatalogItem | null> {
    const uid = await this.requireUid();
    const label = normalizeTagLabel(tag.name);
    if (!label) {
      return null;
    }

    const docId = normalizeTagName(label);
    const color = (tag.color && tag.color.trim()) || pickTagColor(this.current());
    const payload: StoredTagDoc = { name: label, color };

    await this.firestore.doc(`${this.collectionPath(uid)}/${docId}`).set(payload, { merge: true });
    return { name: label, color };
  }

  /**
   * Bulk insert/update — only writes tags that are new or whose color changed.
   * Never deletes tags missing from the input (use `remove` for that).
   */
  async upsertMany(tags: ReadonlyArray<TagCatalogItem>): Promise<void> {
    const uid = await this.requireUid();
    const existingByKey = new Map(
      this.current().map((tag) => [normalizeTagName(tag.name), tag])
    );

    const writes: Array<Promise<void>> = [];
    const seen = new Set<string>();

    for (const tag of tags) {
      const label = normalizeTagLabel(tag.name);
      if (!label) {
        continue;
      }
      const docId = normalizeTagName(label);
      if (seen.has(docId)) {
        continue;
      }
      seen.add(docId);

      const existing = existingByKey.get(docId);
      const color = (tag.color && tag.color.trim()) || existing?.color || pickTagColor(this.current());
      if (existing && existing.name === label && existing.color === color) {
        continue;
      }

      writes.push(
        this.firestore
          .doc(`${this.collectionPath(uid)}/${docId}`)
          .set({ name: label, color }, { merge: true })
      );
    }

    await Promise.all(writes);
  }

  /** Permanently remove a tag from the catalog (does not touch events/launches). */
  async remove(name: string): Promise<void> {
    const uid = await this.requireUid();
    const docId = normalizeTagName(name);
    if (!docId) {
      return;
    }
    await this.firestore.doc(`${this.collectionPath(uid)}/${docId}`).delete();
  }

  /** Rename a tag (creates new doc, deletes old). */
  async rename(oldName: string, newName: string): Promise<void> {
    const uid = await this.requireUid();
    const oldId = normalizeTagName(oldName);
    const newLabel = normalizeTagLabel(newName);
    const newId = normalizeTagName(newLabel);
    if (!oldId || !newId || oldId === newId) {
      if (oldId && newId && oldId === newId && newLabel) {
        // Same identity but display label changed — just update the doc.
        const existing = this.current().find((tag) => normalizeTagName(tag.name) === oldId);
        await this.firestore
          .doc(`${this.collectionPath(uid)}/${oldId}`)
          .set({ name: newLabel, color: existing?.color ?? pickTagColor(this.current()) }, { merge: true });
      }
      return;
    }

    const existing = this.current().find((tag) => normalizeTagName(tag.name) === oldId);
    const color = existing?.color ?? pickTagColor(this.current());

    await this.firestore.doc(`${this.collectionPath(uid)}/${newId}`).set({ name: newLabel, color });
    await this.firestore.doc(`${this.collectionPath(uid)}/${oldId}`).delete();
  }

  private async requireUid(): Promise<string> {
    if (this.currentUid) {
      return this.currentUid;
    }
    const user = await this.afAuth.currentUser;
    if (!user) {
      throw new Error('Usuário não autenticado');
    }
    this.currentUid = user.uid;
    return user.uid;
  }

  private collectionPath(uid: string): string {
    return `users/${uid}/tags`;
  }

  private normalizeDocs(docs: ReadonlyArray<StoredTagDoc & { id?: string }>): TagCatalogItem[] {
    const seen = new Set<string>();
    const result: TagCatalogItem[] = [];

    for (const doc of docs) {
      const label = normalizeTagLabel(String(doc.name ?? doc.id ?? ''));
      if (!label) {
        continue;
      }
      const key = normalizeTagName(label);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const color = typeof doc.color === 'string' && doc.color.trim().length
        ? doc.color.trim()
        : pickTagColor(result);
      result.push({ name: label, color });
    }

    return result;
  }

  private async maybeMigrateLocalStorage(uid: string, remote: TagCatalogItem[]): Promise<void> {
    if (typeof localStorage === 'undefined') {
      return;
    }

    const flagKey = `${MIGRATION_FLAG_PREFIX}${uid}`;
    if (localStorage.getItem(flagKey)) {
      return;
    }
    if (remote.length > 0) {
      // Remote already populated → assume migration unnecessary, mark done.
      localStorage.setItem(flagKey, '1');
      return;
    }

    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(flagKey, '1');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.setItem(flagKey, '1');
      return;
    }

    const candidates = this.normalizeLegacyPayload(parsed);
    if (candidates.length === 0) {
      localStorage.setItem(flagKey, '1');
      return;
    }

    try {
      await this.upsertMany(candidates);
      localStorage.setItem(flagKey, '1');
    } catch (error) {
      console.warn('[TagsService] Falha ao migrar tags do localStorage:', error);
    }
  }

  private normalizeLegacyPayload(payload: unknown): TagCatalogItem[] {
    if (!Array.isArray(payload)) {
      return [];
    }

    const result: TagCatalogItem[] = [];
    const seen = new Set<string>();

    for (const item of payload) {
      let label = '';
      let color = '';

      if (typeof item === 'string') {
        label = normalizeTagLabel(item);
      } else if (item && typeof item === 'object') {
        const candidate = item as { name?: unknown; color?: unknown };
        label = normalizeTagLabel(String(candidate.name ?? ''));
        if (typeof candidate.color === 'string' && candidate.color.trim().length) {
          color = candidate.color.trim();
        }
      }

      if (!label) {
        continue;
      }
      const key = normalizeTagName(label);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ name: label, color: color || pickTagColor(result) });
    }

    return result;
  }
}
