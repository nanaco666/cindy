const state = {
  step: 1,
  protocol: 'anthropic',
  selected: new Set(['claude-code', 'pi']),
  providerName: 'Nebula Gateway',
  target: null,
  overrides: {},
};

const compatibility = {
  anthropic: {
    'claude-code': { ok: true, reason: '接受 Anthropic Messages' },
    codex: { ok: false, reason: 'Codex 需要 OpenAI Responses' },
    pi: { ok: true, reason: '接受 Anthropic Messages' },
  },
  openai: {
    'claude-code': { ok: false, reason: 'Claude Code 需要 Anthropic Messages' },
    codex: { ok: true, reason: '接受 OpenAI Responses' },
    pi: { ok: false, reason: 'Pi manifest 未声明 OpenAI Responses' },
  },
};

const labels = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' };
const protocolLabels = { anthropic: 'Anthropic Messages', openai: 'OpenAI Responses' };
const fields = {
  baseUrl: () => document.querySelector('#base-url').value,
  path: () => document.querySelector('#request-path').value,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 2600);
}

function renderSteps() {
  $$('.step').forEach((step, index) => {
    step.classList.toggle('current', index + 1 === state.step);
    step.classList.toggle('done', index + 1 < state.step);
  });
  $$('.step-panel').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== ['scope', 'source', 'review'][state.step - 1]));
  $('#back-step').classList.toggle('hidden', state.step === 1);
  $('#primary-action').textContent = state.step === 1 ? '继续配置' : state.step === 2 ? '查看确认' : `创建 ${state.selected.size} 个连接`;
  $('#source-target-count').textContent = String(state.selected.size);
  renderReview();
}

function renderCompatibility() {
  const map = compatibility[state.protocol];
  $$('.harness-card').forEach((card) => {
    const harness = card.dataset.harness;
    const result = map[harness];
    card.disabled = !result.ok;
    card.classList.toggle('selected', result.ok && state.selected.has(harness));
    card.setAttribute('aria-pressed', String(result.ok && state.selected.has(harness)));
    card.querySelector('.compatibility').textContent = result.ok ? '兼容' : '协议不兼容';
    card.querySelector('.compatibility').className = `compatibility ${result.ok ? 'compatible' : 'blocked'}`;
  });
  $('#selection-count').textContent = `${state.selected.size} 个已选择`;
  $('#protocol-help').textContent = state.protocol === 'anthropic'
    ? 'Claude Code 与 Pi 当前接受 Anthropic Messages 配置。'
    : 'Codex 当前接受 OpenAI Responses 配置；其他 Harness 将被锁定。';
}

function renderSnapshots() {
  const list = $('#snapshot-list');
  const selected = [...state.selected];
  list.innerHTML = selected.map((harness) => {
    const isOverride = Boolean(state.overrides[harness]);
    const suffix = isOverride ? ' · 有单独覆盖' : '';
    return `<article class="snapshot-card selected ${isOverride ? 'override' : ''}" data-snapshot="${harness}">
      <div class="snapshot-main"><span class="harness-icon ${harness === 'claude-code' ? 'claude' : harness}">${harness === 'claude-code' ? 'C' : harness === 'codex' ? '✦' : 'π'}</span><div><strong>${labels[harness]}</strong><span>${protocolLabels[state.protocol]}</span></div><span class="snapshot-state">将创建</span></div>
      <div class="snapshot-meta"><span>${fields.baseUrl()} · ${fields.path()}</span><span>2 个模型 · key 独立${suffix}</span></div>
      <button class="snapshot-edit" type="button" data-edit-snapshot="${harness}">${isOverride ? '继续编辑此覆盖' : '编辑此副本'}</button>
    </article>`;
  }).join('');
  $$('.snapshot-edit').forEach((button) => button.addEventListener('click', () => {
    state.target = button.dataset.editSnapshot;
    $('#override-title').textContent = `正在编辑 ${labels[state.target]} 副本`;
    $('#override-copy').textContent = '这里的修改只会写入当前 runtime；来源配置仍保持不变。';
    showToast(`已切换到 ${labels[state.target]} 的独立配置视图`);
  }));
}

function renderReview() {
  const review = $('#review-table');
  if (!review) return;
  review.innerHTML = `<div class="review-row header"><span>Harness</span><span>协议</span><span>保存形态</span></div>${[...state.selected].map((harness) => `<div class="review-row"><div class="review-runtime"><span class="harness-icon ${harness === 'claude-code' ? 'claude' : harness}">${harness === 'claude-code' ? 'C' : harness === 'codex' ? '✦' : 'π'}</span><div><strong>${labels[harness]}</strong><small>${state.overrides[harness] ? '包含单独覆盖' : '来自来源配置'}</small></div></div><div class="review-value">${protocolLabels[state.protocol]}</div><span class="review-independent">独立配置 + 独立密钥</span></div>`).join('')}`;
}

function setProtocol(protocol) {
  state.protocol = protocol;
  const map = compatibility[protocol];
  for (const harness of [...state.selected]) if (!map[harness].ok) state.selected.delete(harness);
  $$('.segment').forEach((button) => {
    const selected = button.dataset.protocol === protocol;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  renderCompatibility();
  renderSnapshots();
  showToast(protocol === 'anthropic' ? '已切换到 Anthropic Messages' : '已切换到 OpenAI Responses；不兼容 Harness 已锁定');
}

function addModel() {
  const name = window.prompt('输入模型 ID', 'nebula-3.2-pro');
  if (!name) return;
  const chip = document.createElement('span');
  chip.className = 'model-chip';
  chip.innerHTML = `<span>${name}</span><button type="button" aria-label="移除模型">×</button>`;
  chip.querySelector('button').addEventListener('click', () => chip.remove());
  $('#model-list').insertBefore(chip, $('#add-model'));
}

function addHeader() {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = '<input class="text-input mono" placeholder="Header name" aria-label="请求头名称" /><input class="text-input mono" placeholder="Header value" aria-label="请求头值" /><button class="field-icon" type="button" aria-label="移除请求头">×</button>';
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('#add-header').before(row);
}

function goNext() {
  if (state.step === 1) {
    const name = $('#provider-name').value.trim();
    if (!name) return showToast('请先填写供应商名称');
    if (state.selected.size === 0) return showToast('至少选择一个兼容 Harness');
    state.providerName = name;
    state.step = 2;
  } else if (state.step === 2) {
    state.step = 3;
  } else {
    const callout = $('#rollback-callout');
    if (!callout.hidden) {
      callout.hidden = true;
      showToast('已准备好再次保存');
      return;
    }
    showToast(`已创建 ${state.selected.size} 个独立连接`);
    $('.draft-pill').innerHTML = '<span class="draft-dot"></span> 已保存';
    $('#primary-action').textContent = '完成';
  }
  renderSteps();
  if (state.step === 2) renderSnapshots();
}

function goBack() {
  if (state.step === 1) return;
  state.step -= 1;
  renderSteps();
}

function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('screen') === 'review') state.step = 3;
  if (params.get('theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark';
    $('#theme-label').textContent = 'Light';
  }
  if (params.get('protocol') === 'openai') {
    state.protocol = 'openai';
    state.selected = new Set(['codex']);
    $$('.segment').forEach((button) => { button.classList.toggle('selected', button.dataset.protocol === 'openai'); });
  }
  $('#theme-toggle').addEventListener('click', () => {
    const html = document.documentElement;
    const dark = html.dataset.theme !== 'dark';
    html.dataset.theme = dark ? 'dark' : 'light';
    $('#theme-label').textContent = dark ? 'Light' : 'Dark';
  });
  $$('.segment').forEach((button) => button.addEventListener('click', () => setProtocol(button.dataset.protocol)));
  $$('.harness-card').forEach((card) => card.addEventListener('click', () => {
    if (card.disabled) return;
    const harness = card.dataset.harness;
    if (state.selected.has(harness)) {
      if (state.selected.size === 1) return showToast('至少保留一个 Harness');
      state.selected.delete(harness);
    } else state.selected.add(harness);
    renderCompatibility();
    renderSnapshots();
  }));
  $('#primary-action').addEventListener('click', goNext);
  $('#back-step').addEventListener('click', goBack);
  $('#secondary-action').addEventListener('click', () => showToast('已保留在当前页面，尚未写入配置'));
  $('#add-model').addEventListener('click', addModel);
  $('#add-header').addEventListener('click', addHeader);
  $('#fetch-models').addEventListener('click', () => showToast('模型列表已更新；请在弹层中确认选择'));
  $('#test-connection').addEventListener('click', () => {
    $('#test-result').hidden = false;
    showToast('已完成最小探测请求');
  });
  $('#reveal-key').addEventListener('click', () => {
    const input = $('#api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $$('.model-chip button').forEach((button) => button.addEventListener('click', () => button.closest('.model-chip').remove()));
  $('#simulate-failure').addEventListener('click', () => {
    $('#rollback-callout').hidden = false;
    showToast('Pi 保存失败，已回滚全部 runtime');
  });
  if (params.get('failure') === '1') $('#rollback-callout').hidden = false;
  renderCompatibility();
  renderSnapshots();
  renderSteps();
}

init();
