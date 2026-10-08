-- =====================================================================
-- Cajuca — migração 001: projetos, donos e compartilhamento
-- Rodar UMA vez no SQL Editor do Supabase, no banco que já tem o schema.sql.
-- (Instalação nova: rode o schema.sql e depois este arquivo.)
--
-- Regras de acesso
--  * Toda árvore de tarefas tem um dono (owner_id = quem criou a raiz).
--  * Tarefa sem projeto: só o dono vê e altera.
--  * Projeto: tem um dono, que pode compartilhar com outros usuários como
--      'viewer'  -> só visualização
--      'editor'  -> visualização e edição das tarefas
--    Só o dono renomeia, compartilha ou exclui o projeto.
--  * Subtarefas herdam projeto e dono da raiz (o banco cuida disso).
--  * Pop-ups (atraso, inatividade, lembrete) só aparecem para quem pode editar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) > 0),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
-- o mesmo dono não repete nome de projeto
create unique index uq_projects_name on public.projects (owner_id, lower(trim(name)));

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index idx_members_user on public.project_members(user_id);

alter table public.tasks
  add column project_id uuid references public.projects(id) on delete set null,
  add column owner_id   uuid references auth.users(id) on delete cascade;
create index idx_tasks_project on public.tasks(project_id);
create index idx_tasks_owner   on public.tasks(owner_id);

-- tarefas que já existiam ficam com o primeiro usuário cadastrado
do $$
begin
  perform public.set_automation(true);   -- não conta como atividade (regra 10)
  update public.tasks
     set owner_id = (select id from auth.users order by created_at limit 1)
   where owner_id is null;
  perform public.set_automation(false);
end $$;

-- ---------------------------------------------------------------------
-- Permissões (security definer: não passam pelo RLS, evitando recursão)
-- ---------------------------------------------------------------------
create or replace function public.can_view_project(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects p where p.id = p_project and p.owner_id = auth.uid())
      or exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = auth.uid())
$$;

create or replace function public.can_edit_project(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects p where p.id = p_project and p.owner_id = auth.uid())
      or exists (select 1 from public.project_members m
                 where m.project_id = p_project and m.user_id = auth.uid() and m.role = 'editor')
$$;

create or replace function public.is_project_owner(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.projects p where p.id = p_project and p.owner_id = auth.uid())
$$;

-- acesso a uma tarefa a partir das colunas dela
create or replace function public.can_view_task(p_project uuid, p_owner uuid)
returns boolean language sql stable as $$
  select case when p_project is null then p_owner = auth.uid()
              else public.can_view_project(p_project) end
$$;

create or replace function public.can_edit_task(p_project uuid, p_owner uuid)
returns boolean language sql stable as $$
  select case when p_project is null then p_owner = auth.uid()
              else public.can_edit_project(p_project) end
$$;

create or replace function public.can_edit_task_id(p_task uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.can_edit_task(t.project_id, t.owner_id) from public.tasks t where t.id = p_task), false)
$$;

-- ---------------------------------------------------------------------
-- Triggers: subtarefa herda projeto e dono da raiz
-- ---------------------------------------------------------------------
create or replace function public.tasks_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.parent_id is not null then
    select p.project_id, p.owner_id into new.project_id, new.owner_id
    from public.tasks p where p.id = new.parent_id;
  elsif tg_op = 'INSERT' then
    new.owner_id := coalesce(auth.uid(), new.owner_id);   -- quem cria a raiz é o dono
  else
    new.owner_id := old.owner_id;   -- dono não muda por edição
    -- quem tira uma árvore de um projeto passa a ser o dono dela
    if not public.is_automation() and new.project_id is null and old.project_id is not null then
      new.owner_id := coalesce(auth.uid(), old.owner_id);
    end if;
  end if;

  if not public.is_automation() then
    -- V1
    if new.status = 'done'
       and (tg_op = 'INSERT' or old.status <> 'done')
       and exists (select 1 from public.tasks c where c.parent_id = new.id and c.status <> 'done') then
      raise exception 'Não é possível concluir: esta tarefa ainda tem subtarefas abertas';
    end if;
    new.last_activity_at := now();
  end if;

  new.status := public.compute_status(new);   -- também aplica V2

  if new.status = 'done' then
    if tg_op = 'INSERT' or old.status <> 'done' then
      new.completed_at := now();
    end if;
  else
    new.completed_at := null;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- leva projeto/dono da raiz para toda a árvore quando mudam
create or replace function public.tasks_propagate_project()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_prev boolean := public.is_automation();
begin
  perform public.set_automation(true);
  update public.tasks c
     set project_id = new.project_id, owner_id = new.owner_id
   where c.parent_id = new.id
     and (c.project_id is distinct from new.project_id or c.owner_id is distinct from new.owner_id);
  perform public.set_automation(v_prev);
  return null;
end $$;

create trigger trg_tasks_propagate_project
after update of project_id, owner_id on public.tasks
for each row
when (old.project_id is distinct from new.project_id or old.owner_id is distinct from new.owner_id)
execute function public.tasks_propagate_project();

alter table public.tasks alter column owner_id set not null;

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

-- Pop-ups só para quem pode editar a tarefa
create or replace function public.refresh_automations()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today      date := public.today_br();
  v_overdue    jsonb;
  v_reminders  jsonb;
  v_inactivity jsonb;
begin
  perform public.require_auth();
  perform public.set_automation(true);

  -- marca atrasos novos (sem pausa)
  update public.tasks t
     set status = 'overdue'
   where t.status not in ('done', 'overdue')
     and t.due_date < v_today
     and not public.is_paused(t.parent_id, t.blocking_status);

  -- plano de ação sem nenhuma subtarefa vinculada deixa de ser válido
  update public.overdue_events e
     set resolution = null, resolved_at = null
   where e.resolution = 'action_plan'
     and not exists (select 1 from public.tasks c where c.action_plan_for_event = e.id)
     and exists (select 1 from public.tasks t
                 where t.id = e.task_id and t.status = 'overdue' and t.due_date = e.expired_due_date);

  perform public.set_automation(false);

  -- pop-ups de atraso (regra 9)
  select coalesce(jsonb_agg(jsonb_build_object(
           'event_id', e.id, 'task_id', t.id, 'expired_due_date', e.expired_due_date)
           order by e.expired_due_date), '[]'::jsonb)
    into v_overdue
  from public.overdue_events e
  join public.tasks t on t.id = e.task_id
  where e.resolution is null
    and t.status = 'overdue'
    and t.due_date = e.expired_due_date
    and not public.is_paused(t.parent_id, t.blocking_status)
    and public.can_edit_task(t.project_id, t.owner_id);

  -- lembretes (regra 12)
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', t.id, 'due_date', t.due_date, 'days_left', t.due_date - v_today)
           order by t.due_date), '[]'::jsonb)
    into v_reminders
  from public.tasks t
  where t.status <> 'done'
    and t.due_date is not null
    and t.reminder_days is not null
    and v_today between t.due_date - t.reminder_days and t.due_date
    and (t.reminder_shown_for_due_date, t.reminder_shown_for_days)
        is distinct from (t.due_date, t.reminder_days)
    and not public.is_paused(t.parent_id, t.blocking_status)
    and public.can_edit_task(t.project_id, t.owner_id);

  -- inatividade de 7 em 7 dias (regra 10)
  select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id)), '[]'::jsonb)
    into v_inactivity
  from public.tasks t
  where t.status = 'in_progress'
    and greatest(t.last_activity_at, coalesce(t.last_inactivity_prompt_at, t.last_activity_at))
        < now() - interval '7 days'
    and not public.is_paused(t.parent_id, t.blocking_status)
    and public.can_edit_task(t.project_id, t.owner_id);

  return jsonb_build_object(
    'overdue',    v_overdue,
    'reminders',  v_reminders,
    'inactivity', v_inactivity
  );
end $$;

-- Estas só alteram tarefas: passam a rodar com as permissões de quem chama,
-- então o RLS impede alterar tarefa de projeto "só visualização".
alter function public.ack_reminder(uuid)                          security invoker;
alter function public.extend_due_date(uuid, date)                 security invoker;
alter function public.set_situation(uuid, text, text, boolean)    security invoker;
alter function public.resume_task(uuid, jsonb)                    security invoker;

-- Plano de ação mexe em overdue_events, então continua security definer
-- e confere a permissão antes.
create or replace function public.create_action_plan(
  p_parent   uuid,
  p_title    text,
  p_due      date,
  p_assignee text    default null,
  p_notes    text    default null,
  p_priority boolean default false
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

  insert into public.tasks (parent_id, title, due_date, assignee_email, notes, priority, action_plan_for_event)
  values (p_parent, p_title, p_due, p_assignee, p_notes, coalesce(p_priority, false), v_event)
  returning id into v_id;

  if v_event is not null then
    update public.overdue_events
       set resolution = 'action_plan', resolved_at = now()
     where id = v_event and resolution is null;
  end if;

  return v_id;
end $$;

-- Excluir projeto (só o dono): as árvores voltam para "Sem projeto" de quem as criou
create or replace function public.delete_project(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.is_project_owner(p_id) then
    raise exception 'Sem permissão para alterar este projeto';
  end if;
  perform public.set_automation(true);
  update public.tasks set project_id = null where project_id = p_id and parent_id is null;
  perform public.set_automation(false);
  delete from public.projects where id = p_id;
end $$;

-- Usuários cadastrados (para escolher com quem compartilhar)
create or replace function public.list_users()
returns table (id uuid, email text) language sql stable security definer set search_path = public as $$
  select u.id, u.email::text from auth.users u
  where auth.uid() is not null
  order by u.email
$$;

-- ---------------------------------------------------------------------
-- Segurança (RLS)
-- ---------------------------------------------------------------------
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

create policy "projects_select" on public.projects for select to authenticated
  using (owner_id = auth.uid() or public.can_view_project(id));
create policy "projects_insert" on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
create policy "projects_update" on public.projects for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "projects_delete" on public.projects for delete to authenticated
  using (owner_id = auth.uid());

create policy "members_select" on public.project_members for select to authenticated
  using (public.can_view_project(project_id));
create policy "members_write" on public.project_members for all to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id) and user_id <> auth.uid());

-- tarefas: troca a política aberta por permissões
drop policy if exists "tasks_authenticated_all" on public.tasks;
create policy "tasks_select" on public.tasks for select to authenticated
  using (public.can_view_task(project_id, owner_id));
create policy "tasks_insert" on public.tasks for insert to authenticated
  with check (public.can_edit_task(project_id, owner_id));
create policy "tasks_update" on public.tasks for update to authenticated
  using (public.can_edit_task(project_id, owner_id))
  with check (public.can_edit_task(project_id, owner_id));
create policy "tasks_delete" on public.tasks for delete to authenticated
  using (public.can_edit_task(project_id, owner_id));

drop policy if exists "overdue_events_authenticated_read" on public.overdue_events;
create policy "overdue_events_read" on public.overdue_events for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id));   -- herda o RLS de tasks

revoke all on public.projects, public.project_members from anon, authenticated;
grant select, insert, update, delete on public.projects, public.project_members to authenticated;

revoke all on function
  public.can_view_project(uuid), public.can_edit_project(uuid), public.is_project_owner(uuid),
  public.can_view_task(uuid, uuid), public.can_edit_task(uuid, uuid), public.can_edit_task_id(uuid),
  public.tasks_propagate_project(), public.delete_project(uuid), public.list_users()
from public, anon, authenticated;

grant execute on function
  public.can_view_project(uuid), public.can_edit_project(uuid), public.is_project_owner(uuid),
  public.can_view_task(uuid, uuid), public.can_edit_task(uuid, uuid), public.can_edit_task_id(uuid),
  public.delete_project(uuid), public.list_users()
to authenticated;
