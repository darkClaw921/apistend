#!/usr/bin/env node

/**
 * Локальное приложение Bitrix24 — работающий пример для APIStend.
 *
 * Запускается голым node, без зависимостей и без сборки:
 *   node examples/b24-local-app/server.mjs
 *
 * Код устроен так же, как боевое приложение, и переносится на настоящий Bitrix24
 * без правок: адрес библиотеки и REST берутся из полей, которые прислал портал,
 * токены сохраняются на диск, а installFinish вызывается последним — после того,
 * как виджет зарегистрирован, а подписка на событие создана.
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKENS_FILE = join(HERE, '.tokens.json')

const PORT = Number(process.env.PORT ?? 3210)

/** Адрес, по которому портал видит это приложение. Уходит в placement.bind и event.bind. */
const APP_URL = (process.env.APP_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '')

const HANDLER_URL = `${APP_URL}/handler`
const INSTALL_URL = `${APP_URL}/install`
const EVENTS_URL = `${APP_URL}/events`

/** Точка встраивания и событие, которые пример регистрирует в мастере установки. */
const WIDGET_PLACEMENT = 'CRM_DEAL_DETAIL_TAB'
const WIDGET_TITLE = 'Пример APIStend'
const EVENT_CODE = 'ONCRMDEALUPDATE'

/** Права, без которых установка не пройдёт: placement — на регистрацию, crm — на саму точку. */
const REQUIRED_SCOPE = 'crm, placement, user'

const MAX_BODY_BYTES = 256 * 1024

// ─────────────────────────────── Токены ───────────────────────────────

let tokens = loadTokens()

function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Токены пишутся на диск, а не только в память: access_token живёт час, и после
 * перезапуска приложения вернуться к порталу можно лишь по refresh_token. Боевое
 * приложение кладёт их в хранилище, недоступное из браузера; здесь — файл рядом
 * со скриптом, как в install.php из CRest.
 */
function saveTokens(fields) {
  // Поля, которых в запросе не было, не затираются: часть точек встраивания
  // присылает не весь набор, а application_token нужен обработчику событий всегда.
  const previous = tokens ?? {}
  tokens = {
    accessToken: fields.AUTH_ID ?? previous.accessToken ?? null,
    refreshToken: fields.REFRESH_ID ?? previous.refreshToken ?? null,
    expiresIn: Number(fields.AUTH_EXPIRES ?? previous.expiresIn ?? 0),
    applicationToken: fields.APPLICATION_TOKEN ?? previous.applicationToken ?? null,
    scope: fields.APPLICATION_SCOPE ?? previous.scope ?? '',
    memberId: fields.member_id ?? previous.memberId ?? null,
    domain: fields.DOMAIN ?? previous.domain ?? null,
    protocol: fields.PROTOCOL ?? previous.protocol ?? '0',
    serverEndpoint: fields.SERVER_ENDPOINT ?? previous.serverEndpoint ?? null,
    status: fields.status ?? previous.status ?? null,
    savedAt: new Date().toISOString(),
  }
  writeFileSync(TOKENS_FILE, `${JSON.stringify(tokens, null, 2)}\n`)
}

// ─────────────────────────────── Журнал ───────────────────────────────

function log(scope, message) {
  console.log(`[${scope}] ${message}`)
}

/** Документация Bitrix24 запрещает писать AUTH_ID и REFRESH_ID в логи — печатаем огрызок. */
const SECRET_FIELDS = new Set(['AUTH_ID', 'REFRESH_ID', 'APPLICATION_TOKEN'])

function maskValue(name, value) {
  if (!SECRET_FIELDS.has(name)) return value
  return value.length > 12 ? `${value.slice(0, 8)}… длина ${value.length}` : '…'
}

function printFields(scope, fields) {
  for (const [name, value] of Object.entries(fields)) {
    log(scope, `  ${name} = ${maskValue(name, value)}`)
  }
}

// ─────────────────────────── Разбор запроса ───────────────────────────

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new Error('Тело запроса больше 256 КБ')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Портал делит данные фрейма между query-строкой и телом POST: DOMAIN, PROTOCOL,
 * LANG и APP_SID видны в адресе, всё остальное — в теле, потому что там токены.
 * Приложению удобнее видеть их одним набором.
 */
async function readFrameFields(req, url) {
  const raw = await readBody(req)
  return {
    ...Object.fromEntries(url.searchParams),
    ...Object.fromEntries(new URLSearchParams(raw)),
  }
}

/** PLACEMENT_OPTIONS приходит строкой JSON, а не объектом: портал не раскладывает его по полям. */
function parsePlacementOptions(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// ─────────────────────────── Адреса портала ───────────────────────────

/** PROTOCOL приходит как «0» или «1» — у localhost это всегда «0», и приложение обязано это увидеть. */
function portalOrigin(fields) {
  if (!fields.DOMAIN) return null
  return `${fields.PROTOCOL === '1' ? 'https' : 'http'}://${fields.DOMAIN}`
}

/**
 * Адрес библиотеки не зашит в код: в бою это общий //api.bitrix24.com/api/v1/,
 * в APIStend — тот же хост, что прислал портал. Значение можно переопределить
 * переменной BX24_JS_URL, если портал и его API разведены по разным адресам.
 */
function bx24JsUrl(fields) {
  if (process.env.BX24_JS_URL) return process.env.BX24_JS_URL
  const origin = portalOrigin(fields)
  return origin ? `${origin}/api/v1/` : ''
}

// ────────────────────────────── Ответы ──────────────────────────────

/**
 * Без frame-ancestors браузер оставит на месте приложения пустой фрейм — та же ошибка
 * «сайт не разрешает подключение», что и в бою. Портал её не увидит: страницу блокирует
 * браузер, а не он. X-Frame-Options здесь не отправляется намеренно: SAMEORIGIN дал бы
 * ровно этот пустой фрейм.
 *
 * В бою перечисляют один точный адрес портала. У APIStend портал и его API живут
 * на разных портах localhost, поэтому разрешены локальные адреса целиком.
 */
function frameAncestors(fields) {
  const sources = ["'self'", 'http://localhost:*', 'http://127.0.0.1:*']
  const origin = portalOrigin(fields)
  if (origin && !sources.includes(origin)) sources.push(origin)
  return `frame-ancestors ${sources.join(' ')}`
}

function sendHtml(res, html, fields = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': frameAncestors(fields),
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

// ────────────────────────────── Разметка ──────────────────────────────

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Внутри <script> опасна не кавычка, а «</» и разделители строк U+2028/U+2029. */
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const PAGE_STYLE = `
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body { margin: 0; background: #f5f6f8; color: #16181d;
         font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif }
  .wrap { max-width: 780px; margin: 0 auto; padding: 20px 20px 40px }
  h1 { font-size: 18px; margin: 0 0 6px }
  h2 { font-size: 14px; margin: 0 0 10px; color: #3d434f }
  p { margin: 0 0 12px }
  .muted { color: #6b7280 }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 16px; margin-bottom: 12px }
  .fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 18px; margin: 0 }
  .fields dt { color: #6b7280; white-space: nowrap }
  .fields dd { margin: 0; overflow-wrap: anywhere }
  ol.steps { margin: 0; padding-left: 20px }
  ol.steps li { margin-bottom: 6px }
  .state { color: #6b7280 }
  .state.ok { color: #0d7a3f }
  .state.fail { color: #b42318 }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px }
  button { font: inherit; padding: 7px 12px; border: 1px solid #d3d7de; border-radius: 8px;
           background: #fff; color: inherit; cursor: pointer }
  button:hover { border-color: #98a2b3 }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px }
  pre { margin: 0; padding: 12px; border-radius: 8px; background: #10131a; color: #e4e7ec;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap; overflow-wrap: anywhere; max-height: 340px; overflow: auto }
`

function layout({ title, body, script = '', appData = null, libraryUrl = '' }) {
  const library = libraryUrl ? `<script src="${escapeHtml(libraryUrl)}"></script>` : ''
  const data = appData ? `<script>window.__APP__ = ${embedJson(appData)};</script>` : ''
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
${library}
${data}
</head>
<body>
<div class="wrap">
${body}
</div>
${script ? `<script>\n${script}\n</script>` : ''}
</body>
</html>
`
}

function fieldsCard(heading, fields) {
  const rows = Object.entries(fields)
    .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(maskValue(name, value))}</dd>`)
    .join('\n      ')
  return `<div class="card">
    <h2>${escapeHtml(heading)}</h2>
    <dl class="fields">
      ${rows}
    </dl>
  </div>`
}

// ──────────────────────── Клиентский код страниц ────────────────────────

/** Общий кусок клиентского кода: разбор ошибки ajaxResult и вывод результата. */
const CLIENT_HELPERS = `
  var app = window.__APP__;
  var out = document.getElementById('out');

  function show(label, value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    out.textContent = label + '\\n\\n' + text;
  }

  function describeError(error) {
    if (!error) return 'неизвестная ошибка';
    if (typeof error === 'string') return error;
    var ex = error.ex || error;
    var code = ex.error || ex.code || '';
    var text = ex.error_description || ex.error_information || '';
    return (code + (text ? ': ' + text : '')) || String(error);
  }

  function libraryMissing() {
    if (typeof BX24 !== 'undefined') return false;
    show('Библиотека BX24.js не загрузилась', 'Адрес: ' + (app.libraryUrl || 'не определён') +
      '\\nПортал не отдал библиотеку по этому адресу — приложение открыто вне фрейма' +
      ' или адрес библиотеки указан неверно.');
    return true;
  }
`

const INSTALL_SCRIPT = `
${CLIENT_HELPERS}

  function mark(step, text, state) {
    var node = document.querySelector('#step-' + step + ' .state');
    node.textContent = text;
    node.className = 'state' + (state ? ' ' + state : '');
  }

  function bindPlacement() {
    mark('placement', 'регистрирую…');
    BX24.callMethod('placement.bind', {
      PLACEMENT: app.placement,
      HANDLER: app.handlerUrl,
      TITLE: app.widgetTitle
    }, function (result) {
      if (result.error()) {
        mark('placement', describeError(result.error()), 'fail');
        show('placement.bind не прошёл', describeError(result.error()));
        return;
      }
      mark('placement', 'готово', 'ok');
      bindEvent();
    });
  }

  function bindEvent() {
    mark('event', 'подписываюсь…');
    // Третий аргумент — auth_type: 0 означает авторизацию того, чьи действия вызвали событие.
    BX24.callBind(app.event, app.eventsUrl, 0, function (result) {
      if (result.error()) {
        mark('event', describeError(result.error()), 'fail');
        show('event.bind не прошёл', describeError(result.error()));
        return;
      }
      mark('event', 'готово', 'ok');
      finish();
    });
  }

  function finish() {
    // installFinish — строго последним. До него портал не доставляет события
    // и не показывает виджеты, хотя обе регистрации уже вернули успех.
    mark('finish', 'вызываю…');
    BX24.installFinish();
    mark('finish', 'готово', 'ok');
    show('Установка завершена', 'Виджет «' + app.widgetTitle + '» зарегистрирован в ' + app.placement +
      ', подписка на ' + app.event + ' создана, installFinish вызван.' +
      '\\nПортал перезапустит фрейм и откроет основную страницу приложения.');
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (libraryMissing()) return;
    BX24.init(function () {
      show('Библиотека инициализирована', 'Начинаю установку: сначала регистрации, installFinish — в конце.');
      bindPlacement();
    });
  });
`

const HANDLER_SCRIPT = `
${CLIENT_HELPERS}

  function describeUser(user) {
    var name = [user.NAME, user.LAST_NAME].filter(Boolean).join(' ');
    return (name || 'без имени') + ' (ID ' + user.ID + ')';
  }

  function fillContext() {
    var box = document.getElementById('who');
    var info = BX24.placement.info();
    var lines = [
      'Портал: ' + BX24.getDomain(),
      'Язык интерфейса: ' + BX24.getLang(),
      'Права администратора: ' + (BX24.isAdmin() ? 'есть' : 'нет'),
      'Точка встраивания: ' + info.placement,
      'Контекст вызова: ' + JSON.stringify(info.options)
    ];
    BX24.callMethod('user.current', {}, function (result) {
      lines.push(result.error()
        ? 'Пользователь: ' + describeError(result.error())
        : 'Пользователь: ' + describeUser(result.data()));
      box.textContent = lines.join('\\n');
    });
    box.textContent = lines.join('\\n');
  }

  function loadContextDeal() {
    var box = document.getElementById('deal');
    if (!box) return;
    var id = app.placementOptions.ID;
    if (!id) {
      box.textContent = 'Портал не передал ID сделки в PLACEMENT_OPTIONS.';
      return;
    }
    BX24.callMethod('crm.deal.get', { id: id }, function (result) {
      if (result.error()) {
        box.textContent = 'crm.deal.get: ' + describeError(result.error());
        return;
      }
      var deal = result.data();
      box.textContent = deal.TITLE + ' — стадия ' + deal.STAGE_ID + ', сумма ' + deal.OPPORTUNITY;
    });
  }

  var actions = {
    deals: function () {
      show('crm.deal.list', 'Запрашиваю…');
      BX24.callMethod('crm.deal.list', {
        select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY'],
        start: 0
      }, function (result) {
        if (result.error()) { show('crm.deal.list', describeError(result.error())); return; }
        show('crm.deal.list — всего ' + result.total(), result.data());
      });
    },

    batch: function () {
      show('callBatch', 'Запрашиваю…');
      BX24.callBatch({
        me: ['user.current', {}],
        deals: ['crm.deal.list', { select: ['ID', 'TITLE'] }]
      }, function (result) {
        var payload = {};
        for (var key in result) {
          if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
          payload[key] = result[key].error() ? describeError(result[key].error()) : result[key].data();
        }
        show('callBatch', payload);
      });
    },

    fit: function () {
      BX24.fitWindow();
      show('fitWindow', 'Команда отправлена: портал подогнал высоту фрейма под содержимое.');
    },

    slider: function () {
      BX24.openApplication({ opened: 'Y', from: app.placement }, function () {
        show('openApplication', 'Слайдер закрыт.');
      });
      show('openApplication', 'Приложение открыто слайдером поверх страницы портала.');
    },

    user: function () {
      BX24.selectUser(function (user) { show('selectUser', user); });
    },

    crm: function () {
      BX24.selectCRM({ entityType: ['deal'], multiple: false }, function (selected) {
        show('selectCRM', selected);
      });
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (libraryMissing()) return;
    var buttons = document.querySelectorAll('button[data-action]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (event) {
        actions[event.currentTarget.getAttribute('data-action')]();
      });
    }
    BX24.init(function () {
      fillContext();
      loadContextDeal();
      // Высота фрейма у портала фиксированная, пока приложение не попросит другую.
      BX24.fitWindow();
    });
  });
`

// ────────────────────────────── Маршруты ──────────────────────────────

async function handleInstall(req, res, url) {
  const fields = await readFrameFields(req, url)
  log('установка', `портал ${fields.DOMAIN ?? 'не назвался'} открыл мастер установки, APP_SID=${fields.APP_SID ?? '—'}`)
  printFields('установка', fields)

  saveTokens(fields)
  log('установка', `токены сохранены в ${TOKENS_FILE}`)
  log('установка', `права приложения: ${fields.APPLICATION_SCOPE ?? '—'}`)

  const body = `
  <h1>Мастер установки</h1>
  <p class="muted">Портал открывает этот адрес первым и будет открывать его при каждом запуске,
  пока приложение не вызовет <code>BX24.installFinish()</code>.</p>

  <div class="card">
    <h2>Порядок установки</h2>
    <ol class="steps">
      <li id="step-placement">Регистрация виджета <code>${escapeHtml(WIDGET_PLACEMENT)}</code> — <span class="state">ожидание</span></li>
      <li id="step-event">Подписка на событие <code>${escapeHtml(EVENT_CODE)}</code> — <span class="state">ожидание</span></li>
      <li id="step-finish">Вызов <code>BX24.installFinish()</code> — <span class="state">ожидание</span></li>
    </ol>
  </div>

  <div class="card">
    <h2>Что происходит</h2>
    <pre id="out">Жду инициализации библиотеки…</pre>
  </div>

  ${fieldsCard('Что прислал портал', fields)}
  `

  sendHtml(
    res,
    layout({
      title: 'Установка приложения',
      body,
      script: INSTALL_SCRIPT,
      libraryUrl: bx24JsUrl(fields),
      appData: {
        placement: WIDGET_PLACEMENT,
        widgetTitle: WIDGET_TITLE,
        event: EVENT_CODE,
        handlerUrl: HANDLER_URL,
        eventsUrl: EVENTS_URL,
        libraryUrl: bx24JsUrl(fields),
      },
    }),
    fields,
  )
}

async function handleHandler(req, res, url) {
  const fields = await readFrameFields(req, url)
  const placement = fields.PLACEMENT ?? 'DEFAULT'
  const options = parsePlacementOptions(fields.PLACEMENT_OPTIONS)

  log('обработчик', `открыт из ${placement}, APP_SID=${fields.APP_SID ?? '—'}, member_id=${fields.member_id ?? '—'}`)
  if (Object.keys(options).length > 0) {
    log('обработчик', `контекст вызова: ${JSON.stringify(options)}`)
  }

  // Каждый показ фрейма приносит свежий AUTH_ID — боевое приложение обновляет им пару.
  saveTokens(fields)

  const dealCard =
    placement === WIDGET_PLACEMENT
      ? `<div class="card">
    <h2>Сделка из контекста</h2>
    <div id="deal" class="muted">Запрашиваю crm.deal.get по ID из PLACEMENT_OPTIONS…</div>
  </div>`
      : ''

  const body = `
  <h1>Приложение открыто</h1>
  <p class="muted">Точка встраивания <code>${escapeHtml(placement)}</code>.
  Тот же обработчик обслуживает все точки: различает их значение <code>PLACEMENT</code>.</p>

  <div class="card">
    <h2>Кто открыл</h2>
    <div id="who" class="muted">Читаю окружение…</div>
  </div>

  ${dealCard}

  <div class="card">
    <h2>Проверки</h2>
    <div class="buttons">
      <button type="button" data-action="deals">Список сделок</button>
      <button type="button" data-action="batch">Пакетный запрос</button>
      <button type="button" data-action="fit">Подогнать высоту</button>
      <button type="button" data-action="slider">Открыть слайдером</button>
      <button type="button" data-action="user">Выбрать сотрудника</button>
      <button type="button" data-action="crm">Выбрать сделку</button>
    </div>
  </div>

  <div class="card">
    <h2>Ответ</h2>
    <pre id="out">Нажмите кнопку — сюда придёт ответ портала.</pre>
  </div>

  ${fieldsCard('Что прислал портал', fields)}
  `

  sendHtml(
    res,
    layout({
      title: 'Пример локального приложения',
      body,
      script: HANDLER_SCRIPT,
      libraryUrl: bx24JsUrl(fields),
      appData: {
        placement,
        placementOptions: options,
        libraryUrl: bx24JsUrl(fields),
      },
    }),
    fields,
  )
}

async function handleEvents(req, res) {
  const raw = await readBody(req)
  const pairs = [...new URLSearchParams(raw)]
  const values = Object.fromEntries(pairs)

  log('событие', `${values.event ?? 'без имени'} от ${values['auth[domain]'] ?? 'неизвестного портала'}`)
  for (const [name, value] of pairs) {
    log('событие', `  ${name} = ${name.includes('token') ? maskValue('AUTH_ID', value) : value}`)
  }

  // Единственная защита обработчика: application_token совпадает с тем, что портал
  // прислал при установке. Адрес обработчика доступен из сети, подписи у Bitrix24 нет.
  const expected = tokens?.applicationToken ?? null
  const received = values['auth[application_token]'] ?? null
  if (expected && received) {
    log('событие', received === expected ? '  application_token совпал' : '  application_token НЕ совпал — запрос чужой')
  }

  // Успехом Bitrix24 считает любой ответ 2xx и повторов не делает: упавший
  // обработчик теряет событие насовсем.
  sendText(res, 200, 'OK')
}

function handleStatus(res) {
  const state = tokens
    ? `Токены сохранены ${tokens.savedAt}, портал ${tokens.domain}, права: ${tokens.scope || '—'}.`
    : 'Токенов пока нет — приложение ещё не устанавливали.'

  const body = `
  <h1>Пример локального приложения Bitrix24</h1>
  <p class="muted">${escapeHtml(state)}</p>

  <div class="card">
    <h2>Адреса для карточки приложения</h2>
    <dl class="fields">
      <dt>Путь обработчика</dt><dd><code>${escapeHtml(HANDLER_URL)}</code></dd>
      <dt>Путь установки</dt><dd><code>${escapeHtml(INSTALL_URL)}</code></dd>
      <dt>Обработчик событий</dt><dd><code>${escapeHtml(EVENTS_URL)}</code></dd>
      <dt>Права</dt><dd><code>${escapeHtml(REQUIRED_SCOPE)}</code></dd>
    </dl>
  </div>

  <p class="muted">Страницы приложения открывает портал POST-запросом и показывает во фрейме.
  По прямой ссылке из браузера они пустые: без полей портала библиотеке BX24.js неоткуда
  взять адрес и авторизацию.</p>
  `

  sendHtml(res, layout({ title: 'Пример локального приложения Bitrix24', body }))
}

function handleDirectOpen(res, what) {
  const body = `
  <h1>Страница открыта напрямую</h1>
  <p class="muted">Адрес <code>${escapeHtml(what)}</code> открывает портал POST-запросом
  и передаёт в нём авторизацию и контекст вызова. GET-запрос из браузера этих полей не несёт,
  поэтому показывать здесь нечего.</p>
  <p class="muted">Откройте приложение из портала APIStend — <a href="/">адреса для его карточки</a>.</p>
  `
  sendHtml(res, layout({ title: 'Страница открыта напрямую', body }))
}

// ─────────────────────────────── Сервер ───────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  const dispatch = async () => {
    if (req.method === 'POST' && route === '/install') return handleInstall(req, res, url)
    if (req.method === 'POST' && route === '/handler') return handleHandler(req, res, url)
    if (req.method === 'POST' && route === '/events') return handleEvents(req, res)
    if (req.method === 'GET' && route === '/') return handleStatus(res)
    if (req.method === 'GET' && (route === '/install' || route === '/handler')) {
      return handleDirectOpen(res, route)
    }
    if (req.method === 'GET' && route === '/favicon.ico') return sendText(res, 404, 'нет иконки')
    return sendText(res, 404, `Нет такого адреса: ${route}`)
  }

  dispatch().catch((error) => {
    log('ошибка', `${req.method} ${route}: ${error.message}`)
    if (!res.headersSent) sendText(res, 500, `Ошибка приложения: ${error.message}`)
  })
})

server.listen(PORT, () => {
  console.log('')
  log('старт', `пример локального приложения слушает ${APP_URL}`)
  console.log('')
  console.log('Впишите в карточку приложения APIStend:')
  console.log(`  Путь обработчика               ${HANDLER_URL}`)
  console.log(`  Путь первоначальной установки  ${INSTALL_URL}`)
  console.log(`  Права                          ${REQUIRED_SCOPE}`)
  console.log('')
  console.log(
    tokens
      ? `Токены с прошлой установки на месте: ${TOKENS_FILE}`
      : 'Токенов пока нет: откройте приложение в портале, и мастер установки их сохранит.',
  )
  console.log('')
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('ошибка', `порт ${PORT} занят. Освободите его или задайте другой: PORT=3211 node server.mjs`)
    process.exit(1)
  }
  throw error
})
