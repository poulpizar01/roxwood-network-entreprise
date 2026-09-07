-- AlterTable
-- No rows exist yet with this column populated (verified before authoring this migration) —
-- dead field tied to the removed /stock command, never written or read anywhere in the code.
ALTER TABLE "MonitoringSafe" DROP COLUMN "label";
