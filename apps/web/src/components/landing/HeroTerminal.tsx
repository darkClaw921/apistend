import { TerminalFrame } from '@apistend/ui'

/**
 * Терминал в hero-секции. Показывает реальный вызов мока и реальный конверт ответа
 * Bitrix24 — с полями next, total и объектом time, как отдаёт боевой портал.
 */
export function HeroTerminal() {
  return (
    <TerminalFrame fileName="request.sh">
      <pre className="overflow-x-auto scrollbar-thin p-[18px] font-mono text-[12.5px] leading-[1.55]">
        <code>
          <span className="text-code-muted">$ </span>
          <span className="text-code-key">curl</span>
          <span className="text-code-text"> -X GET \</span>{'\n'}
          <span className="text-code-string">{'  '}&apos;https://apistend.ru/b24/rest/crm.deal.list&apos;</span>
          <span className="text-code-text"> \</span>{'\n'}
          <span className="text-code-text">{'  '}-H </span>
          <span className="text-code-string">&apos;X-Mock-Key: stend_sbx_7f3a…&apos;</span>{'\n'}
          {'\n'}
          <span className="text-code-text">{'{'}</span>{'\n'}
          <span className="text-code-key">{'  '}&quot;result&quot;</span>
          <span className="text-code-text">: [</span>{'\n'}
          <span className="text-code-text">{'    { '}</span>
          <span className="text-code-key">&quot;ID&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-string">&quot;1042&quot;</span>
          <span className="text-code-text">, </span>
          <span className="text-code-key">&quot;TITLE&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-string">&quot;Поставка для ПАО&quot;</span>
          <span className="text-code-text"> {'}'},</span>{'\n'}
          <span className="text-code-text">{'    { '}</span>
          <span className="text-code-key">&quot;ID&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-string">&quot;1041&quot;</span>
          <span className="text-code-text">, </span>
          <span className="text-code-key">&quot;TITLE&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-string">&quot;Возврат Wildberries&quot;</span>
          <span className="text-code-text"> {'}'}</span>{'\n'}
          <span className="text-code-text">{'  '}],</span>{'\n'}
          <span className="text-code-key">{'  '}&quot;next&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-number">50</span>
          <span className="text-code-text">,</span>{'\n'}
          <span className="text-code-key">{'  '}&quot;total&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-number">128</span>
          <span className="text-code-text">,</span>{'\n'}
          <span className="text-code-key">{'  '}&quot;time&quot;</span>
          <span className="text-code-text">: {'{ '}</span>
          <span className="text-code-key">&quot;duration&quot;</span>
          <span className="text-code-text">: </span>
          <span className="text-code-number">0.041</span>
          <span className="text-code-text"> {'}'}</span>{'\n'}
          <span className="text-code-text">{'}'}</span>
        </code>
      </pre>
    </TerminalFrame>
  )
}
