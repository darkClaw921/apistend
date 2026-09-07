import { createHash } from 'node:crypto'
import { BX24_BRIDGE_NS, BX24_BRIDGE_VERSION } from '@apistend/shared'

/**
 * Библиотека BX24.js, которую подключает приложение разработчика.
 *
 * Боевую подключают как <script src="//api.bitrix24.tech/api/v1/">, нашу —
 * как <script src="http://localhost:8080/api/v1/">: подмена базового адреса, ровно
 * та же, что и во всём остальном продукте. Текст отдаёт маршрут /api/v1/ в apps/api,
 * здесь только сам текст и его ETag.
 *
 * Реализация собственная, потому что боевой протокол postMessage между фреймом
 * приложения и страницей портала Bitrix24 не опубликован: он инкапсулирован внутри
 * библиотеки и живёт вместе с ней. Совпадать обязана поверхность BX24.* — имена
 * методов, порядок аргументов, синхронность геттеров, форма ajaxResult, — а не
 * транспорт. Транспорт наш и описан в packages/shared/src/b24-apps.ts.
 *
 * Текст ниже — ES5 без сборки и без зависимостей: приложение разработчика может
 * грузить его в любом окружении, и библиотека не вправе требовать ни сборщика,
 * ни полифилов.
 */

/**
 * Константы протокола продублированы в тексте библиотеки: она уходит в браузер
 * готовой строкой и импортировать shared не может. Проверки ниже ломают сборку,
 * если значения в shared разойдутся с зашитыми.
 */
BX24_BRIDGE_NS satisfies 'apistend.bx24'
BX24_BRIDGE_VERSION satisfies 1

export const BX24_JS_SOURCE = `/**
 * BX24.js — APIStend.
 *
 * Поверхность повторяет боевую библиотеку Bitrix24; транспорт до портала —
 * мост postMessage APIStend. ES5 без сборки.
 */
(function (win, doc) {
'use strict';

if (win.BX24) { return; }

var NS = 'apistend.bx24';
var PROTOCOL_VERSION = 1;

/** Сколько ждём ответ портала. Больше 30 секунд ждать бессмысленно: страница уже ушла. */
var BRIDGE_TIMEOUT = 30000;

/** Боевой предел batch. Команд больше — режем на пачки и шлём последовательно. */
var BATCH_LIMIT = 50;

/** Размер страницы REST. Тот же, что у боевого портала. */
var PAGE_SIZE = 50;

var inFrame = win.parent && win.parent !== win ? true : false;

var appSid = '';
var parentOrigin = '';
var authData = null;
var envData = { domain: '', lang: '', isAdmin: false, userId: 0 };
var placementData = { placement: '', options: {}, command: [], event: [] };

var initReceived = false;
var initFired = false;
var firstRun = false;
var installStarted = false;
var installScript = '';

var initHandlers = [];
var installHandlers = [];
var readyHandlers = [];
var deferredCalls = [];
var placementHandlers = {};

var pendingBridge = {};
var bridgeSeq = 0;

var userOptions = {};
var userOptionsAsked = {};
var appOptions = {};
var appOptionsAsked = {};

var proxyCache = [];
var proxyCtx = null;

var domReady = doc.readyState === 'complete' || doc.readyState === 'interactive';

// ─────────────────────────── мелкие утилиты ───────────────────────────

function isFunction(v) { return typeof v === 'function'; }

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

function isObject(v) { return v !== null && typeof v === 'object'; }

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function later(fn) { win.setTimeout(fn, 0); }

function warn(text) {
  if (win.console && win.console.warn) { win.console.warn('BX24: ' + text); }
}

function safeCall(fn, arg) {
  if (!isFunction(fn)) { return; }
  try { fn(arg); } catch (e) {
    if (win.console && win.console.error) { win.console.error(e); }
  }
}

function shallowCopy(o) {
  var out = {};
  for (var k in o) { if (hasOwn(o, k)) { out[k] = o[k]; } }
  return out;
}

function portalUnavailable(text) {
  return { error: 'no_portal', error_description: text };
}

// ─────────────────────── адрес приложения (APP_SID) ───────────────────────

function queryParam(name) {
  var search = win.location && win.location.search ? win.location.search : '';
  if (!search) { return ''; }
  var parts = search.replace(/^[?]/, '').split('&');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    var key = eq < 0 ? parts[i] : parts[i].substring(0, eq);
    if (decodeURIComponent(key) !== name) { continue; }
    if (eq < 0) { return ''; }
    return decodeURIComponent(parts[i].substring(eq + 1).replace(/[+]/g, ' '));
  }
  return '';
}

/**
 * Порядок поиска боевой: query-строка фрейма, window.name, скрытое поле формы.
 * Третий вариант нужен, когда портал открывает приложение POST-запросом и адрес
 * фрейма остаётся без параметров.
 */
function detectAppSid() {
  var fromQuery = queryParam('APP_SID');
  if (fromQuery) { return fromQuery; }

  var fromName = '';
  try { fromName = win.name || ''; } catch (e) { fromName = ''; }
  if (fromName && /^[A-Za-z0-9_.-]+$/.test(fromName)) { return fromName; }

  if (doc.querySelector) {
    var input = doc.querySelector('input[name=APP_SID]');
    if (input && input.value) { return input.value; }
  }
  return '';
}

// ────────────────────────── кодирование запроса ──────────────────────────

/**
 * Ключ кодируем целиком, но скобки возвращаем как есть: боевой портал получает
 * filter[STAGE_ID], и в логах должно быть видно то же самое.
 */
function encKey(v) {
  return encodeURIComponent(v).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function encValue(v) { return encodeURIComponent(v); }

function appendParam(out, prefix, value) {
  if (value === null || value === undefined) {
    out.push(encKey(prefix) + '=');
    return;
  }
  if (isObject(value)) {
    for (var k in value) {
      if (!hasOwn(value, k)) { continue; }
      appendParam(out, prefix ? prefix + '[' + k + ']' : k, value[k]);
    }
    return;
  }
  if (typeof value === 'boolean') { value = value ? '1' : '0'; }
  out.push(encKey(prefix) + '=' + encValue(String(value)));
}

/** Параметры уходят в тело плоским списком с PHP-скобками: params[FILTER][STAGE_ID]=NEW. */
function buildQuery(params) {
  var out = [];
  if (isObject(params)) {
    for (var k in params) {
      if (hasOwn(params, k)) { appendParam(out, k, params[k]); }
    }
  }
  return out.join('&');
}

function parseJson(text) {
  if (!text) { return null; }
  try { return JSON.parse(text); } catch (e) { return null; }
}

// ─────────────────────────────── мост ───────────────────────────────

function nextBridgeId() {
  bridgeSeq++;
  return 'b' + bridgeSeq + '.' + Math.random().toString(36).substring(2, 10);
}

function postToParent(frame) {
  if (!inFrame) { return false; }
  // До init origin родителя неизвестен, и узнать его неоткуда — hello уходит на '*'.
  // Дальше шлём строго на запомненный origin.
  var target = parentOrigin || '*';
  try { win.parent.postMessage(frame, target); return true; } catch (e) { return false; }
}

function sendHello() {
  if (!appSid) { return; }
  postToParent({ ns: NS, v: PROTOCOL_VERSION, type: 'hello', appSid: appSid });
}

/** Команда с ответом. cb получает результат портала либо объект с полем error. */
function callBridge(method, params, cb) {
  if (!inFrame || !appSid) {
    if (isFunction(cb)) {
      later(function () {
        cb(portalUnavailable('приложение открыто вне фрейма портала, команда ' + method + ' невыполнима'));
      });
    }
    return;
  }
  var id = nextBridgeId();
  if (isFunction(cb)) {
    pendingBridge[id] = {
      cb: cb,
      timer: win.setTimeout(function () {
        delete pendingBridge[id];
        safeCall(cb, { error: 'bridge_timeout', error_description: 'Портал не ответил на ' + method + ' за 30 секунд' });
      }, BRIDGE_TIMEOUT)
    };
  }
  postToParent({
    ns: NS,
    v: PROTOCOL_VERSION,
    type: 'call',
    appSid: appSid,
    id: id,
    method: method,
    params: params === undefined ? null : params
  });
}

/** Команда без ответа: BX24.im.* по боевой сигнатуре колбэков не принимает. */
function fireBridge(method, params) {
  if (!inFrame || !appSid) {
    warn('команда ' + method + ' пропущена: портал недоступен');
    return;
  }
  postToParent({
    ns: NS,
    v: PROTOCOL_VERSION,
    type: 'call',
    appSid: appSid,
    id: nextBridgeId(),
    method: method,
    params: params === undefined ? null : params
  });
}

function onMessage(e) {
  if (!inFrame) { return; }
  // Отправитель — только родительское окно: на странице портала живут соседние фреймы.
  if (e.source !== win.parent) { return; }
  var data = e.data;
  if (!isObject(data) || data.ns !== NS || data.v !== PROTOCOL_VERSION) { return; }
  if (data.appSid !== appSid) { return; }
  if (parentOrigin && e.origin !== parentOrigin) { return; }

  if (data.type === 'init') { handleInit(data, e.origin); return; }
  if (data.type === 'result') { handleResult(data); return; }
  if (data.type === 'event') { handleEvent(data); return; }
}

function handleResult(frame) {
  var waiting = pendingBridge[frame.id];
  if (!waiting) { return; }
  delete pendingBridge[frame.id];
  win.clearTimeout(waiting.timer);
  if (frame.error) {
    safeCall(waiting.cb, { error: frame.error.code, error_description: frame.error.message });
    return;
  }
  safeCall(waiting.cb, frame.result);
}

function handleEvent(frame) {
  var list = placementHandlers[frame.event];
  if (!list) { return; }
  for (var i = 0; i < list.length; i++) { safeCall(list[i], frame.data); }
}

/**
 * init приходит на hello и повторно при смене контекста (портал переоткрыл фрейм
 * в другой точке встраивания). Обработчики init при этом второй раз не зовём:
 * приложение рассчитывает на одну инициализацию.
 */
function handleInit(frame, origin) {
  if (!parentOrigin) { parentOrigin = origin; }

  authData = frame.auth || null;
  envData = {
    domain: frame.domain || '',
    lang: frame.lang || '',
    isAdmin: frame.isAdmin === true,
    userId: frame.userId || 0
  };
  var iface = frame.placementInterface || {};
  placementData = {
    placement: frame.placement || 'DEFAULT',
    options: frame.placementOptions || {},
    command: iface.command || [],
    event: iface.event || []
  };
  firstRun = frame.firstRun === true;

  var wasReceived = initReceived;
  initReceived = true;
  flushDeferred();
  if (wasReceived) { return; }

  if (firstRun && (installHandlers.length || installScript)) {
    startInstall();
    return;
  }
  fireInit();
}

function flushDeferred() {
  var queue = deferredCalls;
  deferredCalls = [];
  for (var i = 0; i < queue.length; i++) { queue[i](); }
}

function fireInit() {
  if (initFired) { return; }
  initFired = true;
  var list = initHandlers;
  initHandlers = [];
  for (var i = 0; i < list.length; i++) { safeCall(list[i]); }
}

// ───────────────────────── установка приложения ─────────────────────────

function startInstall() {
  if (installStarted) { return; }
  installStarted = true;
  for (var i = 0; i < installHandlers.length; i++) { safeCall(installHandlers[i]); }
  if (installScript) {
    loadScript(installScript, function () { installFinish(); });
  }
}

function install(arg) {
  if (typeof arg === 'string') { installScript = arg; }
  else if (isFunction(arg)) { installHandlers.push(arg); }
  if (initReceived && firstRun) { startInstall(); }
}

/**
 * Пока приложение не отчиталось об установке, обработчики init не зовём —
 * то же правило, что и на боевом портале.
 */
function installFinish() {
  callBridge('installFinish', {}, function () { fireInit(); });
}

function init(cb) {
  if (!isFunction(cb)) { return; }
  if (initFired) { later(function () { cb(); }); return; }
  initHandlers.push(cb);
}

function ready(cb) {
  if (!isFunction(cb)) { return; }
  if (domReady) { later(function () { cb(); }); return; }
  readyHandlers.push(cb);
}

function fireReady() {
  if (domReady) { return; }
  domReady = true;
  BX24.isReady = true;
  var list = readyHandlers;
  readyHandlers = [];
  for (var i = 0; i < list.length; i++) { safeCall(list[i]); }
}

function loadScript(src, cb) {
  var list = typeof src === 'string' ? [src] : (src || []);
  var left = list.length;
  if (!left) { if (isFunction(cb)) { later(cb); } return; }

  var parent = doc.getElementsByTagName('head')[0] || doc.body || doc.documentElement;
  for (var i = 0; i < list.length; i++) {
    (function (url) {
      var el = doc.createElement('script');
      var done = false;
      // Ошибку загрузки считаем завершением: иначе install подвиснет навсегда.
      var finish = function () {
        if (done) { return; }
        done = true;
        left--;
        if (left === 0 && isFunction(cb)) { cb(); }
      };
      el.type = 'text/javascript';
      el.charset = 'utf-8';
      el.async = true;
      el.onload = finish;
      el.onerror = finish;
      el.onreadystatechange = function () {
        if (el.readyState === 'loaded' || el.readyState === 'complete') { finish(); }
      };
      el.src = url;
      parent.appendChild(el);
    })(list[i]);
  }
}

// ────────────────────────────── авторизация ──────────────────────────────

/**
 * Синхронный геттер: приложение вправе прочитать токен в первой же строке
 * обработчика init. Вне фрейма отдаём пустые значения — падать здесь нельзя,
 * прикладной код почти всегда сразу обращается к полю.
 */
function getAuth() {
  if (!authData) {
    return { access_token: '', refresh_token: '', expires_in: 0, domain: '', member_id: '' };
  }
  return {
    access_token: authData.access_token,
    refresh_token: authData.refresh_token,
    expires_in: authData.expires_in,
    domain: authData.domain,
    member_id: authData.member_id
  };
}

function applyAuth(fresh) {
  if (!isObject(fresh) || !fresh.access_token) { return false; }
  var merged = authData ? shallowCopy(authData) : {};
  for (var k in fresh) { if (hasOwn(fresh, k)) { merged[k] = fresh[k]; } }
  authData = merged;
  return true;
}

function refreshAuth(cb) {
  callBridge('refreshAuth', {}, function (res) {
    if (applyAuth(res)) { safeCall(cb, getAuth()); return; }
    safeCall(cb, res);
  });
}

// ────────────────────────────────── REST ──────────────────────────────────

function AjaxError(status, body) {
  this.status = status;
  this.ex = body.ex !== undefined ? body.ex : body;
  this.error = body.error !== undefined && body.error !== null ? body.error : 'unknown_error';
  this.error_description = body.error_description !== undefined ? body.error_description : '';
}

AjaxError.prototype.getError = function () { return this.ex; };
AjaxError.prototype.getStatus = function () { return this.status; };
AjaxError.prototype.toString = function () { return this.error + ': ' + this.error_description; };

/**
 * Результат вызова REST. Набор методов боевой: data, error, more, total, time, next.
 */
function AjaxResult(status, body, params, reissue) {
  this.__status = status;
  this.__body = isObject(body) ? body : {};
  this.__params = isObject(params) ? params : {};
  this.__reissue = reissue;
  this.__error = undefined;
}

AjaxResult.prototype.data = function () { return this.__body.result; };

AjaxResult.prototype.error = function () {
  if (this.__error !== undefined) { return this.__error; }
  var body = this.__body;
  var failed = this.__status < 200 || this.__status >= 300 ||
    (body.error !== undefined && body.error !== null && body.error !== '');
  this.__error = failed ? new AjaxError(this.__status, body) : false;
  return this.__error;
};

AjaxResult.prototype.more = function () {
  return this.__body.next !== undefined && this.__body.next !== null;
};

AjaxResult.prototype.total = function () { return this.__body.total; };

AjaxResult.prototype.time = function () { return this.__body.time; };

/** Следующая страница уходит в тот же колбэк. false — данных больше нет. */
AjaxResult.prototype.next = function () {
  if (!this.more() || !isFunction(this.__reissue)) { return false; }
  var params = shallowCopy(this.__params);
  var start = this.__body.next;
  if (typeof start !== 'number') {
    start = (typeof this.__params.start === 'number' ? this.__params.start : 0) + PAGE_SIZE;
  }
  params.start = start;
  this.__reissue(params);
  return true;
};

function restEndpoint() {
  var base = authData && authData.client_endpoint ? authData.client_endpoint : '';
  if (!base) { return ''; }
  return base.charAt(base.length - 1) === '/' ? base : base + '/';
}

/**
 * Запрос в REST идёт прямо из фрейма, минуя портал. Токен кладётся в тело,
 * а не в query-строку: в query он осел бы в логах веб-сервера, и документация
 * Bitrix24 советует ровно это.
 */
function restRequest(method, params, onDone) {
  var endpoint = restEndpoint();
  if (!endpoint) {
    onDone(0, { error: 'NO_AUTH_FOUND', error_description: 'Wrong authorization data' });
    return;
  }
  var body = buildQuery(params);
  body = body ? body + '&auth=' + encValue(authData.access_token) : 'auth=' + encValue(authData.access_token);

  var xhr = new win.XMLHttpRequest();
  xhr.open('POST', endpoint + method, true);
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) { return; }
    var parsed = parseJson(xhr.responseText);
    if (parsed === null) {
      onDone(xhr.status, { error: 'invalid_response', error_description: 'Ответ REST не разобрался как JSON' });
      return;
    }
    onDone(xhr.status, parsed);
  };
  xhr.onerror = function () {
    onDone(0, { error: 'network_error', error_description: 'Запрос к REST не дошёл' });
  };
  xhr.send(body);
}

/**
 * Протухший токен обновляем сами и повторяем запрос ровно один раз — так делает
 * боевая библиотека. Второй 401 уходит приложению как есть.
 */
function restCall(method, params, cb, retried, reissue) {
  restRequest(method, params, function (status, body) {
    if (status === 401 && body && body.error === 'expired_token' && !retried) {
      refreshAuth(function (auth) {
        if (auth && auth.access_token) {
          restCall(method, params, cb, true, reissue);
          return;
        }
        safeCall(cb, new AjaxResult(status, body, params, reissue));
      });
      return;
    }
    safeCall(cb, new AjaxResult(status, body, params, reissue));
  });
}

/** До init вызов откладывается: токена ещё нет. Боевая ведёт себя так же. */
function deferUntilInit(run) {
  if (initReceived) { run(); return true; }
  if (!inFrame) { return false; }
  deferredCalls.push(run);
  return true;
}

function callMethod(method, params, cb) {
  if (isFunction(params)) { cb = params; params = {}; }
  if (!isObject(params)) { params = {}; }

  var reissue = function (nextParams) { restCall(method, nextParams, cb, false, reissue); };
  var run = function () { restCall(method, params, cb, false, reissue); };

  if (!deferUntilInit(run)) {
    later(function () {
      safeCall(cb, new AjaxResult(0, { error: 'NO_AUTH_FOUND', error_description: 'Wrong authorization data' }, params, null));
    });
  }
}

/** Разбирает и объект, и массив вызовов; ссылки вида $result[key][ID] уходят серверу как есть. */
function prepareBatch(calls) {
  var keys = [];
  var cmd = {};
  if (!isObject(calls)) { return { keys: keys, cmd: cmd, plain: {} }; }

  var plain = {};
  for (var key in calls) {
    if (!hasOwn(calls, key)) { continue; }
    var call = calls[key];
    var method = '';
    var params = {};
    if (typeof call === 'string') {
      var qm = call.indexOf('?');
      method = qm < 0 ? call : call.substring(0, qm);
      cmd[key] = call;
      plain[key] = { method: method, params: {} };
      keys.push(key);
      continue;
    }
    if (isArray(call)) {
      method = call[0];
      params = isObject(call[1]) ? call[1] : {};
    } else if (isObject(call)) {
      method = call.method;
      params = isObject(call.params) ? call.params : {};
    }
    if (!method) { continue; }
    var query = buildQuery(params);
    cmd[key] = query ? method + '?' + query : method;
    plain[key] = { method: method, params: params };
    keys.push(key);
  }
  return { keys: keys, cmd: cmd, plain: plain };
}

function pickKeys(source, keys) {
  var out = {};
  for (var i = 0; i < keys.length; i++) { out[keys[i]] = source[keys[i]]; }
  return out;
}

/** Результат пачки раскладывается по тем же ключам, что и запрос. */
function unpackBatch(result, keys, plain, cb, into) {
  var envelope = isObject(result.data()) ? result.data() : {};
  var res = isObject(envelope.result) ? envelope.result : {};
  var errors = isObject(envelope.result_error) ? envelope.result_error : {};
  var totals = isObject(envelope.result_total) ? envelope.result_total : {};
  var nexts = isObject(envelope.result_next) ? envelope.result_next : {};
  var times = isObject(envelope.result_time) ? envelope.result_time : {};
  var batchError = result.error();

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var body = { result: res[key], total: totals[key], next: nexts[key], time: times[key] };
    if (hasOwn(errors, key) && errors[key]) {
      body.ex = errors[key];
      body.error = errors[key].error;
      body.error_description = errors[key].error_description;
    } else if (batchError) {
      // Запрос не дошёл целиком: ошибка одна на все ключи, форма ответа не меняется.
      body.ex = batchError.ex;
      body.error = batchError.error;
      body.error_description = batchError.error_description;
    }
    into[key] = makeBatchResult(result.__status, body, plain[key], key, cb);
  }
}

/** Дозапрос страницы внутри пачки уходит одиночным вызовом, но колбэку отдаётся привычная карта. */
function makeBatchResult(status, body, call, key, cb) {
  var reissue = function (nextParams) {
    restCall(call.method, nextParams, function (single) {
      var map = {};
      map[key] = single;
      safeCall(cb, map);
    }, false, reissue);
  };
  return new AjaxResult(status, body, call.params, reissue);
}

function callBatch(calls, cb, bHaltOnError) {
  var prepared = prepareBatch(calls);
  if (!prepared.keys.length) { later(function () { safeCall(cb, {}); }); return; }

  var halt = bHaltOnError ? 1 : 0;
  var collected = {};
  var offset = 0;

  var runChunk = function () {
    var keys = prepared.keys.slice(offset, offset + BATCH_LIMIT);
    offset += keys.length;
    callMethod('batch', { halt: halt, cmd: pickKeys(prepared.cmd, keys) }, function (result) {
      unpackBatch(result, keys, prepared.plain, cb, collected);
      var failed = false;
      for (var i = 0; i < keys.length; i++) {
        if (collected[keys[i]].error()) { failed = true; break; }
      }
      if (offset < prepared.keys.length && !(halt && failed)) { runChunk(); return; }
      safeCall(cb, collected);
    });
  };
  runChunk();
}

function callBind(event, handler, authType, cb) {
  if (isFunction(authType)) { cb = authType; authType = undefined; }
  var params = { event: event, handler: handler };
  if (authType) { params.auth_type = authType; }
  callMethod('event.bind', params, cb);
}

function callUnbind(event, handler, authType, cb) {
  if (isFunction(authType)) { cb = authType; authType = undefined; }
  var params = { event: event, handler: handler };
  if (authType) { params.auth_type = authType; }
  callMethod('event.unbind', params, cb);
}

// ────────────────────────────── окно и портал ──────────────────────────────

function contentWidth() {
  var body = doc.body;
  var root = doc.documentElement;
  var a = body ? body.scrollWidth : 0;
  var b = root ? root.scrollWidth : 0;
  return a > b ? a : b;
}

function contentHeight() {
  var body = doc.body;
  var root = doc.documentElement;
  var a = body ? body.scrollHeight : 0;
  var b = root ? root.scrollHeight : 0;
  return a > b ? a : b;
}

function resizeWindow(width, height, cb) {
  callBridge('resizeWindow', { width: width, height: height }, cb);
}

/** Высоту считает сама библиотека: портал содержимое фрейма измерить не может. */
function fitWindow(cb) {
  callBridge('fitWindow', { width: contentWidth(), height: contentHeight() }, cb);
}

function reloadWindow(cb) { callBridge('reloadWindow', {}, cb); }

function setTitle(title, cb) { callBridge('setTitle', { title: title }, cb); }

function scrollParentWindow(scroll, cb) { callBridge('scrollParentWindow', { scroll: scroll }, cb); }

/**
 * Боевая отдаёт размеры окна портала. Мост синхронного канала не даёт, поэтому
 * возвращаем размеры своего документа — то же, чем пользуется fitWindow.
 */
function getScrollSize() {
  if (!inFrame) { return { scrollWidth: 0, scrollHeight: 0 }; }
  return { scrollWidth: contentWidth(), scrollHeight: contentHeight() };
}

function openApplication(params, closeCb, settings) {
  callBridge('openApplication', { params: params || {}, settings: settings || {} }, closeCb);
}

function closeApplication(cb) { callBridge('closeApplication', {}, cb); }

function openPath(path, cb) { callBridge('openPath', { path: path }, cb); }

function getDomain() { return envData.domain; }

function getLang() { return envData.lang; }

function isAdmin() { return envData.isAdmin === true; }

// ─────────────────────────────── диалоги ───────────────────────────────

function selectUser(cb) { callBridge('selectUser', {}, cb); }

function selectUsers(cb) { callBridge('selectUsers', {}, cb); }

function selectAccess(value, cb) {
  if (isFunction(value)) { cb = value; value = []; }
  callBridge('selectAccess', { value: value || [] }, cb);
}

function selectCRM(params, cb) {
  if (isFunction(params)) { cb = params; params = {}; }
  callBridge('selectCRM', { params: params || {} }, cb);
}

// ─────────────────────────────── настройки ───────────────────────────────

/**
 * Геттеры настроек боевые синхронные: портал отдаёт их вместе с фреймом.
 * Init-кадр моста настроек не несёт, поэтому значение берётся из локального кэша,
 * а параллельно уходит запрос порталу — первое обращение к непрочитанной настройке
 * вернёт пустую строку, следующее уже отдаст значение.
 */
function optionGet(cache, asked, command, name) {
  if (hasOwn(cache, name)) { return cache[name]; }
  if (!hasOwn(asked, name)) {
    asked[name] = true;
    callBridge(command, { name: name }, function (res) {
      if (isObject(res) && res.error) { return; }
      cache[name] = res;
    });
  }
  return '';
}

function userOptionSet(name, value) {
  userOptions[name] = value;
  fireBridge('userOption.set', { name: name, value: value });
}

function userOptionGet(name) {
  return optionGet(userOptions, userOptionsAsked, 'userOption.get', name);
}

function appOptionSet(name, value, cb) {
  appOptions[name] = value;
  callBridge('appOption.set', { name: name, value: value }, cb);
}

function appOptionGet(name) {
  return optionGet(appOptions, appOptionsAsked, 'appOption.get', name);
}

// ────────────────────────────── встраивание ──────────────────────────────

function placementInfo() {
  return { placement: placementData.placement, options: placementData.options };
}

function placementGetInterface(cb) {
  var iface = { command: placementData.command, event: placementData.event };
  if (isFunction(cb)) { later(function () { cb(iface); }); }
}

function placementCall(command, params, cb) {
  if (isFunction(params)) { cb = params; params = []; }
  callBridge('placement.call', { command: command, params: params === undefined ? [] : params }, cb);
}

function placementBindEvent(event, cb) {
  if (!isFunction(cb)) { return; }
  if (!placementHandlers[event]) { placementHandlers[event] = []; }
  placementHandlers[event].push(cb);
}

// ─────────────────────────────── утилиты BX ───────────────────────────────

/**
 * Повторный proxy с той же парой (функция, контекст) отдаёт ту же обёртку.
 * Отличие от BX.proxy задокументировано и на нём держится unbind: снять
 * обработчик можно только той же ссылкой, которой его вешали.
 */
function proxy(fn, ctx) {
  if (!isFunction(fn)) { return fn; }
  for (var i = 0; i < proxyCache.length; i++) {
    if (proxyCache[i].fn === fn && proxyCache[i].ctx === ctx) { return proxyCache[i].proxied; }
  }
  var proxied = function () {
    var previous = proxyCtx;
    proxyCtx = ctx;
    try { return fn.apply(ctx, arguments); }
    finally { proxyCtx = previous; }
  };
  proxyCache.push({ fn: fn, ctx: ctx, proxied: proxied });
  return proxied;
}

function proxyContext() { return proxyCtx; }

function bind(el, ev, fn) {
  if (!el) { return; }
  if (el.addEventListener) { el.addEventListener(ev, fn, false); }
  else if (el.attachEvent) { el.attachEvent('on' + ev, fn); }
}

function unbind(el, ev, fn) {
  if (!el) { return; }
  if (el.removeEventListener) { el.removeEventListener(ev, fn, false); }
  else if (el.detachEvent) { el.detachEvent('on' + ev, fn); }
}

// ─────────────────────────────── сборка BX24 ───────────────────────────────

var BX24 = {
  init: init,
  install: install,
  installFinish: installFinish,
  ready: ready,
  isReady: domReady,
  loadScript: loadScript,

  getAuth: getAuth,
  refreshAuth: refreshAuth,

  callMethod: callMethod,
  callBatch: callBatch,
  callBind: callBind,
  callUnbind: callUnbind,

  resizeWindow: resizeWindow,
  fitWindow: fitWindow,
  reloadWindow: reloadWindow,
  setTitle: setTitle,
  scrollParentWindow: scrollParentWindow,
  getScrollSize: getScrollSize,
  openApplication: openApplication,
  closeApplication: closeApplication,
  openPath: openPath,

  getDomain: getDomain,
  getLang: getLang,
  isAdmin: isAdmin,

  selectUser: selectUser,
  selectUsers: selectUsers,
  selectAccess: selectAccess,
  selectCRM: selectCRM,

  userOption: { set: userOptionSet, get: userOptionGet },
  appOption: { set: appOptionSet, get: appOptionGet },

  im: {
    callTo: function (userId, video) { fireBridge('im.callTo', { userId: userId, video: video !== false }); },
    phoneTo: function (phone) { fireBridge('im.phoneTo', { phone: phone }); },
    openMessenger: function (dialogId) { fireBridge('im.openMessenger', { dialogId: dialogId }); },
    openHistory: function (dialogId) { fireBridge('im.openHistory', { dialogId: dialogId }); }
  },

  placement: {
    info: placementInfo,
    getInterface: placementGetInterface,
    call: placementCall,
    bindEvent: placementBindEvent
  },

  proxy: proxy,
  proxyContext: proxyContext,
  bind: bind,
  unbind: unbind
};

win.BX24 = BX24;

// ─────────────────────────────── запуск ───────────────────────────────

var NO_APP_SID = 'APP_SID не найден, связаться с порталом нечем. Приложение должен открывать портал APIStend, а не адресная строка браузера.';

bind(win, 'message', onMessage);

if (!domReady) {
  bind(doc, 'DOMContentLoaded', function () {
    fireReady();
    if (initReceived || !inFrame) { return; }
    // APP_SID мог лежать в скрытом поле формы, которого при разборе ещё не было.
    if (!appSid) { appSid = detectAppSid(); }
    if (appSid) { sendHello(); } else { warn(NO_APP_SID); }
  });
  bind(win, 'load', fireReady);
}

if (inFrame) {
  appSid = detectAppSid();
  if (appSid) {
    sendHello();
  } else if (domReady) {
    warn(NO_APP_SID);
  }
} else {
  warn('приложение открыто напрямую, вне фрейма портала. Портал недоступен: методы, которым нужен портал, вернут ошибку, а getAuth(), getDomain(), getLang() и isAdmin() отдадут пустые значения. Откройте приложение из карточки приложения в APIStend.');
}

})(window, document);
`

let cachedEtag: string | null = null

/**
 * ETag библиотеки. Текст меняется только вместе с релизом, поэтому маршрут может
 * отдавать его с длинным max-age и отвечать 304 на If-None-Match. Кавычки навешивает
 * маршрут: здесь только хеш.
 */
export function bx24JsEtag(): string {
  if (cachedEtag === null) {
    cachedEtag = createHash('sha1').update(BX24_JS_SOURCE, 'utf8').digest('hex').slice(0, 16)
  }
  return cachedEtag
}
