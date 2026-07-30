import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

mkdirSync(join(__dirname, 'data'), { recursive: true })

const db = new DatabaseSync(process.env.DATABASE_URL || join(__dirname, 'data/app.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS journeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distance REAL NOT NULL,
    passengers INTEGER NOT NULL,
    completed_at TEXT DEFAULT (datetime('now'))
  )
`)

const { count } = db.prepare('SELECT COUNT(*) as count FROM journeys').get()
if (count === 0) {
  db.exec(`
    INSERT INTO journeys (distance, passengers) VALUES (287.4, 143);
    INSERT INTO journeys (distance, passengers) VALUES (156.2, 89);
    INSERT INTO journeys (distance, passengers) VALUES (412.8, 201);
    INSERT INTO journeys (distance, passengers) VALUES (93.5, 47);
    INSERT INTO journeys (distance, passengers) VALUES (334.1, 178);
  `)
}

const app = new Hono()

app.get('/api/stats', (c) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_journeys,
      ROUND(COALESCE(SUM(distance), 0), 1) as total_distance,
      COALESCE(SUM(passengers), 0) as total_passengers,
      ROUND(COALESCE(MAX(distance), 0), 1) as longest_journey
    FROM journeys
  `).get()
  return c.json(stats)
})

app.post('/api/journey', async (c) => {
  const { distance, passengers } = await c.req.json()
  db.prepare('INSERT INTO journeys (distance, passengers) VALUES (?, ?)').run(
    Math.round(distance * 10) / 10,
    passengers
  )
  return c.json({ success: true })
})

app.get('/', (c) => {
  const html = readFileSync(join(__dirname, 'public/index.html'), 'utf-8')
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

const port = parseInt(process.env.PORT || '3000')
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Iron Horse Express running on port ${port}`)
})
