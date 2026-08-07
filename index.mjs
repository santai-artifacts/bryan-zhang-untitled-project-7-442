import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(__dirname, 'data'), { recursive: true })

// ── Database ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(process.env.DATABASE_URL || join(__dirname, 'data/news.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    link TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    pub_date TEXT DEFAULT '',
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_category ON articles(category);
  CREATE INDEX IF NOT EXISTS idx_fetched ON articles(fetched_at DESC);
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now'))
  );
`)

// ── RSS Feeds ─────────────────────────────────────────────────────────────────
const FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',       source: 'BBC News',      category: 'World' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',  source: 'BBC Tech',      category: 'Technology' },
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', source: 'BBC Science', category: 'Science' },
  { url: 'https://feeds.npr.org/1001/rss.xml',                 source: 'NPR',           category: 'World' },
  { url: 'https://news.ycombinator.com/rss',                   source: 'Hacker News',   category: 'Technology' },
  { url: 'https://www.sciencedaily.com/rss/top/science.xml',   source: 'Science Daily', category: 'Science' },
]

// ── RSS Parser ────────────────────────────────────────────────────────────────
function extractField(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = xml.match(re)
  if (!m) return ''
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseRSS(xml, source, category) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const title = extractField(block, 'title')
    const raw = extractField(block, 'description')
    const description = raw.length > 220 ? raw.slice(0, 217) + '…' : raw
    const link = extractField(block, 'link') || extractField(block, 'guid')
    const pub_date = extractField(block, 'pubDate')
    if (title && link) items.push({ title, description, link, source, category, pub_date })
  }
  return items
}

// ── Feed Fetcher ──────────────────────────────────────────────────────────────
async function fetchFeed({ url, source, category }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)' }
    })
    if (!res.ok) return []
    const xml = await res.text()
    return parseRSS(xml, source, category)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO articles (title, description, link, source, category, pub_date)
  VALUES (?, ?, ?, ?, ?, ?)
`)

async function refreshFeeds() {
  console.log('Refreshing feeds…')
  const results = await Promise.allSettled(FEEDS.map(fetchFeed))
  let total = 0
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const a of r.value) {
      insert.run(a.title, a.description, a.link, a.source, a.category, a.pub_date)
      total++
    }
  }
  // Prune old articles (keep latest 500)
  db.exec(`DELETE FROM articles WHERE id NOT IN (SELECT id FROM articles ORDER BY fetched_at DESC, id DESC LIMIT 500)`)
  console.log(`Feeds refreshed — ${total} articles processed`)
  await generateSummary()
}

// ── AI Summary ────────────────────────────────────────────────────────────────
function fallbackSummary() {
  const top = db.prepare(`SELECT title FROM articles ORDER BY fetched_at DESC LIMIT 5`).all()
  if (!top.length) return
  const content = `Today's top stories: ${top.map(a => a.title).join('. ')}.`
  db.prepare(`INSERT INTO summaries (content) VALUES (?)`).run(content)
}

async function generateSummary() {
  const base = process.env.SANTAI_AI_BASE_URL
  const token = process.env.SANTAI_AI_TOKEN
  if (!base) { fallbackSummary(); return }
  try {
    const headlines = db.prepare(`SELECT title, source FROM articles ORDER BY fetched_at DESC LIMIT 15`).all()
    if (!headlines.length) return
    const list = headlines.map((h, i) => `${i + 1}. [${h.source}] ${h.title}`).join('\n')

    const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }))
    if (!Anthropic) return

    const ai = new Anthropic({ baseURL: base, apiKey: token || 'placeholder' })
    const msg = await ai.messages.create({
      model: 'anthropic-claude-bedrock4.5-haiku',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are writing a TL;DR morning briefing for a general audience. Here are today's top headlines from multiple news sources:\n\n${list}\n\nWrite 2–3 crisp, factual sentences summarizing the key themes. No bullet points. No intros like "Today's briefing...". Just the sentences.`
      }]
    })
    const content = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim()
    if (content) db.prepare(`INSERT INTO summaries (content) VALUES (?)`).run(content)
  } catch (e) {
    console.error('AI summary failed:', e.message)
    fallbackSummary()
  }
}

// ── API ───────────────────────────────────────────────────────────────────────
const app = new Hono()

app.get('/api/articles', (c) => {
  const cat = c.req.query('category') || 'All'
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = 18
  const offset = (page - 1) * limit

  const where = cat === 'All' ? '' : `WHERE category = '${cat.replace(/'/g, "''")}'`
  const articles = db.prepare(`
    SELECT id, title, description, link, source, category, pub_date, fetched_at
    FROM articles ${where}
    ORDER BY fetched_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset)

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM articles ${where}`).get()
  return c.json({ articles, total, page, pages: Math.ceil(total / limit) })
})

app.get('/api/summary', (c) => {
  const row = db.prepare(`SELECT content, generated_at FROM summaries ORDER BY id DESC LIMIT 1`).get()
  return c.json(row || { content: null, generated_at: null })
})

app.get('/api/stats', (c) => {
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM articles`).get()
  const { sources } = db.prepare(`SELECT COUNT(DISTINCT source) as sources FROM articles`).get()
  const { categories } = db.prepare(`SELECT COUNT(DISTINCT category) as categories FROM articles`).get()
  const { last_updated } = db.prepare(`SELECT MAX(fetched_at) as last_updated FROM articles`).get()
  const cats = db.prepare(`SELECT category, COUNT(*) as n FROM articles GROUP BY category ORDER BY n DESC`).all()
  return c.json({ total, sources, categories, last_updated, breakdown: cats })
})

let lastRefresh = 0
app.post('/api/refresh', async (c) => {
  const now = Date.now()
  if (now - lastRefresh < 60000) return c.json({ ok: false, message: 'Rate limited — wait 1 minute' })
  lastRefresh = now
  refreshFeeds()
  return c.json({ ok: true })
})

app.get('/', (c) => {
  const html = readFileSync(join(__dirname, 'public/index.html'), 'utf-8')
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

// ── Start ─────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3000')
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, async () => {
  console.log(`The Brief running on port ${port}`)
  await refreshFeeds()
  setInterval(refreshFeeds, 30 * 60 * 1000)
})
