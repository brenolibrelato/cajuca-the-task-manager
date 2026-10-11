-- =====================================================================
-- Cajuca — migração 003: ordem dos projetos (arrastar e soltar)
-- Rodar UMA vez no SQL Editor do Supabase, depois da 002.
--
--  * Cada usuário tem a sua própria ordem de projetos (inclusive dos
--    projetos compartilhados com ele). Mudar a ordem não afeta os outros.
--  * Projetos sem posição salva aparecem depois, em ordem alfabética.
--  * "Sem projeto" fica sempre por último.
-- =====================================================================

create table public.project_order (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  position   int  not null check (position >= 0),
  primary key (user_id, project_id)
);

alter table public.project_order enable row level security;

create policy "project_order_own" on public.project_order for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_view_project(project_id));

revoke all on public.project_order from anon, authenticated;
grant select, insert, update, delete on public.project_order to authenticated;
