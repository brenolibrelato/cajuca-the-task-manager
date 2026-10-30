# Cajuca — planejador de tarefas

O Cajuca é um gestor de tarefas hierárquico: cada tarefa pode ter subtarefas ilimitadas, e o status de toda a árvore se atualiza sozinho conforme o trabalho avança. O projeto foi pensado para acompanhar prazos, evitar que tarefas fiquem esquecidas e manter um histórico do que já foi concluído.

*A hierarchical task manager with automatic status, deadlines and reminders, in Portuguese and English.*

🔗 https://brenolibrelato.github.io/cajuca-the-task-manager/

## Funcionalidades

- **Tarefas e subtarefas** organizadas em árvore, com recuo visual
- **Projetos** para agrupar as tarefas (ex.: "Tarefas Gabriele", "Tarefas Leticia"), com filtro de seleção múltipla
- **Ordem dos projetos** definida arrastando e soltando, salva para cada usuário
- **Compartilhamento de projetos** com outros usuários, escolhendo para cada um "só visualização" ou "visualização e edição". Tarefas fora de projeto são privadas
- **Status automático**: a tarefa mãe fica "em andamento" quando alguma filha começa e é concluída quando todas as filhas terminam
- **Controle de atraso**: tarefas com prazo vencido ficam atrasadas, e um aviso permite prorrogar o prazo, criar um plano de ação ou lembrar no dia seguinte
- **Situação da tarefa**: em andamento, aguardando terceiros, parado ou outros (com justificativa). Uma tarefa parada pausa a árvore inteira
- **Aviso de inatividade** a cada 7 dias para tarefas em andamento sem movimentação
- **Lembretes** configuráveis em dias antes do prazo
- **Retomada** de tarefas paradas, com revisão de prazos e status
- **Histórico** com as árvores de tarefas concluídas
- **Filtros** por prioridade, período e responsável
- **Responsáveis** por tarefa: um ou vários, escolhidos entre os usuários cadastrados ou escritos livremente
- **Bilíngue**: português e inglês, à escolha do usuário
- **Tema claro e escuro** automático
- **Acesso restrito** com login e recuperação de senha por e-mail
- **Acessível pelo teclado**: células editáveis (Tab + Enter) e botões para subir/descer projetos, além de arrastar

## Instalação

O Cajuca é um site estático (GitHub Pages) que conversa direto com o [Supabase](https://supabase.com). Não há build.

1. Crie um projeto no Supabase.
2. No **SQL Editor**, rode `schema.sql` e depois, **em ordem**, `migrations/001` até `migrations/005`.
3. Em **Authentication**:
   - desative o cadastro público (*Allow new users to sign up*) e crie os usuários manualmente;
   - em *URL Configuration*, coloque o endereço do site em **Redirect URLs** (necessário para "esqueci minha senha").
4. Em `js/config.js`, ajuste `SUPABASE_URL` e `SUPABASE_KEY` (use só a chave **publishable**; nunca a *secret* nem a `service_role`).
5. Em `index.html`, ajuste o domínio do Supabase na política de segurança (`Content-Security-Policy`, linhas `connect-src`).
6. Publique a pasta (GitHub Pages) ou sirva localmente apenas em `localhost`, por exemplo `python -m http.server --bind 127.0.0.1`.

## Testes

Precisa do Node 18 ou mais novo.

```
npm test
```

Cobre a lógica da árvore e dos filtros (`js/tree.js`) e os textos pt/en (`js/i18n.js`). O GitHub Actions roda o mesmo comando a cada push.

## Segurança

- Quem protege os dados é o login + RLS do Supabase; a chave publishable no código é pública por desenho.
- O `supabase-js` é carregado do jsDelivr com **versão fixa** (em `js/app.js`). Ao atualizar, troque o número e teste.
- A `Content-Security-Policy` do `index.html` só permite scripts do próprio site e do jsDelivr.

---

Feito por [Breno Librelato](https://github.com/brenolibrelato).
