import { createHmac } from "node:crypto";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Point de branchement generique vers des systemes externes (CRM, site web...) : chaque
 * guilde peut abonner des URLs a des types d'evenements via `WebhookSubscription`. Aucune
 * integration specifique n'est codee en dur ici, volontairement.
 */

/** Types d'evenements pouvant declencher l'envoi d'un webhook. */
export type WebhookEventType =
  | "monitoring.duty"
  | "monitoring.recruitment"
  | "monitoring.storage"
  | "monitoring.invoice"
  | "monitoring.sale"
  | "absence.updated"
  | "order.updated"
  | "recruitment.updated"
  | "custom";

/**
 * Libelle affichable de chaque type d'evenement, et source de verite de la liste complete —
 * tous les abonnements webhook se gerent depuis le panneau "Monitoring", quel que soit le
 * domaine de l'evenement (choix explicite de l'utilisateur : un seul endroit centralise
 * plutot qu'un bouton "Ajouter un webhook" disperse sur chaque panneau concerne).
 */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "monitoring.duty": "Prise de service (Monitoring)",
  "monitoring.recruitment": "Recrutement (Monitoring)",
  "monitoring.storage": "Coffre (Monitoring)",
  "monitoring.invoice": "Facture (Monitoring)",
  "monitoring.sale": "Vente run (Monitoring)",
  "absence.updated": "Absences",
  "order.updated": "Commandes",
  "recruitment.updated": "Candidatures",
  custom: "Personnalisé (contenu au choix)",
};

/**
 * Libelle affichable d'un abonnement dans une liste (embed, menu de suppression...) : le
 * `label` libre s'il existe (abonnements "custom", potentiellement plusieurs par guilde —
 * voir le schema), sinon le type d'evenement seul suffit deja a l'identifier.
 */
export function describeSubscription(sub: { eventType: string; label: string | null }): string {
  return sub.label ? `${sub.label} (${sub.eventType})` : sub.eventType;
}

/**
 * Signe le corps de la requete en HMAC-SHA256 avec le secret propre a chaque abonnement,
 * pour que le service externe puisse verifier l'authenticite de l'appel (header `X-Signature-256`).
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Nombre maximum de tentatives (1 immediate + relances) avant d'abandonner definitivement une
 * livraison et de perdre l'evenement — au-dela, le recepteur est considere durablement en
 * panne ou mal configure plutot que temporairement indisponible.
 */
const MAX_DELIVERY_ATTEMPTS = 10;
/** Sonde les livraisons a reessayer toutes les minutes. */
const RETRY_POLL_INTERVAL_MS = 60 * 1000;
/**
 * Delai maximum accorde a un envoi avant de le considerer en echec — sans ca, un recepteur
 * qui accepte la connexion sans jamais repondre bloquerait indefiniment (fetch n'a pas de
 * timeout par defaut), et avec le sondage periodique ci-dessous, un chevauchement de passes
 * pourrait alors declencher des envois en double.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Delai avant la Nieme tentative : 1, 2, 4, 8... minutes, plafonne a 30 minutes. */
function nextAttemptDelayMs(attempts: number): number {
  const minutes = Math.min(2 ** (attempts - 1), 30);
  return minutes * 60 * 1000;
}

type DeliveryResult = { ok: true } | { ok: false; retryable: boolean; error: string };

/**
 * Signe et tente un unique POST JSON vers un abonnement — ne lance jamais d'exception, le
 * resultat indique si l'echec (s'il y en a un) vaut la peine d'etre reessaye : une erreur
 * reseau/timeout ou un 5xx/429 est transitoire (le recepteur peut revenir), alors qu'un 4xx
 * (401, 404...) signale un probleme de configuration qui redonnera la meme erreur a chaque
 * essai — inutile de s'acharner dessus pendant des heures.
 */
async function attemptDelivery(sub: { id: string; url: string; secret: string }, body: string, eventType: string): Promise<DeliveryResult> {
  try {
    const response = await fetch(sub.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-256": sign(sub.secret, body),
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true };
    logger.warn(`Webhook ${sub.id} (${eventType}) a repondu ${response.status}`);
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, error: `HTTP ${response.status}` };
  } catch (error) {
    logger.error(`Echec d'envoi du webhook ${sub.id} (${eventType})`, error);
    return { ok: false, retryable: true, error: error instanceof Error ? error.message : "Erreur reseau" };
  }
}

/**
 * Envoie une premiere fois immediatement ; si cet essai echoue pour une raison transitoire,
 * met la livraison en file pour nouvelle tentative (voir `retryFailedDeliveries`) plutot que
 * de perdre l'evenement — a la demande explicite de l'utilisateur (risque de perte de donnees
 * si le site externe est injoignable au moment precis de l'envoi).
 */
async function post(sub: { id: string; url: string; secret: string }, body: string, eventType: string): Promise<void> {
  const result = await attemptDelivery(sub, body, eventType);
  if (result.ok || !result.retryable) return;

  await prisma.webhookDeliveryAttempt.create({
    data: {
      subscriptionId: sub.id,
      eventType,
      body,
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(1)),
      lastError: result.error,
    },
  });
}

/**
 * Reessaie toutes les livraisons arrivees a echeance. Chaque tentative reussie supprime son
 * enregistrement ; chaque nouvel echec transitoire recale l'echeance suivante ; un echec non
 * transitoire (4xx) ou le depassement de `MAX_DELIVERY_ATTEMPTS` abandonne definitivement la
 * livraison (journalise en erreur — c'est une perte de donnees reelle, a distinguer d'un
 * simple warning). Un abonnement desactive ou supprime entretemps annule aussi ses livraisons
 * en attente (desactive : verifie ici : supprime : cascade DB automatique).
 */
export async function retryFailedDeliveries(): Promise<void> {
  const due = await prisma.webhookDeliveryAttempt.findMany({
    where: { nextAttemptAt: { lte: new Date() } },
    include: { subscription: true },
  });

  for (const delivery of due) {
    if (!delivery.subscription.enabled) {
      await prisma.webhookDeliveryAttempt.delete({ where: { id: delivery.id } });
      continue;
    }

    const result = await attemptDelivery(delivery.subscription, delivery.body, delivery.eventType);
    if (result.ok) {
      await prisma.webhookDeliveryAttempt.delete({ where: { id: delivery.id } });
      logger.info(`Webhook ${delivery.subscriptionId} (${delivery.eventType}) livre apres nouvelle tentative (essai ${delivery.attempts + 1})`);
      continue;
    }

    const attempts = delivery.attempts + 1;
    if (!result.retryable || attempts >= MAX_DELIVERY_ATTEMPTS) {
      await prisma.webhookDeliveryAttempt.delete({ where: { id: delivery.id } });
      logger.error(`Webhook ${delivery.subscriptionId} (${delivery.eventType}) abandonne definitivement apres ${attempts} tentative(s) — evenement perdu`);
      continue;
    }

    await prisma.webhookDeliveryAttempt.update({
      where: { id: delivery.id },
      data: { attempts, nextAttemptAt: new Date(Date.now() + nextAttemptDelayMs(attempts)), lastError: result.error },
    });
  }
}

/** Demarre le sondage periodique des livraisons a reessayer — a appeler une seule fois au demarrage du bot (voir `ready.ts`). */
export function startWebhookRetryPolling(): void {
  // Verrou de re-entrance : si une passe depasse l'intervalle (beaucoup de livraisons en
  // attente, recepteur lent), la suivante ne doit pas demarrer par-dessus au risque de
  // retenter la meme livraison deux fois en parallele.
  let isRunning = false;
  setInterval(() => {
    if (isRunning) return;
    isRunning = true;
    retryFailedDeliveries()
      .catch((error) => logger.error("Erreur inattendue lors du sondage des webhooks a reessayer", error))
      .finally(() => {
        isRunning = false;
      });
  }, RETRY_POLL_INTERVAL_MS);
}

/**
 * Envoie `payload` (en POST JSON signe) a tous les webhooks actifs de la guilde abonnes
 * a ce type d'evenement. Les envois sont paralleles et independants : l'echec d'un
 * abonnement (timeout, 4xx/5xx, exception reseau) est logge mais n'empeche pas les autres
 * d'etre notifies, et ne fait jamais echouer l'appelant (pas de throw).
 *
 * @param guildId - guilde d'origine de l'evenement
 * @param eventType - type d'evenement (voir `WebhookEventType`)
 * @param payload - donnees specifiques a l'evenement, serialisees telles quelles dans le body
 */
export async function dispatchWebhook(
  guildId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: { guildId, eventType, enabled: true },
  });

  if (subscriptions.length === 0) return;

  // `guildId` est inclus explicitement dans le corps envoye : si le recepteur utilise la
  // meme URL pour plusieurs guildes (plutot qu'une URL dediee par guilde), c'est le seul
  // moyen pour lui de savoir de quel serveur Discord provient l'evenement — sans ca, rien
  // dans la requete ne permettrait de les distinguer.
  const body = JSON.stringify({ guildId, eventType, payload, sentAt: new Date().toISOString() });

  await Promise.all(subscriptions.map((sub) => post(sub, body, eventType)));
}

/**
 * Recupere un abonnement webhook actif par id (verifie qu'il appartient bien a la guilde) — a
 * charger une seule fois avant une boucle qui dispatche plusieurs evenements vers le meme
 * abonnement (voir `dispatchToSubscription`), typiquement une synchronisation Google Sheet qui
 * envoie une ligne par evenement : sans ca, chaque ligne redeclenchait la meme recherche en
 * base pour retrouver un abonnement pourtant identique a chaque fois.
 */
export async function findActiveSubscription(guildId: string, subscriptionId: string) {
  return prisma.webhookSubscription.findFirst({ where: { id: subscriptionId, guildId, enabled: true } });
}

/**
 * Envoie un contenu libre a un abonnement deja charge (pas de nouvelle recherche en base) —
 * voir `findActiveSubscription`. Pas de fanout par type : un seul abonnement cible, meme
 * raisonnement que `dispatchWebhook` mais pour un seul destinataire choisi explicitement.
 */
export async function dispatchToSubscription(
  sub: { id: string; url: string; secret: string; eventType: string; label: string | null },
  guildId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify({ guildId, eventType: sub.eventType, label: sub.label, payload, sentAt: new Date().toISOString() });
  await post(sub, body, sub.eventType);
}

/**
 * Envoie un contenu libre a **un seul** abonnement "custom" choisi explicitement par le staff
 * (pas de fanout par type — plusieurs abonnements custom d'une meme guilde, ex: un par Google
 * Sheet, doivent pouvoir recevoir des contenus completement differents sans se marcher dessus).
 * Retourne `false` sans rien envoyer si l'abonnement n'existe pas/plus ou n'appartient pas a
 * cette guilde (verification d'isolation, meme raisonnement que `dispatchWebhook`). Pour un
 * envoi ponctuel ; si plusieurs evenements doivent partir vers le meme abonnement de suite,
 * preferer `findActiveSubscription` + `dispatchToSubscription` pour ne charger l'abonnement
 * qu'une seule fois.
 */
export async function dispatchCustomWebhook(
  guildId: string,
  subscriptionId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const sub = await findActiveSubscription(guildId, subscriptionId);
  if (!sub) return false;

  await dispatchToSubscription(sub, guildId, payload);
  return true;
}
