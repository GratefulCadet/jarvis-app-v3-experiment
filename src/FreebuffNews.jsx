import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, CircleAlert, ExternalLink, Newspaper, RefreshCw, Search, Sparkles } from 'lucide-react'

const scoreLabel = (score) => Number.isFinite(Number(score)) ? `${score}/10` : '—'

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '날짜 미상'
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function FreebuffNews({ onBack }) {
  const [news, setNews] = useState({ items: [], sources: [], lastRefresh: null, scorer: 'keyword-fallback', model: null })
  const [selectedId, setSelectedId] = useState(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (refresh = false) => {
    if (!window.freebuffNews) {
      setError('Electron 뉴스 브리지를 사용할 수 없습니다. 앱을 다시 실행해 주세요.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const data = refresh ? await window.freebuffNews.refresh() : await window.freebuffNews.get()
      setNews(data)
      setSelectedId((current) => data.items.some((item) => item.id === current) ? current : data.items[0]?.id || null)
    } catch (cause) {
      setError(cause?.message || '뉴스를 불러오지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return news.items
    return news.items.filter((item) => `${item.title} ${item.summary} ${item.source} ${(item.category || []).join(' ')}`.toLowerCase().includes(needle))
  }, [news.items, query])
  const selected = filteredItems.find((item) => item.id === selectedId) || filteredItems[0]
  const highValueCount = news.items.filter((item) => item.importance >= 7 && item.freebuff_relevance >= 6).length

  return (
    <main className="freebuff-news-screen" aria-label="Freebuff News">
      <header className="freebuff-news-header">
        <button className="freebuff-news-back" onClick={onBack} type="button">← <span>Assistant</span></button>
        <div className="freebuff-news-brand"><span className="freebuff-news-mark"><Newspaper size={17} /></span><div><p>FREEBUFF / SCOUT</p><h1>AI News Brief</h1></div></div>
        <button className="freebuff-news-refresh" type="button" onClick={() => load(true)} disabled={busy}>
          <RefreshCw size={15} className={busy ? 'is-spinning' : ''} /> {busy ? '수집 중…' : '새로 수집'}
        </button>
      </header>

      <div className="freebuff-news-meta">
        <span><i className="freebuff-news-live-dot" /> 무료 공개 소스 · 로컬 우선</span>
        <span>{news.lastRefresh ? `최근 업데이트 ${formatDate(news.lastRefresh)}` : '첫 수집을 준비하고 있습니다'}</span>
        <span>{news.scorer === 'ollama' ? `LOCAL LLM · ${news.model || 'Ollama'}` : 'KEYWORD FILTER · 무료 모드'}</span>
      </div>

      {error && <div className="freebuff-news-error" role="alert"><CircleAlert size={16} />{error}</div>}

      <section className="freebuff-news-overview" aria-label="수집 요약">
        <div><span>수집된 AI 시그널</span><strong>{news.items.length}</strong><small>중복 제거 후 로컬 저장</small></div>
        <div><span>높은 Freebuff 관련도</span><strong>{highValueCount}</strong><small>중요도 ≥ 7 · 관련도 ≥ 6</small></div>
        <div className="freebuff-news-source-card"><span>활성 데이터 소스</span><strong>{news.sources.filter((source) => !source.error).length}<small> / {news.sources.length}</small></strong><small>{news.sources.map((source) => source.name).join(' · ') || 'GDELT · GitHub · arXiv · RSS · HN'}</small></div>
      </section>

      <section className="freebuff-news-workspace">
        <div className="freebuff-news-list-panel">
          <div className="freebuff-news-list-heading"><div><span>SCOUT FEED</span><strong>발견된 정보</strong></div><label className="freebuff-news-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색" aria-label="뉴스 검색" /></label></div>
          <div className="freebuff-news-items" aria-live="polite">
            {filteredItems.length ? filteredItems.map((item) => (
              <button key={item.id} type="button" className={`freebuff-news-item ${selected?.id === item.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                <span className="freebuff-news-item-meta"><span>{item.source}</span><time>{formatDate(item.publishedAt)}</time></span>
                <strong>{item.title}</strong>
                <span className="freebuff-news-item-summary">{item.summary || '원문에서 내용을 확인하세요.'}</span>
                <span className="freebuff-news-item-footer"><span>{(item.category || []).join(' · ')}</span><span>중요도 <b>{scoreLabel(item.importance)}</b></span></span>
              </button>
            )) : <div className="freebuff-news-empty">{busy ? '무료 데이터 소스에서 최신 정보를 찾고 있습니다…' : query ? '검색 결과가 없습니다.' : '아직 수집된 정보가 없습니다. 새로 수집을 눌러 시작하세요.'}</div>}
          </div>
        </div>

        <article className="freebuff-news-detail">
          {selected ? <>
            <div className="freebuff-news-detail-top"><span>{selected.source} <i>·</i> {formatDate(selected.publishedAt)}</span><a href={selected.url} target="_blank" rel="noreferrer">원문 열기 <ExternalLink size={13} /></a></div>
            <h2>{selected.title}</h2>
            <div className="freebuff-news-scores">
              <div><span>중요도</span><strong>{scoreLabel(selected.importance)}</strong></div>
              <div><span>Freebuff 관련도</span><strong>{scoreLabel(selected.freebuff_relevance)}</strong></div>
              <div><span>신규성</span><strong>{scoreLabel(selected.novelty)}</strong></div>
            </div>
            <section><h3><Sparkles size={14} /> 핵심 요약</h3><p>{selected.summary || selected.title}</p></section>
            <section><h3>왜 중요한가</h3><p>{selected.why_it_matters || '키워드 기반으로 분류되었습니다. Ollama를 실행하면 로컬 모델이 Freebuff 관점에서 추가 분석합니다.'}</p></section>
            <section className="freebuff-news-action"><h3><ArrowUpRight size={14} /> 적용 아이디어</h3><p>{selected.possible_action || '원문을 확인하고 적용 가능성을 살펴보세요.'}</p></section>
            <div className="freebuff-news-analysis-note">{selected.evaluator === 'ollama' ? `로컬 모델 분석 · ${news.model || 'Ollama'}` : '키워드 기반 사전 필터 · API 비용 없음'}</div>
          </> : <div className="freebuff-news-empty-detail"><Newspaper size={28} /><strong>AI 정보를 수집하고 있습니다</strong><span>GDELT · GitHub · Hacker News · arXiv · RSS</span></div>}
        </article>
      </section>

      <footer className="freebuff-news-sources">
        <span>DATA SOURCES</span>
        {news.sources.length ? news.sources.map((source) => <span key={source.name} className={source.error ? 'is-unavailable' : ''} title={source.error || `${source.count}건 수집`}>{source.name}{source.error ? ' · 오류' : ` · ${source.count}`}</span>) : <span>GDELT · GitHub · Hacker News · arXiv · Hugging Face RSS · Google AI RSS</span>}
        <span className="freebuff-news-sources-tail">수집 결과는 이 기기에 저장됩니다. <ArrowUpRight size={12} /></span>
      </footer>
    </main>
  )
}
