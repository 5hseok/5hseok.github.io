/* The public web shell never downloads the question bank from its host. */
(function () {
  'use strict';
  const DB = 'certloop-content';
  const PACK_KEY = 'private-pack';
  let database;

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('content');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function getPack() {
    return new Promise((resolve, reject) => {
      const request = database.transaction('content').objectStore('content').get(PACK_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function putPack(pack) {
    return new Promise((resolve, reject) => {
      const tx = database.transaction('content', 'readwrite');
      tx.objectStore('content').put(pack, PACK_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  function validate(pack) {
    if (!['certloop-content-pack', 'certloop-start-pack'].includes(pack?.format) || pack.version !== 1 || !pack.data ||
        !Array.isArray(pack.data.questions) || !Array.isArray(pack.data.concepts) || !Array.isArray(pack.data.checkpoints) || !Array.isArray(pack.data.categories) ||
        pack.data.questions.length < 1 || pack.data.questions.length > 50000 ||
        new Set(pack.data.questions.map(q => q.id)).size !== pack.data.questions.length ||
        pack.data.questions.some(q => typeof q.id !== 'string' || !Array.isArray(q.answer) || !q.choices)) {
      throw Error('CertLoop 문제집 파일 형식이 올바르지 않습니다.');
    }
  }
  function launch(pack) {
    window.QUIZ_DATA = pack.data;
    document.querySelector('#setup').hidden = true;
    document.querySelector('header').hidden = false;
    document.querySelector('main').hidden = false;
    const script = document.createElement('script');
    script.src = 'app.js?v=20261029d';
    script.onerror = () => { document.querySelector('#setupError').textContent = '학습 화면을 불러오지 못했습니다. 다시 열어 주세요.'; };
    document.body.appendChild(script);
  }
  async function importPack(input) {
    const file = input.files?.[0];
    if (!file) return;
    const status = document.querySelector('#setupError');
    status.textContent = '문제집을 확인하고 있습니다…';
    try {
      if (file.size > 30_000_000) throw Error('30MB 이하의 문제집 파일을 선택해 주세요.');
      const pack = JSON.parse(await file.text());
      validate(pack);
      if (pack.progress) {
        await ProgressStore.init(pack.data.questions, pack.data.checkpoints);
        await ProgressStore.importJSON(JSON.stringify(pack.progress), pack.data.questions, pack.data.checkpoints);
      }
      await putPack({ format: 'certloop-content-pack', version: 1, data: pack.data });
      location.reload();
    } catch (error) { status.textContent = error.message; if (document.querySelector('#setup').hidden) alert('문제집 업데이트 실패: ' + error.message); input.value = ''; }
  }
  async function init() {
    const setup = document.querySelector('#setup');
    document.querySelector('#contentImport').addEventListener('change', event => importPack(event.target));
    document.querySelector('#contentUpdate').addEventListener('change', event => importPack(event.target));
    try {
      database = await openDB();
      const pack = await getPack();
      if (pack) { validate(pack); launch(pack); }
      else setup.hidden = false;
    } catch (error) {
      setup.hidden = false;
      document.querySelector('#setupError').textContent = '기기 저장소를 열 수 없습니다: ' + error.message;
    }
  }
  if (typeof module !== 'undefined') { module.exports = { validate }; return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
