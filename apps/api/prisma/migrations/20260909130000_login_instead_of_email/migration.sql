-- Вход по логину вместо почты.
--
-- Колонка добавляется в три шага, а не одним ALTER с NOT NULL: у существующих
-- пользователей логина нет, и база отвергла бы обязательную колонку без значения.
-- Логин им собирается из части адреса до собаки; при совпадении — с суффиксом,
-- потому что «ivan@a.ru» и «ivan@b.ru» дали бы один и тот же логин.
ALTER TABLE "users" ADD COLUMN "login" TEXT;

UPDATE "users" u
SET "login" = base.candidate
FROM (
  SELECT id,
         CASE WHEN row_number() OVER (PARTITION BY lower(split_part(email, '@', 1)) ORDER BY "createdAt") = 1
              THEN lower(split_part(email, '@', 1))
              ELSE lower(split_part(email, '@', 1)) || '-' || row_number() OVER (PARTITION BY lower(split_part(email, '@', 1)) ORDER BY "createdAt")
         END AS candidate
  FROM "users"
) AS base
WHERE u.id = base.id;

ALTER TABLE "users" ALTER COLUMN "login" SET NOT NULL;
CREATE UNIQUE INDEX "users_login_key" ON "users"("login");

-- Почта перестаёт быть обязательной: заводить аккаунт можно и без неё.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
