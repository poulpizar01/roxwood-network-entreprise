/*
  Warnings:

  - You are about to drop the column `closedCategoryId` on the `GuildConfig` table. All the data in the column will be lost.
  - You are about to drop the column `ticketCategoryIds` on the `GuildConfig` table. All the data in the column will be lost.
  - Added the required column `type` to the `Ticket` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('RECRUITMENT', 'SERVICE');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'INTERVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CatalogFieldStyle" AS ENUM ('SHORT', 'PARAGRAPH', 'QUANTITY');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PREPARING', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID');

-- AlterTable
ALTER TABLE "GuildConfig" DROP COLUMN "closedCategoryId",
DROP COLUMN "ticketCategoryIds";

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "type" "TicketType" NOT NULL;

-- CreateTable
CREATE TABLE "TicketCategoryConfig" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "type" "TicketType" NOT NULL,

    CONSTRAINT "TicketCategoryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentApplication" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "recruiterId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitmentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentAnswer" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "RecruitmentAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItemField" (
    "id" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "style" "CatalogFieldStyle" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CatalogItemField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceOrder" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "invoiceNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "catalogItemId" TEXT,
    "name" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemAnswer" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "OrderItemAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketCategoryConfig_guildId_categoryId_key" ON "TicketCategoryConfig"("guildId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentApplication_ticketId_key" ON "RecruitmentApplication"("ticketId");

-- CreateIndex
CREATE INDEX "CatalogItem_guildId_active_idx" ON "CatalogItem"("guildId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrder_ticketId_key" ON "ServiceOrder"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOrder_invoiceNumber_key" ON "ServiceOrder"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Ticket_guildId_type_idx" ON "Ticket"("guildId", "type");

-- AddForeignKey
ALTER TABLE "TicketCategoryConfig" ADD CONSTRAINT "TicketCategoryConfig_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentApplication" ADD CONSTRAINT "RecruitmentApplication_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentAnswer" ADD CONSTRAINT "RecruitmentAnswer_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RecruitmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItemField" ADD CONSTRAINT "CatalogItemField_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ServiceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemAnswer" ADD CONSTRAINT "OrderItemAnswer_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
