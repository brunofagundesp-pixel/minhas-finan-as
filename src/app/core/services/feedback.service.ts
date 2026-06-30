import { Injectable } from '@angular/core';
import { AngularFirestore } from '@angular/fire/compat/firestore';
import { AngularFireAuth } from '@angular/fire/compat/auth';
import firebase from 'firebase/compat/app';

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  constructor(
    private afAuth: AngularFireAuth,
    private firestore: AngularFirestore
  ) {}

  async send(message: string): Promise<void> {
    const user = await this.afAuth.currentUser;
    if (!user) throw new Error('Usuário não autenticado.');

    await this.firestore.collection('feedback').add({
      message: message.trim(),
      userId: user.uid,
      email: user.email ?? '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
}
