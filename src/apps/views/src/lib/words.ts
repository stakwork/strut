import { taskErrorCode, useWords, type AnswerIssue, type Lang } from "@strut/kit";

// The words of a WORKER app's pieces (components/WorkerTask.tsx,
// components/TaskForm.tsx; plans/i18n.md), in every language strut speaks.
// English is the type: Spanish must have every message, of the same shape,
// or tsc fails. A function owns its word order and its plurals (English and
// Spanish have one and other alone). Neutral Latin American Spanish, `tú`.
// What a task type says — its ask, its fields' titles, its choices — is the
// admin's, in the language they wrote it in, and never here.

const en = {
  // The page.
  title: "Tasks",
  oneMoment: "One moment…",
  signInHeading: "Get paid for small tasks",
  signInText: "Sign in, then answer the tasks that show up here. Each one pays what it says.",
  signIn: "Sign in to start",
  signInClosed: "Signing in isn't open on this page.",
  signedIn: "You're signed in",
  noWorkYet: "There's no work for you here yet.",
  checksAgain: "This page checks again on its own.",
  cantReach: "Can't reach the work",
  somethingWrong: "Something went wrong.",
  tryingAgain: "Trying again…",
  looking: "Looking for work…",
  noTasksNow: "No tasks right now. The next one shows up here.",
  backToWork: "Back to your work",

  // The dashboard.
  paused: "Your work here is paused",
  pausedText: "An admin has paused your account here. What you earned is still yours.",
  workYouCanDo: "Work you can do",
  noWorkText: "There's no work for you here yet. An admin decides who does which work; this page checks again on its own.",
  startWorking: "Start working",
  // Their level (plans/worker-progress.md): XP is every sat they ever earned here.
  level: (n: number) => `Level ${n}`,
  xp: (n: string) => `${n} XP`,
  toLevel: (n: number) => `to Level ${n}`,
  topLevel: "The top level",
  readyToWithdraw: "Ready to withdraw",
  withdraw: "Withdraw",
  withdrawing: "Withdrawing…",
  withdrawSent: "Sent to your wallet.",
  withdrawPending: "On its way to your wallet.",
  withdrawFailed: "The withdrawal failed. Your sats are back in your balance.",
  withdrawOut: (sats: string) => `${sats} on the way to you. You can withdraw again once it arrives.`,
  withdrawNoAddress: "Sign in with Peel to withdraw: your sign-in gave no Sphinx address to pay.",
  withdrawOff: "Withdrawals are off on this server for now.",
  withdrawCannotPay: "This server can't pay out right now.",
  withdrawNotHere: "This server doesn't pay out earnings.",
  withdrawDayLimit: "You've reached today's withdrawal limit. Try again tomorrow.",
  withdrawBelowMin: (min: string, fee: string) => `Withdrawals start at ${min}, plus up to ${fee} routing fee.`,
  withdrawPaused: "Withdrawals are paused on this server until tomorrow.",
  held: "In review",
  inReview: (sats: string) => `${sats} in review`,
  yourWork: "Your work",
  nothingYet: "Nothing yet. Tasks you do show up here.",
  inProgress: "In progress",
  completed: "Completed",
  nPages: (n: number) => (n === 1 ? "1 page" : `${n} pages`),
  nApproved: (n: number) => `${n} approved`,
  nUnderReview: (n: number) => `${n} under review`,
  nSentBack: (n: number) => `${n} sent back`,
  inYourHand: "In your hand",
  letGo: "Let go",
  continue: "Continue",
  letGoAsk: "Let go of this task? Someone else can take it, and you can pick other work.",
  keepIt: "Keep it",
  finishFirst: "Finish or let go of the task in your hand first",
  waiting: (n: number) => `${n} waiting`,
  noneNow: "None right now",
  skipped: "Skipped",
  notFinished: "Not finished",
  sent: "Sent",
  notPaid: "Not paid",
  sentBack: "Sent back",
  toFix: (why: string) => `To fix: ${why}`,
  heldClears: (when: string) => `In review until ${when}`,
  cleared: "Paid",
  reply: "Reply",
  pictures: (n: number) => (n === 1 ? "1 picture" : `${n} pictures`),
  files: (n: number) => (n === 1 ? "1 file" : `${n} files`),

  // A task.
  earn: (sats: string) => `Earn ${sats}`,
  aTask: "A task for you",
  send: "Send",
  addToSend: (short: number, min: number) => `Add ${short === 1 ? (min === 1 ? "a photo" : "1 more photo") : `${short} more photos`} to send.`,

  // Its photos.
  photo: (n: number) => `Photo ${n}`,
  added: (images: boolean, at: number, of: number) => `${images ? "Photo" : "File"} ${of > 1 ? `${at} of ${of}` : "added"}`,
  retake: "Retake",
  remove: (images: boolean, n: number) => `Remove ${images ? "photo" : "file"} ${n}`,
  show: (images: boolean, n: number) => `Show ${images ? "photo" : "file"} ${n}`,
  add: (images: boolean): string => (images ? "Add a photo" : "Add a file"),
  fillFrame: "Fill the frame. Flat, sharp and in good light.",
  addFile: "Add the file your answer needs.",
  takePhoto: "Take a photo",
  choose: (images: boolean): string => (images ? "Choose a photo" : "Choose a file"),
  orChoose: "or choose one from this device",
  /** How many files the answer takes, and how many are there: "1 photo with your answer", "Up to 3 photos, if you like, with your answer · 2 added". */
  rule: (r: { min: number; max: number }, images: boolean, added: number) => {
    const noun = (n: number) => `${images ? "photo" : "file"}${n === 1 ? "" : "s"}`;
    const many = r.min === 0 ? `Up to ${r.max} ${noun(r.max)}, if you like` : r.min === r.max ? `${r.min} ${noun(r.min)}` : `${r.min} to ${r.max} ${noun(r.max)}`;
    return `${many} with your answer${added > 0 && r.max > 1 ? ` · ${added} added` : ""}`;
  },

  // After an answer.
  thanks: "Sent. Thank you!",
  earnedHeld: "Earned. It's in review.",
  earnedOnOk: "It's paid once it's checked and OK'd. If it's sent back, you'll see why, and that one isn't paid.",
  answerIn: "Your answer is in.",
  nextTask: "Next task",
  done: "Done",
  yourAnswer: "Your answer",

  // The form.
  yes: "Yes",
  no: "No",
  submit: "Submit",
  skip: "Skip",
  chooseOne: "Choose…",
  writeHere: "Write here…",
  needsOwnUi: (problem: string) => `This task type needs its own UI: ${problem}.`,
  issue: (i: AnswerIssue) =>
    i.kind === "required" ? `${i.fields.join(", ")} ${i.fields.length === 1 ? "is" : "are"} required` : `${i.field} is ${i.kind === "integer" ? "a whole number" : "a number"}`,

  /** A task refusal (its code) in words; English says the server's own sentence, which names the type. */
  refusal: (_code: string): string | undefined => undefined,
};

export type WorkerWords = typeof en;

/** Spanish: what the server refuses for, by its code. */
const REFUSED_ES: Record<string, string> = {
  not_active: "Un administrador decide quién hace las tareas aquí.",
  not_granted: "No tienes este tipo de trabajo. Un administrador decide quién lo hace.",
  limit_reached: "Llegaste al límite de este trabajo por ahora. Vuelve más tarde.",
  type_disabled: "Este tipo de trabajo está apagado por ahora.",
  unknown_type: "Este tipo de trabajo ya no existe aquí.",
  wrong_app: "Esta tarea se hace en otra app.",
  lease_held: "Ya tienes una tarea en tus manos: termínala o suéltala primero.",
  no_lease: "Esta tarea ya no está en tus manos.",
  lease_closed: "Esta tarea ya se respondió u omitió.",
  lease_expired: "Se acabó el tiempo para responder esta tarea.",
  task_closed: "Esta tarea ya no está abierta.",
  too_many: "Demasiadas solicitudes. Espera un minuto.",
  no_file: "Ese archivo ya no está.",
};

const es: WorkerWords = {
  title: "Tareas",
  oneMoment: "Un momento…",
  signInHeading: "Gana dinero con tareas cortas",
  signInText: "Inicia sesión y responde las tareas que aparezcan aquí. Cada una paga lo que dice.",
  signIn: "Inicia sesión para empezar",
  signInClosed: "En esta página no se puede iniciar sesión.",
  signedIn: "Ya iniciaste sesión",
  noWorkYet: "Todavía no hay trabajo para ti aquí.",
  checksAgain: "Esta página vuelve a revisar sola.",
  cantReach: "No pudimos cargar el trabajo",
  somethingWrong: "Algo salió mal.",
  tryingAgain: "Intentando de nuevo…",
  looking: "Buscando trabajo…",
  noTasksNow: "No hay tareas por ahora. La próxima aparecerá aquí.",
  backToWork: "Volver a tu trabajo",

  paused: "Tu trabajo aquí está en pausa",
  pausedText: "Un administrador pausó tu cuenta aquí. Lo que ganaste sigue siendo tuyo.",
  workYouCanDo: "Trabajo que puedes hacer",
  noWorkText: "Todavía no hay trabajo para ti aquí. Un administrador decide quién hace cada trabajo; esta página vuelve a revisar sola.",
  startWorking: "Empezar a trabajar",
  level: (n) => `Nivel ${n}`,
  xp: (n) => `${n} XP`,
  toLevel: (n) => `para el nivel ${n}`,
  topLevel: "El nivel más alto",
  readyToWithdraw: "Listo para retirar",
  withdraw: "Retirar",
  withdrawing: "Retirando…",
  withdrawSent: "Enviado a tu billetera.",
  withdrawPending: "Va en camino a tu billetera.",
  withdrawFailed: "El retiro falló. Tus sats volvieron a tu saldo.",
  withdrawOut: (sats) => `Tu retiro de ${sats} va en camino. Podrás retirar de nuevo cuando llegue.`,
  withdrawNoAddress: "Inicia sesión con Peel para retirar: tu sesión no dio una dirección de Sphinx a la que pagar.",
  withdrawOff: "Los retiros están desactivados en este servidor por ahora.",
  withdrawCannotPay: "Este servidor no puede pagar en este momento.",
  withdrawNotHere: "Este servidor no paga ganancias.",
  withdrawDayLimit: "Llegaste al límite de retiros de hoy. Intenta de nuevo mañana.",
  withdrawBelowMin: (min, fee) => `El retiro mínimo es de ${min}, más hasta ${fee} de comisión de enrutamiento.`,
  withdrawPaused: "Los retiros están en pausa en este servidor hasta mañana.",
  held: "En revisión",
  inReview: (sats) => `${sats} en revisión`,
  yourWork: "Tu trabajo",
  nothingYet: "Nada todavía. Las tareas que hagas aparecerán aquí.",
  inProgress: "En curso",
  completed: "Completadas",
  nPages: (n) => (n === 1 ? "1 página" : `${n} páginas`),
  nApproved: (n) => `${n} aprobadas`,
  nUnderReview: (n) => `${n} en revisión`,
  nSentBack: (n) => `${n} devueltas`,
  inYourHand: "En tus manos",
  letGo: "Soltar",
  continue: "Continuar",
  letGoAsk: "¿Soltar esta tarea? Otra persona podrá tomarla y tú podrás elegir otro trabajo.",
  keepIt: "Quedármela",
  finishFirst: "Primero termina o suelta la tarea que tienes",
  waiting: (n) => `${n} en espera`,
  noneNow: "Ninguna por ahora",
  skipped: "Omitida",
  notFinished: "Sin terminar",
  sent: "Enviada",
  notPaid: "No pagada",
  sentBack: "Devuelta",
  toFix: (why) => `Por corregir: ${why}`,
  heldClears: (when) => `En revisión hasta el ${when}`,
  cleared: "Pagado",
  reply: "Respuesta",
  pictures: (n) => (n === 1 ? "1 imagen" : `${n} imágenes`),
  files: (n) => (n === 1 ? "1 archivo" : `${n} archivos`),

  earn: (sats) => `Gana ${sats}`,
  aTask: "Una tarea para ti",
  send: "Enviar",
  addToSend: (short, min) => `Agrega ${short === 1 ? (min === 1 ? "una foto" : "1 foto más") : `${short} fotos más`} para enviar.`,

  photo: (n) => `Foto ${n}`,
  added: (images, at, of) => (of > 1 ? `${images ? "Foto" : "Archivo"} ${at} de ${of}` : images ? "Foto agregada" : "Archivo agregado"),
  retake: "Repetir",
  remove: (images, n) => `Quitar ${images ? "foto" : "archivo"} ${n}`,
  show: (images, n) => `Ver ${images ? "foto" : "archivo"} ${n}`,
  add: (images) => (images ? "Agregar una foto" : "Agregar un archivo"),
  fillFrame: "Llena el encuadre. De frente, nítida y con buena luz.",
  addFile: "Agrega el archivo que necesita tu respuesta.",
  takePhoto: "Toma una foto",
  choose: (images) => (images ? "Elige una foto" : "Elige un archivo"),
  orChoose: "o elige una de este dispositivo",
  rule: (r, images, added) => {
    const noun = (n: number) => (images ? (n === 1 ? "foto" : "fotos") : n === 1 ? "archivo" : "archivos");
    const many = r.min === 0 ? `Hasta ${r.max} ${noun(r.max)}, si quieres,` : r.min === r.max ? `${r.min} ${noun(r.min)}` : `De ${r.min} a ${r.max} ${noun(r.max)}`;
    const count = images ? (added === 1 ? "agregada" : "agregadas") : added === 1 ? "agregado" : "agregados";
    return `${many} con tu respuesta${added > 0 && r.max > 1 ? ` · ${added} ${count}` : ""}`;
  },

  thanks: "Enviado. ¡Gracias!",
  earnedHeld: "Ganado. Está en revisión.",
  earnedOnOk: "Se paga cuando se revise y se apruebe. Si se devuelve, verás por qué, y esa no se paga.",
  answerIn: "Recibimos tu respuesta.",
  nextTask: "Siguiente tarea",
  done: "Listo",
  yourAnswer: "Tu respuesta",

  yes: "Sí",
  no: "No",
  submit: "Enviar",
  skip: "Omitir",
  chooseOne: "Elige…",
  writeHere: "Escribe aquí…",
  needsOwnUi: (problem) => `Este tipo de tarea necesita su propia pantalla: ${problem}.`,
  issue: (i) =>
    i.kind === "required"
      ? `${i.fields.length === 1 ? "Falta" : "Faltan"}: ${i.fields.join(", ")}`
      : `${i.field} debe ser ${i.kind === "integer" ? "un número entero" : "un número"}`,

  refusal: (code) => REFUSED_ES[code],
};

/** Every language strut speaks, each whole: one left out fails tsc. */
export const WORKER_WORDS = { en, es } satisfies Record<Lang, WorkerWords>;

/** A task refusal in words: the page's language's sentence for its code,
 *  else the server's own, its code dropped ("an admin decides who takes
 *  tasks here"; a type's check's reason, plans/human-steps.md §5.6.7 c). */
export function refusalText(err: Error, w: WorkerWords): string {
  const said = w.refusal(taskErrorCode(err) ?? "");
  if (said) return said;
  const text = err.message.replace(/^[a-z_]+:\s*/, "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "";
}

/** A worker app's words, in the page's language. */
export const useWorkerWords = (): WorkerWords => useWords(WORKER_WORDS);
