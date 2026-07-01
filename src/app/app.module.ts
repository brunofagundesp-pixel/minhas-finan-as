import { NgModule, APP_INITIALIZER } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { AngularFireModule } from '@angular/fire/compat';
import { AngularFirestoreModule } from '@angular/fire/compat/firestore';
import { AngularFireAuthModule } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';
import 'firebase/compat/app-check';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { CardsTabComponent } from './features/cards/cards-tab/cards-tab.component';
import { ConfigTabComponent } from './features/config/config-tab/config-tab.component';
import { LoginComponent } from './features/auth/login/login.component';
import { GoalsTabComponent } from './features/goals/goals-tab/goals-tab.component';
import { SimulatorTabComponent } from './features/simulator/simulator-tab/simulator-tab.component';
import { InvestmentTabComponent } from './features/investment/investment-tab/investment-tab.component';
import { BetaBlockedComponent } from './features/beta-blocked/beta-blocked.component';
import { BudgetsSummaryComponent } from './shared/budgets-summary/budgets-summary.component';
import { AnnouncementsModalComponent } from './shared/announcements-modal/announcements-modal.component';
import { environment } from '../environments/environment';

@NgModule({
  declarations: [
    AppComponent,
    CardsTabComponent,
    ConfigTabComponent,
    LoginComponent,
    GoalsTabComponent,
    SimulatorTabComponent,
    InvestmentTabComponent,
    BetaBlockedComponent,
    BudgetsSummaryComponent,
    AnnouncementsModalComponent
  ],
  imports: [
    BrowserModule,
    FormsModule,
    AngularFireModule.initializeApp(environment.firebase),
    AngularFirestoreModule,
    AngularFireAuthModule,
    AppRoutingModule
  ],
  providers: [
    { provide: APP_INITIALIZER, useFactory: () => initializeAppCheck, multi: true }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }

export function initializeAppCheck(): void {
  if (typeof window !== 'undefined') {
    if (!firebase.apps.length) {
      firebase.initializeApp(environment.firebase);
    }
    firebase.appCheck().activate(environment.appCheckSiteKey);
  }
}
