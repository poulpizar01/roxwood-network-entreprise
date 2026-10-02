-- CreateEnum
CREATE TYPE "RecruitmentFieldStyle" AS ENUM ('SHORT', 'PARAGRAPH');

-- CreateTable
CREATE TABLE "RecruitmentQuestion" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "style" "RecruitmentFieldStyle" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecruitmentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecruitmentQuestion_guildId_idx" ON "RecruitmentQuestion"("guildId");

-- AddForeignKey
ALTER TABLE "RecruitmentQuestion" ADD CONSTRAINT "RecruitmentQuestion_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;
