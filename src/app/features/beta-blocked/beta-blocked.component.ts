import { Component } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { Observable } from 'rxjs';
import firebase from 'firebase/compat/app';

@Component({
  selector: 'app-beta-blocked',
  templateUrl: './beta-blocked.component.html',
  styleUrls: ['./beta-blocked.component.scss']
})
export class BetaBlockedComponent {
  user$: Observable<firebase.User | null>;

  constructor(public auth: AuthService) {
    this.user$ = this.auth.user$;
  }
}
