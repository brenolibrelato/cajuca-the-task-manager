-- =====================================================================
-- Cajuca — schema completo (Supabase / Postgres)
-- Rodar inteiro no SQL Editor do Supabase, uma única vez.
--
-- Arquitetura: front estático (GitHub Pages) -> Supabase direto.
-- As regras de negócio vivem aqui (triggers + funções RPC), então valem
-- para qualquer forma de acesso aos dados.
--
-- ---------------------------------------------------------------------
-- ORDEM DE PRIORIDADE DAS REGRAS DE STATUS (regra geral 2)
-- Avaliada em compute_status(), de cima para baixo; a primeira que
-- se aplica decide:
--
--  P1. Mãe com todas as filhas concluídas  -> "done"         (regra 5)
--      (vale mesmo com prazo da mãe vencido: conclusão > atraso)
--  P2. Tarefa marcada "done" sem filhas abertas -> "done"    (regra 7)
--      Se ganhou filha aberta, é reaberta como "in_progress".
--  P3. Prazo próprio vencido e sem pausa       -> "overdue"  (regras 4, 7)
--      "Atrasado" nunca é herdado das filhas                (regra 2)
--      Se a tarefa está pausada ("Parado" nela ou em ancestral),
--      não há verificação de prazo: o status fica como está.
--  P4. Estava "overdue" mas o prazo deixou de estar vencido
--      (prorrogação/edição)                    -> "in_progress" (regra 9)
--  P5. Alguma filha "in_progress"              -> "in_progress" (regras 1, 3)
--  P6. Caso contrário, mantém o status atual.
--
-- Validações (bloqueiam a operação):
--  V1. Concluir manualmente uma mãe com filhas abertas é proibido (regra 8).
--  V2. "overdue" não pode ser definido à mão; só o prazo determina.
--  V3. Hierarquia não pode ter ciclos.
--
-- "Hoje" é sempre calculado no fuso America/Sao_Paulo.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table public.tasks (
  id                uuid primary key default gen_random_uuid(),
  parent_id         uuid references public.tasks(id) on delete cascade,  -- regra 13

  title             text not null check (length(trim(title)) > 0),
  notes             text,
  priority          boolean not null default false,
  due_date          date,
  reminder_days     int check (reminder_days >= 0),
  assignee_email    text check (
                      assignee_email is null
                      or assignee_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
                    ),
  status            text not null default 'not_started'
                    check (status in ('not_started', 'in_progress', 'overdue', 'done')),
  completed_at      timestamptz,

  -- situação (regra 10), separada do status
  blocking_status   text check (blocking_status in ('in_progress', 'waiting_others', 'stopped', 'other')),
  blocking_reason   text,
  blocking_set_at   timestamptz,

  -- controle das automações
  last_activity_at            timestamptz not null default now(),
  last_inactivity_prompt_at   timestamptz,
  reminder_shown_for_due_date date,
  reminder_shown_for_days     int,

  action_plan_for_event uuid,   -- regra 9: subtarefa criada como plano de ação

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chk_no_self_parent check (parent_id is null or parent_id <> id),
  constraint chk_done_has_date  check ((status = 'done') = (completed_at is not null)),
  constraint chk_other_reason   check (
                                  blocking_status is distinct from 'other'
                                  or length(trim(coalesce(blocking_reason, ''))) > 0
                                ),
  constraint chk_plan_has_due   check (action_plan_for_event is null or due_date is not null)
);

-- Eventos de atraso (regra 9)
--   resolution null          -> pop-up pendente
--   'extended'               -> prazo prorrogado
--   'action_plan'            -> plano de ação criado (válido enquanto existir
--                               subtarefa apontando para o evento)
--   'closed'                 -> encerrado por conclusão ou troca de prazo
create table public.overdue_events (
  id                uuid primary key default gen_random_uuid(),
  task_id           uuid not null references public.tasks(id) on delete cascade,
  expired_due_date  date not null,
  resolution        text check (resolution in ('extended', 'action_plan', 'closed')),
  new_due_date      date,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  unique (task_id, expired_due_date)
);

alter table public.tasks
  add constraint fk_action_plan_event
  foreign key (action_plan_for_event) references public.overdue_events(id) on delete set null;

create index idx_tasks_parent       on public.tasks(parent_id);
create index idx_tasks_status       on public.tasks(status);
create index idx_tasks_due_date     on public.tasks(due_date);
create index idx_tasks_completed_at on public.tasks(completed_at);
create index idx_tasks_assignee     on public.tasks(assignee_email);
create index idx_tasks_plan_event   on public.tasks(action_plan_for_event);
create index idx_overdue_open       on public.overdue_events(task_id) where resolution is null;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.today_br()
returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Flag de "alteração automática": não conta como atividade do usuário
-- e não passa pela validação V1.
create or replace function public.is_automation()
returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('cajuca.automation', true), ''), 'off') = 'on'
$$;

create or replace function public.set_automation(p_on boolean)
returns void language plpgsql as $$
begin
  perform set_config('cajuca.automation', case when p_on then 'on' else 'off' end, true);
end $$;

create or replace function public.require_auth()
returns void language plpgsql stable as $$
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;
end $$;

-- Pausada = "Parado" nela mesma ou em qualquer ancestral (pausa herdada)
create or replace function public.is_paused(p_parent_id uuid, p_blocking text)
returns boolean language sql stable as $$
  select coalesce(p_blocking = 'stopped', false)
      or exists (
        with recursive anc as (
          select id, parent_id, blocking_status from public.tasks where id = p_parent_id
          union all
          select t.id, t.parent_id, t.blocking_status
          from public.tasks t join anc a on t.id = a.parent_id
        )
        select 1 from anc where blocking_status = 'stopped'
      )
$$;

-- ---------------------------------------------------------------------
-- Motor de status (ver ORDEM DE PRIORIDADE no topo)
-- ---------------------------------------------------------------------
create or replace function public.compute_status(t public.tasks)
returns text language plpgsql stable as $$
declare
  v_has_children      boolean;
  v_open_children     boolean;
  v_child_in_progress boolean;
  v_paused            boolean;
  v_base              text := t.status;
begin
  select count(*) > 0,
         coalesce(bool_or(c.status <> 'done'), false),
         coalesce(bool_or(c.status = 'in_progress'), false)
    into v_has_children, v_open_children, v_child_in_progress
  from public.tasks c
  where c.parent_id = t.id;

  -- P1
  if v_has_children and not v_open_children then
    return 'done';
  end if;

  -- P2
  if v_base = 'done' then
    if not v_open_children then
      return 'done';
    end if;
    v_base := 'in_progress';   -- reaberta por ter ganho filha aberta
  end if;

  v_paused := public.is_paused(t.parent_id, t.blocking_status);

  if not v_paused then
    -- P3
    if t.due_date is not null and t.due_date < public.today_br() then
      return 'overdue';
    end if;
    -- P4
    if v_base = 'overdue' then
      v_base := 'in_progress';
    end if;
  end if;

  -- P5
  if v_child_in_progress and v_base <> 'overdue' then
    return 'in_progress';
  end if;

  -- P6
  return v_base;
end $$;

-- Recalcula uma tarefa (usado para propagar mudanças para a mãe)
create or replace function public.recompute_task(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t      public.tasks;
  v_new  text;
  v_prev boolean;
begin
  if p_id is null then return; end if;

  select * into t from public.tasks where id = p_id;
  if not found then return; end if;

  v_new := public.compute_status(t);
  if v_new is distinct from t.status then
    v_prev := public.is_automation();
    perform public.set_automation(true);
    update public.tasks set status = v_new where id = p_id;  -- dispara propagação para o avô
    perform public.set_automation(v_prev);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create or replace function public.tasks_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
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

create or replace function public.tasks_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- encerra eventos de atraso que deixaram de valer
    update public.overdue_events e
       set resolution   = case
                            when new.status = 'done'    then 'closed'
                            when new.status <> 'overdue' then 'extended'
                            else 'closed'
                          end,
           new_due_date = case when new.status not in ('done', 'overdue') then new.due_date end,
           resolved_at  = now()
     where e.task_id = new.id
       and e.resolution is null
       and (new.status <> 'overdue' or e.expired_due_date is distinct from new.due_date);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.status = 'overdue' and new.due_date is not null then
    insert into public.overdue_events (task_id, expired_due_date)
    values (new.id, new.due_date)
    on conflict (task_id, expired_due_date) do nothing;
  end if;

  -- propagação para a mãe
  if tg_op = 'DELETE' then
    perform public.recompute_task(old.parent_id);
  elsif tg_op = 'INSERT' then
    perform public.recompute_task(new.parent_id);
  elsif old.status is distinct from new.status or old.parent_id is distinct from new.parent_id then
    perform public.recompute_task(new.parent_id);
    if old.parent_id is distinct from new.parent_id then
      perform public.recompute_task(old.parent_id);
    end if;
  end if;

  return null;
end $$;

create or replace function public.prevent_task_cycle()
returns trigger language plpgsql as $$
begin
  if new.parent_id is null then
    return new;
  end if;

  if exists (
    with recursive anc as (
      select id, parent_id from public.tasks where id = new.parent_id
      union all
      select t.id, t.parent_id from public.tasks t join anc a on t.id = a.parent_id
    )
    select 1 from anc where id = new.id
  ) then
    raise exception 'Hierarquia inválida: a tarefa não pode ser descendente de si mesma';
  end if;

  return new;
end $$;

create trigger trg_tasks_a_no_cycle
before insert or update of parent_id on public.tasks
for each row execute function public.prevent_task_cycle();

create trigger trg_tasks_b_before_write
before insert or update on public.tasks
for each row execute function public.tasks_before_write();

create trigger trg_tasks_after_write
after insert or update or delete on public.tasks
for each row execute function public.tasks_after_write();

-- ---------------------------------------------------------------------
-- RPC: chamada pelo front ao abrir a tela.
-- Aplica as regras que dependem do tempo e devolve os pop-ups pendentes.
-- ---------------------------------------------------------------------
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
    and not public.is_paused(t.parent_id, t.blocking_status);

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
    and not public.is_paused(t.parent_id, t.blocking_status);

  -- inatividade de 7 em 7 dias (regra 10)
  select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id)), '[]'::jsonb)
    into v_inactivity
  from public.tasks t
  where t.status = 'in_progress'
    and greatest(t.last_activity_at, coalesce(t.last_inactivity_prompt_at, t.last_activity_at))
        < now() - interval '7 days'
    and not public.is_paused(t.parent_id, t.blocking_status);

  return jsonb_build_object(
    'overdue',    v_overdue,
    'reminders',  v_reminders,
    'inactivity', v_inactivity
  );
end $$;

-- ---------------------------------------------------------------------
-- RPCs dos pop-ups
-- ---------------------------------------------------------------------

-- Regra 12: marca o lembrete como exibido para o prazo/configuração atuais
create or replace function public.ack_reminder(p_task uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  perform public.set_automation(true);
  update public.tasks
     set reminder_shown_for_due_date = due_date,
         reminder_shown_for_days     = reminder_days
   where id = p_task;
  perform public.set_automation(false);
end $$;

-- Regra 9: prorrogar prazo (o trigger volta o status para "in_progress"
-- e registra o evento como 'extended')
create or replace function public.extend_due_date(p_task uuid, p_new_due date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if p_new_due is null or p_new_due < public.today_br() then
    raise exception 'O novo prazo precisa ser hoje ou uma data futura';
  end if;
  update public.tasks set due_date = p_new_due where id = p_task;
end $$;

-- Regra 9 (e opcional na regra 10): plano de ação via subtarefa com prazo
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
  if p_due is null or p_due < public.today_br() then
    raise exception 'O plano de ação precisa ter um prazo de hoje em diante';
  end if;

  -- evento de atraso atual da mãe (pendente ou já com plano)
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

-- Regra 10: define a situação (pop-up de inatividade ou ação manual)
create or replace function public.set_situation(
  p_task        uuid,
  p_situation   text,
  p_reason      text    default null,
  p_from_prompt boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if p_situation not in ('in_progress', 'waiting_others', 'stopped', 'other') then
    raise exception 'Situação inválida';
  end if;
  if p_situation = 'other' and length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Informe a justificativa para "Outros"';
  end if;

  if p_from_prompt then
    perform public.set_automation(true);   -- responder o pop-up não é "atividade"
  end if;

  update public.tasks
     set blocking_status = p_situation,
         blocking_reason = nullif(trim(coalesce(p_reason, '')), ''),
         blocking_set_at = now(),
         last_inactivity_prompt_at = case when p_from_prompt then now() else last_inactivity_prompt_at end
   where id = p_task;

  perform public.set_automation(false);
end $$;

-- Regra 11: retomar tarefa "Parado" após revisão.
-- p_changes: [{"id": "...", "due_date": "2026-11-01", "status": "in_progress"}, ...]
--   - só as chaves enviadas são alteradas ("due_date": null remove o prazo)
--   - ids devem ser a própria tarefa ou descendentes
--   - envie as mais profundas primeiro
create or replace function public.resume_task(p_task uuid, p_changes jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_subtree uuid[];
  v_item    jsonb;
  v_id      uuid;
begin
  perform public.require_auth();

  if not exists (select 1 from public.tasks where id = p_task and blocking_status = 'stopped') then
    raise exception 'Esta tarefa não está parada';
  end if;

  with recursive sub as (
    select id from public.tasks where id = p_task
    union all
    select c.id from public.tasks c join sub s on c.parent_id = s.id
  )
  select array_agg(id) into v_subtree from sub;

  -- 1. remove a pausa (descendentes continuam pausados se outro ancestral estiver "Parado")
  update public.tasks
     set blocking_status = null, blocking_reason = null, blocking_set_at = null
   where id = p_task;

  -- 2. aplica o que o usuário revisou
  for v_item in select value from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    v_id := (v_item->>'id')::uuid;
    if not (v_id = any(v_subtree)) then
      raise exception 'Tarefa % não pertence à árvore retomada', v_id;
    end if;
    update public.tasks
       set due_date = case when v_item ? 'due_date' then (v_item->>'due_date')::date else due_date end,
           status   = case when v_item ? 'status'   then v_item->>'status'          else status   end
     where id = v_id;
  end loop;

  -- 3. reavalia toda a subárvore com as automações reativadas
  perform public.set_automation(true);
  update public.tasks set status = status where id = any(v_subtree);
  perform public.set_automation(false);
end $$;

-- ---------------------------------------------------------------------
-- Segurança
-- Somente usuários logados (Supabase Auth) acessam. Desative o cadastro
-- público no painel e crie os usuários manualmente.
-- ---------------------------------------------------------------------
alter table public.tasks          enable row level security;
alter table public.overdue_events enable row level security;

create policy "tasks_authenticated_all" on public.tasks
  for all to authenticated using (true) with check (true);

create policy "overdue_events_authenticated_read" on public.overdue_events
  for select to authenticated using (true);
-- escrita em overdue_events só pelas funções (security definer)

-- grants explícitos (não depende do padrão do projeto Supabase)
revoke all on public.tasks, public.overdue_events from anon, authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select on public.overdue_events to authenticated;

revoke all on function
  public.today_br(), public.is_automation(), public.set_automation(boolean),
  public.require_auth(), public.is_paused(uuid, text), public.compute_status(public.tasks),
  public.recompute_task(uuid), public.tasks_before_write(), public.tasks_after_write(),
  public.prevent_task_cycle(),
  public.refresh_automations(), public.ack_reminder(uuid), public.extend_due_date(uuid, date),
  public.create_action_plan(uuid, text, date, text, text, boolean),
  public.set_situation(uuid, text, text, boolean), public.resume_task(uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  public.refresh_automations(), public.ack_reminder(uuid), public.extend_due_date(uuid, date),
  public.create_action_plan(uuid, text, date, text, text, boolean),
  public.set_situation(uuid, text, text, boolean), public.resume_task(uuid, jsonb),
  public.today_br()
to authenticated;
