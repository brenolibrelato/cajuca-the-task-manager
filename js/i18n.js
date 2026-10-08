// Traduções e formatação por idioma.
// Para adicionar um texto: crie a chave nos dois dicionários e use t('chave').
// Variáveis: t('overdue.text', { title: 'X' }) substitui {title}.

const DICT = {
  pt: {
    'app.subtitle': 'Planejador de tarefas',
    'login.email': 'E-mail',
    'login.password': 'Senha',
    'login.submit': 'Entrar',
    'login.error': 'E-mail ou senha inválidos.',
    'top.tasks': 'Tarefas',
    'top.history': 'Histórico',
    'top.logout': 'Sair',
    'top.language': 'Idioma',

    'filter.priority': 'Prioridade',
    'filter.due': 'Prazo',
    'filter.completed': 'Concluídas',
    'filter.assignee': 'Responsável',
    'filter.clear': 'Limpar filtros',
    'filter.all': 'Todas',
    'filter.yes': 'Sim',
    'filter.no': 'Não',
    'filter.everyone': 'Todos',
    'filter.noAssignee': 'Sem responsável',
    'period.all': 'Tudo',
    'period.next7': 'Próximos 7 dias',
    'period.next15': 'Próximos 15 dias',
    'period.next30': 'Próximos 30 dias',
    'period.none': 'Sem prazo',
    'period.last7': 'Últimos 7 dias',
    'period.last15': 'Últimos 15 dias',
    'period.last30': 'Últimos 30 dias',
    'btn.newTask': '+ Nova tarefa',

    'col.task': 'Tarefa',
    'col.notes': 'Observação',
    'col.priority': 'Prioridade',
    'col.due': 'Prazo',
    'col.reminder': 'Lembrete',
    'col.assignee': 'Responsável',
    'col.status': 'Status',
    'yes': 'Sim',
    'no': 'Não',
    'days.short': '{n} d',

    'status.not_started': 'Não iniciado',
    'status.in_progress': 'Em andamento',
    'status.overdue': 'Atrasado',
    'status.done': 'Concluído',
    'situation.in_progress': 'Em andamento',
    'situation.waiting_others': 'Depende de outros',
    'situation.stopped': 'Parado',
    'situation.other': 'Outros',

    'action.resume': 'Retomar',
    'action.pause': 'Marcar como Parado',
    'action.addSub': 'Nova subtarefa',
    'action.edit': 'Editar',
    'action.delete': 'Excluir',
    'action.toggle': 'Expandir/recolher',
    'action.close': 'Fechar',

    'empty.filtered': 'Nenhuma tarefa corresponde aos filtros.',
    'empty.history': 'Nenhuma tarefa concluída ainda.',
    'empty.main': 'Nenhuma tarefa aberta. Crie a primeira!',

    'form.editTitle': 'Editar tarefa',
    'form.newTitle': 'Nova tarefa',
    'form.newSubTitle': 'Nova subtarefa',
    'form.inside': 'Dentro de: {path}',
    'form.task': 'Tarefa',
    'form.notes': 'Observação',
    'form.due': 'Prazo',
    'form.reminder': 'Lembrete (dias antes do prazo)',
    'form.assignee': 'Responsável (e-mail)',
    'form.priority': 'Prioridade',
    'btn.cancel': 'Cancelar',
    'btn.save': 'Salvar',
    'btn.confirm': 'Confirmar',
    'btn.ok': 'Ok',

    'delete.withChildren': 'Excluir "{title}" e TODAS as suas {n} subtarefa(s)?\n\nEssa ação não pode ser desfeita.',
    'delete.single': 'Excluir "{title}"?\n\nEssa ação não pode ser desfeita.',

    'pause.title': 'Marcar como Parado',
    'pause.text': '<strong>{title}</strong> e todas as subtarefas ficarão pausadas: sem lembretes, sem verificação de atraso e sem avisos de inatividade até você retomar.',
    'pause.reason': 'Motivo da paralisação',
    'pause.submit': 'Pausar',

    'resume.title': 'Retomar tarefa',
    'resume.current': 'Prazo atual: {due} · Status atual: {status}',
    'resume.reason': ' · Motivo da pausa: {reason}',
    'resume.hint': 'Revise prazos e status. Nada é ajustado automaticamente pelo tempo parado.',
    'resume.expired': 'Prazo venceu durante a pausa',
    'resume.wasInProgress': 'Estava em andamento',
    'resume.submit': 'Confirmar retomada',
    'noDue': 'sem prazo',

    'overdue.title': 'Tarefa atrasada',
    'overdue.text': '<strong>{title}</strong> venceu em {date}.',
    'overdue.choose': 'Escolha como resolver:',
    'overdue.extend': 'Prorrogar o prazo',
    'overdue.plan': 'Criar plano de ação (subtarefa)',
    'overdue.newDue': 'Novo prazo',
    'overdue.extendSubmit': 'Prorrogar',
    'overdue.planTask': 'Subtarefa do plano de ação',
    'overdue.planHint': 'A tarefa continua "Atrasado" até as subtarefas do plano serem concluídas.',
    'overdue.planSubmit': 'Criar plano',

    'inact.title': 'Tarefa sem atividade há mais de 7 dias',
    'inact.header': '<strong>{title}</strong> · Prazo: {due}',
    'inact.subtask': 'Subtarefa',
    'inact.noSubtasks': 'Sem subtarefas.',
    'inact.question': 'Qual é a situação? (obrigatório)',
    'inact.reason': 'Motivo',
    'inact.reasonOther': 'Justificativa (obrigatória)',
    'inact.reasonWaiting': 'De quem/do que depende',
    'inact.optional': 'Opcional',
    'inact.changeDue': 'Alterar prazo',
    'inact.createPlan': 'Criar subtarefa (plano de ação)',
    'inact.planPlaceholder': 'Deixe em branco para não criar',
    'inact.planDue': 'Prazo da subtarefa',

    'rem.title': 'Lembrete',
    'rem.today': 'vence <strong>hoje</strong>',
    'rem.tomorrow': 'vence <strong>amanhã</strong>',
    'rem.inDays': 'vence em <strong>{n} dias</strong>',
    'rem.assignee': 'Responsável: {email}',

    'err.generic': 'Algo deu errado',
    'err.openChildren': 'Não é possível concluir: esta tarefa ainda tem subtarefas abertas.',
    'err.cycle': 'Hierarquia inválida: a tarefa não pode ser descendente de si mesma.',
    'err.extendPast': 'O novo prazo precisa ser hoje ou uma data futura.',
    'err.planPast': 'O plano de ação precisa ter um prazo de hoje em diante.',
    'err.otherReason': 'Informe a justificativa para "Outros".',
    'err.notStopped': 'Esta tarefa não está parada.',
    'err.notInTree': 'Uma das tarefas não pertence à árvore retomada.',
    'err.auth': 'Sessão expirada. Entre novamente.',
    'err.email': 'E-mail do responsável inválido.',
    'err.title': 'O nome da tarefa não pode ficar vazio.',
    'err.reminder': 'O lembrete não pode ser negativo.',
  },

  en: {
    'app.subtitle': 'Task planner',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'login.error': 'Invalid email or password.',
    'top.tasks': 'Tasks',
    'top.history': 'History',
    'top.logout': 'Sign out',
    'top.language': 'Language',

    'filter.priority': 'Priority',
    'filter.due': 'Due date',
    'filter.completed': 'Completed',
    'filter.assignee': 'Assignee',
    'filter.clear': 'Clear filters',
    'filter.all': 'All',
    'filter.yes': 'Yes',
    'filter.no': 'No',
    'filter.everyone': 'Everyone',
    'filter.noAssignee': 'Unassigned',
    'period.all': 'All',
    'period.next7': 'Next 7 days',
    'period.next15': 'Next 15 days',
    'period.next30': 'Next 30 days',
    'period.none': 'No due date',
    'period.last7': 'Last 7 days',
    'period.last15': 'Last 15 days',
    'period.last30': 'Last 30 days',
    'btn.newTask': '+ New task',

    'col.task': 'Task',
    'col.notes': 'Notes',
    'col.priority': 'Priority',
    'col.due': 'Due date',
    'col.reminder': 'Reminder',
    'col.assignee': 'Assignee',
    'col.status': 'Status',
    'yes': 'Yes',
    'no': 'No',
    'days.short': '{n} d',

    'status.not_started': 'Not started',
    'status.in_progress': 'In progress',
    'status.overdue': 'Overdue',
    'status.done': 'Done',
    'situation.in_progress': 'In progress',
    'situation.waiting_others': 'Waiting on others',
    'situation.stopped': 'Stopped',
    'situation.other': 'Other',

    'action.resume': 'Resume',
    'action.pause': 'Mark as Stopped',
    'action.addSub': 'New subtask',
    'action.edit': 'Edit',
    'action.delete': 'Delete',
    'action.toggle': 'Expand/collapse',
    'action.close': 'Close',

    'empty.filtered': 'No tasks match the filters.',
    'empty.history': 'No completed tasks yet.',
    'empty.main': 'No open tasks. Create the first one!',

    'form.editTitle': 'Edit task',
    'form.newTitle': 'New task',
    'form.newSubTitle': 'New subtask',
    'form.inside': 'Inside: {path}',
    'form.task': 'Task',
    'form.notes': 'Notes',
    'form.due': 'Due date',
    'form.reminder': 'Reminder (days before due date)',
    'form.assignee': 'Assignee (email)',
    'form.priority': 'Priority',
    'btn.cancel': 'Cancel',
    'btn.save': 'Save',
    'btn.confirm': 'Confirm',
    'btn.ok': 'OK',

    'delete.withChildren': 'Delete "{title}" and ALL of its {n} subtask(s)?\n\nThis cannot be undone.',
    'delete.single': 'Delete "{title}"?\n\nThis cannot be undone.',

    'pause.title': 'Mark as Stopped',
    'pause.text': '<strong>{title}</strong> and all its subtasks will be paused: no reminders, no overdue checks and no inactivity prompts until you resume.',
    'pause.reason': 'Reason for stopping',
    'pause.submit': 'Pause',

    'resume.title': 'Resume task',
    'resume.current': 'Current due date: {due} · Current status: {status}',
    'resume.reason': ' · Reason for pause: {reason}',
    'resume.hint': 'Review due dates and statuses. Nothing is adjusted automatically for the time stopped.',
    'resume.expired': 'Due date passed during the pause',
    'resume.wasInProgress': 'Was in progress',
    'resume.submit': 'Confirm resume',
    'noDue': 'no due date',

    'overdue.title': 'Task overdue',
    'overdue.text': '<strong>{title}</strong> was due on {date}.',
    'overdue.choose': 'Choose how to resolve it:',
    'overdue.extend': 'Extend the due date',
    'overdue.plan': 'Create an action plan (subtask)',
    'overdue.newDue': 'New due date',
    'overdue.extendSubmit': 'Extend',
    'overdue.planTask': 'Action plan subtask',
    'overdue.planHint': 'The task stays "Overdue" until the action plan subtasks are done.',
    'overdue.planSubmit': 'Create plan',

    'inact.title': 'Task inactive for more than 7 days',
    'inact.header': '<strong>{title}</strong> · Due: {due}',
    'inact.subtask': 'Subtask',
    'inact.noSubtasks': 'No subtasks.',
    'inact.question': 'What is the situation? (required)',
    'inact.reason': 'Reason',
    'inact.reasonOther': 'Justification (required)',
    'inact.reasonWaiting': 'Waiting on whom/what',
    'inact.optional': 'Optional',
    'inact.changeDue': 'Change due date',
    'inact.createPlan': 'Create subtask (action plan)',
    'inact.planPlaceholder': 'Leave blank to skip',
    'inact.planDue': 'Subtask due date',

    'rem.title': 'Reminder',
    'rem.today': 'is due <strong>today</strong>',
    'rem.tomorrow': 'is due <strong>tomorrow</strong>',
    'rem.inDays': 'is due in <strong>{n} days</strong>',
    'rem.assignee': 'Assignee: {email}',

    'err.generic': 'Something went wrong',
    'err.openChildren': 'Cannot complete: this task still has open subtasks.',
    'err.cycle': 'Invalid hierarchy: a task cannot be its own descendant.',
    'err.extendPast': 'The new due date must be today or later.',
    'err.planPast': 'The action plan must have a due date from today onwards.',
    'err.otherReason': 'Please provide a justification for "Other".',
    'err.notStopped': 'This task is not stopped.',
    'err.notInTree': 'One of the tasks does not belong to the resumed tree.',
    'err.auth': 'Session expired. Please sign in again.',
    'err.email': 'Invalid assignee email.',
    'err.title': 'The task name cannot be empty.',
    'err.reminder': 'The reminder cannot be negative.',
  },
};

export const LANGS = { pt: 'Português', en: 'English' };
const LOCALE = { pt: 'pt-BR', en: 'en-US' };
const STORAGE_KEY = 'cajuca.lang';

function initialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved in DICT) return saved;
  } catch { /* navegador sem storage: segue o idioma do sistema */ }
  return (navigator.language || 'pt').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

let lang = initialLang();

export function getLang() { return lang; }

export function setLang(next) {
  if (!(next in DICT)) return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignora */ }
  document.documentElement.lang = LOCALE[lang];
}

export function t(key, vars = {}) {
  const text = DICT[lang][key] ?? DICT.pt[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// Datas 'YYYY-MM-DD' no formato do idioma (pt: 08/10/2026, en: 10/08/2026)
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

// Textos estáticos do HTML: data-i18n (texto), data-i18n-title, data-i18n-aria
export function applyStatic(root = document) {
  document.documentElement.lang = LOCALE[lang];
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}

// Mensagens do banco (escritas em português no schema.sql) -> chave traduzida
const DB_ERRORS = [
  [/subtarefas abertas/i, 'err.openChildren'],
  [/Hierarquia inválida/i, 'err.cycle'],
  [/novo prazo precisa/i, 'err.extendPast'],
  [/plano de ação precisa/i, 'err.planPast'],
  [/justificativa para "Outros"/i, 'err.otherReason'],
  [/não está parada/i, 'err.notStopped'],
  [/não pertence à árvore/i, 'err.notInTree'],
  [/Não autenticado|JWT expired/i, 'err.auth'],
  [/assignee_email_check/i, 'err.email'],
  [/title_check/i, 'err.title'],
  [/reminder_days_check/i, 'err.reminder'],
];

export function translateError(message) {
  if (!message) return t('err.generic');
  const hit = DB_ERRORS.find(([re]) => re.test(message));
  return hit ? t(hit[1]) : message;
}
