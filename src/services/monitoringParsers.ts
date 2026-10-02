/**
 * Parseurs purs pour les logs webhook du script FiveM (monitoring). Chaque type de log est
 * poste dans son propre salon (voir `MonitoringChannelConfig`), donc le type est deja connu
 * par l'appelant — chaque parseur n'a qu'a extraire les donnees utiles du texte libre de
 * `description` (la plupart des champs numeriques ne sont PAS dans des champs structures de
 * l'embed, juste dans ce texte) et retourner `null` si le format ne correspond a aucun motif
 * connu, plutot que de planter. Bases sur 5 exemples reels fournis par l'utilisateur — a
 * elargir si de nouvelles variantes de description apparaissent en conditions reelles.
 */

export type ShiftParseResult = { direction: "in" | "out" };

export type RecruitmentParseResult =
  | { action: "hired" }
  | { action: "fired" }
  | { action: "grade_change"; grade: string };

export type SafeParseResult = { direction: "in" | "out"; quantity: number; itemLabel: string };

export type InvoiceParseResult = { amount: number; taxPercent: number; payerName: string };

export type SaleParseResult = {
  quantity: number;
  itemLabel: string;
  totalPrice: number;
  companyShare: number;
  sellerName: string;
};

/** "prise de service (Oil RoxWood)" / "fin de service (Oil RoxWood)". */
export function parseShift(description: string): ShiftParseResult | null {
  if (/^prise de service/i.test(description)) return { direction: "in" };
  if (/^fin de service/i.test(description)) return { direction: "out" };
  return null;
}

/**
 * "Recrutement de X dans l'entreprise Y" / "X a été renvoyé de l'entreprise Y" /
 * "Modification du grade de X: Z".
 */
export function parseRecruitment(description: string): RecruitmentParseResult | null {
  if (/^Recrutement de /.test(description)) return { action: "hired" };
  if (/a été renvoyé de l'entreprise/.test(description)) return { action: "fired" };

  const gradeMatch = /^Modification du grade de .+:\s*(.+)$/.exec(description);
  if (gradeMatch) return { action: "grade_change", grade: gradeMatch[1].trim() };

  return null;
}

/**
 * "a retiré {N}x {Item} du coffre de l'entreprise" (retrait) /
 * "dépôt de {N}x {Item} dans le coffre de l'entreprise" (depot).
 */
export function parseSafe(description: string): SafeParseResult | null {
  const withdrawMatch = /^a retiré (\d+)x (.+?) du coffre/.exec(description);
  if (withdrawMatch) return { direction: "out", quantity: Number(withdrawMatch[1]), itemLabel: withdrawMatch[2] };

  const depositMatch = /^dépôt de (\d+)x (.+?) dans le coffre/.exec(description);
  if (depositMatch) return { direction: "in", quantity: Number(depositMatch[1]), itemLabel: depositMatch[2] };

  return null;
}

/** "paiement d'une facture de {montant} (taxes {pct}%) par {nom}". */
export function parseInvoice(description: string): InvoiceParseResult | null {
  const match = /^paiement d'une facture de (\d+) \(taxes (\d+)%\) par (.+)$/.exec(description);
  if (!match) return null;
  return { amount: Number(match[1]), taxPercent: Number(match[2]), payerName: match[3].trim() };
}

/** "Vente de {N}x {Item} pour {total}$ par {vendeur}. {part}$ pour la société". */
export function parseSale(description: string): SaleParseResult | null {
  const match = /^Vente de (\d+)x (.+?) pour (\d+)\$ par (.+?)\. (\d+)\$ pour la société$/.exec(description);
  if (!match) return null;
  return {
    quantity: Number(match[1]),
    itemLabel: match[2],
    totalPrice: Number(match[3]),
    sellerName: match[4].trim(),
    companyShare: Number(match[5]),
  };
}
