/* ===== AWS 자격증 학습 앱 ===== */
(function () {
'use strict';

const DATA = window.QUIZ_DATA || { questions: [], concepts: [], categories: [] };
const LS = {
  get wrong() { try { return JSON.parse(localStorage.getItem('aws_wrong') || '[]'); } catch { return []; } },
  set wrong(v) { localStorage.setItem('aws_wrong', JSON.stringify([...new Set(v)])); },
  get theme() { return localStorage.getItem('aws_theme') || 'dark'; },
  set theme(v) { localStorage.setItem('aws_theme', v); },
  get notes() { return localStorage.getItem('aws_notes') || ''; },
  set notes(v) { localStorage.setItem('aws_notes', v); },
  get dockW() { return localStorage.getItem('aws_dockw') || ''; },
  set dockW(v) { localStorage.setItem('aws_dockw', v); },
  get cp() { try { return JSON.parse(localStorage.getItem('aws_cp') || '{}'); } catch { return {}; } },
  set cp(v) { localStorage.setItem('aws_cp', JSON.stringify(v)); },
};

/* ---------- 체크포인트 ---------- */
const CPS = DATA.checkpoints || [];
const cpKey = (exam, cat, idx) => exam + '|' + cat + '|' + idx;
const findCP = (exam, cat, idx) => CPS.find(c => c.exam === exam && c.category === cat && c.idx === idx);
function cpStat(exam, cat) {
  const st = LS.cp, list = CPS.filter(c => c.exam === exam && c.category === cat);
  const done = list.filter(c => { const r = st[cpKey(exam, cat, c.idx)]; return r && r.correct >= c.pass; }).length;
  return { total: list.length, done };
}

/* ---------- 유틸 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; };
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decodeEnt = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const examClass = e => e.startsWith('SAP') ? 'sap' : e.startsWith('SAA') ? 'saa' : e.startsWith('AIP') ? 'aip' : 'dop';
const shortCat = c => c.replace(/^\d+\s*-\s*/, '');

/* ---------- 마크다운 렌더 ---------- */
const CALLOUT_LABEL = { tip: '💡 TIP', hint: '💡 HINT', warning: '⚠️ 주의', caution: '⚠️ 주의', example: '📝 예시', success: '✅ 정답', note: 'ℹ️ 노트', info: 'ℹ️ 정보', danger: '🚫 위험', error: '🚫 오류' };

if (window.marked) marked.setOptions({ breaks: false, gfm: true });
if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose', flowchart: { htmlLabels: true } });

function renderCallouts(md) {
  const lines = md.split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const m = lines[i].match(/^>\s?\[!(\w+)\]([+-]?)\s*(.*)$/);
    if (m) {
      const type = m[1].toLowerCase();
      const title = (m[3] && m[3].trim()) || CALLOUT_LABEL[type] || type.toUpperCase();
      const body = []; i++;
      while (i < lines.length && /^>/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      const bodyHtml = marked.parse(body.join('\n'));
      out.push(`\n\n<div class="callout cl-${type}"><div class="cl-title">${escapeHtml(title)}</div><div class="cl-body">${bodyHtml}</div></div>\n\n`);
    } else { out.push(lines[i]); i++; }
  }
  return out.join('\n');
}
function renderWikilinks(md) {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, t, l) => wl(t, l))
    .replace(/\[\[([^\]]+)\]\]/g, (_, t) => wl(t, t));
}
function wl(target, label) {
  const ci = DATA.concepts.findIndex(c => target.includes(c.domain) || ('00 - 개념집 · ' + c.domain) === target);
  if (ci >= 0) return `<a class="wikilink" onclick="App.openConceptDock(${ci},null,false)">${escapeHtml(label)}</a>`;
  return `<span class="wikilink" style="cursor:default;border:none;color:var(--muted)">${escapeHtml(label)}</span>`;
}
function renderMD(md, { callouts = true } = {}) {
  let src = md.replace(/\.\.\/문제집\/SAA-C03\/_attachments\//g, 'assets/');
  if (callouts) src = renderCallouts(src);
  src = renderWikilinks(src);
  let html = marked.parse(src);
  // mermaid 코드블록 → div.mermaid
  html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<div class="mermaid">${decodeEnt(code)}</div>`);
  return html;
}
function runMermaid(container) {
  if (!window.mermaid) return;
  const nodes = $$('.mermaid', container).filter(n => !n.dataset.done);
  nodes.forEach(n => n.dataset.done = '1');
  if (nodes.length) { try { mermaid.run({ nodes }); } catch (e) { console.warn('mermaid', e); } }
}

/* ---------- 뷰 전환 ---------- */
function show(view) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  window.scrollTo(0, 0);
}

/* ---------- 홈 ---------- */
const EXAM_META = [
  { code: 'SAP-C02', emoji: '🏛️' },
  { code: 'SAA-C03', emoji: '☁️' },
  { code: 'DOP-C02', emoji: '⚙️' },
  { code: 'AIP-C01', emoji: '🤖' },
];

function renderHome() {
  $('#homeStat').textContent =
    `${DATA.questions.length}문항 · 개념집 ${DATA.concepts.length}개 · ${DATA.categories.length}개 카테고리`;
  const activeExam = ProgressStore.value.selectedExam || 'SAP-C02';
  const stats = ProgressStore.summary(activeExam);
  const next = ProgressStore.nextCheckpoint(CPS, activeExam);
  $('#examSelect').value = activeExam;
  $('#progressSummary').textContent = `${activeExam} · ${stats.attempts}회 풀이 · 정답률 ${stats.rate == null ? '기록 없음' : stats.rate + '%'} · 복습할 오답 ${stats.wrong}개`;
  $('#todayLine').textContent = next ? `오늘의 범위 · ${shortCat(next.category)} · 체크포인트 ${next.idx}/${next.total}` : '';
  $('#migrationHint').hidden = stats.attempts > 0;

  // 자격증별 오답 카운트
  const wrongIds = new Set(LS.wrong);
  const wrongQs = DATA.questions.filter(q => wrongIds.has(q.id));
  const byExam = {};
  wrongQs.forEach(q => { byExam[q.exam] = (byExam[q.exam] || 0) + 1; });
  const examsPresent = EXAM_META.filter(e => DATA.questions.some(q => q.exam === e.code));
  const wrongBtn = (emoji, label, count, onclick) => `
    <div class="big-btn${count ? '' : ' disabled'}" ${count ? `onclick="${onclick}"` : ''}>
      <div class="emoji">${emoji}</div>
      <div><b>${label}</b><small>틀린 문제 ${count}개</small></div>
    </div>`;
  $('#wrongRow').innerHTML =
    wrongBtn('🔁', '전체 오답', wrongQs.length, 'App.startWrong()') +
    examsPresent.map(e => wrongBtn(e.emoji, e.code + ' 오답', byExam[e.code] || 0, `App.startWrong('${e.code}')`)).join('');

  // 카테고리 카드
  $('#catGrid').innerHTML = DATA.categories.map(c => `
    <div class="cat-card" onclick="App.startRandom(null,0,'${c.exam}','${c.category.replace(/'/g, "\\'")}')">
      <span class="badge ${examClass(c.exam)}">${c.exam}</span>
      <h3>${escapeHtml(shortCat(c.category))}</h3>
      <div class="meta">${c.count}문항${(() => { const s = cpStat(c.exam, c.category); return s.total ? ` · 🎯 ${s.done}/${s.total}` : ''; })()}</div>
      <div class="bar"><i style="width:${Math.min(100, c.count / 2.2)}%"></i></div>
    </div>`).join('');

  // 개념집 카드
  $('#conceptGrid').innerHTML = DATA.concepts.map((c, i) => `
    <div class="cat-card" onclick="App.openConcept(${i})">
      <span class="badge ${examClass(c.exam)}">${c.exam}</span>
      <h3>📘 ${escapeHtml(c.domain)}</h3>
      <div class="meta">${(() => { const s = cpStat(c.exam, c.category); return s.total ? `🎯 체크포인트 ${s.done}/${s.total} 통과` : '개념 통독 · 비교표 · 함정'; })()}</div>
    </div>`).join('');
}

/* ---------- 퀴즈 ---------- */
const Q = { list: [], idx: 0, score: 0, answered: [], picked: new Set(), scopeLabel: '', startTime: 0, questionStart: 0, timerId: null, elapsed: 0, cpKey: null };

/* ---------- 경과 시간 타이머 ---------- */
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
function tickTimer() {
  const el = $('#timeText');
  if (el) el.textContent = '⏱ ' + fmtDur(performance.now() - Q.startTime);
}
function startTimer() {
  stopTimer();
  Q.startTime = performance.now();
  tickTimer();
  Q.timerId = setInterval(tickTimer, 1000);
}
function stopTimer() {
  if (Q.timerId) { clearInterval(Q.timerId); Q.timerId = null; }
}

function startQuiz(list, label) {
  if (!list.length) { alert('해당 범위에 문제가 없습니다.'); return; }
  Q.list = list; Q.idx = 0; Q.score = 0; Q.answered = new Array(list.length).fill(null);
  Q.scopeLabel = label || ''; Q.cpKey = null;
  show('quiz');
  $('#quizScope').textContent = label || '범위';
  startTimer();
  renderQuestion();
}
function renderQuestion() {
  const q = Q.list[Q.idx];
  Q.questionStart = performance.now();
  Q.picked = new Set();
  const already = Q.answered[Q.idx];
  const multi = q.answer.length > 1;
  const keys = Object.keys(q.choices);

  $('#progBar').style.width = ((Q.idx) / Q.list.length * 100) + '%';
  $('#progText').textContent = `${Q.idx + 1} / ${Q.list.length}`;
  $('#scoreText').textContent = `정답 ${Q.score}`;

  $('#quizContent').innerHTML = `
    <div class="qcard">
      <div class="qhead">
        <span class="tag">${q.exam}</span>
        <span class="tag">${escapeHtml(shortCat(q.category))}</span>
        <span class="tag">${q.num}</span>
      </div>
      <div class="qtitle">${escapeHtml(q.title)}</div>
      <div class="qbody md">${renderMD(q.body, { callouts: false })}</div>
      ${multi ? `<span class="multi-hint">복수 정답 · ${q.answer.length}개 선택</span>` : ''}
      <ul class="choices" id="choices">
        ${keys.map(k => `
          <li class="choice" data-k="${k}" onclick="App.pick('${k}',${multi})">
            <span class="key">${k}</span>
            <span class="ctext md">${renderMD(q.choices[k], { callouts: false })}</span>
          </li>`).join('')}
      </ul>
      <div class="actions">
        <button class="btn btn-ghost" onclick="App.prev()" ${Q.idx === 0 ? 'disabled' : ''}>← 이전</button>
        <button class="btn btn-primary" id="submitBtn" onclick="App.submit()">정답 확인</button>
        <button class="btn btn-ghost" id="nextBtn" onclick="App.next()" style="margin-left:auto;display:none">
          ${Q.idx === Q.list.length - 1 ? '결과 보기 →' : '다음 →'}</button>
      </div>
      <div class="answer-box" id="answerBox"></div>
    </div>`;
  $$('#choices .ctext p').forEach(p => { p.style.margin = '0'; });
  if (already) restoreAnswered(already);
}
function restoreAnswered(rec) {
  rec.picked.forEach(k => Q.picked.add(k));
  gradeUI(rec.picked);
  $('#submitBtn').style.display = 'none';
  $('#nextBtn').style.display = 'inline-block';
}
function gradeUI(picked) {
  const q = Q.list[Q.idx];
  $$('#choices .choice').forEach(li => {
    const k = li.dataset.k;
    li.classList.add('disabled'); li.onclick = null;
    const isAns = q.answer.includes(k), isPicked = picked.includes(k);
    if (isAns) { li.classList.add('correct'); li.querySelector('.mark') || li.insertAdjacentHTML('beforeend', '<span class="mark" style="color:var(--ok)">✓</span>'); }
    if (isPicked && !isAns) { li.classList.add('wrong'); li.insertAdjacentHTML('beforeend', '<span class="mark" style="color:var(--bad)">✗</span>'); }
  });
  const correct = q.answer.length === picked.length && q.answer.every(a => picked.includes(a));
  const box = $('#answerBox');
  box.innerHTML = `
    <div class="verdict ${correct ? 'ok' : 'bad'}">${correct ? '✅ 정답입니다' : '❌ 오답 — 정답: ' + q.answer.join(', ')}</div>
    ${q.vote ? `<div class="vote">커뮤니티 득표: ${escapeHtml(q.vote)}</div>` : ''}
    <div class="md">${renderMD(q.explanation)}</div>`;
  box.classList.add('show');
  runMermaid(box);
  return correct;
}

/* ---------- 개념 ---------- */
function openConcept(i, anchorText, readingMarkdown, todayCheckpoint) {
  const c = DATA.concepts[i];
  show('concept');
  $('#todayNotice').hidden = true;
  const html = renderMD(readingMarkdown || c.markdown);
  $('#conceptContent').innerHTML = html;
  // TOC
  const heads = $$('#conceptContent h2, #conceptContent h3');
  heads.forEach((h, idx) => h.id = 'h_' + idx);
  $('#conceptToc').innerHTML = '<b>목차</b>' + heads.map((h, idx) =>
    `<a onclick="document.getElementById('h_${idx}').scrollIntoView({behavior:'smooth'})"
        style="${h.tagName === 'H3' ? 'padding-left:12px;font-size:12.5px' : ''}">${escapeHtml(h.textContent)}</a>`).join('');
  decorateCheckpoints($('#conceptContent'), c);
  if (todayCheckpoint) {
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = `개념을 읽었어요 · 체크포인트 ${todayCheckpoint.idx} 풀기`;
    button.onclick = () => App.startCheckpoint(todayCheckpoint.exam, todayCheckpoint.category, todayCheckpoint.idx);
    $('#conceptContent').appendChild(button);
  }
  runMermaid($('#conceptContent'));
  if (anchorText) {
    const target = heads.find(h => h.textContent.includes(anchorText));
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth' }), 60);
  }
}

function decorateCheckpoints(root, c) {
  $$('.callout.cl-todo', root).forEach(el => {
    const t = el.querySelector('.cl-title');
    if (!t || t.textContent.indexOf('체크포인트') < 0) return;
    const m = t.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return;
    const idx = +m[1], cp = findCP(c.exam, c.category, idx);
    if (!cp) return;
    const rec = LS.cp[cpKey(c.exam, c.category, idx)];
    const wrap = document.createElement('div');
    wrap.className = 'cp-actions';
    if (cp.nums.length) {
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = `▶ 이 체크포인트 문제 ${cp.nums.length}개 풀기`;
      b.onclick = () => App.startCheckpoint(c.exam, c.category, idx);
      wrap.appendChild(b);
    } else {
      const sp = document.createElement('span');
      sp.className = 'cp-score';
      sp.textContent = '이 구간 전용 문항 없음 — 다음 체크포인트에서 함께 확인';
      wrap.appendChild(sp);
    }
    if (rec) {
      const sp = document.createElement('span');
      const passed = rec.correct >= cp.pass;
      sp.className = 'cp-score ' + (passed ? 'ok' : 'bad');
      sp.textContent = `${passed ? '✅ 통과' : '❌ 미달'} · 최고 점수 ${rec.correct}/${rec.total || cp.nums.length} (합격선 ${cp.pass})`;
      wrap.appendChild(sp);
    }
    el.querySelector('.cl-body').appendChild(wrap);
  });
}

/* ---------- 우측 도크 (메모 + 개념) ---------- */
function toggleDock(open) {
  const d = $('#dock');
  const willOpen = (open === undefined) ? !d.classList.contains('open') : !!open;
  d.classList.toggle('open', willOpen);
  d.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
  document.body.classList.toggle('dock-open', willOpen);
  $('#dockBtn').classList.toggle('on', willOpen);
}
function dockTab(name) {
  $$('.dock-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $('#dockNotes').classList.toggle('active', name === 'notes');
  $('#dockConcept').classList.toggle('active', name === 'concept');
}
function openConceptDock(i, anchor, fromSearch) {
  const c = DATA.concepts[i];
  const back = (fromSearch !== false && lastSearch)
    ? `<div class="dock-back" onclick="App.doSearch(${JSON.stringify(lastSearch).replace(/"/g, '&quot;')})">← "${escapeHtml(lastSearch)}" 검색 결과</div>` : '';
  $('#dockConceptContent').innerHTML = back +
    `<div class="dock-doc-title"><span class="badge ${examClass(c.exam)}">${c.exam}</span>📘 ${escapeHtml(c.domain)}</div>` +
    renderMD(c.markdown);
  runMermaid($('#dockConceptContent'));
  toggleDock(true); dockTab('concept');
  $('#dockConcept').scrollTop = 0;
  if (anchor) {
    const heads = $$('#dockConceptContent h2, #dockConceptContent h3');
    const target = heads.find(h => h.textContent.includes(anchor));
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }
}

/* ---------- 검색 (도크에 표시 — 메인 화면 유지) ---------- */
let lastSearch = '';
function doSearch(term) {
  term = term.trim();
  if (term.length < 2) return;
  lastSearch = term;
  const low = term.toLowerCase();
  const rx = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');

  // 개념집 섹션 검색
  const conceptHits = [];
  DATA.concepts.forEach((c, ci) => {
    const secs = c.markdown.split(/\n(?=## )/);
    secs.forEach(sec => {
      if (sec.toLowerCase().includes(low)) {
        const head = (sec.match(/^#{2,3}\s*(.+)/) || [, c.domain])[1].replace(/[#*]/g, '').trim();
        const plain = sec.replace(/[#>*`\[\]|]/g, ' ').replace(/\s+/g, ' ');
        const at = plain.toLowerCase().indexOf(low);
        const snip = plain.slice(Math.max(0, at - 40), at + 120);
        conceptHits.push({ ci, domain: c.domain, exam: c.exam, head, snip });
      }
    });
  });

  // 문제 검색
  const qHits = DATA.questions.filter(q =>
    (q.title + ' ' + q.body + ' ' + q.explanation).toLowerCase().includes(low)
  ).slice(0, 60);

  const hi = s => escapeHtml(s).replace(rx, '<mark>$1</mark>');
  let html = `<div class="dock-search-title">"${escapeHtml(term)}" 검색 결과</div>`;
  html += `<div class="sr-group"><div class="section-title">📘 개념집 (${conceptHits.length})</div>`;
  html += conceptHits.length ? conceptHits.slice(0, 40).map(h => `
    <div class="sr-hit" onclick="App.openConceptDock(${h.ci}, ${JSON.stringify(h.head).replace(/"/g, '&quot;')}, true)">
      <h4><span class="badge ${examClass(h.exam)}" style="margin-right:6px">${h.exam}</span>${hi(h.head)}
        <small style="color:var(--faint);font-weight:400"> · ${escapeHtml(h.domain)}</small></h4>
      <div class="snip">…${hi(h.snip)}…</div>
    </div>`).join('') : '<div class="empty">개념집에서 일치 항목이 없습니다.</div>';
  html += '</div>';

  html += `<div class="sr-group"><div class="section-title">📝 관련 문제 (${qHits.length}${qHits.length >= 60 ? '+' : ''})</div>`;
  html += qHits.length ? qHits.map(q => `
    <div class="sr-hit" onclick="App.solveOne('${q.id}')">
      <h4><span class="badge ${examClass(q.exam)}" style="margin-right:6px">${q.exam}</span>${hi(q.title)}
        <small style="color:var(--faint);font-weight:400"> · ${escapeHtml(shortCat(q.category))} ${q.num}</small></h4>
      <div class="snip">${hi(q.body.slice(0, 160))}</div>
    </div>`).join('') : '<div class="empty">관련 문제가 없습니다.</div>';
  html += '</div>';

  $('#dockConceptContent').innerHTML = html;
  toggleDock(true); dockTab('concept');
  $('#dockConcept').scrollTop = 0;
}

/* ---------- 공개 API ---------- */
const App = {
  async exportProgress() {
    if ($('#notesArea').value !== ProgressStore.value.webNotes) await ProgressStore.setWebNotes($('#notesArea').value);
    const url = URL.createObjectURL(new Blob([ProgressStore.exportJSON()],{type:'application/json'}));
    const link = document.createElement('a');link.href=url;link.download='CertLoop-full-progress-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
  async importProgress(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const progressText = parsed.format === 'certloop-start-pack' ? JSON.stringify(parsed.progress) : text;
      const result = await ProgressStore.importJSON(progressText, DATA.questions, CPS);
      $('#notesArea').value = LS.notes;
      renderHome();
      alert(`기록을 합쳤습니다. 풀이 ${result.attempts}회 · 체크포인트 ${result.checkpoints}개. 기존 웹 기록도 보존했습니다.`);
    } catch (error) { alert('가져오기 실패: ' + error.message); }
    finally { input.value = ''; }
  },
  async chooseExam(exam) { await ProgressStore.chooseExam(exam); renderHome(); },
  async startToday() {
    const exam = ProgressStore.value.selectedExam || 'SAP-C02';
    const cp = ProgressStore.nextCheckpoint(CPS, exam);
    if (!cp) { alert('이 자격증의 체크포인트가 없습니다.'); return; }
    await ProgressStore.startDaily(cp);
    const conceptIndex = DATA.concepts.findIndex(c => c.exam === cp.exam && c.category === cp.category);
    if (conceptIndex < 0) { App.startCheckpoint(cp.exam, cp.category, cp.idx); return; }
    openConcept(conceptIndex, cp.readingMarkdown ? null : cp.sections?.[0], cp.readingMarkdown, cp);
    $('#todayNotice').textContent = `${exam} · 체크포인트 ${cp.idx}/${cp.total} · 개념을 읽고 해당 체크포인트 버튼을 누르세요.`;
    $('#todayNotice').hidden = false;
  },
  goHome() { stopTimer(); show('home'); renderHome(); },
  startRandom(exam, n, exactExam, exactCat) {
    let pool = DATA.questions;
    let label = '전체';
    if (exactExam && exactCat) { pool = pool.filter(q => q.exam === exactExam && q.category === exactCat); label = shortCat(exactCat); }
    else if (exam) { pool = pool.filter(q => q.exam === exam); label = exam; }
    pool = shuffle(pool);
    if (n && n > 0) pool = pool.slice(0, n);
    startQuiz(pool, label);
  },
  startCheckpoint(exam, cat, idx) {
    const cp = findCP(exam, cat, idx);
    if (!cp) { alert('체크포인트 정보를 찾을 수 없습니다. build.py를 다시 실행하세요.'); return; }
    const set = new Set(cp.nums);
    const pool = DATA.questions.filter(q => q.exam === exam && q.category === cat && set.has(q.num));
    if (!pool.length) { alert('이 체크포인트에 연결된 문항이 없습니다.'); return; }
    startQuiz(shuffle(pool), `${shortCat(cat)} · CP${idx} ${cp.range}`);
    Q.cpKey = cpKey(exam, cat, idx);
    Q.cpPass = cp.pass;
    ProgressStore.markDailyRead(cp).catch(error => alert('읽기 기록 저장 실패: ' + error.message));
  },
  startWrong(exam) {
    const set = new Set(LS.wrong);
    let pool = DATA.questions.filter(q => set.has(q.id));
    if (exam) pool = pool.filter(q => q.exam === exam);
    pool = shuffle(pool);
    if (!pool.length) { alert('저장된 오답이 없습니다. 문제를 풀면 틀린 문제가 여기 모입니다.'); return; }
    startQuiz(pool, exam ? exam + ' 오답' : '오답노트 전체');
  },
  solveOne(id) {
    const q = DATA.questions.find(x => x.id === id);
    if (q) startQuiz([q], q.num);
  },
  pick(k, multi) {
    if (Q.answered[Q.idx]) return;
    if (multi) { Q.picked.has(k) ? Q.picked.delete(k) : Q.picked.add(k); }
    else { Q.picked = new Set([k]); }
    $$('#choices .choice').forEach(li => li.classList.toggle('sel', Q.picked.has(li.dataset.k)));
  },
  async submit() {
    if (!Q.picked.size) { alert('선지를 선택하세요.'); return; }
    if (Q.answered[Q.idx]) return;
    const picked = [...Q.picked];
    const correct = gradeUI(picked);
    Q.answered[Q.idx] = { picked, correct };
    if (correct) Q.score++;
    try { await ProgressStore.recordAttempt(Q.list[Q.idx], picked, correct, Math.max(0, (performance.now() - Q.questionStart) / 1000), Q.cpKey ? 'checkpoint' : 'practice'); }
    catch (error) { alert('학습 기록 저장 실패: ' + error.message + '\n기록 내보내기로 백업해 주세요.'); }
    $('#scoreText').textContent = `정답 ${Q.score}`;
    $('#submitBtn').style.display = 'none';
    $('#nextBtn').style.display = 'inline-block';
  },
  next() {
    if (Q.idx < Q.list.length - 1) { Q.idx++; renderQuestion(); }
    else renderResult();
  },
  prev() { if (Q.idx > 0) { Q.idx--; renderQuestion(); } },
  toggleConfig() { App.goHome(); },
  openConcept, doSearch, toggleDock, dockTab, openConceptDock,
};
window.App = App;

async function renderResult() {
  stopTimer();
  const total = Q.list.length, sc = Q.score, pct = Math.round(sc / total * 100);
  const cls = pct >= 80 ? 'g' : pct >= 60 ? 'y' : 'r';
  const ms = performance.now() - Q.startTime;
  const perQ = Math.round(ms / 1000 / total);   // 문항당 평균(초)
  let cpLine = '';
  if (Q.cpKey) {
    try { await ProgressStore.recordCheckpoint(Q.cpKey, sc, total); }
    catch (error) { alert('체크포인트 저장 실패: ' + error.message); }
    const pass = Q.cpPass || Math.max(1, Math.round(total * 0.75));
    cpLine = sc >= pass
      ? `<div class="cp-verdict ok">✅ 체크포인트 통과 (합격선 ${pass}개) — 다음 구간으로 넘어가세요</div>`
      : `<div class="cp-verdict bad">❌ 합격선 ${pass}개 미달 — 이 구간을 다시 읽고 재도전하세요</div>`;
  }
  tickTimer();
  $('#progBar').style.width = '100%';
  // 실제 시험 페이스: 75문항 / 180분 = 문항당 144초(2분 24초)
  $('#quizContent').innerHTML = `
    <div class="result-card">
      <div>완료했습니다</div>
      <div class="big ${cls}">${pct}%</div>
      <div style="color:var(--muted)">${total}문제 중 <b style="color:var(--text)">${sc}</b>문제 정답 · ${Q.scopeLabel}</div>
      ${cpLine}
      <div class="result-time">⏱ 소요 <b>${fmtDur(ms)}</b> · 문항당 평균 ${perQ}초
        <span style="color:var(--faint)">(실제 시험 페이스 문항당 144초 / 75문항·180분)</span></div>
      <div class="actions" style="justify-content:center;margin-top:26px">
        <button class="btn btn-primary" onclick="App.goHome()">홈으로</button>
        <button class="btn btn-ghost" onclick="location.reload()">한 번 더</button>
      </div>
    </div>`;
}

/* ---------- 초기화 ---------- */
async function init() {
  try { await ProgressStore.init(DATA.questions, CPS); }
  catch (error) { alert('학습 기록 저장소를 열 수 없습니다: ' + error.message); return; }
  document.documentElement.dataset.theme = LS.theme;
  $('#themeBtn').textContent = LS.theme === 'dark' ? '🌙' : '☀️';
  $('#themeBtn').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t; LS.theme = t;
    $('#themeBtn').textContent = t === 'dark' ? '🌙' : '☀️';
    if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: t === 'dark' ? 'dark' : 'default', securityLevel: 'loose' });
  };
  let t;
  $('#searchInput').addEventListener('input', e => {
    clearTimeout(t); const v = e.target.value;
    t = setTimeout(() => { if (v.trim().length >= 2) doSearch(v); }, 260);
  });
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(e.target.value); });

  /* ----- 도크 초기화 ----- */
  const setHH = () => document.documentElement.style.setProperty('--hh', $('header').offsetHeight + 'px');
  setHH(); window.addEventListener('resize', setHH);
  if (LS.dockW) document.documentElement.style.setProperty('--dock-w', LS.dockW);
  const ta = $('#notesArea');
  ta.value = LS.notes;
  let nt; ta.addEventListener('input', () => { clearTimeout(nt); nt = setTimeout(async () => { LS.notes = ta.value; try { await ProgressStore.setWebNotes(ta.value); } catch (error) { alert('메모 저장 실패: ' + error.message); } }, 300); });
  $('#dockBtn').onclick = () => toggleDock();
  // 도크 너비 조절
  const rz = $('#dockResizer');
  if (rz) {
    const move = e => {
      const w = Math.min(760, Math.max(300, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--dock-w', w + 'px');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      LS.dockW = getComputedStyle(document.documentElement).getPropertyValue('--dock-w').trim();
    };
    rz.addEventListener('mousedown', e => {
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
  }
  // ESC로 도크 닫기
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleDock(false); });

  renderHome();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
}
if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

})();
