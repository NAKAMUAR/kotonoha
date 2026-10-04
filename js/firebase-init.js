// =====================================================================
// 言の葉 / Kotonoha — Firebase 初期化
// Step 2: Auth (Google) + Firestore (users コレクション)
// =====================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  getRedirectResult,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  EmailAuthProvider,
  linkWithCredential,
  updatePassword,
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

// ログインはポップアップ方式のみ。
// リダイレクト方式は、アプリ（localhost）と認証ドメイン（firebaseapp.com）が
// 別サイトのため、最近のブラウザのストレージ分離により
// 「missing initial state / sessionStorage is inaccessible」で失敗する。
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request') {
      return null; // ユーザーがキャンセル
    }
    throw err; // popup-blocked 等は呼び出し元でメッセージ表示
  }
}

// iPhone / iPad の「ホーム画面に追加」したアプリとして起動しているか。
// この状態ではログイン用のポップアップが別の画面で開かれ、Google ログインの途中経過
// （sessionStorage）が引き継がれないため「missing initial state」で失敗する。
export function isIosStandalone() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true ||
                     window.matchMedia?.('(display-mode: standalone)').matches;
  return ios && standalone;
}

// ---------- メールアドレス＋パスワード（ホーム画面アプリ用） ----------
// Google でログインしたアカウントにパスワードを追加しておくと、同じアカウント（同じ学習記録）に
// メールアドレスとパスワードでもログインできる。

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email.trim(), password);
  return result.user;
}

export function hasPasswordLogin(user = auth.currentUser) {
  return !!user?.providerData?.some((p) => p.providerId === 'password');
}

/** ログイン中のアカウントにパスワードを設定（既にあれば変更） */
export async function setAccountPassword(password) {
  const user = auth.currentUser;
  if (!user?.email) throw Object.assign(new Error('no email'), { code: 'kotonoha/no-email' });
  if (hasPasswordLogin(user)) {
    await updatePassword(user, password);
  } else {
    await linkWithCredential(user, EmailAuthProvider.credential(user.email, password));
  }
  await user.reload();
  return user;
}

export function sendPasswordReset(email) {
  return sendPasswordResetEmail(auth, email.trim());
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
      return 'Firebase コンソールでこのログイン方法が有効になっていません（Authentication → Sign-in method で「メール / パスワード」または「Google」を有効にしてください）';
    case 'auth/network-request-failed':
      return 'ネットワークエラー — 接続を確認してください';
    case 'auth/popup-blocked':
      return 'ログイン画面（ポップアップ）がブロックされました。アドレスバー右端のアイコンから、このサイトのポップアップを「許可」して、もう一度押してください';
    case 'auth/missing-initial-state':
    case 'auth/web-storage-unsupported':
      return 'ブラウザの保存領域が使えないためログインできません。シークレット（プライベート）ウィンドウではなく、通常のウィンドウで開いてください。iPhone のホーム画面アプリでは「メールアドレスでログイン」を使ってください';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'メールアドレスかパスワードが違います。パスワードをまだ設定していない場合は、先にパソコンか Safari で Google ログインし、ホーム画面いちばん下の「アカウント」で設定してください';
    case 'auth/invalid-email':
      return 'メールアドレスの形式が正しくありません';
    case 'auth/missing-password':
      return 'パスワードを入力してください';
    case 'auth/weak-password':
      return 'パスワードは6文字以上にしてください';
    case 'auth/too-many-requests':
      return '試行回数が多すぎます。しばらく待ってからもう一度お試しください';
    case 'auth/requires-recent-login':
      return '安全のため、いったんログアウトして Google でログインし直してから、もう一度設定してください';
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return 'このメールアドレスは別のアカウントで使われています';
    case 'kotonoha/no-email':
      return 'このアカウントにはメールアドレスが無いため、パスワードを設定できません';
    case 'permission-denied':
      return 'Firestore のセキュリティルールでアクセスが拒否されました';
    case 'unavailable':
      return 'Firestore に接続できません — Database を作成しましたか？';
    default:
      return `エラー: ${err?.message ?? err}`;
  }
}
