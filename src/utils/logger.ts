/** Horodatage ISO utilise en prefixe de chaque ligne de log. */
const timestamp = () => new Date().toISOString();

/**
 * Logger minimaliste (wrapper autour de `console`) qui prefixe chaque message
 * avec un horodatage et un niveau (INFO/WARN/ERROR), sans dependance externe.
 */
export const logger = {
  /** Log de niveau information (deroulement normal : connexion, ticket suivi, etc.). */
  info: (message: string, ...meta: unknown[]) => console.log(`[${timestamp()}] INFO  ${message}`, ...meta),
  /** Log de niveau avertissement (situation degradee mais non bloquante, ex: webhook qui repond en erreur). */
  warn: (message: string, ...meta: unknown[]) => console.warn(`[${timestamp()}] WARN  ${message}`, ...meta),
  /** Log de niveau erreur (echec d'une operation, generalement accompagne de l'objet erreur en `meta`). */
  error: (message: string, ...meta: unknown[]) => console.error(`[${timestamp()}] ERROR ${message}`, ...meta),
};
