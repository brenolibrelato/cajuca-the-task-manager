-- =====================================================================
-- Cajuca — migração 004: "Sem projeto" também pode ser reordenado
-- Rodar UMA vez no SQL Editor do Supabase, depois da 003.
--
--  * Em project_order, project_id nulo = posição do grupo "Sem projeto".
--  * A ordem é salva de uma vez pela função save_project_order.
-- =====================================================================

alter table public.project_order drop constraint project_order_pkey;
alter table public.project_order alter column project_id drop not null;

create unique index uq_project_order
  on public.project_order (user_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop policy "project_order_own" on public.project_order;
create policy "project_order_own" on public.project_order for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (project_id is null or public.can_view_project(project_id)));

-- p_ids: ids dos projetos na ordem da tela; null = "Sem projeto"
create or replace function public.save_project_order(p_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;
  delete from public.project_order where user_id = auth.uid();
  insert into public.project_order (user_id, project_id, position)
  select auth.uid(), u.id, (u.ord - 1)::int
  from unnest(p_ids) with ordinality as u(id, ord)
  where u.id is null or public.can_view_project(u.id);
end $$;

revoke all on function public.save_project_order(uuid[]) from public, anon, authenticated;
grant execute on function public.save_project_order(uuid[]) to authenticated;
