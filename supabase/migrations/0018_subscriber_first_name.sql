-- A first name for the greeting ("Good morning, Mark."). Nullable; set on the
-- profile page, else derived heuristically from the email's local part.
alter table public.subscribers
  add column if not exists first_name text;
