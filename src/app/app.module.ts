import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { AngularFireModule } from '@angular/fire/compat';
import { AngularFirestoreModule } from '@angular/fire/compat/firestore';
import { AngularFireAuthModule } from '@angular/fire/compat/auth';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { CardsTabComponent } from './features/cards/cards-tab/cards-tab.component';
import { LoginComponent } from './features/auth/login/login.component';
import { SettingsTabComponent } from './features/settings/settings-tab/settings-tab.component';
import { BudgetsSummaryComponent } from './shared/budgets-summary/budgets-summary.component';
import { AnnouncementsModalComponent } from './shared/announcements-modal/announcements-modal.component';
import { environment } from '../environments/environment';

@NgModule({
  declarations: [
    AppComponent,
    CardsTabComponent,
    LoginComponent,
    SettingsTabComponent,
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
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
