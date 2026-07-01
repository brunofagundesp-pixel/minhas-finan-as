import { Injectable } from '@angular/core';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import firebase from 'firebase/compat/app';
import { Observable, of } from 'rxjs';
import { map, shareReplay, startWith, switchMap, take } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

const EMAIL_KEY = 'emailForSignIn';
const TRUST_UNTIL_KEY = 'authTrustUntil';
const PENDING_VERIFICATION_KEY = 'pendingVerification';

export interface AuthState {
  /** True quando o Firebase Auth já restaurou (ou não) a sessão persistida. */
  ready: boolean;
  user: firebase.User | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  user$: Observable<firebase.User | null>;
  /**
   * Estado completo de autenticação, incluindo um flag `ready` que só vira
   * true após a primeira emissão do Firebase. Use isto para evitar o flash da
   * tela de login enquanto a sessão persistida ainda está sendo restaurada.
   */
  authState$: Observable<AuthState>;

  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore
  ) {
    this.user$ = this.afAuth.authState;
    this.authState$ = this.afAuth.authState.pipe(
      map<firebase.User | null, AuthState>((user) => ({ ready: true, user })),
      startWith<AuthState>({ ready: false, user: null }),
      shareReplay({ bufferSize: 1, refCount: false })
    );
    this.enforceTrustedSessionWindow();
  }

  /**
   * Tenta fazer login com email+senha. Se o usuário não existir, cria a conta.
   * Retorna `{ credential, isNewUser }` indicando se a conta foi criada agora.
   * Google e email-link já criam conta automaticamente pelo Firebase.
   */
  async loginWithEmailPassword(email: string, password: string, trustDays: number | null): Promise<{ credential: firebase.auth.UserCredential; isNewUser: boolean }> {
    await this.configurePersistence(trustDays);

    try {
      // Seta o flag ANTES do createUser para que, quando o Firebase mudar o
      // authState e o Angular re-renderizar, o showVerificationScreen já seja true
      // e não haja flash da tela do app.
      localStorage.setItem(PENDING_VERIFICATION_KEY, email);
      const credential = await this.afAuth.createUserWithEmailAndPassword(email, password);
      return { credential, isNewUser: true };
    } catch (err: any) {
      const code: string = err?.code ?? '';

      if (code === 'auth/email-already-in-use') {
        localStorage.removeItem(PENDING_VERIFICATION_KEY);
        const credential = await this.afAuth.signInWithEmailAndPassword(email, password);
        return { credential, isNewUser: false };
      }

      localStorage.removeItem(PENDING_VERIFICATION_KEY);
      throw err;
    }
  }

  async loginWithGoogle(trustDays: number | null): Promise<firebase.auth.UserCredential> {
    await this.configurePersistence(trustDays);

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

  /** Envia email de verificação para o usuário logado. */
  async sendVerificationEmail(): Promise<void> {
    const user = await this.afAuth.currentUser;
    if (!user) throw new Error('Nenhum usuário logado.');
    await user.sendEmailVerification({ url: environment.appUrl });
  }

  /** Atualiza o email do usuário logado e envia nova verificação. */
  async updateEmailAndVerify(newEmail: string): Promise<void> {
    const user = await this.afAuth.currentUser;
    if (!user) throw new Error('Nenhum usuário logado.');
    await user.updateEmail(newEmail);
    await user.sendEmailVerification({ url: environment.appUrl });
    localStorage.setItem(PENDING_VERIFICATION_KEY, newEmail);
  }

  /** Recarrega os dados do usuário do servidor e retorna emailVerified. */
  async checkEmailVerified(): Promise<boolean> {
    const user = await this.afAuth.currentUser;
    if (!user) return false;
    await user.reload();
    return (await this.afAuth.currentUser)?.emailVerified ?? false;
  }

  /** Email pendente de verificação salvo no localStorage. */
  get pendingVerificationEmail(): string | null {
    return localStorage.getItem(PENDING_VERIFICATION_KEY);
  }

  /** Remove a flag de verificação pendente. */
  clearPendingVerification(): void {
    localStorage.removeItem(PENDING_VERIFICATION_KEY);
  }

  logout(): Promise<void> {
    localStorage.removeItem(PENDING_VERIFICATION_KEY);
    return this.afAuth.signOut();
  }

  /**
   * Re-autentica o usuário corrente com email+senha. Usado em ações sensíveis
   * (ex.: excluir tag em massa) para confirmar que é o dono da conta.
   * Retorna true se a senha confere; false em qualquer outro caso.
   */
  async reauthenticateWithPassword(password: string): Promise<boolean> {
    const user = await this.afAuth.currentUser;
    if (!user || !user.email) {
      return false;
    }
    try {
      const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
      await user.reauthenticateWithCredential(credential);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True quando o usuário corrente entrou usando senha. Para usuários do
   * Google (sem provedor `password`), pular a confirmação por senha.
   */
  async hasPasswordProvider(): Promise<boolean> {
    const user = await this.afAuth.currentUser;
    if (!user) return false;
    return user.providerData.some((p) => p?.providerId === 'password');
  }

  private async configurePersistence(trustDays: number | null): Promise<void> {
    const usePersistentSession = Number.isInteger(trustDays) && (trustDays ?? 0) > 0;
    await this.afAuth.setPersistence(
      usePersistentSession ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION
    );

    if (usePersistentSession) {
      const expiresAt = Date.now() + (Number(trustDays) * 24 * 60 * 60 * 1000);
      localStorage.setItem(TRUST_UNTIL_KEY, String(expiresAt));
      return;
    }

    localStorage.removeItem(TRUST_UNTIL_KEY);
  }

  /**
   * Verifica se o usuário está autorizado a acessar o app.
   * Checa primeiro a coleção `betaApplicants` pelo email e, se não encontrar,
   * usa o `metadata.creationTime` do Firebase Auth para determinar se a conta
   * foi criada antes do beta (usuário existente).
   */
  checkAuthorization(email: string, uid: string): Observable<boolean> {
    return this.firestore
      .collection('betaApplicants', ref => ref.where('email', '==', email).limit(1))
      .valueChanges({ idField: 'id' })
      .pipe(
        switchMap(applicants => {
          if (applicants.length > 0) return of(true);
          return this.afAuth.authState.pipe(
            take(1),
            map(user => {
              if (!user?.metadata?.creationTime) return false;
              const created = new Date(user.metadata.creationTime).getTime();
              const cutoff = Date.now() - 5000;
              return created < cutoff;
            })
          );
        }),
        take(1)
      );
  }

  private enforceTrustedSessionWindow(): void {
    this.afAuth.authState.subscribe((user) => {
      if (!user) {
        return;
      }

      const trustUntilRaw = localStorage.getItem(TRUST_UNTIL_KEY);
      if (!trustUntilRaw) {
        return;
      }

      const trustUntil = Number(trustUntilRaw);
      if (!Number.isFinite(trustUntil)) {
        localStorage.removeItem(TRUST_UNTIL_KEY);
        return;
      }

      if (Date.now() <= trustUntil) {
        return;
      }

      localStorage.removeItem(TRUST_UNTIL_KEY);
      this.afAuth.signOut();
    });
  }
}

