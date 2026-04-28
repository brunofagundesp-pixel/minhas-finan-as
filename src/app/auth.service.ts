import { Injectable } from '@angular/core';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

const EMAIL_KEY = 'emailForSignIn';

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<firebase.User | null>;

  constructor(private afAuth: AngularFireAuth) {
    this.user$ = this.afAuth.authState;
  }

  /**
   * Tenta fazer login com email+senha. Se o usuário não existir, cria a conta.
   * Google e email-link já criam conta automaticamente pelo Firebase.
   */
  async loginWithEmailPassword(email: string, password: string): Promise<firebase.auth.UserCredential> {
    try {
      return await this.afAuth.createUserWithEmailAndPassword(email, password);
    } catch (err: any) {
      const code: string = err?.code ?? '';

      if (code === 'auth/email-already-in-use') {
        return await this.afAuth.signInWithEmailAndPassword(email, password);
      }

      throw err;
    }
  }

  loginWithGoogle(): Promise<firebase.auth.UserCredential> {
    const provider = new firebase.auth.GoogleAuthProvider();
    return this.afAuth.signInWithPopup(provider);
  }

  /** Envia o link mágico para o e-mail informado (fluxo alternativo). */
  sendEmailLink(email: string): Promise<void> {
    const actionCodeSettings: firebase.auth.ActionCodeSettings = {
      url: environment.appUrl,
      handleCodeInApp: true
    };
    return this.afAuth.sendSignInLinkToEmail(email, actionCodeSettings).then(() => {
      localStorage.setItem(EMAIL_KEY, email);
    });
  }

  /** Conclui o login quando o usuário volta pelo link de e-mail. */
  async completeEmailLinkSignIn(): Promise<boolean> {
    const isLink = await this.afAuth.isSignInWithEmailLink(window.location.href);
    if (!isLink) return false;

    let email = localStorage.getItem(EMAIL_KEY);
    if (!email) {
      email = window.prompt('Confirme seu e-mail para concluir o login:') ?? '';
    }
    if (!email) return false;

    await this.afAuth.signInWithEmailLink(email, window.location.href);
    localStorage.removeItem(EMAIL_KEY);
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }

  logout(): Promise<void> {
    return this.afAuth.signOut();
  }
}

