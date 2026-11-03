-- Token Tally sign-ups. People can add their email. Nobody can read the list through the public key.
create table if not exists public.signups (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254 and email like '%_@_%'),
  created_at timestamptz not null default now()
);

create unique index if not exists signups_email_unique on public.signups (lower(email));

alter table public.signups enable row level security;

drop policy if exists "anyone can sign up" on public.signups;
create policy "anyone can sign up" on public.signups
  for insert to anon
  with check (true);
