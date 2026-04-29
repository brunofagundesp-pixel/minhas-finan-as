import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';

import { Announcement, AnnouncementsService } from '../../core/services/announcements.service';

/**
 * Modal de "novidades" mostrado automaticamente no primeiro acesso apos um
 * release com novos anuncios. Usuario navega entre os itens com prev/next e
 * fecha com "Entendi" — o que marca todos os anuncios atualmente pendentes
 * como vistos (nao volta a aparecer).
 */
@Component({
  selector: 'app-announcements-modal',
  templateUrl: './announcements-modal.component.html',
  styleUrls: ['./announcements-modal.component.scss']
})
export class AnnouncementsModalComponent implements OnInit, OnDestroy {
  pending: Announcement[] = [];
  index = 0;
  isOpen = false;

  private subscription = new Subscription();
  private readonly monthNames = [
    'jan', 'fev', 'mar', 'abr', 'mai', 'jun',
    'jul', 'ago', 'set', 'out', 'nov', 'dez'
  ];

  constructor(private readonly service: AnnouncementsService) {}

  ngOnInit(): void {
    this.subscription.add(
      this.service.pending$.subscribe((pending) => {
        this.pending = pending;
        if (pending.length > 0 && !this.isOpen) {
          this.index = 0;
          // Pequeno atraso evita "flash" durante boot quando o usuario nao logado tambem
          // dispara este componente. Em login screen o componente nao e renderizado.
          this.isOpen = true;
        }
        if (pending.length === 0) {
          this.isOpen = false;
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  get current(): Announcement | null {
    return this.pending[this.index] ?? null;
  }

  get hasPrevious(): boolean {
    return this.index > 0;
  }

  get hasNext(): boolean {
    return this.index < this.pending.length - 1;
  }

  goPrevious(): void {
    if (this.hasPrevious) {
      this.index -= 1;
    }
  }

  goNext(): void {
    if (this.hasNext) {
      this.index += 1;
    }
  }

  /** Fecha o modal e marca como vistos todos os anuncios atualmente pendentes. */
  dismiss(): void {
    const ids = this.pending.map((a) => a.id);
    this.isOpen = false;
    this.service.markAsSeen(ids);
  }

  formatPublishedAt(dateIso: string): string {
    const parts = dateIso.split('-');
    if (parts.length !== 3) return dateIso;
    const month = Number(parts[1]);
    if (!Number.isInteger(month) || month < 1 || month > 12) return dateIso;
    return `${parts[2]} ${this.monthNames[month - 1]} ${parts[0]}`;
  }

  trackByIndex(i: number): number {
    return i;
  }
}
