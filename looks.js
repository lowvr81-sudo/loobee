ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS is_ceo BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.profiles AS p
SET is_ceo = TRUE
FROM auth.users AS u
WHERE p.id = u.id
  AND LOWER(u.email) = 'lowvr81@gmail.com';
