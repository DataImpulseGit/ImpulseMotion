-- Pages of the client bot (saved questions shown as tabs). Additive: one new table.
CREATE TABLE "BotRoutine" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'manual',
    "position" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotRoutine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotRoutine_conversationId_key" ON "BotRoutine"("conversationId");
CREATE INDEX "BotRoutine_botId_userId_position_idx" ON "BotRoutine"("botId", "userId", "position");
CREATE INDEX "BotRoutine_schedule_idx" ON "BotRoutine"("schedule");

ALTER TABLE "BotRoutine" ADD CONSTRAINT "BotRoutine_botId_fkey" FOREIGN KEY ("botId") REFERENCES "ClientBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRoutine" ADD CONSTRAINT "BotRoutine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BotRoutine" ADD CONSTRAINT "BotRoutine_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
