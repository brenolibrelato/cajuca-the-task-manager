-- =====================================================================
-- Cajuca — migração 005: correções de permissão
-- Rodar UMA vez no SQL Editor do Supabase, depois da 004. Pode ser rodada de novo sem problema.
--
--  1. ack_reminder, set_situation e resume_task passaram a "security invoker" na 001,
--     mas chamam set_automation(), cujo EXECUTE foi revogado de "authenticated".
--     Resultado: "permission denied" ao confirmar lembrete, responder o pop-up de
--     inatividade, pausar/retomar. Aqui voltam a ser "security definer" e conferem a
--     permissão sobre a tarefa (can_edit_task_id) antes de qualquer alteração.
--     set_automation continua fechada ao usuário: liberar quebraria a regra V1.
--
--  2. Um editor (não dono) podia tirar uma árvore de um projeto compartilhado e virar
--     dono dela, escondendo-a do dono do projeto. Agora só o dono do projeto de origem
--     pode tirar a árvore dele ou movê-la para outro projeto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funções que mudam tarefas com a flag de automação
-- ---------------------------------------------------------------------
create or replace function public.ack_reminder(p_task uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_auth();
  if not public.can_edit_task_id(p_task) then
    raise exception 'Sem permissão para alterar esta tarefa';
  end if;
  perform public.set_automation(true);
  update public.tasks
     set reminder_shown_for_due_date = due_date,
         reminder_shown_for_days     = reminder_days
   where id = p_task;
  perform public.set_automation(false);
end $$;

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
         blocking_set_at = now(),
         last_inactivity_prompt_at = case when p_from_prompt then now() else last_inactivity_prompt_at end
   where id = p_task;

  perform public.set_automation(false);
end $$;

create or replace function public.resume_task(p_task uuid, p_changes jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_subtree uuid[];
  v_item    jsonb;
  v_id      uuid;
begin
  perform public.require_auth();
  -- a subárvore inteira pertence ao mesmo projeto/dono da raiz: basta conferir a tarefa pedida
  if not public.can_edit_task_id(p_task) then
    raise exception 'Sem permissão para alterar esta tarefa';
  end if;

  if not exists (select 1 from public.tasks where id = p_task and blocking_status = 'stopped') then
    raise exception 'Esta tarefa não está parada';
  end if;

  with recursive sub as (
    select id from public.tasks where id = p_task
    union all
    select c.id from public.tasks c join sub s on c.parent_id = s.id
  )
  select array_agg(id) into v_subtree from sub;

  -- 1. remove a pausa
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
-- 2. Só o dono do projeto tira ou move uma árvore dele
-- (restante da função idêntico à versão da migração 001)
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
    if not public.is_automation() and new.project_id is distinct from old.project_id
       and old.project_id is not null then
      if not public.is_project_owner(old.project_id) then
        raise exception 'Sem permissão para alterar o projeto desta tarefa';
      end if;
      -- quem tira uma árvore de um projeto passa a ser o dono dela
      if new.project_id is null then
        new.owner_id := coalesce(auth.uid(), old.owner_id);
      end if;
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

-- permissões: as funções acima continuam chamáveis só por usuários logados
revoke all on function
  public.ack_reminder(uuid), public.set_situation(uuid, text, text, boolean),
  public.resume_task(uuid, jsonb), public.tasks_before_write()
from public, anon, authenticated;

grant execute on function
  public.ack_reminder(uuid), public.set_situation(uuid, text, text, boolean),
  public.resume_task(uuid, jsonb)
to authenticated;
