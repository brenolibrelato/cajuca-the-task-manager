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
- **Controle de atraso**: tarefas com prazo vencido ficam atrasadas; a pendência permite prorrogar o prazo, criar um plano de ação ou lembrar no dia seguinte
- **Situação da tarefa**: em andamento, depende de outros, parado ou outros (com justificativa). Uma tarefa "Parado" deixa a árvore inteira parada (sem lembretes, atraso ou inatividade) até ser retomada
- **Aviso de inatividade** a cada 7 dias para tarefas em andamento sem movimentação
- **Lembretes** configuráveis em dias antes do prazo
- **Painel de pendências** (sino no topo, com contador): atrasos, inatividade e lembretes ficam numa lista e cada um é resolvido quando você escolher, sem pop-ups em sequência. Em projeto compartilhado, lembrete e inatividade são por pessoa (migração 006)
- **Retomada** de tarefas paradas, com revisão de prazos e status
- **Histórico** com as árvores de tarefas concluídas
- **Resumo** no topo (atrasadas, vencem hoje, vencem nesta semana, em andamento): clique para filtrar
- **Filtros** por projeto, prioridade, período e responsável, **busca** por título/observação (sem diferenciar acentos e maiúsculas) e **atalhos** (Minhas tarefas, Atrasadas, Hoje, Esta semana, Em andamento). Filtros, ordenação e projetos recolhidos ficam salvos no navegador, por usuário
- **Ordenação** por tarefa, prioridade, prazo ou status clicando no cabeçalho (crescente → decrescente → ordem padrão); a hierarquia é mantida
- **Prazo relativo** ("hoje", "em 3 dias", "há 2 dias") junto da data
- **Mover tarefas** arrastando pela alça ⋮⋮ para outro projeto ou para cima de outra tarefa (vira subtarefa), ou pelo menu ⋯ → "Mover para…"
- **Atualização otimista**: status e edições diretas aparecem na hora e voltam atrás se o banco recusar
- **Exportar CSV** e **imprimir** a visão atual
- **Celular**: em telas estreitas a tabela vira lista de cartões e os filtros recolhem
- **Responsáveis** por tarefa: um ou vários, escolhidos entre os usuários cadastrados ou escritos livremente
- **Bilíngue**: português e inglês, à escolha do usuário
- **Tema claro e escuro** automático
- **Acesso restrito** com login e recuperação de senha por e-mail
- **Acessível pelo teclado**: células editáveis, menus e painel operáveis sem mouse, alternativas por teclado para todo arraste

## Atalhos e uso

- **Editar direto na tabela**: Tab até a célula e Enter (ou F2). Enter salva, Esc cancela; na observação, Shift+Enter quebra linha.
- **Menu ⋯ da linha**: Editar, Marcar como Parado, Mover para…, Excluir. Setas ↑/↓, Home/End, Enter para escolher, Esc para fechar.
- **Projetos**: ▴/▾ (aparecem ao passar o mouse ou com o foco do teclado) mudam a ordem; ⋯ tem Editar e compartilhar e Excluir (só o dono).
- **Busca**: Esc limpa o campo.
- **Arrastar**: Esc cancela. Destino em vermelho = não permitido (sem permissão, ciclo, ou tirar árvore de projeto de outra pessoa).

## Exportar e imprimir

- **Exportar CSV** (barra de ferramentas) baixa a visão atual com os mesmos filtros e a mesma ordem da tela, com tudo expandido (inclusive projetos e tarefas recolhidos). Colunas: projeto, caminho da tarefa, título, observação, prioridade, prazo, lembrete, responsáveis, status e situação.
- O arquivo é gerado no próprio navegador (nada é enviado a outro serviço), em UTF-8 com BOM e separador `;`, pronto para o Excel em português. Células que começam com `=`, `+`, `-`, `@`, tab ou CR recebem um apóstrofo na frente, para o Excel não executar fórmulas vindas de texto digitado.
- **Imprimir** usa a impressão do navegador: esconde barras e botões e expande tudo.

## Instalação

O Cajuca é um site estático (GitHub Pages) que conversa direto com o [Supabase](https://supabase.com). Não há build.

1. Crie um projeto no Supabase.
2. No **SQL Editor**, rode `schema.sql` e depois, **em ordem**, `migrations/001` até `migrations/007`:
   - `001_projetos_compartilhamento.sql` — projetos, donos e compartilhamento
   - `002_varios_responsaveis.sql` — vários responsáveis por tarefa
   - `003_ordem_projetos.sql` e `004_ordem_sem_projeto.sql` — ordem dos projetos por usuário
   - `005_correcoes_seguranca.sql` — correções de permissão
   - `006_avisos_por_usuario.sql` — lembrete e inatividade por pessoa em projetos compartilhados
   - `007_mover_tarefas.sql` — regras para mover tarefas entre projetos e tarefas mães

### Atualizando uma instalação existente

Se o banco já tem até a 005, rode no SQL Editor a `006` e depois a `007` (cada uma inteira, uma vez; podem ser rodadas de novo sem problema). O site funciona antes delas: sem a 006, lembrete e inatividade continuam compartilhados por tarefa, como antes; sem a 007, mover tarefas funciona, mas um editor que não é dono do projeto conseguiria levar uma árvore para fora dele arrastando-a para dentro de outra tarefa (a tela já não oferece isso; a 007 garante no banco).
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

Cobre a lógica da árvore, filtros, busca, atalhos, ordenação, regras de mover e preferências salvas (`js/tree.js`), a geração do CSV (`js/csv.js`) e os textos pt/en (`js/i18n.js`). O GitHub Actions roda o mesmo comando a cada push.

## Segurança

- Quem protege os dados é o login + RLS do Supabase; a chave publishable no código é pública por desenho.
- O `supabase-js` é carregado do jsDelivr com **versão fixa** (em `js/app.js`). Ao atualizar, troque o número e teste.
- A `Content-Security-Policy` do `index.html` só permite scripts do próprio site e do jsDelivr.
- Preferências (filtros, inclusive busca e responsável escolhido, ordenação, projetos recolhidos) e o "Lembrar amanhã" ficam no `localStorage` do navegador, por usuário. Em computador compartilhado, quem usar o mesmo navegador consegue ler essas preferências (texto da busca, e-mail do responsável filtrado, ids de projetos), mas não as tarefas.

---

Feito por [Breno Librelato](https://github.com/brenolibrelato).
