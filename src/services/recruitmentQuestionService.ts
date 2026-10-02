import type { RecruitmentFieldStyle } from "@prisma/client";
import { prisma } from "../db/prisma.js";

/**
 * Service dedie aux questions configurables du formulaire de candidature (panneau
 * "Recrutement" -> "Ajouter/Retirer une question"). Si une guilde n'en configure aucune, le
 * formulaire repli sur `DEFAULT_RECRUITMENT_QUESTIONS` (les 5 questions fixes d'origine) —
 * voir `getEffectiveQuestions`.
 */

/** Nombre maximum de questions par guilde. Contrainte Discord : un modal ne peut afficher que 5 `TextInputComponent` au plus. */
const MAX_QUESTIONS = 5;

export type QuestionLike = { label: string; style: RecruitmentFieldStyle };

/** Questions par defaut, utilisees tant qu'aucune n'est configuree pour la guilde. */
export const DEFAULT_RECRUITMENT_QUESTIONS: QuestionLike[] = [
  { label: "Nom RP", style: "SHORT" },
  { label: "Âge", style: "SHORT" },
  { label: "Expérience RP", style: "PARAGRAPH" },
  { label: "Disponibilités", style: "PARAGRAPH" },
  { label: "Motivation", style: "PARAGRAPH" },
];

/** Liste les questions configurees par la guilde, dans l'ordre du formulaire. */
export async function listQuestions(guildId: string) {
  return prisma.recruitmentQuestion.findMany({ where: { guildId }, orderBy: { position: "asc" } });
}

/**
 * Questions effectivement utilisees pour construire le formulaire : celles configurees par
 * le staff, ou les 5 questions par defaut si la guilde n'en a configure aucune.
 */
export async function getEffectiveQuestions(guildId: string): Promise<QuestionLike[]> {
  const configured = await listQuestions(guildId);
  return configured.length > 0 ? configured : DEFAULT_RECRUITMENT_QUESTIONS;
}

/**
 * Ajoute une question au formulaire de cette guilde.
 * @throws si la guilde a deja atteint `MAX_QUESTIONS`.
 */
export async function addQuestion(guildId: string, label: string, style: RecruitmentFieldStyle) {
  const existing = await listQuestions(guildId);
  if (existing.length >= MAX_QUESTIONS) {
    throw new Error(`Le formulaire ne peut pas avoir plus de ${MAX_QUESTIONS} questions (limite Discord).`);
  }
  return prisma.recruitmentQuestion.create({ data: { guildId, label, style, position: existing.length } });
}

/** Retire une question du formulaire. No-op si l'id n'existe pas ou n'appartient pas a cette guilde. */
export async function removeQuestion(guildId: string, id: string) {
  await prisma.recruitmentQuestion.deleteMany({ where: { id, guildId } });
}
