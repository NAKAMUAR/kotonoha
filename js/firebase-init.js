// =====================================================================
// 言の葉 / Kotonoha — Firebase 初期化
// Step 2: Auth (Google) + Firestore (users コレクション)
// =====================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { firebaseConfig } from '../firebase-config.js';

// ---------- 初期化 ----------

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

// ---------- 認証 ----------

export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request') {
      return null; // ユーザーがキャンセル
    }
    if (err.code === 'auth/popup-blocked') {
      // ポップアップブロック時は redirect にフォールバック
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

export async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    return result?.user ?? null;
  } catch (err) {
    console.error('redirect result error:', err);
    return null;
  }
}

export function signOutUser() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ---------- ユーザードキュメント ----------
// Firestore: users/{uid}
//   profile:  { uid, displayName, email, photoURL, createdAt, lastLoginAt }
//   progress: { streak, lastStudyDate, totalWordsLearned, completedScenarios,
//               currentPhase, currentLanguage }
//   settings: { targetLanguage, dailyGoalMinutes }

const USERS = 'users';

export const DEFAULT_PROGRESS = {
  streak: 0,
  lastStudyDate: null,
  totalWordsLearned: 0,
  completedScenarios: 0,
  currentPhase: 1,
  currentLanguage: 'en',
};

const DEFAULT_SETTINGS = {
  targetLanguage: 'en',
  dailyGoalMinutes: 20,
};

export async function ensureUserDoc(user) {
  const ref  = doc(db, USERS, user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const initial = {
      profile: {
        uid:         user.uid,
        displayName: user.displayName ?? '名無し',
        email:       user.email ?? null,
        photoURL:    user.photoURL ?? null,
        createdAt:   serverTimestamp(),
        lastLoginAt: serverTimestamp(),
      },
      progress: { ...DEFAULT_PROGRESS },
      settings: { ...DEFAULT_SETTINGS },
    };
    await setDoc(ref, initial);
    return initial;
  }

  await updateDoc(ref, { 'profile.lastLoginAt': serverTimestamp() });
  return snap.data();
}

export async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, USERS, uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateUserProgress(uid, partial) {
  const ref = doc(db, USERS, uid);
  const updates = {};
  for (const [k, v] of Object.entries(partial)) {
    updates[`progress.${k}`] = v;
  }
  await updateDoc(ref, updates);
}

export async function updateUserSettings(uid, partial) {
  const ref = doc(db, USERS, uid);
  const updates = {};
  for (const [k, v] of Object.entries(partial)) {
    updates[`settings.${k}`] = v;
  }
  await updateDoc(ref, updates);
}

// ---------- エラー → 日本語メッセージ ----------

export function authErrorMessage(err) {
  switch (err?.code) {
    case 'auth/unauthorized-domain':
      return 'このドメインは Firebase で許可されていません（Authorized domains に追加してください）';
    case 'auth/operation-not-allowed':
      return 'Firebase コンソールで Google ログインを有効にしてください';
    case 'auth/network-request-failed':
      return 'ネットワークエラー — 接続を確認してください';
    case 'auth/popup-blocked':
      return 'ポップアップがブロックされました';
    case 'permission-denied':
      return 'Firestore のセキュリティルールでアクセスが拒否されました';
    case 'unavailable':
      return 'Firestore に接続できません — Database を作成しましたか？';
    default:
      return `エラー: ${err?.message ?? err}`;
  }
}
