-- =====================================================================
-- Cajuca — migração 007: mover tarefas (arrastar ou "Mover para…")
-- Rodar UMA vez no SQL Editor do Supabase, depois da 006. Pode ser rodada de novo sem problema.
--
-- O front move tarefas só com update de parent_id/project_id (as políticas de tasks já
-- aceitam). Esta migração fecha duas brechas que mover por parent_id abria:
--
--  1. A 005 impediu um editor (não dono) de tirar uma árvore de um projeto compartilhado
--     mudando project_id. Mas, ao mudar parent_id para uma tarefa de OUTRO projeto (ou de
--     uma árvore sem projeto dele), o trigger copiava projeto e dono da nova mãe sem
--     conferir nada: o editor conseguia levar a árvore embora e virar dono dela.
--     Agora a mesma regra vale nos dois caminhos: só o dono do projeto de origem tira
--     uma tarefa (e suas filhas) do projeto. A mensagem é a mesma da 005.
--
--  2. Subtarefa criada como plano de ação (action_plan_for_event) que muda de mãe deixa
--     de contar como plano do atraso da mãe antiga: o vínculo é limpo, e a verificação
--     periódica volta a mostrar o atraso dela como pendente.
--
-- Ciclos continuam barrados por prevent_task_cycle (schema.sql).
-- Restante da função idêntico à versão da migração 005.
-- =====================================================================

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
    -- quem tira uma árvore de um projeto passa a ser o dono dela (a permissão é conferida abaixo)
    if not public.is_automation() and new.project_id is null and old.project_id is not null then
      new.owner_id := coalesce(auth.uid(), old.owner_id);
    end if;
  end if;

  if tg_op = 'UPDATE' and not public.is_automation() then
    -- 005 + 007: vale tanto para project_id quanto para parent_id (projeto herdado da nova mãe)
    if old.project_id is not null and new.project_id is distinct from old.project_id
       and not public.is_project_owner(old.project_id) then
      raise exception 'Sem permissão para alterar o projeto desta tarefa';
    end if;
    -- plano de ação que muda de lugar deixa de valer para o atraso da mãe antiga
    if new.parent_id is distinct from old.parent_id then
      new.action_plan_for_event := null;
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

-- função de trigger: ninguém chama direto
revoke all on function public.tasks_before_write() from public, anon, authenticated;
