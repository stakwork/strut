// ── The words strut draws around a visitor's app (plans/i18n.md) ───────────
//
// The page's LOCALE is the link's `lang=` (an invite's link, Peel's web
// view, a screenshot), else the browser's. strut hands it to every app it
// frames as the host context's `locale`, so an app and the sheets strut draws
// over it — sign in, the camera, the account widget, the Back bar — speak one
// language. Only those are here: the rest of strut's UI is an admin's, in
// English. English is the type, as in strut/views' words (kit/src/folds/words.ts).

import { formats, wordsFor, type Lang } from "@strut/kit/folds";

/** A page's locale: its link's `lang=` when it is one, else the browser's. */
export function pageLocale(href?: string, browser?: string): string {
  try {
    const lang = href ? new URL(href).searchParams.get("lang")?.trim() : undefined;
    if (lang && Intl.getCanonicalLocales(lang).length) return lang;
  } catch {
    // Not a tag: the browser's.
  }
  return browser || "en-US";
}

/** This page's locale, read once: a new `lang=` is a new page. */
export const LOCALE = pageLocale(
  typeof location !== "undefined" ? location.href : undefined,
  typeof navigator !== "undefined" ? navigator.language : undefined,
);

const en = {
  // The sign-in sheet.
  signIn: "Sign in",
  signInTo: (seller: string) => `Sign in to ${seller}`,
  continueHere: "Continue on this device",
  withNostr: "Sign in with Nostr",
  withLnurl: "Sign in with a Lightning wallet",
  withWallet: (name: string) => `Sign in with ${name}`,
  confirmIn: (name: string) => `Confirm in ${name}…`,
  signingIn: "Signing in…",
  scan: "Scan with a Lightning wallet that signs in (LNURL-auth).",
  qrLabel: "LNURL-auth QR code",
  waitingForWallet: "Waiting for the wallet",
  knownByKey: "You are known here by a key only you hold. Nothing else about you is shared.",
  codeExpired: "The code expired before a wallet signed it.",
  close: "Close",
  yourWallet: "your wallet",
  declinedIn: (name: string) => `You declined in ${name}.`,
  didNotSignIn: (name: string, why: string) => `${name} did not sign you in (${why}).`,
  pressToConfirm: (name: string) => ` Press Sign in with ${name} to confirm there.`,

  // The camera.
  asksForPhoto: "asks for a photo",
  thePhoto: "The photo",
  cancel: "Cancel",
  camera: "Camera",
  noCamera: "This browser offers no camera here.",
  retake: "Retake",
  usePhoto: "Use photo",
  takePhoto: "Take photo",

  // The account widget.
  account: "Account",
  openAccount: "Open account",
  accountSignedIn: "Account: signed in",
  signedIn: "Signed in",
  signOut: "Sign out",
  notSignedIn: "Not signed in",
  credit: "Credit",
  noCredit: "No credit",
  held: "Held",
  withdrawable: "Withdrawable",
  withdraw: (sats: string) => `Withdraw ${sats}`,
  withdrawFailed: "The withdrawal failed.",
  withdrawPending: "Withdrawal on its way.",
  withdrawn: "Withdrawn.",
  collapse: "Collapse to a dot",

  // An app alone.
  back: "Back",
  thisServer: "this server",
  notPublic: (app: string, server: string) => `"${app}" is not in ${server}'s public view`,
  loadingApp: "Loading the app…",
  couldNotLoad: (why: string) => `The app could not be loaded: ${why}`,
  noApp: (app: string) => `No app "${app}"`,
  loadingApps: "Loading apps…",
};

export type HostWords = typeof en;

const es: HostWords = {
  signIn: "Iniciar sesión",
  signInTo: (seller) => `Iniciar sesión en ${seller}`,
  continueHere: "Continuar en este dispositivo",
  withNostr: "Iniciar sesión con Nostr",
  withLnurl: "Iniciar sesión con una billetera Lightning",
  withWallet: (name) => `Iniciar sesión con ${name}`,
  confirmIn: (name) => `Confirma en ${name}…`,
  signingIn: "Iniciando sesión…",
  scan: "Escanea con una billetera Lightning que inicie sesión (LNURL-auth).",
  qrLabel: "Código QR de LNURL-auth",
  waitingForWallet: "Esperando a la billetera",
  knownByKey: "Aquí te reconocen por una llave que solo tú tienes. No se comparte nada más sobre ti.",
  codeExpired: "El código venció antes de que una billetera lo firmara.",
  close: "Cerrar",
  yourWallet: "tu billetera",
  declinedIn: (name) => `Lo rechazaste en ${name}.`,
  didNotSignIn: (name, why) => `${name} no inició tu sesión (${why}).`,
  pressToConfirm: (name) => ` Toca Iniciar sesión con ${name} para confirmarlo allí.`,

  asksForPhoto: "pide una foto",
  thePhoto: "La foto",
  cancel: "Cancelar",
  camera: "Cámara",
  noCamera: "Este navegador no ofrece una cámara aquí.",
  retake: "Repetir",
  usePhoto: "Usar foto",
  takePhoto: "Tomar foto",

  account: "Cuenta",
  openAccount: "Abrir cuenta",
  accountSignedIn: "Cuenta: sesión iniciada",
  signedIn: "Sesión iniciada",
  signOut: "Cerrar sesión",
  notSignedIn: "Sin sesión",
  credit: "Crédito",
  noCredit: "Sin crédito",
  held: "Retenido",
  withdrawable: "Para retirar",
  withdraw: (sats) => `Retirar ${sats}`,
  withdrawFailed: "El retiro falló.",
  withdrawPending: "El retiro va en camino.",
  withdrawn: "Retirado.",
  collapse: "Reducir a un punto",

  back: "Atrás",
  thisServer: "este servidor",
  notPublic: (app, server) => `"${app}" no está en la vista pública de ${server}`,
  loadingApp: "Cargando la app…",
  couldNotLoad: (why) => `No se pudo cargar la app: ${why}`,
  noApp: (app) => `No hay una app "${app}"`,
  loadingApps: "Cargando apps…",
};

/** Every language strut speaks, each whole: one left out fails tsc. */
export const HOST_WORDS = { en, es } satisfies Record<Lang, HostWords>;

/** This page's words, and its numbers and times. */
export const words: HostWords = wordsFor(HOST_WORDS, LOCALE);
export const fmt = formats(LOCALE);
