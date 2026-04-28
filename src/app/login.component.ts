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
      const code: string = err?.code ?? '';
      if (code === 'auth/wrong-password') {
        this.errorMessage = 'Senha incorreta.';
      } else {
        this.errorMessage = err.message ?? 'Erro ao entrar.';
      }
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
      this.errorMessage = err.message ?? 'Erro ao entrar com Google.';
    } finally {
      this.loading = false;
    }
  }
}

