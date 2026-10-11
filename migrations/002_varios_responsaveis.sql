-- =====================================================================
-- Cajuca — migração 002: vários responsáveis por tarefa
-- Rodar UMA vez no SQL Editor do Supabase, depois da 001.
--
--  * tasks.assignee_email (um e-mail) vira tasks.assignees (lista de texto).
--  * Cada responsável pode ser um usuário do sistema (e-mail) ou um nome
--    escrito livremente (alguém sem login, por exemplo).
--  * O banco limpa a lista: tira espaços e vazios e remove repetidos
--    (sem diferenciar maiúsculas/minúsculas).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Coluna nova, com os dados da antiga
-- ---------------------------------------------------------------------
alter table public.tasks add column assignees text[] not null default '{}';

update public.tasks
   set assignees = array[assignee_email]
 where assignee_email is not null;

drop index if exists public.idx_tasks_assignee;
alter table public.tasks drop column assignee_email;

create index idx_tasks_assignees on public.tasks using gin (assignees);

-- ---------------------------------------------------------------------
-- Normalização da lista
-- ---------------------------------------------------------------------
create or replace function public.normalize_assignees(p text[])
returns text[] language sql immutable as $$
  select coalesce(array_agg(v order by pos), '{}')
  from (
    select min(ord) as pos, (array_agg(trim(x) order by ord))[1] as v
    from unnest(coalesce(p, '{}')) with ordinality as u(x, ord)
    where length(trim(coalesce(x, ''))) > 0
    group by lower(trim(x))
  ) s
$$;

create or replace function public.tasks_normalize_assignees()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.assignees := public.normalize_assignees(new.assignees);
  return new;
end $$;

create trigger trg_tasks_normalize_assignees
  before insert or update of assignees on public.tasks
  for each row execute function public.tasks_normalize_assignees();

alter table public.tasks
  add constraint chk_assignees_len check (cardinality(assignees) <= 50);

-- ---------------------------------------------------------------------
-- Plano de ação: recebe a lista de responsáveis
-- ---------------------------------------------------------------------
drop function public.create_action_plan(uuid, text, date, text, text, boolean);

create or replace function public.create_action_plan(
  p_parent    uuid,
  p_title     text,
  p_due       date,
  p_assignees text[]  default '{}',
  p_notes     text    default null,
  p_priority  boolean default false
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_event uuid;
  v_id    uuid;
begin
  perform public.require_auth();
  if not public.can_edit_task_id(p_parent) then
    raise exception 'Sem permissão para alterar esta tarefa';
  end if;
  if p_due is null or p_due < public.today_br() then
    raise exception 'O plano de ação precisa ter um prazo de hoje em diante';
  end if;

  select e.id into v_event
  from public.overdue_events e
  join public.tasks t on t.id = e.task_id
  where e.task_id = p_parent
    and t.status = 'overdue'
    and e.expired_due_date = t.due_date
    and e.resolution is distinct from 'extended'
  limit 1;

  insert into public.tasks (parent_id, title, due_date, assignees, notes, priority, action_plan_for_event)
  values (p_parent, p_title, p_due, coalesce(p_assignees, '{}'), p_notes, coalesce(p_priority, false), v_event)
  returning id into v_id;

  if v_event is not null then
    update public.overdue_events
       set resolution = 'action_plan', resolved_at = now()
     where id = v_event and resolution is null;
  end if;

  return v_id;
end $$;

revoke all on function
  public.create_action_plan(uuid, text, date, text[], text, boolean),
  public.normalize_assignees(text[]), public.tasks_normalize_assignees()
from public, anon, authenticated;

grant execute on function
  public.create_action_plan(uuid, text, date, text[], text, boolean)
to authenticated;
