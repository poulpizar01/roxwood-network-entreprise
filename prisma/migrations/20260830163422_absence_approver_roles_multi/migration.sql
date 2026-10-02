-- AlterTable
-- Remplace absenceApproverRoleId (String?) par absenceApproverRoleIds (String[]) sans perte de
-- donnees : le role deja configure (s'il existe) est repris tel quel comme seul element du
-- nouveau tableau, plutot que d'etre jete par un DROP+ADD naif.
ALTER TABLE "GuildConfig" ADD COLUMN "absenceApproverRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "GuildConfig"
SET "absenceApproverRoleIds" = ARRAY["absenceApproverRoleId"]
WHERE "absenceApproverRoleId" IS NOT NULL;

ALTER TABLE "GuildConfig" DROP COLUMN "absenceApproverRoleId";
