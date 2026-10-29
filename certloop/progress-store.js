/* CertLoop의 학습 기록은 브라우저 안의 IndexedDB에 보관한다. */
(function (root) {
  'use strict';
  const DB_NAME = 'certloop-study';
  const KEY = 'progress';
  const APPLE_EPOCH = 978307200;
  const empty = () => ({ version: 1, attempts: [], reviews: {}, bookmarks: [], notes: {}, checkpointScores: {}, preferences: { dailyGoal: 10, reminderEnabled: false, reminderHour: 21, reminderMinute: 0 }, selectedExam: 'SAP-C02', webCheckpointRecords: {}, webNotes: '', highlights: [] });
  const now = () => Date.now() / 1000 - APPLE_EPOCH;
  let state = empty();
  let db;

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function read() {
    return new Promise((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function save() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put(state, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  function cpId(key) {
    const parts = key.split('|');
    if (parts.length !== 3) return key;
    return (parts[0] === 'SAP-C02' ? '' : parts[0] + ':') + parts[1] + ':' + parts[2];
  }
  function checkpointId(cp) { return (cp.exam === 'SAP-C02' ? '' : cp.exam + ':') + cp.category + ':' + cp.idx; }
  function nextCheckpoint(checkpoints, progress, exam) {
    const sorted = checkpoints.filter(cp => cp.exam === exam).sort((a, b) => a.category.localeCompare(b.category) || a.idx - b.idx);
    if (!sorted.length) return null;
    const currentExam = progress.selectedExam || 'SAP-C02';
    const lesson = currentExam === exam ? progress.dailyLesson : progress.savedLessons?.[exam];
    const session = currentExam === exam ? progress.session : progress.savedSessions?.[exam];
    const scores = progress.checkpointScores || {};
    if (lesson && lesson.completedAt == null) {
      const cp = sorted.find(item => checkpointId(item) === lesson.checkpointID);
      if (cp && ((session?.checkpointID === lesson.checkpointID && session.index < (session.questionIDs?.length || 0)) || scores[lesson.checkpointID] == null)) return cp;
    }
    const unseen = sorted.find(cp => scores[checkpointId(cp)] == null);
    if (unseen) return unseen;
    const failed = sorted.find(cp => scores[checkpointId(cp)] < cp.pass);
    if (failed) return failed;
    return sorted.reduce((best, cp) => (scores[checkpointId(cp)] || 0) * (best.nums?.length || 1) < (scores[checkpointId(best)] || 0) * (cp.nums?.length || 1) ? cp : best);
  }
  function webCheckpointKey(id) {
    const m = id.match(/^(?:(SAP-C02|SAA-C03):)?(.+):(\d+)$/);
    return m ? `${m[1] || 'SAP-C02'}|${m[2]}|${m[3]}` : null;
  }
  function validate(candidate, questionIds, checkpointIds) {
    if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.attempts) || !Array.isArray(candidate.bookmarks)) throw Error('CertLoop 앱 기록 JSON이 아닙니다.');
    if (candidate.attempts.length > 100000 || (candidate.highlights || []).length > 2000) throw Error('기록 크기가 지원 범위를 넘었습니다.');
    if (candidate.attempts.some(a => !questionIds.has(a.questionID) || !Array.isArray(a.selected) || typeof a.correct !== 'boolean')) throw Error('현재 문제집에 없는 풀이 기록이 있습니다.');
    if (candidate.bookmarks.some(id => !questionIds.has(id))) throw Error('현재 문제집에 없는 북마크가 있습니다.');
    if (Object.keys(candidate.checkpointScores || {}).some(id => !checkpointIds.has(id))) throw Error('현재 문제집에 없는 체크포인트가 있습니다.');
    if (Object.keys(candidate.webCheckpointRecords || {}).some(id => !checkpointIds.has(id))) throw Error('현재 문제집에 없는 웹 체크포인트가 있습니다.');
    if (Object.keys(candidate.reviews || {}).some(id => !questionIds.has(id))) throw Error('현재 문제집에 없는 복습 기록이 있습니다.');
  }
  function merge(a, b) {
    const result = { ...empty(), ...a, ...b };
    const attempts = new Map();
    [...(a.attempts || []), ...(b.attempts || [])].forEach(item => attempts.set(item.id, item));
    result.attempts = [...attempts.values()].sort((x, y) => x.date - y.date);
    result.reviews = { ...a.reviews, ...b.reviews };
    const lastA = {}, lastB = {};
    for (const item of a.attempts || []) lastA[item.questionID] = Math.max(lastA[item.questionID] || -Infinity, item.date);
    for (const item of b.attempts || []) lastB[item.questionID] = Math.max(lastB[item.questionID] || -Infinity, item.date);
    for (const id of Object.keys(a.reviews || {})) {
      if ((lastA[id] || -Infinity) > (lastB[id] || -Infinity)) result.reviews[id] = a.reviews[id];
    }
    result.bookmarks = [...new Set([...(a.bookmarks || []), ...(b.bookmarks || [])])];
    result.notes = { ...a.notes, ...b.notes };
    result.checkpointScores = { ...a.checkpointScores };
    Object.entries(b.checkpointScores || {}).forEach(([id, score]) => { result.checkpointScores[id] = Math.max(score, result.checkpointScores[id] ?? 0); });
    result.webCheckpointRecords = { ...a.webCheckpointRecords, ...b.webCheckpointRecords };
    const highlights = new Map();
    [...(a.highlights || []), ...(b.highlights || [])].forEach(item => highlights.set(item.id, item));
    result.highlights = [...highlights.values()];
    result.webNotes = [a.webNotes, b.webNotes].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index).join('\n\n');
    const newer = (left, right, field) => (left && (!right || (left[field] || 0) > (right[field] || 0))) ? left : right;
    result.dailyLesson = newer(a.dailyLesson, b.dailyLesson, 'date') || null;
    result.session = newer(a.session, b.session, 'startedQuestion') || null;
    result.savedLessons = { ...a.savedLessons, ...b.savedLessons };
    result.savedSessions = { ...a.savedSessions, ...b.savedSessions };
    for (const exam of new Set([...Object.keys(a.savedLessons || {}), ...Object.keys(b.savedLessons || {})])) result.savedLessons[exam] = newer(a.savedLessons?.[exam], b.savedLessons?.[exam], 'date');
    for (const exam of new Set([...Object.keys(a.savedSessions || {}), ...Object.keys(b.savedSessions || {})])) result.savedSessions[exam] = newer(a.savedSessions?.[exam], b.savedSessions?.[exam], 'startedQuestion');
    return result;
  }
  function syncLegacy() {
    const cp = {};
    for (const [id, score] of Object.entries(state.checkpointScores || {})) {
      const key = webCheckpointKey(id);
      if (key) cp[key] = { correct: score, total: 0, at: 0 };
    }
    for (const [id, record] of Object.entries(state.webCheckpointRecords || {})) {
      const key = webCheckpointKey(id);
      if (key && (!cp[key] || record.correct > cp[key].correct)) cp[key] = { correct: record.correct, total: record.total, at: record.at || 0 };
    }
    localStorage.setItem('aws_cp', JSON.stringify(cp));
    const wrong = Object.entries(state.reviews || {}).filter(([, review]) => review.lastCorrect === false).map(([id]) => id);
    localStorage.setItem('aws_wrong', JSON.stringify(wrong));
    localStorage.setItem('aws_notes', state.webNotes || '');
  }
  function importLegacy(questionIds, checkpointIds) {
    let cp = {}, wrong = [];
    try { cp = JSON.parse(localStorage.getItem('aws_cp') || '{}'); } catch (_) {}
    try { wrong = JSON.parse(localStorage.getItem('aws_wrong') || '[]'); } catch (_) {}
    for (const [key, record] of Object.entries(cp)) {
      const id = cpId(key);
      if (checkpointIds.has(id) && Number.isFinite(record.correct)) {
        state.webCheckpointRecords[id] = { correct: record.correct, total: record.total || 1, at: record.at || 0 };
        state.checkpointScores[id] = Math.max(state.checkpointScores[id] || 0, record.correct);
      }
    }
    for (const id of wrong) if (questionIds.has(id) && !state.reviews[id]) state.reviews[id] = { consecutiveCorrect: 0, due: now(), lastCorrect: false };
    if (!state.webNotes) state.webNotes = localStorage.getItem('aws_notes') || '';
  }
  const api = {
    async init(questions, checkpoints) {
      db = await open();
      if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
      state = { ...empty(), ...(await read() || {}) };
      const qids = new Set(questions.map(q => q.id));
      const cpids = new Set(checkpoints.map(cp => (cp.exam === 'SAP-C02' ? '' : cp.exam + ':') + cp.category + ':' + cp.idx));
      importLegacy(qids, cpids);
      await save();
      syncLegacy();
    },
    get value() { return state; },
    async importJSON(text, questions, checkpoints) {
      const parsed = JSON.parse(text);
      const candidate = parsed.format === 'certloop-web-progress' ? {
        ...empty(),
        selectedExam: state.selectedExam,
        webNotes: parsed.notes || '',
        webCheckpointRecords: Object.fromEntries(Object.entries(parsed.checkpoints || {}).map(([k, v]) => [cpId(k), v])),
        reviews: Object.fromEntries((parsed.wrong || []).map(id => [id, { consecutiveCorrect: 0, due: now(), lastCorrect: false }])),
      } : { ...empty(), ...parsed };
      const qids = new Set(questions.map(q => q.id));
      const cpids = new Set(checkpoints.map(cp => (cp.exam === 'SAP-C02' ? '' : cp.exam + ':') + cp.category + ':' + cp.idx));
      validate(candidate, qids, cpids);
      const before = JSON.stringify(state);
      state = merge(state, candidate);
      try { await save(); syncLegacy(); } catch (error) { state = JSON.parse(before); throw error; }
      return { attempts: state.attempts.length, checkpoints: Object.keys(state.checkpointScores).length };
    },
    async recordAttempt(question, selected, correct, seconds, mode) {
      state.attempts.push({ id: crypto.randomUUID(), questionID: question.id, date: now(), selected, correct, seconds, mode });
      const previous = state.reviews[question.id];
      const consecutiveCorrect = correct ? (previous?.consecutiveCorrect || 0) + 1 : 0;
      const days = [1, 3, 7, 14, 30][Math.min(Math.max(consecutiveCorrect - 1, 0), 4)];
      state.reviews[question.id] = { consecutiveCorrect, lastCorrect: correct, due: now() + (correct ? days * 86400 : 600) };
      await save(); syncLegacy();
    },
    async recordCheckpoint(key, correct, total) {
      const id = cpId(key);
      state.checkpointScores[id] = Math.max(state.checkpointScores[id] || 0, correct);
      state.webCheckpointRecords[id] = { correct, total, at: Date.now() };
      if (state.dailyLesson?.checkpointID === id) state.dailyLesson.completedAt = now();
      await save(); syncLegacy();
    },
    async setWebNotes(text) { state.webNotes = text; await save(); },
    async setDailyGoal(value) { state.preferences.dailyGoal = Math.min(100, Math.max(1, Number(value) || 10)); await save(); },
    async toggleBookmark(id) {
      const bookmarks = new Set(state.bookmarks || []);
      if (bookmarks.has(id)) bookmarks.delete(id); else bookmarks.add(id);
      state.bookmarks = [...bookmarks];
      await save();
      return bookmarks.has(id);
    },
    async setQuestionNote(id, text) { state.notes[id] = text; await save(); },
    async chooseExam(exam) {
      const previous = state.selectedExam || 'SAP-C02';
      if (previous === exam) return;
      state.savedLessons = { ...state.savedLessons, [previous]: state.dailyLesson || null };
      state.savedSessions = { ...state.savedSessions, [previous]: state.session || null };
      state.selectedExam = exam;
      state.dailyLesson = state.savedLessons[exam] || null;
      state.session = state.savedSessions[exam] || null;
      await save();
    },
    nextCheckpoint(checkpoints, exam) { return nextCheckpoint(checkpoints, state, exam); },
    async startDaily(cp) {
      const id = checkpointId(cp);
      if (state.dailyLesson?.checkpointID !== id || state.dailyLesson?.completedAt != null) state.dailyLesson = { checkpointID: id, date: now(), readAt: null, completedAt: null };
      await save();
    },
    async markDailyRead(cp) {
      if (state.dailyLesson?.checkpointID === checkpointId(cp)) { state.dailyLesson.readAt = now(); await save(); }
    },
    async beginSession(title, questionIDs, checkpointID = null) {
      state.session = { id: crypto.randomUUID(), title, questionIDs, index: 0, selected: [], submitted: false, correct: 0, startedQuestion: now(), checkpointID };
      await save();
    },
    async selectInSession(selected) { if (state.session && !state.session.submitted) { state.session.selected = selected; await save(); } },
    async submitInSession(correct) { if (state.session && !state.session.submitted) { state.session.submitted = true; if (correct) state.session.correct++; await save(); } },
    async advanceSession() { if (state.session?.submitted) { state.session.index++; state.session.selected = []; state.session.submitted = false; state.session.startedQuestion = now(); await save(); } },
    webCheckpointKey,
    exportJSON() { return JSON.stringify(state, null, 2); },
    summary(exam) {
      const list = state.attempts.filter(a => a.questionID.startsWith(exam + '-'));
      const correct = list.filter(a => a.correct).length;
      return { attempts: list.length, rate: list.length ? Math.round(correct * 100 / list.length) : null, wrong: Object.entries(state.reviews).filter(([id, r]) => id.startsWith(exam + '-') && !r.lastCorrect).length };
    },
    metrics(exam, questions) {
      const attempts = state.attempts.filter(item => item.questionID.startsWith(exam + '-'));
      const today = new Date().toDateString();
      const dayOf = item => new Date((item.date + APPLE_EPOCH) * 1000).toDateString();
      const todayCount = attempts.filter(item => dayOf(item) === today).length;
      const days = new Set(attempts.map(dayOf));
      const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
      if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
      let streak = 0;
      while (days.has(cursor.toDateString())) { streak++; cursor.setDate(cursor.getDate() - 1); }
      const questionIds = new Set(questions.map(q => q.id));
      const dueIds = Object.entries(state.reviews || {}).filter(([id, review]) => questionIds.has(id) && review.due <= now()).map(([id]) => id);
      const wrongIds = Object.entries(state.reviews || {}).filter(([id, review]) => questionIds.has(id) && review.lastCorrect === false).map(([id]) => id);
      const missedIds = new Set(attempts.filter(item => !item.correct).map(item => item.questionID));
      const recovered = [...missedIds].filter(id => state.reviews[id]?.lastCorrect === true).length;
      return { attempts, todayCount, dailyGoal: state.preferences.dailyGoal || 10, streak, coverage: new Set(attempts.map(item => item.questionID)).size, dueIds, wrongIds, recovered };
    },
  };
  root.ProgressStore = api;
  if (typeof module !== 'undefined') module.exports = { merge, cpId, checkpointId, nextCheckpoint, webCheckpointKey, validate, empty };
})(typeof window !== 'undefined' ? window : globalThis);
