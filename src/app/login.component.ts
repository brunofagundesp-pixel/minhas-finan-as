import { Component, OnInit } from '@angular/core';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit {
  email = '';
  password = '';
  errorMessage = '';
  loading = false;

  constructor(private auth: AuthService) {}

  async ngOnInit() {
    // Conclui login se o usuário voltou por um link de e-mail
    try {
      await this.auth.completeEmailLinkSignIn();
    } catch (err: any) {
      this.errorMessage = err.message ?? 'Erro ao confirmar o link de acesso.';
    }
  }

  async loginWithEmailPassword() {
    if (!this.email || !this.password) {
      this.errorMessage = 'Preencha e-mail e senha.';
      return;
    }
    if (this.password.length < 6) {
      this.errorMessage = 'A senha deve ter pelo menos 6 caracteres.';
      return;
    }
    this.errorMessage = '';
    this.loading = true;
    try {
      await this.auth.loginWithEmailPassword(this.email, this.password);
    } catch (err: any) {
      this.errorMessage = this.describeAuthError(err);
    } finally {
      this.loading = false;
    }
  }

  async loginWithGoogle() {
    this.errorMessage = '';
    this.loading = true;
    try {
      await this.auth.loginWithGoogle();
    } catch (err: any) {
      this.errorMessage = this.describeAuthError(err, true);
    } finally {
      this.loading = false;
    }
  }

  private describeAuthError(err: any, isGoogle = false): string {
    const code: string = err?.code ?? '';

    switch (code) {
      case 'auth/wrong-password':
        return 'Senha incorreta.';
      case 'auth/invalid-email':
        return 'E-mail invalido.';
      case 'auth/operation-not-allowed':
      case 'auth/configuration-not-found':
        return isGoogle
          ? 'O login com Google nao esta habilitado no Firebase Auth. Ative esse provedor no console do Firebase.'
          : 'O login com e-mail e senha nao esta habilitado no Firebase Auth. Ative o provedor Email/Senha no console do Firebase.';
      case 'auth/invalid-credential':
        return isGoogle
          ? 'Nao foi possivel autenticar com Google. Verifique a configuracao do provedor no Firebase Auth.'
          : 'E-mail ou senha invalidos.';
      case 'auth/popup-closed-by-user':
        return 'A janela de login foi fechada antes da conclusao.';
      case 'auth/network-request-failed':
        return 'Falha de rede ao tentar autenticar. Verifique sua conexao e tente novamente.';
      default:
        return err?.message ?? (isGoogle ? 'Erro ao entrar com Google.' : 'Erro ao entrar.');
    }
  }
}

