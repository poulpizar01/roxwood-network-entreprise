import type { ApplicationStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { storeImage } from "../utils/imageAttachment.js";
import { getTicketById } from "./ticketService.js";
import { dispatchWebhook } from "./webhookDispatcher.js";

/**
 * Service dedie au flux de recrutement : une `RecruitmentApplication` (1:1 avec un `Ticket`
 * de type RECRUITMENT) porte le statut du pipeline, le recruteur assigne, ses reponses
 * au formulaire (`RecruitmentAnswer[]`) et les pieces jointes envoyees par le candidat
 * (`RecruitmentAttachment[]`).
 */

/**
 * Nombre maximum de pieces jointes par candidature — seul point ou un membre non-staff (le
 * candidat) peut declencher directement une ecriture en base depuis un contenu qu'il controle
 * entierement (voir `handleRecruitmentFinishAttachments`). Sans plafond, rien n'empecherait d'y
 * pousser un nombre arbitraire de fichiers (la taille par fichier est plafonnee separement,
 * voir `MAX_UPLOAD_SIZE_BYTES` dans `imageAttachment.ts`).
 */
export const MAX_RECRUITMENT_ATTACHMENTS = 3;

/**
 * Envoie l'etat complet et courant d'une candidature sur l'unique evenement
 * `recruitment.updated` — meme principe que `absence.updated`/`order.updated` : un recepteur
 * n'a qu'un seul type d'evenement a ecouter pour toujours avoir la derniere version d'une
 * candidature, sans fusionner plusieurs evenements lui-meme. Les octets des pieces jointes ne
 * sont jamais inclus (juste leur nom) : le JSON du webhook n'est pas fait pour transporter du
 * binaire, seul le nom permet au recepteur de savoir qu'un fichier existe. No-op silencieux
 * si le ticket/la candidature n'existe plus (ne devrait pas arriver en usage normal).
 */
async function dispatchRecruitmentUpdated(ticketId: string): Promise<void> {
  const ticket = await getTicketById(ticketId);
  const application = await getApplicationSummary(ticketId);
  if (!ticket || !application) return;

  await dispatchWebhook(ticket.guildId, "recruitment.updated", {
    ticketId,
    channelId: ticket.channelId,
    candidateId: ticket.openerId,
    status: application.status,
    recruiterId: application.recruiterId,
    submittedAt: application.submittedAt?.toISOString() ?? null,
    answers: application.answers.map((a) => ({ question: a.question, answer: a.answer })),
    attachments: application.attachments.map((a) => ({ filename: a.filename })),
  });
}

/**
 * Cree la candidature associee a un ticket, juste apres sa detection (voir `onChannelCreate`).
 * Statut initial PENDING par defaut (valeur par defaut du schema Prisma).
 */
export async function createApplication(ticketId: string) {
  return prisma.recruitmentApplication.create({ data: { ticketId } });
}

/**
 * Enregistre les reponses du candidat au formulaire (modal Discord) et marque la candidature
 * comme soumise (`submittedAt`). Suppose que la candidature existe deja (creee a l'ouverture
 * du ticket) : leve une erreur sinon (`findUniqueOrThrow`), ce qui ne devrait arriver que si
 * le canal n'a pas ete correctement suivi comme ticket RECRUITMENT.
 *
 * @param ticketId - id du ticket (pas le channelId Discord)
 * @param answers - paires question/reponse dans l'ordre du formulaire
 */
export async function saveAnswers(ticketId: string, answers: { question: string; answer: string }[]) {
  const application = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { ticketId } });

  await prisma.recruitmentAnswer.createMany({
    data: answers.map((a) => ({ applicationId: application.id, question: a.question, answer: a.answer })),
  });

  const updated = await prisma.recruitmentApplication.update({
    where: { id: application.id },
    data: { submittedAt: new Date() },
    include: { answers: true, attachments: true },
  });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/** Fait avancer la candidature dans le pipeline (PENDING / INTERVIEW / ACCEPTED / REJECTED). */
export async function setStatus(ticketId: string, status: ApplicationStatus) {
  const updated = await prisma.recruitmentApplication.update({ where: { ticketId }, data: { status } });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/** Assigne un membre du staff comme recruteur responsable de cette candidature (reassignation possible). */
export async function assignRecruiter(ticketId: string, recruiterId: string) {
  const updated = await prisma.recruitmentApplication.update({ where: { ticketId }, data: { recruiterId } });
  await dispatchRecruitmentUpdated(ticketId);
  return updated;
}

/**
 * Memorise ou vit le message de suivi (recap + boutons Statut/S'assigner), pour pouvoir
 * le retrouver et l'editer en place lors d'un changement de statut ou d'assignation.
 */
export async function saveLogMessageRef(ticketId: string, logChannelId: string, logMessageId: string) {
  return prisma.recruitmentApplication.update({ where: { ticketId }, data: { logChannelId, logMessageId } });
}

/**
 * Rattache en une seule fois toutes les images que le candidat a envoyees en message classique
 * dans le salon du ticket, une fois qu'il a clique "J'ai terminé" (voir
 * `handleRecruitmentFinishAttachments`) — les modals Discord ne supportant pas l'upload de
 * fichier, c'est le seul moyen technique de joindre des fichiers a une candidature. Chaque
 * ligne est d'abord creee (pour obtenir son id, cle deterministe utilisee par `storeImage` —
 * voir `RecruitmentAttachment.imageUrl`), puis mise a jour avec le resultat du stockage : sur
 * le CDN en production (seule l'URL est alors gardee), sur disque local en dev — jamais l'URL
 * Discord d'origine, qui est signee et expire. Un seul `dispatchRecruitmentUpdated` pour tout
 * le lot plutot qu'un par fichier — evite de spammer les webhooks abonnes d'un evenement par
 * piece jointe alors qu'elles arrivent toutes ensemble, en une seule action candidat.
 */
export async function addAttachments(
  ticketId: string,
  files: { data: Buffer; filename: string; contentType?: string | null }[]
) {
  if (files.length === 0) return [];

  const application = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { ticketId } });
  const created = await prisma.$transaction(
    files.map((f) => prisma.recruitmentAttachment.create({ data: { applicationId: application.id, filename: f.filename } }))
  );
  await Promise.all(
    created.map(async (row, i) => {
      const file = files[i];
      const stored = await storeImage(`recruitment-attachments/${row.id}`, file.data, { contentType: file.contentType, name: file.filename });
      await prisma.recruitmentAttachment.update({ where: { id: row.id }, data: { imageUrl: stored.url } });
    })
  );
  await dispatchRecruitmentUpdated(ticketId);
  return created;
}

/**
 * Enregistre l'URL Discord CDN finale de chaque piece jointe image, capturee juste apres
 * l'envoi initial du message de suivi (voir `finalizeRecruitmentAttachments`) — reutilisee
 * ensuite par tout rafraichissement du message sans jamais re-uploader les octets ni toucher
 * aux pieces jointes du message (voir le commentaire sur `RecruitmentAttachment.discordUrl`
 * dans le schema).
 */
export async function setAttachmentDiscordUrls(urls: { attachmentId: string; discordUrl: string }[]) {
  if (urls.length === 0) return;
  await prisma.$transaction(
    urls.map((u) => prisma.recruitmentAttachment.update({ where: { id: u.attachmentId }, data: { discordUrl: u.discordUrl } }))
  );
}

/**
 * Recupere la candidature complete d'un ticket (tous les champs scalaires, reponses et pieces
 * jointes), ou `null` si aucune n'existe — a n'utiliser que quand ces champs complets sont
 * reellement necessaires (voir `finalizeRecruitmentAttachments`). Pour tout le reste (verifier
 * un statut, construire le payload d'un webhook, rafraichir le texte du message de suivi...),
 * preferer `getApplicationSummary`, qui ne charge qu'un sous-ensemble cible des champs.
 */
export async function getApplication(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    include: { answers: true, attachments: true },
  });
}

/**
 * Comme `getApplication`, en ne chargeant qu'un sous-ensemble cible des champs (statut,
 * recruteur, references du message de suivi, reponses, et juste le nom/les URLs des pieces
 * jointes — voir `RecruitmentAttachment.imageUrl`/`discordUrl`) — pour les usages qui n'ont
 * besoin que de metadonnees (verifier un statut, construire le payload d'un webhook, rafraichir
 * le texte du message de suivi) et n'ont jamais besoin de re-uploader un fichier.
 */
export async function getApplicationSummary(ticketId: string) {
  return prisma.recruitmentApplication.findUnique({
    where: { ticketId },
    select: {
      status: true,
      recruiterId: true,
      submittedAt: true,
      logChannelId: true,
      logMessageId: true,
      answers: { select: { question: true, answer: true } },
      attachments: { select: { filename: true, imageUrl: true, discordUrl: true } },
    },
  });
}
