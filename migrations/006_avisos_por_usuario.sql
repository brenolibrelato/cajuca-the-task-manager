-- =====================================================================
-- Cajuca — migração 006: lembretes e inatividade por usuário
-- Rodar UMA vez no SQL Editor do Supabase, depois da 005. Pode ser rodada de novo sem problema.
--
-- Problema
--   "Lembrete já exibido" (tasks.reminder_shown_*) e "última pergunta de inatividade"
--   (tasks.last_inactivity_prompt_at) ficavam na própria tarefa. Em projeto compartilhado,
--   o primeiro editor que fechava o lembrete ou respondia a pergunta fazia o aviso sumir
--   para todos os outros editores.
--
-- Decisão
--  * Tabela nova task_user_state (tarefa x usuário) guarda, para CADA pessoa:
--      - para qual prazo/antecedência ela já viu o lembrete;
--      - quando ela respondeu pela última vez a pergunta de inatividade.
--  * refresh_automations, ack_reminder e set_situation(p_from_prompt => true) passam a
--    usar só a linha de quem chama (auth.uid()).
--  * A RESPOSTA da inatividade continua sendo da tarefa: a situação escolhida (em andamento,
--    depende de outros, parado, outros) vale para todos. Só o "já respondi" é por pessoa:
--    cada editor recebe a pergunta no seu próprio ciclo de 7 dias.
--  * Atraso (overdue_events) é fato da tarefa e NÃO muda: prorrogar o prazo ou criar plano
--    de ação resolve para todos. "Lembrar amanhã" continua só no navegador de quem clicou.
--  * Quem trabalha sozinho não percebe diferença: o estado atual de cada tarefa é copiado
--    para a linha do dono dela. (Em projeto compartilhado, os outros editores podem ver uma
--    última vez um lembrete que outra pessoa já tinha fechado: é justamente a correção.)
--  * As colunas antigas de tasks ficam no lugar, sem uso, para dar para voltar atrás.
--    Podem ser removidas numa migração futura.
--
-- Segurança
--  * RLS: cada usuário só lê e escreve as próprias linhas, e só de tarefas que pode editar.
--  * As funções continuam security definer + search_path fixo, conferem can_edit_task_id
--    antes de mexer em qualquer coisa e não abrem set_automation ao usuário.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------
create table if not exists public.task_user_state (
  task_id                     uuid not null references public.tasks(id) on delete cascade,
  user_id                     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reminder_shown_for_due_date date,
  reminder_shown_for_days     int,
  last_inactivity_prompt_at   timestamptz,
  updated_at                  timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists idx_task_user_state_user on public.task_user_state(user_id);

-- o estado que estava na tarefa passa a ser o do dono dela
insert into public.task_user_state
  (task_id, user_id, reminder_shown_for_due_date, reminder_shown_for_days, last_inactivity_prompt_at)
select t.id, t.owner_id, t.reminder_shown_for_due_date, t.reminder_shown_for_days, t.last_inactivity_prompt_at
from public.tasks t
where t.reminder_shown_for_due_date is not null or t.last_inactivity_prompt_at is not null
on conflict (task_id, user_id) do nothing;

alter table public.task_user_state enable row level security;

drop policy if exists "task_user_state_own" on public.task_user_state;
create policy "task_user_state_own" on public.task_user_state for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_edit_task_id(task_id));

revoke all on public.task_user_state from anon, authenticated;
grant select, insert, update, delete on public.task_user_state to authenticated;

-- ---------------------------------------------------------------------
-- refresh_automations: igual à da 001, mas lembrete e inatividade olham a linha do usuário
-- ---------------------------------------------------------------------
create or replace function public.refresh_automations()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today      date := public.today_br();
  v_uid        uuid := auth.uid();
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

  -- atrasos (regra 9): continuam sendo da tarefa
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

  -- lembretes (regra 12): "já vi" é por usuário
  select coalesce(jsonb_agg(jsonb_build_object(
           'task_id', t.id, 'due_date', t.due_date, 'days_left', t.due_date - v_today)
           order by t.due_date), '[]'::jsonb)
    into v_reminders
  from public.tasks t
  left join public.task_user_state s on s.task_id = t.id and s.user_id = v_uid
  where t.status <> 'done'
    and t.due_date is not null
    and t.reminder_days is not null
    and v_today between t.due_date - t.reminder_days and t.due_date
    and (s.reminder_shown_for_due_date, s.reminder_shown_for_days)
        is distinct from (t.due_date, t.reminder_days)
    and not public.is_paused(t.parent_id, t.blocking_status)
    and public.can_edit_task(t.project_id, t.owner_id);

  -- inatividade de 7 em 7 dias (regra 10): o ciclo conta a partir da última resposta do usuário
  select coalesce(jsonb_agg(jsonb_build_object('task_id', t.id)), '[]'::jsonb)
    into v_inactivity
  from public.tasks t
  left join public.task_user_state s on s.task_id = t.id and s.user_id = v_uid
  where t.status = 'in_progress'
    and greatest(t.last_activity_at, coalesce(s.last_inactivity_prompt_at, t.last_activity_at))
        < now() - interval '7 days'
    and not public.is_paused(t.parent_id, t.blocking_status)
    and public.can_edit_task(t.project_id, t.owner_id);

  return jsonb_build_object(
    'overdue',    v_overdue,
    'reminders',  v_reminders,
    'inactivity', v_inactivity
  );
end $$;

-- ---------------------------------------------------------------------
-- ack_reminder: grava "já vi" só para quem fechou o lembrete (não mexe na tarefa)
-- ---------------------------------------------------------------------
create or replace function public.ack_reminder(p_task uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.can_edit_task_id(p_task) then
    raise exception 'Sem permissão para alterar esta tarefa';
  end if;
  insert into public.task_user_state (task_id, user_id, reminder_shown_for_due_date, reminder_shown_for_days, updated_at)
  select t.id, auth.uid(), t.due_date, t.reminder_days, now()
  from public.tasks t where t.id = p_task
  on conflict (task_id, user_id) do update
    set reminder_shown_for_due_date = excluded.reminder_shown_for_due_date,
        reminder_shown_for_days     = excluded.reminder_shown_for_days,
        updated_at                  = now();
end $$;

-- ---------------------------------------------------------------------
-- set_situation: a situação é da tarefa; "respondi a pergunta" é do usuário
-- ---------------------------------------------------------------------
create or replace function public.set_situation(
  p_task        uuid,
  p_situation   text,
  p_reason      text    default null,
  p_from_prompt boolean default false
)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.can_edit_task_id(p_task) then
    raise exception 'Sem permissão para alterar esta tarefa';
  end if;
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
         blocking_set_at = now()
   where id = p_task;

  perform public.set_automation(false);

  if p_from_prompt then
    insert into public.task_user_state (task_id, user_id, last_inactivity_prompt_at, updated_at)
    values (p_task, auth.uid(), now(), now())
    on conflict (task_id, user_id) do update
      set last_inactivity_prompt_at = excluded.last_inactivity_prompt_at,
          updated_at                = now();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Permissões
-- ---------------------------------------------------------------------
revoke all on function
  public.refresh_automations(), public.ack_reminder(uuid), public.set_situation(uuid, text, text, boolean)
from public, anon, authenticated;

grant execute on function
  public.refresh_automations(), public.ack_reminder(uuid), public.set_situation(uuid, text, text, boolean)
to authenticated;
