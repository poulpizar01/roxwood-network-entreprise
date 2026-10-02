import { PrismaClient } from "@prisma/client";

/**
 * Instance unique du client Prisma partagee par tout le bot.
 * A importer depuis ce fichier plutot que d'instancier `new PrismaClient()` ailleurs,
 * pour ne garder qu'un seul pool de connexions vers Postgres.
 */
export const prisma = new PrismaClient();
